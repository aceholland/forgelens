import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startMcp} from '../src/mcp';
import {selectContext} from '../src/context';
import {SequentialDraft} from '../src/sequentialDraft';

test('the native tool preserves an earlier file across a bad anchor and validates the assembled plan', async t => {
  const root = await mkdtemp(path.join(tmpdir(),'forge-sequential-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const plan = ['widget.py','test_widget.py'].map(path => ({path,reason:'Update the widget'}));
  for (const {path:file} of plan) await writeFile(path.join(root,file),'widget = 0');
  const state = new SequentialDraft();
  const compact = selectContext(plan.map(({path})=>({path,content:'widget = 0'})),'Update widget and tests',12000);
  const overlays = new Map<string,string>();
  const plans:unknown[] = [], validations:unknown[] = [];
  const bridge = await startMcp({root,budget:12000,compactContext:compact,draftFromContext:true,sequentialDraft:state,
    autoValidateReviewedTests:true,active:()=>true,pending:p=>overlays.get(p),onPlan:p=>plans.push(p),
    propose:async(p,content)=>{overlays.set(p,content);return 'accepted';},
    validate:async tests=>{validations.push([tests,[...overlays.keys()]]);return 'Candidate pytest exited 0; passed';},
    command:async()=>'',context:()=>{}});
  t.after(()=>bridge.close());
  const client = new Client({name:'sequential-test',version:'1'});
  t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:'Bearer '+bridge.token}}}));
  const propose = (file:string, oldText:string, first=false) => client.callTool({name:'propose_changes',arguments:{
    ...(first?{plan}:{}),files:[{path:file,reason:'Update widget',edits:[{oldText,newText:'1'}]}]}});
  assert.ok(!(await propose('widget.py','0',true)).isError);
  assert.match(state.incomplete()!,/test_widget.py/);
  assert.ok((await propose('test_widget.py','missing')).isError);
  assert.deepEqual([...overlays],[['widget.py','widget = 1']]);
  assert.ok(!(await propose('test_widget.py','0')).isError);
  assert.equal(state.incomplete(),undefined);
  assert.deepEqual(plans,[plan]);
  assert.deepEqual(validations,[[['test_widget.py'],['widget.py','test_widget.py']]]);
});

test('a rejected or partially rejected file closes its plan without a retry',()=>{
  for (const overlay of [undefined,'only the accepted hunk']) {
    const state = new SequentialDraft();
    const plan = [{path:'a',reason:'model plan'}];
    state.begin('a',plan);
    state.reviewed('a','whole candidate',overlay);
    assert.match(state.incomplete()!,/review/i);
    assert.throws(()=>state.begin('a',plan),/review/i);
  }
});

test('repeated requests without progress stop with an incomplete plan',()=>{
  const state = new SequentialDraft();
  const plan = [{path:'a',reason:'model plan'}];
  for(let i=0;i<3;i++) {state.begin('a',plan);state.recordFailure();}
  assert.match(state.incomplete()!,/progress/i);
  assert.throws(()=>state.begin('a',plan),/progress/i);
});

test('failed checks allow a reviewed repair of a planned path and reuse the original validation',()=>{
  const state = new SequentialDraft();
  state.begin('a',[{path:'a',reason:'model plan'}]);
  state.reviewed('a','candidate','candidate');
  state.requestTests(['test_a.py']);
  assert.match(state.incomplete()!,/validation is still pending/);
  state.validation('Candidate pytest exited 1; failed');
  assert.throws(()=>state.begin('unplanned'),/planned file/);
  state.begin('a');
  state.reviewed('a','repaired','repaired');
  assert.deepEqual(state.finalTests,['test_a.py']);
  state.validation('Candidate pytest exited 0; passed');
  assert.equal(state.incomplete(),undefined);
});

test('a declined validation closes the draft and cannot trigger another test request',()=>{
  const state=new SequentialDraft();
  state.begin('a',[{path:'a',reason:'Review this file'}]);
  state.reviewed('a','edited','edited');
  state.requestTests([]);
  state.validation('User declined candidate tests.');
  assert.match(state.incomplete()!,/will not be requested again/);
  assert.equal(state.finalTests,undefined);
  assert.throws(()=>state.begin('a'),/will not be requested again/);
});
