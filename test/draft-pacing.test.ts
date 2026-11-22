import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startMcp} from '../src/mcp';
import {selectContext} from '../src/context';
import {waitForDraftInterval} from '../src/draftPacing';

test('pacing counts elapsed review time and skips an already satisfied window',async()=>{
  let time=4000;
  const notices:number[]=[];
  const clock={now:()=>time,wait:async(ms:number)=>{time+=ms;}};
  const ready=()=>true, signal=new AbortController().signal;
  assert.ok(await waitForDraftInterval(0,10000,ready,signal,ms=>notices.push(ms),clock));
  assert.equal(time,10000);assert.deepEqual(notices,[6000]);
  assert.ok(await waitForDraftInterval(0,10000,ready,signal,ms=>notices.push(ms),clock));
  assert.deepEqual(notices,[6000]);
});

test('an inactive run or an abort stops the pacing wait immediately',async()=>{
  for(const mode of ['abort','inactive']){
    let active=true, ticks=0, time=10;
    const control=new AbortController();
    const clock={now:()=>time,wait:async(ms:number)=>{time+=ms;ticks++;if(mode==='abort')control.abort();else active=false;}};
    assert.equal(await waitForDraftInterval(0,90000,()=>active,control.signal,()=>{},clock),false);
    assert.equal(ticks,1);assert.ok(time<1000);
  }
});

test('native Draft paces approved and invalid tool receipts, with one immediate review and no replay',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'forge-draft-interval-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file='widget.txt',source='sample 0';
  await writeFile(path.join(root,file),source);
  const context=selectContext([{path:file,content:source}],'sample',4000);
  const started:number[]=[],notices:number[]=[];
  let reviews=0,tests=0,active=true;
  const reviewsAtWait:number[]=[];
  const server=await startMcp({root,budget:4000,draftFromContext:true,draftModelIntervalSeconds:1,compactContext:context,active:()=>active,
    onToolRequest:()=>started.push(performance.now()),onDraftWait:ms=>{notices.push(ms);reviewsAtWait.push(reviews);if(notices.length===3)active=false;},
    propose:async()=>{reviews++;return 'Reviewer rejected this hunk';},
    validate:async()=>{tests++;throw Error('Candidate validation declined');},command:async()=>'',context:()=>{}});
  t.after(()=>server.close());
  const client=new Client({name:'interval-test',version:'1'});t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:{Authorization:'Bearer '+server.token}}}));
  const propose=(args:Record<string,unknown>)=>client.callTool({name:'propose_changes',arguments:args});
  const reviewed=await propose({files:[{path:file,reason:'fixture',edits:[{oldText:'0',newText:'1'}]}],tests:[]});
  assert.ok(performance.now()-started[0]!>=980);assert.deepEqual(reviewsAtWait,[1]);
  assert.match(JSON.stringify(reviewed.content),/Reviewer rejected this hunk/);
  assert.match(JSON.stringify(reviewed.content),/Candidate validation declined/);
  const bad=await propose({files:'wrong type'});
  assert.ok(bad.isError);assert.ok(performance.now()-started[1]!>=980);
  assert.equal(reviews,1);assert.equal(tests,1);assert.equal(notices.length,2);
  await assert.rejects(propose({files:[{path:file,reason:'another fixture',edits:[{oldText:'0',newText:'2'}]}]}));
  assert.equal(reviews,2);assert.equal(tests,1);
});
