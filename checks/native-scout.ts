/**
 * Run against an installed TrueForge 0.185.1 CLI with
 * TRUEFORGE_CLI=.../dist/cli.js node --import tsx checks/native-scout.ts
 * Only the model is scripted. The server, SDK, agents, approvals and MCP transport are real.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import http from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {TrueForge} from '@truefoundry/trueforge-sdk';
import {ForgeRunner, registerMcp, type ForgeEvent} from '../src/client';
import {instructions} from '../src/instructions';
import {startMcp} from '../src/mcp';

async function listen(server:http.Server):Promise<number> {
  await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const address=server.address();
  assert.ok(address && typeof address==='object');
  return address.port;
}

async function main() {
  const cli=process.env.TRUEFORGE_CLI;
  assert.ok(cli && path.isAbsolute(cli),'Set TRUEFORGE_CLI to an installed TrueForge dist/cli.js');
  const scratch=await mkdtemp(path.join(tmpdir(),'forgelens-native-scout-'));
  const workspace=path.join(scratch,'workspace');
  for(const name of ['workspace','state','temp','profile','local-app-data','app-data'])await mkdir(path.join(scratch,name));
  const source='def target():\n    return False\n';
  await writeFile(path.join(workspace,'sample.py'),source);
  const task='Find the target implementation and propose the requested return value.';
  const parentName='fixture-editor';
  const scoutName='fixture-scout';
  const calls={parent:0,scout:0};
  const summary='Previous context summarized by the loopback provider.';
  const history=' archive'.repeat(64_000);
  const compaction={summaries:0,resumed:false};
  const query={query:task};
  const edit={path:'sample.py',edits:[{oldText:'return False',newText:'return True'}]};
  const tool=(mcp_server:string,tool_name:string,input:unknown)=>({name:'call_tool',args:{mcp_server,tool_name,input}});
  const steps={
    parent:[
      {name:'create_sub_agent',args:{name:'context-scout',input:'Read only the target source using '+scoutName}},
      tool(parentName,'find_relevant_files',query),
      tool(parentName,'report_plan',{files:[{path:'sample.py',reason:'Target implementation.'}]}),
      tool(parentName,'propose_write',edit)
    ],
    scout:[tool(parentName,'propose_write',edit),tool(scoutName,'find_relevant_files',query)]
  };
  const provider=http.createServer(async(req,res)=>{
    if(req.url?.endsWith('/models')){
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({object:'list',data:['scripted','long-history'].map(id=>({id,object:'model'}))}));
      return;
    }
    if(!req.url?.endsWith('/chat/completions')){res.writeHead(404).end();return;}
    const chunks:Buffer[]=[];
    for await(const part of req)chunks.push(part as Buffer);
    const input=JSON.parse(Buffer.concat(chunks).toString());
    if(input.model==='long-history'){
      const messages=JSON.stringify(input.messages);
      const summarizing=messages.includes('summary of the conversation') && messages.includes(history);
      if(summarizing)compaction.summaries++;
      const resumed=messages.includes(summary) && !messages.includes(history);
      compaction.resumed ||= resumed;
      if(!resumed&&!summarizing){res.writeHead(400).end('Expected a summary request or compacted context');return;}
      const delta={role:'assistant',content:summarizing?summary:'Continued using the summary.'};
      res.writeHead(200,{'content-type':'text/event-stream'});
      const packet=(choices:unknown[],usage?:object)=>'data: '+JSON.stringify({
        id:'history',object:'chat.completion.chunk',created:1,model:input.model,choices,usage,
      })+'\n\n';
      res.write(packet([{index:0,delta,finish_reason:null}]));
      res.write(packet([{index:0,delta:{},finish_reason:'stop'}]));
      const promptTokens=resumed?100:64_000;
      res.write(packet([],{prompt_tokens:promptTokens,completion_tokens:12,total_tokens:promptTokens+12}));
      res.end('data: [DONE]\n\n');return;
    }
    const scout=input.messages.some((m:{role:string;content:unknown})=>
      m.role==='system' && JSON.stringify(m.content).includes('operating as a sub-agent'));
    const phase=scout?'scout':'parent';
    const index=calls[phase]++;
    const step=steps[phase][index];
    let delta:object={role:'assistant',content:scout?'Scout found sample.py.':'Parent reviewed the proposal.'};
    if(step){
      const actual=input.tools.find((t:{function:{name:string}})=>t.function.name.endsWith(step.name));
      if(!actual){res.writeHead(400).end(JSON.stringify({error:{message:'Fixture tool unavailable: '+step.name}}));return;}
      delta={role:'assistant',tool_calls:[{index:0,id:phase+index,type:'function',function:{name:actual.function.name,arguments:JSON.stringify(step.args)}}]};
    }
    const packet=(delta:object,finish_reason:string|null)=>({id:'chatcmpl-'+phase+index,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'scripted',choices:[{index:0,delta,finish_reason}]});
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
    for(const event of [packet(delta,null),packet({},step?'tool_calls':'stop')])res.write('data: '+JSON.stringify(event)+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  const providerPort=await listen(provider);
  const reservation=http.createServer();
  const port=await listen(reservation);
  await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const url='http://127.0.0.1:'+port;
  const env:NodeJS.ProcessEnv={};
  for(const key of ['SystemRoot','WINDIR','COMSPEC','PATH','PATHEXT'])if(process.env[key])env[key]=process.env[key];
  Object.assign(env,{HOST:'127.0.0.1',PORT:String(port),STANDALONE:'true',SQLITE_PATH:path.join(scratch,'state','db.sqlite'),
    LOCALAPPDATA:path.join(scratch,'local-app-data'),APPDATA:path.join(scratch,'app-data'),USERPROFILE:path.join(scratch,'profile'),HOME:path.join(scratch,'profile'),
    TEMP:path.join(scratch,'temp'),TMP:path.join(scratch,'temp'),TMPDIR:path.join(scratch,'temp'),NODE_ENV:'test',SENTRY_ENABLED:'false',
    ACCESS_LOGS:'false',LOG_LEVEL:'warn',NETWORK_POLICY_ENABLED:'true',OUTBOUND_URL_ALLOWED_HOSTS:'["127.0.0.1"]',MODEL_HTTP_MAX_RETRIES:'0',OUTBOUND_HTTP_MAX_RETRIES:'0'});
  const log=createWriteStream(path.join(scratch,'server.log'));
  const processHandle=spawn(process.execPath,[cli,'--port',String(port)],{cwd:scratch,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  processHandle.stdout.pipe(log);processHandle.stderr.pipe(log);
  let scoutBridge:Awaited<ReturnType<typeof startMcp>>|undefined;
  let parentBridge:Awaited<ReturnType<typeof startMcp>>|undefined;
  const events:ForgeEvent[]=[],scoutEvents:ForgeEvent[]=[];
  const approvals:string[]=[],parentCalls:string[]=[],scoutCalls:string[]=[];
  let proposals=0;
  try {
    for(let attempt=0;;attempt++){
      assert.equal(processHandle.exitCode,null,'isolated TrueForge exited before startup');
      try {if((await fetch(url+'/health')).status<500)break;} catch {}
      assert.ok(attempt<360,'isolated TrueForge startup timed out');await delay(250);
    }
    const sdk=new TrueForge({baseUrl:url,maxRetries:0,timeoutInSeconds:30});
    await sdk.settings.modelProviders.create({manifest:{type:'custom',name:'local-fixture',baseUrl:'http://127.0.0.1:'+providerPort+'/v1',
      auth:{apiKey:'synthetic-local-fixture'},models:[
        {name:'scripted',modelId:'scripted',properties:{contextLength:32000,maxOutputTokens:2048}},
        {name:'long-history',modelId:'long-history',properties:{contextLength:128000,maxOutputTokens:2048}},
      ]}});
    const common={root:workspace,budget:4000,task,requireDiscovery:true,active:()=>true,context:()=>{},
      command:async()=>{throw new Error('Unexpected command');},propose:async()=>{proposals++;return 'Reviewed test proposal';}};
    scoutBridge=await startMcp({...common,readOnly:true,onToolRequest:name=>scoutCalls.push(name)});
    parentBridge=await startMcp({...common,onToolRequest:name=>parentCalls.push(name)});
    await registerMcp(url,parentName,parentBridge.url,parentBridge.token);
    await registerMcp(url,scoutName,scoutBridge.url,scoutBridge.token);
    const result=await new ForgeRunner({baseUrl:url,model:'local-fixture/scripted',mcpName:parentName,instructions,
      contextScout:{mode:'native',mcpName:scoutName},onEvent:event=>events.push(event),onScoutEvent:event=>scoutEvents.push(event),
      onApproval:async details=>{approvals.push(details.threadId+'/'+details.name);return true;},runTimeoutMs:120000}).run(task);
    assert.equal(result.status,'done');
    const turns=events.filter(e=>e.type==='turn.created');
    const children=scoutEvents.filter(e=>e.type==='thread.created');
    assert.equal(turns.length,1);assert.equal(children.length,1);
    assert.deepEqual(scoutCalls,['find_relevant_files']);
    assert.deepEqual(parentCalls,['find_relevant_files','report_plan','propose_write']);
    assert.deepEqual(approvals,['main/propose_write']);
    assert.equal(proposals,1);
    assert.ok(events.some(e=>e.type==='client.status' && e.message.includes('editor operation was denied')));
    assert.ok(scoutEvents.some(e=>e.type==='thread.done'));
    assert.equal(await readFile(path.join(workspace,'sample.py'),'utf8'),source);
    const historyEvents:ForgeEvent[]=[];
    const longRun=await new ForgeRunner({baseUrl:url,model:'local-fixture/long-history',mcpName:parentName,
      instructions,preloadTools:true,onEvent:event=>historyEvents.push(event),
      onApproval:async()=>assert.fail('The read-only compaction check requested approval.'),runTimeoutMs:120000,
    }).run('Summarize this synthetic archive and continue.'+history);
    assert.equal(longRun.status,'done');
    const lifecycle=historyEvents.filter(event=>event.type==='thread.context_compaction_started'||event.type==='thread.context_compaction_finished');
    assert.deepEqual(lifecycle.map(event=>[event.type,event.trigger.thresholdTokens]),[
      ['thread.context_compaction_started',60_000],['thread.context_compaction_finished',60_000],
    ]);
    assert.deepEqual(compaction,{summaries:1,resumed:true});
    console.log(JSON.stringify({provider:'deterministic loopback fixture',result,turns:turns.length,nativeChildren:children.length,
      childEditorWrite:'denied',scoutCalls,parentCalls,reviewedProposals:proposals,modelCalls:calls,sourceUnchanged:true,
      conversationCompaction:{sessionId:longRun.sessionId,threshold:60_000,...compaction}},null,2));
  } catch(error) {
    await writeFile(path.join(scratch,'failure.json'),JSON.stringify({events,scoutEvents,calls,approvals,parentCalls,scoutCalls},null,2));
    console.error('Isolated fixture diagnostics:',scratch);
    throw error;
  } finally {
    await scoutBridge?.close();await parentBridge?.close();
    processHandle.kill();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));log.end();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
