import { AsyncLocalStorage } from 'node:async_hooks';
import { isJSONRPCRequest, isJSONRPCResultResponse } from '@modelcontextprotocol/sdk/types.js';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { confinedPath, listWorkspace, readWorkspace } from './workspace';
import { isSafeContextPath, selectContext } from './context';
import { resolveAgentProposal } from './patch';

export interface EditorBridge {
 root:string; budget:number; task?:string; active():boolean;
 pending?(path:string):string|undefined;
 propose(path:string, content:string):Promise<string>;
 command(command:string,args:string[]):Promise<string>;
 onPlan?(files:{path:string;reason:string}[]):void;
 onToolCall?(summary:string):void;
 /** Authenticated protocol initialization; not registration or tools/list. */
 onInitialized?():void;
 /** One observation per authenticated tools/call, before argument validation/gating. */
 onToolRequest?(name:string):void;
 context(result:ReturnType<typeof selectContext>):void;
}
export async function startMcp(bridge: EditorBridge) {
 const token=randomBytes(32).toString('hex');
 const transports=new Set<StreamableHTTPServerTransport>();
 const output=(text:string)=>({content:[{type:'text' as const,text}]});
 // Scoped to this bridge/run, not to the individual stateless HTTP transport.
 // Limit fresh text before the first proposal, but always allow small windows.
 const exploration = new Map<string,string>();
 const limit=6;
 const attempt=new AsyncLocalStorage<{used:number;generation:number}>();
 let generation=0;
 const explorationTools=new Set(['find_relevant_files','select_context','read_file','search_workspace']);
 let exposedChars=0, hasProposed=false, calls=0;
 const show=(text:string,used=calls)=>output(`${text}\nbudget: ${used}/${limit} exploration calls used`);
 const safeLabel=(p:string)=>isSafeContextPath(p)&&/^[\w ./-]+$/.test(p)?p:'';
 const report=(tool:string,details='',flag='')=>bridge.onToolCall?.([tool,details.replace(/[\x00-\x1f\x7f]/g,'').slice(0,400),flag].filter(Boolean).join(' · '));
 const take=()=>attempt.getStore()?.used??0;
 const verifyGeneration=()=>{
  const current=attempt.getStore();
  if(current && current.generation!==generation)throw new Error('This tool call belongs to a cancelled turn.');
 };
 const resetExploration=()=>{generation++;calls=0;exposedChars=0;hasProposed=false;exploration.clear();};
 const exhausted=()=>({...show('Budget exhausted: call propose_write now.'),isError:true});
 const failed=(error:unknown,used:number)=>({...show(error instanceof Error?error.message:'Exploration failed.',used),isError:true});
 const digest=(...values:(string|number)[])=>createHash('sha256').update(JSON.stringify(values)).digest('hex');
 const remaining=(max:number)=>hasProposed?max:Math.min(max,Math.max(900,6000-exposedChars));
 const shown=(key:string, text:string, repeat:string, used:number)=>{
  verifyGeneration();
  exposedChars+=text.length;
  if(exploration.size>=128)exploration.delete(exploration.keys().next().value!);
  exploration.set(key,repeat);
  return show(text,used);
 };
 function build() {
  const mcp=new McpServer({name:'forgelens-editor',version:'0.1.0'});
  mcp.server.oninitialized=()=>bridge.onInitialized?.();
  const readView=async(path:string)=>{const disk=await readWorkspace(bridge.root,path);return bridge.pending?.(path)??disk;};
  const guard=()=>{verifyGeneration();if(!bridge.active()) throw new Error('Run cancelled or inactive');};
  mcp.registerTool('read_file',{
   description:'Read staged or saved source in exact line ranges. Defaults to 80 lines. Broad exploration is compacted; follow startLine to paginate. Unchanged repeated reads return a locator unless refresh=true. Use search_workspace or select_context first to find relevant ranges. Staged text is not applied; protected files are excluded.',
   inputSchema:{path:z.string(),startLine:z.number().int().min(1).optional(),lineCount:z.number().int().min(1).max(300).optional(),refresh:z.boolean().optional()}
  },async({path,startLine=1,lineCount=80,refresh=false})=>{
   guard();
   const details=`${safeLabel(path)}:${startLine}+${lineCount}`;
   const usedCall=take();if(!usedCall)return exhausted();
   try {
   const diskPath=await confinedPath(bridge.root,path);
   const info=await stat(diskPath,{bigint:true});
   if(info.size>1000000n)throw new Error('Oversized file excluded');
   guard();
   const pending=bridge.pending?.(path);
   const staged=pending!==undefined?'[STAGED PROPOSAL, not applied or saved] ':'';
   const key=digest('read',path,diskPath,startLine,lineCount,
    pending===undefined?`${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`:digest('staged',pending));
   if(!refresh&&exploration.has(key)){report('read_file',details,'repeat');return show(exploration.get(key)!,usedCall);}
   const lines=(pending??await readWorkspace(bridge.root,path)).split('\n');
   if(startLine>lines.length)throw new Error('startLine exceeds file length.');
   const requestedEnd=Math.min(lines.length,startLine+lineCount-1);
   const maxChars=remaining(4000);
   let end=startLine-1, used=0, clipped=false;
   const visible:string[]=[];
   for(let n=startLine;n<=requestedEnd;n++){
    const line=lines[n-1]!;
    const cost=line.length+(visible.length?1:0);
    if(used+cost>maxChars){
     if(!visible.length){visible.push(line.slice(0,maxChars));end=n;clipped=true;}
     break;
    }
    visible.push(line);used+=cost;end=n;
   }
   const clipNotice=clipped?`\n[Line ${end} clipped; only its prefix is shown.]`:'';
   const more=end<requestedEnd?`\n[Read budget reached. Continue at startLine=${end+1} if needed.]`:'';
   const range=`${staged}${path}: lines ${startLine}-${end} of ${lines.length}`;
   report('read_file',details);
   return shown(key,`${range}\n\n${visible.join('\n')}${clipNotice}${more}`,
    `${range} [Already shown. You already did this; proceed to write.]${more}`,usedCall);
   } catch(error){report('read_file',details,'failed');return failed(error,usedCall);}
  });
  mcp.registerTool('search_workspace',{description:'Search a literal substring (not regex) in source paths and lines. Prefer distinctive identifiers. Optional pathPrefix narrows to a discovered directory or file. Includes 2 neighboring lines by default (contextLines 0-3), with exact line references, so small matches need not be reread. Capped at 8 matches per file and 10 total; preview text is bounded. Unchanged repeated searches return a short note unless refresh=true. Narrow queries if limited.',inputSchema:{query:z.string().min(1).max(200),pathPrefix:z.string().optional(),contextLines:z.number().int().min(0).max(3).optional(),refresh:z.boolean().optional()}},async({query,pathPrefix,contextLines=2,refresh=false})=>{
   guard();
   const usedCall=take();if(!usedCall)return exhausted();
   try {
   const needle=query.toLowerCase();
   const files=await listWorkspace(bridge.root); const hits:string[]=[]; let limited=false, totalMatches=0;
   for(const file of files){guard(); if(pathPrefix && !file.startsWith(pathPrefix))continue;
    try {const text=await readView(file); const lines=text.split('\n');let fileHits=0;const included=new Set<number>();
     if(totalMatches<10&&file.toLowerCase().includes(needle)) {hits.push(file);totalMatches++;}
     for(let i=0;i<lines.length;i++) if(lines[i].toLowerCase().includes(needle)) {
      if(fileHits>=8 || totalMatches>=10){limited=true;break;}
      fileHits++;totalMatches++;
      for(let j=Math.max(0,i-contextLines);j<=Math.min(lines.length-1,i+contextLines);j++) included.add(j);
     }
     for(const i of [...included].sort((a,b)=>a-b)){
      const line=lines[i]!;
      const match=line.toLowerCase().indexOf(needle);
      const start=Math.max(0,Math.min(match-50,line.length-200));
      const preview=line.slice(start,start+200);
      hits.push(`${file}:${i+1}: ${start?'…':''}${preview}${start+preview.length<line.length?'…':''}`);
     }
    }catch{} if(totalMatches>=10){limited=true;break;}}
   guard();
   const key=digest('search',query.toLowerCase(),pathPrefix??'',contextLines,limited?1:0,hits.join('\n'));
   if(!refresh&&exploration.has(key)){report('search_workspace',safeLabel(pathPrefix??''),'repeat');return show(exploration.get(key)!,usedCall);}
   const cap=remaining(4000);
   const visible:string[]=[]; let used=0;
   for(const hit of hits){
    if(visible.length>=10){limited=true;break;}
    const cost=hit.length+(visible.length?1:0);
    if(used+cost>cap){limited=true;break;}
    visible.push(hit);used+=cost;
   }
   const result=visible.join('\n')+(limited?'\n[Results limited. Narrow the literal query or pathPrefix.]':hits.length?'':'No literal matches. Try a shorter distinctive identifier.');
   const repeat=hits.length
    ? `[Unchanged search results already shown; ${totalMatches} matches${limited?' (limited)':''}. You already did this; proceed to write.]`
    : '[No literal matches; unchanged result already shown. You already did this; proceed to write.]';
   report('search_workspace',safeLabel(pathPrefix??''));
   return shown(key,result,repeat,usedCall);
   } catch(error){report('search_workspace',safeLabel(pathPrefix??''),'failed');return failed(error,usedCall);}
  });
  const collectContext=async(query:string,discovery:boolean)=>{
   const usedCall=take();if(!usedCall)return exhausted();
   const name=discovery?'find_relevant_files':'select_context';
   report(name);
   try {
    guard(); const files=[]; let total=0;
    for(const file of await listWorkspace(bridge.root)){
     guard();try{const content=await readView(file);total+=content.length;if(total>8000000)break;files.push({path:file,content});}catch{}
    }
    // Preserve requested test/docs coverage even if the model abbreviates its
    // discovery query. Focused select_context queries remain independent.
    const contextQuery=discovery&&bridge.task?`${bridge.task}\n${query}`:query;
    const result=selectContext(files,contextQuery,discovery?Math.min(4000,bridge.budget):bridge.budget,discovery?{maxFiles:5,maxLines:40}:undefined);
    guard();
    bridge.context(result);
    return show(JSON.stringify(result),usedCall);
   } catch(error){return failed(error,usedCall);}
  };
  mcp.registerTool('find_relevant_files',{
   description:'Find up to five distinct relevant workspace files using the original task requirements plus this query, with reasons and at most 40 lines of evidence per file. Counts toward the shared six-call exploration budget. Use this first.',
   inputSchema:{query:z.string().trim().min(1).max(4000)}
  },async({query})=>collectContext(query,true));
  mcp.registerTool('select_context',{
   description:'Retrieve budgeted source snippets and reasons; supports @file and @symbol. Counts toward the shared six-call exploration budget.',
   inputSchema:{query:z.string().trim().min(1).max(4000)}
  },async({query})=>collectContext(query,false));
  mcp.registerTool('report_plan',{
   description:'Record planned workspace-relative files and the reason for each before staging edits. Does not consume exploration calls or write disk.',
   inputSchema:{files:z.array(z.object({path:z.string().min(1).max(400),reason:z.string().trim().min(1).max(400)})).min(1).max(12)}
  },async({files})=>{
   guard();
   if(new Set(files.map(f=>f.path)).size!==files.length)throw new Error('Report each planned file once.');
   for(const f of files)await confinedPath(bridge.root,f.path);
   guard();
   bridge.onPlan?.(files);
   report('report_plan','',`${files.length} files`);
   return show(`Plan recorded for ${files.length} files. Call propose_write to stage changes.`);
  });
  for(const name of ['propose_write','propose_edit'] as const)mcp.registerTool(name,{description:'Stage or revise exact replacements in an existing file for human per-hunk review; never writes disk. Supply edits:[{oldText,newText}], not file content. Each oldText must match exactly once. Include unchanged surrounding lines only to make an anchor unique. Unchanged file contents are preserved automatically. read_file/search show the staged view, so base revisions on that view.',inputSchema:{path:z.string(),edits:z.array(z.object({oldText:z.string().min(1).max(250000).describe('Exact unique text already present in the current file or staged view.'),newText:z.string().max(250000).describe('Replacement for oldText only; do not reproduce the whole file.')})).min(1).max(20)}},async({path,edits})=>{guard();report(name,safeLabel(path));const original=await readView(path);const proposed=resolveAgentProposal(original,{edits});guard();const result=await bridge.propose(path,proposed);guard();if(bridge.pending?.(path)===proposed)hasProposed=true;return show(result);});
  mcp.registerTool('run_command',{description:'Request an explicitly approved validation command. Restricted to pytest, git status/diff, and flask --help; no shell.',inputSchema:{command:z.string(),args:z.array(z.string()).max(20)}},async({command,args})=>{guard();report('run_command');return show('Validation executes saved disk files, NOT staged proposals.\n'+await bridge.command(command,args));});
  return mcp;
 }
 const server=http.createServer(async(req,res)=>{
  const auth=Buffer.from(req.headers.authorization||''); const expected=Buffer.from(`Bearer ${token}`);
  if(auth.length!==expected.length || !timingSafeEqual(auth,expected)){res.writeHead(401).end();return;}
  if(req.url!='/mcp'){res.writeHead(404).end();return;}
  if(req.method!=='POST'){res.writeHead(405).end();return;}
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true}); transports.add(transport);
  const mcp=build();
  try {
   await mcp.connect(transport);
   const dispatch=transport.onmessage!;
   const indices=new Map<string|number,{tool:string;used:number;generation:number}>();
   const send=transport.send.bind(transport);
   transport.send=(message,options)=>{
    if(isJSONRPCResultResponse(message)){
     const entry=indices.get(message.id);indices.delete(message.id);
     if(entry && message.result.isError===true){
      const parts=message.result.content as {type:string;text?:string}[]|undefined;
      if(!parts?.some(p=>p.text?.includes(' exploration calls used'))){
       if(entry.generation===generation)report(entry.tool,'','invalid arguments');
       message={...message,result:failed(new Error('Invalid exploration tool arguments.'),entry.used)};
      }
     }
    }
    return send(message,options);
   };
   transport.onmessage=(message,extra)=>{
    if(!isJSONRPCRequest(message)||message.method!=='tools/call')return dispatch(message,extra);
    const tool=message.params?.name;
    if(typeof tool!=='string')return dispatch(message,extra);
    bridge.onToolRequest?.(tool);
    if(calls>=limit&&tool!=='propose_write'){
     if(explorationTools.has(tool)||['propose_edit','report_plan','run_command'].includes(tool))report(tool,'','exhausted');
     void transport.send({jsonrpc:'2.0',id:message.id,result:exhausted()}).catch(()=>{});
     return;
    }
    // Count at the validated JSON-RPC boundary, before MCP validates individual args.
    if(explorationTools.has(tool)){
     const used=++calls;
     indices.set(message.id,{tool,used,generation});
     attempt.run({used,generation},()=>dispatch(message,extra));
    }else attempt.run({used:calls,generation},()=>dispatch(message,extra));
   };
   res.on('close',()=>{transports.delete(transport);void transport.close();void mcp.close();});await transport.handleRequest(req,res);}
  catch {if(!res.headersSent)res.writeHead(500).end('MCP request failed');}
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address=server.address();if(!address||typeof address==='string')throw new Error('MCP startup failed');
 return {url:`http://127.0.0.1:${address.port}/mcp`,token,resetExploration,close:async()=>{for(const t of transports)await t.close();await new Promise<void>(r=>server.close(()=>r()));}};
}
