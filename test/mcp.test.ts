import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startMcp} from '../src/mcp';

test('read-only scout bridge exposes only saved-source tools and rejects every mutation callback',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-scout-readonly-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'code.py'),'saved target implementation\n');await writeFile(path.join(root,'.env'),'hidden secret');
 let mutations=0;
 const bridge=await startMcp({root,budget:4000,readOnly:true,active:()=>true,pending:()=> 'private staged overlay',propose:async()=>{mutations++;return 'bad';},command:async()=>{mutations++;return 'bad';},onPlan:()=>{mutations++;},context:()=>{}} as any);t.after(()=>bridge.close());
 const client=new Client({name:'scout-readonly',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['find_relevant_files','read_file','search_workspace','select_context']);
 const read=JSON.stringify(await client.callTool({name:'read_file',arguments:{path:'code.py'}}));assert.match(read,/saved target/);assert.doesNotMatch(read,/private staged overlay|STAGED/);
 for(const name of ['propose_write','propose_edit','run_command','report_plan'])assert.equal((await client.callTool({name,arguments:{path:'code.py',edits:[{oldText:'saved',newText:'changed'}],command:'pytest',args:[],files:[{path:'code.py',reason:'plan'}]}})).isError,true,name);
 assert.equal(mutations,0);assert.equal(await readFile(path.join(root,'code.py'),'utf8'),'saved target implementation\n');
 assert.equal((await client.callTool({name:'read_file',arguments:{path:'.env'}})).isError,true);
 const search=JSON.stringify(await client.callTool({name:'search_workspace',arguments:{query:'target'}}));assert.match(search,/saved target/);assert.doesNotMatch(search,/private staged overlay/);
});

test('scout discovery never satisfies the separate parent bridge discovery gate',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-scout-independent-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'a.py'),'target function\n');
 const options={root,budget:4000,requireDiscovery:true,active:()=>true,propose:async()=>'',command:async()=>'',context:()=>{}};
 const scout=await startMcp({...options,readOnly:true} as any),parent=await startMcp(options);t.after(()=>scout.close());t.after(()=>parent.close());
 const connect=async(bridge:typeof scout)=>{const client=new Client({name:'scout-independent',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));return client;};
 const s=await connect(scout),p=await connect(parent);
 assert.ok(!(await s.callTool({name:'find_relevant_files',arguments:{query:'target'}})).isError);
 assert.ok(!(await s.callTool({name:'read_file',arguments:{path:'a.py'}})).isError);
 assert.equal((await p.callTool({name:'read_file',arguments:{path:'a.py'}})).isError,true);
 assert.ok(!(await p.callTool({name:'find_relevant_files',arguments:{query:'target'}})).isError);
 assert.ok(!(await p.callTool({name:'read_file',arguments:{path:'a.py'}})).isError);
});

test('closing a scout endpoint invalidates in-flight reads before any late context callback',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-scout-close-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(let i=0;i<12;i++)await writeFile(path.join(root,`file${i}.py`),'target evidence\n');
 let contexts=0,started!:()=>void;const ready=new Promise<void>(r=>started=r);
 const bridge=await startMcp({root,budget:4000,readOnly:true,active:()=>{started();return true;},propose:async()=>'',command:async()=>'',context:()=>{contexts++;}});t.after(()=>bridge.close());
 const client=new Client({name:'scout-close',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 const pending=client.callTool({name:'find_relevant_files',arguments:{query:'target'}}).catch(()=>undefined);
 await ready;const closing=bridge.close();
 const closedBeforeClient=await Promise.race([closing.then(()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),200))]);
 await client.close();await closing;await pending;await new Promise(r=>setTimeout(r,30));
 assert.equal(closedBeforeClient,true,'endpoint cleanup must close an in-flight HTTP request without waiting for its client');
 assert.equal(contexts,0,'closed scout must not publish context while its parent is running');
});

test('agent mode must discover budgeted context before workspace access, including after reset',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-required-discovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'code.py'),'target implementation\nreturn False\n');let staged=0,contexts=0;
 const options={root,budget:24000,task:'Update target implementation',requireDiscovery:true,active:()=>true,propose:async()=>{staged++;return 'staged';},command:async()=>'',context:()=>{contexts++;}};
 const bridge=await startMcp(options);t.after(()=>bridge.close());
 const client=new Client({name:'discovery-test',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 const before=await client.callTool({name:'read_file',arguments:{path:'code.py'}});assert.equal(before.isError,true);assert.match(JSON.stringify(before),/find_relevant_files/);assert.ok(!JSON.stringify(before).includes('return False'));
 assert.equal((await client.callTool({name:'propose_write',arguments:{path:'code.py',edits:[{oldText:'False',newText:'True'}]}})).isError,true);assert.equal(staged,0);
 assert.ok(!(await client.callTool({name:'find_relevant_files',arguments:{query:'target'}})).isError);assert.equal(contexts,1);
 assert.ok(!(await client.callTool({name:'read_file',arguments:{path:'code.py'}})).isError);
 bridge.resetExploration();assert.equal((await client.callTool({name:'read_file',arguments:{path:'code.py'}})).isError,true);
 assert.ok(!(await client.callTool({name:'find_relevant_files',arguments:{query:'target'}})).isError);
 assert.ok(!(await client.callTool({name:'propose_write',arguments:{path:'code.py',edits:[{oldText:'False',newText:'True'}]}})).isError);assert.equal(staged,1);
 assert.equal(await readFile(path.join(root,'code.py'),'utf8'),'target implementation\nreturn False\n');
});

test('authenticated MCP requests enforce a two MiB body limit before dispatch',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-body-limit-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const bridge=await startMcp({root,budget:100,active:()=>true,propose:async()=>'',command:async()=>'',context:()=>{}});t.after(()=>bridge.close());
 const response=await fetch(bridge.url,{method:'POST',headers:{Authorization:`Bearer ${bridge.token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'ping',params:{padding:'x'.repeat(2*1024*1024)}})});
 assert.equal(response.status,413);await response.text();
});

test('MCP rejects excessive raw input elements while retaining normal reads and edits',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-input-elements-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'code.py'),'return False\n');const staged:string[]=[];
 const bridge=await startMcp({root,budget:100,active:()=>true,propose:async(_,text)=>{staged.push(text);return 'staged';},command:async()=>'',context:()=>{}});t.after(()=>bridge.close());
 const client=new Client({name:'limits-test',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 for(const padding of [Array(1024).fill(0),Object.fromEntries(Array.from({length:600},(_,i)=>[`key${i}`,0]))]){
  const result=await client.callTool({name:'read_file',arguments:{path:'code.py',padding}});
  assert.equal(result.isError,true,'large unknown collections must be rejected before schema expansion');
 }
 assert.ok(!(await client.callTool({name:'read_file',arguments:{path:'code.py'}})).isError);
 assert.ok(!(await client.callTool({name:'propose_write',arguments:{path:'code.py',edits:[{oldText:'False',newText:'True'}]}})).isError);
 assert.deepEqual(staged,['return True\n']);assert.equal(await readFile(path.join(root,'code.py'),'utf8'),'return False\n');
});

test('MCP authenticates, exposes tools, respects inactive runs and never writes proposals',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-mcp-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'config.ts'),'const config = 1;');await writeFile(path.join(root,'.env'),'SECRET=hidden');
 let active=true;const staged:unknown[]=[];let context:unknown;
 const bridge=await startMcp({root,budget:8,active:()=>active,propose:async(path,content)=>{staged.push({path,content});return 'staged';},command:async()=> 'approved',context:result=>{context=result;}});
 t.after(()=>bridge.close());
 const unauth=await fetch(bridge.url,{method:'POST'});assert.equal(unauth.status,401);
 const badAuth=await fetch(bridge.url,{method:'POST',headers:{authorization:'Bearer wrong'}});assert.equal(badAuth.status,401);
 const client=new Client({name:'forgelens-test',version:'1.0'});
 t.after(()=>client.close());
 await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 const tools=await client.listTools(); assert.deepEqual(tools.tools.map(x=>x.name).sort(),['find_relevant_files','propose_edit','propose_write','read_file','report_plan','run_command','search_workspace','select_context']);
 const read=await client.callTool({name:'read_file',arguments:{path:'config.ts'}});assert.match(JSON.stringify(read),/const config = 1/);
 const secret=await client.callTool({name:'read_file',arguments:{path:'.env'}});assert.equal(secret.isError,true);assert.ok(!JSON.stringify(secret).includes('hidden'));
 await client.callTool({name:'propose_edit',arguments:{path:'config.ts',edits:[{oldText:'const config = 1;',newText:'replacement'}]}});
 assert.deepEqual(staged,[{path:'config.ts',content:'replacement'}]);assert.equal(await readFile(path.join(root,'config.ts'),'utf8'),'const config = 1;');
 const selected=await client.callTool({name:'select_context',arguments:{query:'config'}});
 assert.ok(context);assert.ok(JSON.stringify(selected).includes('usedChars'));
 assert.equal((context as {usedChars:number}).usedChars,8);
 active=false;
 const stopped=await client.callTool({name:'propose_edit',arguments:{path:'config.ts',edits:[{oldText:'const config = 1;',newText:'after cancel'}]}});assert.equal(stopped.isError,true);assert.equal(staged.length,1);
});

test('MCP exact edit resolves in memory, rejects ambiguity and remains unapplied',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-patch-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'code.py'),'before\nreturn False\nafter\n');
 const staged:string[]=[];const bridge=await startMcp({root,budget:100,active:()=>true,propose:async(_,c)=>{staged.push(c);return 'staged';},command:async()=>'',context:()=>{}});t.after(()=>bridge.close());
 const client=new Client({name:'test',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 const range=await client.callTool({name:'read_file',arguments:{path:'code.py',startLine:2,lineCount:1}});assert.match(JSON.stringify(range),/return False/);assert.ok(!JSON.stringify(range).includes('before'));assert.ok(!JSON.stringify(range).includes('after'));
 const pastEnd=await client.callTool({name:'read_file',arguments:{path:'code.py',startLine:99}});assert.equal(pastEnd.isError,true);
 const good=await client.callTool({name:'propose_edit',arguments:{path:'code.py',edits:[{oldText:'return False',newText:'return True'}]}});assert.ok(!good.isError);assert.deepEqual(staged,['before\nreturn True\nafter\n']);
 const bad=await client.callTool({name:'propose_edit',arguments:{path:'code.py',edits:[{oldText:'missing',newText:'x'}]}});assert.equal(bad.isError,true);assert.equal(staged.length,1);assert.equal(await readFile(path.join(root,'code.py'),'utf8'),'before\nreturn False\nafter\n');
});

test('agent edit tools require exact replacements and cannot stage a fragment as a whole file',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-fragment-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const original='import os\r\n\r\ndef existing():\r\n    return False\r\n';await writeFile(path.join(root,'code.py'),original);
 const staged:string[]=[];const bridge=await startMcp({root,budget:100,active:()=>true,propose:async(_,text)=>{staged.push(text);return 'staged';},command:async()=>'',context:()=>{}});t.after(()=>bridge.close());
 const client=new Client({name:'test',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 for(const name of ['propose_write','propose_edit']){
  const result=await client.callTool({name,arguments:{path:'code.py',content:'def new_function():\n    pass\n'}});
  assert.equal(result.isError,true);assert.equal(staged.length,0);
 }
 const valid=await client.callTool({name:'propose_write',arguments:{path:'code.py',edits:[{oldText:'def existing():\n    return False',newText:'def existing():\n    return True'}]}});
 assert.ok(!valid.isError);assert.deepEqual(staged,[original.replace('return False','return True')]);
 assert.equal(await readFile(path.join(root,'code.py'),'utf8'),original);
});

test('discovery retains original task requirements when the model shortens its query',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-task-query-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const dir of ['src','tests','docs'])await mkdir(path.join(root,dir));
 for(const file of ['src/console.py','tests/test_console.py','docs/console.rst','configuration.yaml'])await writeFile(path.join(root,file),'configuration JSON console command\n'.repeat(100));
 const bridge=await startMcp({root,budget:4000,task:'Add a console command covered by a test and documented alongside the other commands.',active:()=>true,propose:async()=>'',command:async()=>'',context:()=>{}});t.after(()=>bridge.close());
 const client=new Client({name:'test',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 const result=await client.callTool({name:'find_relevant_files',arguments:{query:'JSON configuration'}});
 assert.ok(!result.isError);const text=(result.content as {text:string}[])[0]!.text;const selected=JSON.parse(text.slice(0,text.lastIndexOf('\nexploration calls used:')));
 assert.deepEqual(selected.items.map((item:{path:string})=>item.path),['src/console.py','tests/test_console.py','docs/console.rst']);
 assert.ok(selected.usedChars<=4000);
});

test('MCP search bounds per-file hits, supports scope, and excludes secrets',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-search-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'a.py'),'needle\n'.repeat(120));await writeFile(path.join(root,'b.py'),'needle second');await writeFile(path.join(root,'.env'),'needle secretvalue');
 const bridge=await startMcp({root,budget:100,active:()=>true,propose:async()=>'',command:async()=>'',context:()=>{}});t.after(()=>bridge.close());
 const client=new Client({name:'test',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 const search=JSON.stringify(await client.callTool({name:'search_workspace',arguments:{query:'needle',contextLines:0}}));
 assert.match(search,/b.py:1/);assert.ok(!search.includes('a.py:9'));assert.ok(!search.includes('secretvalue'));assert.match(search,/Results limited/);
 const scoped=JSON.stringify(await client.callTool({name:'search_workspace',arguments:{query:'needle',pathPrefix:'b.py'}}));assert.match(scoped,/b.py/);assert.ok(!scoped.includes('a.py'));
 const literal=JSON.stringify(await client.callTool({name:'search_workspace',arguments:{query:'needle.*'}}));assert.match(literal,/No literal matches/);
});

test('staged overlay is visible and revisable without disk writes',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-overlay-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'code.py'),'original\n');let staged:string|undefined='draft\n';
 const bridge=await startMcp({root,budget:100,active:()=>true,pending:()=>staged,propose:async(_,text)=>{staged=text;return 'staged';},command:async()=>'',context:()=>{}});t.after(()=>bridge.close());
 const client=new Client({name:'test',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 const read=JSON.stringify(await client.callTool({name:'read_file',arguments:{path:'code.py'}}));assert.match(read,/STAGED/);assert.match(read,/draft/);
 await client.callTool({name:'propose_edit',arguments:{path:'code.py',edits:[{oldText:'draft',newText:'revised'}]}});assert.equal(staged,'revised\n');assert.equal(await readFile(path.join(root,'code.py'),'utf8'),'original\n');
 const search=JSON.stringify(await client.callTool({name:'search_workspace',arguments:{query:'revised'}}));assert.match(search,/revised/);
 const selected=JSON.stringify(await client.callTool({name:'select_context',arguments:{query:'revised'}}));assert.match(selected,/revised/);
 const secret=await client.callTool({name:'read_file',arguments:{path:'.env'}});assert.equal(secret.isError,true);
});

test('MCP search includes bounded line-referenced neighboring context without duplicate overlaps',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-context-search-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'code.py'),'outside\nbefore\nneedle one\nneedle two\nafter\noutside end\n');
 const bridge=await startMcp({root,budget:100,active:()=>true,propose:async()=>'',command:async()=>'',context:()=>{}});t.after(()=>bridge.close());
 const client=new Client({name:'test',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 const result=await client.callTool({name:'search_workspace',arguments:{query:'needle',contextLines:1}});
 const search=JSON.stringify(result);
 assert.match(search,/code.py:2: before/);assert.match(search,/code.py:5: after/);
 assert.equal(search.split('code.py:3:').length-1,1);assert.ok(!search.includes('outside'));
 const none=JSON.stringify(await client.callTool({name:'search_workspace',arguments:{query:'needle',contextLines:0}}));
 assert.ok(!none.includes('before'));assert.ok(!none.includes('after'));
 const invalid=await client.callTool({name:'search_workspace',arguments:{query:'needle',contextLines:10}});assert.equal(invalid.isError,true);
 const defaults=JSON.stringify(await client.callTool({name:'search_workspace',arguments:{query:'needle'}}));assert.match(defaults,/code.py:1: outside/);
 await writeFile(path.join(root,'large.py'),Array.from({length:80},(_,i)=>`${i%7===3?'needle':'neighbor'} ${'x'.repeat(300)}`).join('\n'));
 const bounded=await client.callTool({name:'search_workspace',arguments:{query:'needle',pathPrefix:'large.py',contextLines:3}});
 const payload=(bounded.content as {type:string;text:string}[])[0]!.text;assert.ok(payload.length<=12100);assert.match(payload,/Results limited/);
});

test('MCP read_file bounds wide requests and gives an exact continuation line',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-read-budget-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const lines=Array.from({length:200},(_,i)=>`row-${i+1} ${'x'.repeat(200)}`);
 lines[99]='oversized '+ 'z'.repeat(5000);
 await writeFile(path.join(root,'code.py'),lines.join('\n'));
 const bridge=await startMcp({root,budget:3000,active:()=>true,propose:async()=>'',command:async()=>'',context:()=>{}});t.after(()=>bridge.close());
 const client=new Client({name:'test',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 const read=async(startLine:number,lineCount?:number)=>{
  const result=await client.callTool({name:'read_file',arguments:{path:'code.py',startLine,lineCount}});
  assert.ok(!result.isError);
  return (result.content as {text:string}[])[0]!.text;
 };
 const wide=await read(10,150);
 assert.ok(wide.length<4200,'source plus metadata should stay under 4,200 characters');
 const bounds=/lines 10-(\d+) of 200/.exec(wide);assert.ok(bounds);
 const end=Number(bounds[1]);
 assert.ok(wide.includes(lines[end-1]!));
 assert.ok(!wide.includes(lines[end]!));
 assert.match(wide,new RegExp(`startLine=${end+1}\\b`));
 const next=await read(end+1,1);
 assert.ok(next.includes(lines[end]!));
 const oversized=await read(100,2);
 assert.ok(oversized.length<4200);
 assert.match(oversized,/line 100 clipped/i);
 assert.match(oversized,/startLine=101\b/);
 assert.ok((await read(101,1)).includes(lines[100]!));
 await writeFile(path.join(root,'short.py'),Array.from({length:200},()=> 'x').join('\n'));
 const defaults=await client.callTool({name:'read_file',arguments:{path:'short.py'}});
 assert.match((defaults.content as {text:string}[])[0]!.text,/lines 1-80 of 200/);
});

test('MCP compact exploration shares a budget, avoids repeated payloads, and still permits edits',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-compact-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=Array.from({length:150},(_,i)=>`row-${i+1} ${'x'.repeat(180)}`).join('\n');
 await writeFile(path.join(root,'code.py'),source);
 let proposed:string|undefined, refuse=true;
 const bridge=await startMcp({root,budget:4000,active:()=>true,pending:()=>proposed,propose:async(_,c)=>{
  if(refuse)return 'not staged';
  proposed=c;return 'staged';
 },command:async()=>'',context:()=>{}});
 t.after(()=>bridge.close());
 const client=new Client({name:'test',version:'1'});
 t.after(()=>client.close());
 await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 const mcp=async(name:string,args:Record<string,unknown>)=>{
  const result=await client.callTool({name,arguments:args});
  assert.ok(!result.isError,JSON.stringify(result));
  return (result.content as {text:string}[])[0]!.text;
 };
 const args={path:'code.py',startLine:1,lineCount:90};
 const first=await mcp('read_file',args);
 assert.ok(first.length>3000);
 const repeat=await mcp('read_file',args);
 assert.ok(repeat.length<280);
 assert.match(repeat,/already shown/i);
 assert.match(repeat,/startLine=22/);
 const explicit=await mcp('read_file',{...args,refresh:true});
 assert.ok(explicit.length>1000);
 const search=await mcp('search_workspace',{query:'row-'});
 assert.ok(search.length<1150);
 assert.match(search,/code\.py:1/);

 const next=await mcp('read_file',{path:'code.py',startLine:22,lineCount:25});
 assert.match(next,/row-22/);
 assert.ok(next.length<1150);
 assert.match(next,/startLine=26/);
 const edit={path:'code.py',edits:[{oldText:'row-1 ',newText:'edited-1 '}]};
 assert.match(await mcp('propose_edit',edit),/^not staged\n/);
 refuse=false;
 assert.match(await mcp('propose_edit',edit),/^staged\n/);
 const edited=await mcp('read_file',args);
 assert.match(edited,/edited-1/);
 assert.ok(edited.length>3000);
 assert.equal(await readFile(path.join(root,'code.py'),'utf8'),source);
});

test('MCP repeats are isolated by actual result and refresh does not relax the cap',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-compact-refresh-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=path.join(root,'code.py');
 await writeFile(target,'nothing matching');
 const bridge=await startMcp({root,budget:100,active:()=>true,propose:async()=>'',command:async()=>'',context:()=>{}});
 t.after(()=>bridge.close());
 const client=new Client({name:'test',version:'1'});
 t.after(()=>client.close());
 await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 const search=async(refresh=false)=>{
  const result=await client.callTool({name:'search_workspace',arguments:{query:'added',refresh}});
  return (result.content as {text:string}[])[0]!.text;
 };
 assert.match(await search(),/No literal matches/);
 assert.match(await search(),/already shown/i);

 await writeFile(target,'added content');
 assert.match(await search(),/added content/);
 const read=async()=>{
  const result=await client.callTool({name:'read_file',arguments:{path:'code.py',startLine:1,lineCount:1}});
  return (result.content as {text:string}[])[0]!.text;
 };
 assert.match(await read(),/added content/);
 assert.match(await read(),/already shown/i);
 await writeFile(target,'fresh content');
 assert.match(await read(),/fresh content/);
});

test('discovery accounting includes repeats and malformed input without blocking repair reads',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-phase-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const original='alpha\nbeta';await writeFile(path.join(root,'code.py'),original);
 let staged:string|undefined;const plans:unknown[]=[],found:unknown[]=[],calls:string[]=[];
 const bridge=await startMcp({root,budget:4000,active:()=>true,pending:()=>staged,propose:async(_,c)=>{staged=c;return 'staged';},command:async()=>{throw Error('should not run');},context:r=>found.push(r),onPlan:p=>plans.push(p),onToolCall:s=>calls.push(s)});
 t.after(()=>bridge.close());const client=new Client({name:'test',version:'1'});t.after(()=>client.close());
 await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 const call=(name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args});
 const body=async(name:string,args:Record<string,unknown>)=>{
  const r=await call(name,args);assert.ok(!r.isError,JSON.stringify(r));
  return (r.content as {text:string}[])[0]!.text;
 };
 assert.match(await body('find_relevant_files',{query:'alpha'}),/exploration calls used: 1/);
 assert.equal(found.length,1);
 assert.deepEqual(calls,['find_relevant_files']);
 assert.match(await body('read_file',{path:'code.py'}),/exploration calls used: 2/);
 assert.match(await body('read_file',{path:'code.py'}),/You already did this; proceed to write.*exploration calls used: 3/s);
 const invalid=await call('read_file',{path:'code.py',lineCount:0});
 assert.equal(invalid.isError,true);
 assert.match((invalid.content as {text:string}[])[0]!.text,/exploration calls used: 4/);
 assert.equal((await call('read_file',{path:'missing.py'})).isError,true);
 const plan=[{path:'code.py',reason:'Defines the feature'}];
 assert.match(await body('report_plan',{files:plan}),/recorded/i);
 assert.deepEqual(plans,[plan]);
 assert.match(await body('select_context',{query:'alpha'}),/exploration calls used: 6/);
 const write={path:'code.py',edits:[{oldText:'alpha',newText:'changed'}]};
 assert.match(await body('read_file',{path:'code.py',refresh:true}),/alpha.*exploration calls used: 7/s);
 assert.match(await body('report_plan',{files:plan}),/recorded/);
 assert.match(await body('propose_edit',write),/staged/);
 assert.match(await body('propose_write',{path:'code.py',edits:[{oldText:'changed',newText:'changed again'}]}),/staged/);
 bridge.resetExploration();
 assert.match(await body('read_file',{path:'code.py'}),/changed again.*exploration calls used: 1/s);
 assert.equal(staged,'changed again\nbeta');
 assert.equal(await readFile(path.join(root,'code.py'),'utf8'),original);
});

test('reset rejects a previous-generation operation and leaves new discovery at call one',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-fallback-reset-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'source.py'),'target keyword');
 let resets=0, reported=0;
 const bridge=await startMcp({root,budget:4000,active:()=>true,propose:async()=>'',command:async()=>'',context:()=>{reported++},onToolCall:name=>{
  if(name==='find_relevant_files' && resets++===0)bridge.resetExploration();
 }});
 t.after(()=>bridge.close()); const client=new Client({name:'test',version:'1'});t.after(()=>client.close());
 await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 const call=()=>client.callTool({name:'find_relevant_files',arguments:{query:'target'}});
 assert.equal((await call()).isError,true);
 assert.equal(reported,0);
 const current=await call();assert.ok(!current.isError);
 assert.match((current.content as {text:string}[])[0]!.text,/exploration calls used: 1/);
 assert.equal(reported,1);
});

test('targeted recovery reads remain available after six exploration attempts',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-recovery-read-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'code.py'),'def existing():\n    return False\n');
 const bridge=await startMcp({root,budget:24000,active:()=>true,propose:async()=>'',command:async()=>'',context:()=>{}});t.after(()=>bridge.close());
 const client=new Client({name:'test',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 for(let i=0;i<6;i++)await client.callTool({name:'search_workspace',arguments:{query:`missing-${i}`}});
 const recovered=await client.callTool({name:'read_file',arguments:{path:'code.py'}});
 assert.ok(!recovered.isError,JSON.stringify(recovered));assert.match(JSON.stringify(recovered),/def existing/);
 assert.equal(await readFile(path.join(root,'code.py'),'utf8'),'def existing():\n    return False\n');
});

test('larger configured retrieval budgets retain useful focused read windows',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-large-read-budget-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'code.py'),Array.from({length:200},(_,i)=>`row-${i+1} ${'x'.repeat(120)}`).join('\n'));
 const bridge=await startMcp({root,budget:24000,active:()=>true,propose:async()=>'',command:async()=>'',context:()=>{}});t.after(()=>bridge.close());
 const client=new Client({name:'test',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 for(const startLine of [1,41,81]){
  const result=await client.callTool({name:'read_file',arguments:{path:'code.py',startLine,lineCount:40}});
  assert.ok(!result.isError);const text=(result.content as {text:string}[])[0]!.text;
  assert.ok(text.length>3000,'configured 24K allowance must not shrink a third focused read to 900 characters');assert.ok(text.length<4200);
 }
});
