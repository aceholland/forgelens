import test from 'node:test';
import assert from 'node:assert/strict';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { CreateSessionRequest } from '@truefoundry/trueforge-sdk/serialization';
import { ForgeRunner, DEFAULT_MODEL_CALL_TIMEOUT_MS, type ForgeOptions } from '../src/client';

async function* stream(events: unknown[]) { for (const event of events) yield event; }
const created = {id:'e1',type:'turn.created',turnId:'t1'};
const answer = {id:'answer',type:'model.message',content:'Finished.'};
const done = {id:'e3',type:'turn.done',state:{status:'done'}};
const failed = {id:'e3',type:'turn.done',state:{status:'error',message:'Model unavailable'}};
function fixture(initial: unknown[] = [created, answer, done]) {
  const calls: {method:string;args:any[]}[] = [];
  let count = 0;
  const sessions = {
    async create(...args:any[]) { calls.push({method:'create',args}); return {data:{id:`s${++count}`}}; },
    async createTurnStream(...args:any[]) { calls.push({method:'stream',args}); return stream(initial) as any; },
    async subscribeToTurn(...args:any[]) { calls.push({method:'subscribe',args}); return stream([done]) as any; },
    async createTurnEvents(...args:any[]) { calls.push({method:'events',args}); return {}; },
    async cancel(...args:any[]) { calls.push({method:'cancel',args}); return {}; },
  };
  const events: unknown[] = [];
  const options: ForgeOptions = {baseUrl:'http://127.0.0.1:8790',model:'test/model',mcpName:'editor',instructions:'Stage edits',
    sdk:{sessions} as unknown as Pick<TrueForge,'sessions'|'settings'>,
    onEvent:e=>events.push(e),onApproval:async()=>true};
  return {sessions,calls,events,options};
}
test('compact mode keeps repository text in user-role context and exposes focused tools',async()=>{
 const f=fixture();f.options.sourceEvidence='Untrusted repository excerpt for this test.';
 assert.equal((await new ForgeRunner(f.options).run('Original task')).status,'done');
 const spec=f.calls.find(c=>c.method==='create')!.args[0].agent.spec;
 assert.equal(spec.instructions,'Stage edits');
 assert.deepEqual(spec.messages,[{type:'user.message',content:f.options.sourceEvidence}]);
 assert.ok(spec.mcpServers[0].enableTools.includes('propose_changes'));
 assert.ok(!spec.mcpServers[0].enableTools.includes('select_context'));
 assert.deepEqual(f.calls.find(c=>c.method==='stream')!.args[1].input,[{type:'user.message',content:'Original task'}]);
});
const approvalEvents = [created,
  {id:'m1',type:'model.message',toolCalls:[{id:'c1',function:{arguments:JSON.stringify({mcp_server:'editor',tool_name:'propose_edit',input:{path:'a.ts',content:'new'}})},toolInfo:{type:'truefoundry-system',name:'call_tool'}}]},
  {id:'a1',type:'tool.approval_required',threadId:'th1',toolCalls:[{id:'c1',sourceEventId:'m1'}]},
  {id:'p1',type:'turn.update',state:{status:'paused'}}];

test('optional separate scout has an SDK-valid read-only spec, bounded notes and unchanged parent turn',async()=>{
 const f=fixture();let n=0,finished=0;const scoutEvents:unknown[]=[];
 Object.assign(f.options,{contextScout:{mcpName:'read-only-scout'},onScoutFinished:async()=>{finished++;},onScoutEvent:(e:unknown)=>scoutEvents.push(e)});
 const createSession=f.sessions.create;
 f.sessions.create=async(...args:any[])=>{if(f.calls.some(c=>c.method==='create'))assert.equal(finished,1,'cleanup must finish before the parent session is created');return createSession(...args);};
 f.sessions.createTurnStream=async(...args:any[])=>{f.calls.push({method:'stream',args});if(n++===0)return stream([created,{...answer,content:'scout report'}, {...done,state:{status:'done',output:{...answer,content:'evidence '.repeat(1000)}}}]) as any;assert.equal(finished,1);return stream([created,answer,done]) as any;};
 const original='Discover the implementation, tests and docs without filenames.';
 assert.equal((await new ForgeRunner(f.options).run(original)).status,'done');
 const specs=f.calls.filter(c=>c.method==='create').map(c=>c.args[0]);assert.equal(specs.length,2);
 for(const request of specs)await CreateSessionRequest.jsonOrThrow(request,{unrecognizedObjectKeys:'fail'});
 const scout=specs[0].agent.spec,parent=specs[1].agent.spec;
 assert.equal(scout.mcpServers[0].name,'read-only-scout');
 assert.deepEqual(scout.mcpServers[0].enableTools,['find_relevant_files','select_context','read_file','search_workspace']);
 assert.deepEqual(scout.mcpServers[0].requireApprovalForTools,[]);
 for(const capability of ['dynamicSubAgents','sandbox','askUserQuestions','webSearch','generativeUi','memory'])assert.equal(scout.config[capability].enabled,false,capability);
 assert.equal(scout.config.iterationLimit,8);
 assert.equal(parent.mcpServers[0].name,'editor');assert.ok(parent.mcpServers[0].requireApprovalForTools.includes('propose_write'));
 assert.equal(parent.messages.length,1);assert.match(parent.messages[0].content,/untrusted/i);assert.ok(parent.messages[0].content.length<4300);
 for(const call of f.calls.filter(c=>c.method==='stream'))assert.deepEqual(call.args[1].input,[{type:'user.message',content:original}]);
 assert.ok(scoutEvents.some((e:any)=>e.content==='scout report'));
 assert.ok(!f.events.some((e:any)=>e.content==='scout report'));
 assert.equal(finished,1);
});

test('scout never forwards approvals and its cleanup finishes before parent creation',async()=>{
 const f=fixture();let n=0,approvals=0,cleaned=false;
 Object.assign(f.options,{contextScout:{mcpName:'scout'},onScoutFinished:async()=>{await new Promise(r=>setImmediate(r));cleaned=true;}});
 f.options.onApproval=async()=>{approvals++;return true;};
 (f.sessions as any).getTurn=async()=>({data:{state:{status:'cancelled'}}});
 f.sessions.createTurnStream=async(...args:any[])=>{f.calls.push({method:'stream',args});if(n++===0)return stream(approvalEvents) as any;assert.ok(cleaned);return stream([created,answer,done]) as any;};
 assert.equal((await new ForgeRunner(f.options).run('task')).status,'done');
 assert.equal(approvals,0);assert.equal(f.calls.filter(c=>c.method==='events').length,0);assert.ok(cleaned);
});

test('scout timeout confirms termination and cleans up before exact parent task resumes',async()=>{
 const f=stalledModelFixture();let cleaned=0;delete f.options.fallbackModel;delete f.options.getStagedProposalCount;
 Object.assign(f.options,{contextScout:{mcpName:'scout'},onScoutFinished:async()=>{cleaned++;}});
 assert.equal((await new ForgeRunner(f.options).run('unchanged task')).status,'done');
 assert.equal(cleaned,1);assert.equal(f.calls.filter(c=>c.method==='create').length,2);
 const methods=f.calls.map(c=>c.method);assert.ok(methods.indexOf('getTurn')<methods.lastIndexOf('create'));
});

test('unconfirmed scout cancellation never overlaps a parent session',async()=>{
 const f=stalledModelFixture();let cleaned=0;
 Object.assign(f.options,{contextScout:{mcpName:'scout'},onScoutFinished:async()=>{cleaned++;}});
 (f.sessions as any).getTurn=async()=>({data:{state:{status:'running'}}});
 assert.equal((await new ForgeRunner(f.options).run('task')).status,'error');
 assert.equal(f.calls.filter(c=>c.method==='create').length,1);assert.equal(cleaned,1);
});

test('scout has a sixty-second total deadline even without a model lifecycle event',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture();let n=0,ready!:()=>void,cleaned=0;const reached=new Promise<void>(r=>ready=r);
 f.options.runTimeoutMs=300000;f.options.modelCallTimeoutMs=200000;
 Object.assign(f.options,{contextScout:{mcpName:'scout'},onScoutFinished:async()=>{cleaned++;},onScoutEvent:(e:any)=>{if(e.type==='turn.created')ready();}});
 (f.sessions as any).getTurn=async(...args:any[])=>{f.calls.push({method:'getTurn',args});return {data:{state:{status:'cancelled'}}};};
 f.sessions.createTurnStream=async(...args:any[])=>{f.calls.push({method:'stream',args});return n++===0?(async function*(){yield created;await new Promise(()=>{});})() as any:stream([created,answer,done]) as any;};
 const task=new ForgeRunner(f.options).run('original task');await reached;t.mock.timers.tick(60001);
 assert.equal((await task).status,'done');assert.equal(cleaned,1);
 assert.equal(f.calls.filter(c=>c.method==='create').length,2);assert.ok(f.calls.some(c=>c.method==='getTurn'));
});

test('user cancellation during scout stays cancelled and cleans up without starting parent',async()=>{
 const f=fixture();let ready!:()=>void,cleaned=0;const reached=new Promise<void>(r=>ready=r);
 Object.assign(f.options,{contextScout:{mcpName:'scout'},onScoutFinished:async()=>{cleaned++;},onScoutEvent:(e:any)=>{if(e.type==='model.message')ready();}});
 f.sessions.createTurnStream=async()=>(async function*(){yield created;yield {...answer,threadId:'main'};await new Promise(()=>{});})() as any;
 const runner=new ForgeRunner(f.options);const task=runner.run('task');await reached;await runner.cancel();
 assert.equal((await task).status,'cancelled');assert.equal(cleaned,1);assert.equal(f.calls.filter(c=>c.method==='create').length,1);
});

test('terminal remote scout cancellation remains cancelled instead of starting parent',async()=>{
 const f=fixture([created,{...done,state:{status:'cancelled'}}]);let cleaned=0;
 Object.assign(f.options,{contextScout:{mcpName:'scout'},onScoutFinished:async()=>{cleaned++;}});
 assert.equal((await new ForgeRunner(f.options).run('task')).status,'cancelled');
 assert.equal(cleaned,1);assert.equal(f.calls.filter(c=>c.method==='create').length,1);
});

test('scout requires a separate connector and cleanup errors fail closed',async()=>{
 for(const mcpName of ['','editor']){const f=fixture();Object.assign(f.options,{contextScout:{mcpName}});await assert.rejects(new ForgeRunner(f.options).run('task'),/separate.*connector/i);assert.equal(f.calls.length,0);}
 const f=fixture();Object.assign(f.options,{contextScout:{mcpName:'scout'},onScoutFinished:async()=>{throw new Error('scout endpoint cleanup failed');}});
 await assert.rejects(new ForgeRunner(f.options).run('task'),/cleanup failed/);assert.equal(f.calls.filter(c=>c.method==='create').length,1);
});

test('streams real SDK-shaped events and passes only a TrueForge agent spec',async()=>{
 const f=fixture([created,{id:'m1',type:'model.message.delta',content:'hello'},done]);
 const r=await new ForgeRunner(f.options).run('Find the implementation');
 assert.deepEqual(r,{sessionId:'s1',status:'done'});
 assert.ok(f.events.some((e:any)=>e.content==='hello'));
 assert.equal(f.calls[0].args[0].agent.spec.model.name,'test/model');
 assert.equal(f.calls[0].args[0].agent.spec.mcpServers[0].preload,false);
 assert.equal(f.calls[1].args[0],'s1');
});

test('resolves deferred tool target and subscribes before approval, preserving rejection',async()=>{
 const f=fixture(approvalEvents); let details:any;
 f.options.onApproval=async d=>{details=d;return false;};
 assert.equal((await new ForgeRunner(f.options).run('edit')).status,'done');
 assert.equal(details.name,'propose_edit'); assert.deepEqual(details.arguments,{path:'a.ts',content:'new'});
 assert.deepEqual(f.calls.slice(-2).map(c=>c.method),['subscribe','events']);
 assert.equal(f.calls.at(-1)!.args[2].events[0].approval.status,'deny');
});

test('cancel while approval is pending stops server and never approves later',async()=>{
 const f=fixture(approvalEvents); let approvalReached!:()=>void;
 const reached=new Promise<void>(r=>approvalReached=r); let answer!:(value:boolean)=>void;
 f.options.onApproval=()=>{approvalReached();return new Promise<boolean>(r=>answer=r);};
 const runner=new ForgeRunner(f.options); const run=runner.run('edit'); await reached;
 await runner.cancel(); assert.equal((await run).status,'cancelled'); answer(true);
 await new Promise(r=>setImmediate(r));
 assert.ok(f.calls.some(c=>c.method==='cancel' && c.args[0]==='s1'));
 assert.equal(f.calls.filter(c=>c.method==='events').length,0);
});

test('explicit terminal model error may use configured fallback through a new TrueForge session',async()=>{
 const f=fixture(); let n=0;
 f.sessions.createTurnStream=async(...args:any[])=>{f.calls.push({method:'stream',args});return stream(n++===0?[created,failed]:[created,answer,done]) as any;};
 f.options.fallbackModel='test/backup';
 assert.deepEqual(await new ForgeRunner(f.options).run('edit'),{sessionId:'s2',status:'done'});
 assert.deepEqual(f.calls.filter(c=>c.method==='create').map(c=>c.args[0].agent.spec.model.name),['test/model','test/backup']);
});

test('does not replay a turn after ambiguous transport interruption',async()=>{
 const f=fixture(); f.options.fallbackModel='test/backup';
 f.sessions.createTurnStream=async()=>{throw new Error('socket lost');};
 await assert.rejects(new ForgeRunner(f.options).run('edit'),/socket lost/);
 assert.equal(f.calls.filter(c=>c.method==='create').length,1);
});

test('bounded retry on explicit transient session rejection',async()=>{
 const f=fixture();let attempts=0;const create=f.sessions.create;
 f.sessions.create=async(...args:any[])=>{if(attempts++<1)throw Object.assign(new Error('busy'),{statusCode:503});return create(...args);};
 assert.equal((await new ForgeRunner(f.options).run('edit')).status,'done');assert.equal(attempts,2);
});

test('stream ending without a terminal event fails safely',async()=>{
 const f=fixture([created]); await assert.rejects(new ForgeRunner(f.options).run('edit'),/without a terminal/);
});

test('refuses concurrent task before any second session is created',async()=>{
 const f=fixture(approvalEvents);let reached!:()=>void;
 const ready=new Promise<void>(r=>reached=r);
 f.options.onApproval=()=>{reached();return new Promise<boolean>(()=>{});};
 const runner=new ForgeRunner(f.options), first=runner.run('one'); await ready;
 await assert.rejects(runner.run('two'),/already running/); await runner.cancel(); await first;
 assert.equal(f.calls.filter(c=>c.method==='create').length,1);
});

test('malformed approval arguments never dispatch an approval',async()=>{
 const initial=structuredClone(approvalEvents) as any[];
 initial[1].toolCalls[0].function.arguments='invalid json';const f=fixture(initial);
 await assert.rejects(new ForgeRunner(f.options).run('edit'),/Malformed/);
 assert.equal(f.calls.filter(c=>c.method==='events').length,0);
});

test('optional schema preloading preserves MCP approvals while default remains deferred',async()=>{
 const f=fixture();f.options.preloadTools=true;await new ForgeRunner(f.options).run('edit');const m=f.calls[0].args[0].agent.spec.mcpServers[0];assert.equal(m.preload,true);assert.deepEqual(m.requireApprovalForTools,['propose_edit','propose_write','propose_changes','create_file','validate_candidate','run_command']);
});

test('optional reasoning effort passes through TrueForge agent spec only',async()=>{
 const f=fixture();f.options.reasoningEffort='none';await new ForgeRunner(f.options).run('edit');assert.deepEqual(f.calls[0].args[0].agent.spec.model.params,{reasoningEffort:'none'});
});

test('validation denial is reported truthfully to the model and editor',async()=>{
 const f=fixture(approvalEvents);
 const reason='Proposal validation failed: oldText must match exactly once. Read current file and retry.';
 f.options.onApproval=async()=>({allowed:false,reason});
 assert.equal((await new ForgeRunner(f.options).run('edit')).status,'done');
 assert.deepEqual(f.calls.at(-1)!.args[2].events[0].approval,{status:'deny',reason});
 assert.ok(f.events.some((e:any)=>e.type==='client.status' && e.message===reason));
});

test('total run deadline stops a pending approval without replay or approval',async()=>{
 const f=fixture(approvalEvents);f.options.runTimeoutMs=25;
 f.options.onApproval=()=>new Promise<boolean>(()=>{});
 const result=await new ForgeRunner(f.options).run('edit');
 assert.equal(result.status,'error');
 assert.equal(f.calls.filter(c=>c.method==='create').length,1);
 assert.equal(f.calls.filter(c=>c.method==='events').length,0);
 assert.ok(f.events.some((e:any)=>e.type==='client.status'&&e.message.includes('time limit')));
});

test('server cancellation passes timeout in SDK request options, not request body',async()=>{
 const f=fixture(approvalEvents);let ready!:()=>void;const reached=new Promise<void>(r=>ready=r);
 f.options.onApproval=()=>{ready();return new Promise<boolean>(()=>{});};const runner=new ForgeRunner(f.options);const run=runner.run('edit');await reached;await runner.cancel();await run;
 const request=f.calls.find(c=>c.method==='cancel')!;
 assert.deepEqual(request.args.slice(1),[{}, {timeoutInSeconds:5,maxRetries:0}]);
});

test('explicit direct mode disables dynamic delegation while retaining TrueForge and edit approvals',async()=>{
 const f=fixture();(f.options as ForgeOptions & {dynamicSubAgents?:boolean}).dynamicSubAgents=false;
 await new ForgeRunner(f.options).run('edit');
 const spec=f.calls[0].args[0].agent.spec;
 assert.deepEqual(spec.config.dynamicSubAgents,{enabled:false});
 assert.deepEqual(spec.mcpServers[0].requireApprovalForTools,['propose_edit','propose_write','propose_changes','create_file','validate_candidate','run_command']);
});

// These tests exercise the real runner; only the external SDK stream is substituted.
test('terminal empty provider response fails without replay or a misleading done event',async()=>{
 const f=fixture([created,{id:'m1',type:'model.message',finishReason:'stop',usage:{outputTokens:68}},
  {id:'m1',type:'model.message.delta',finishReason:'stop'},done]);
 f.options.fallbackModel='test/backup';
 await assert.rejects(new ForgeRunner(f.options).run('edit'),/provider.*no.*(text|output)/i);
 assert.equal(f.calls.filter(c=>c.method==='create').length,1);
 assert.equal(f.events.filter((e:any)=>e.type==='turn.done').length,0);
});

test('whitespace and reasoning alone do not count as usable output',async()=>{
 const f=fixture([created,{id:'m1',type:'model.message',content:'  ',reasoningContent:'thinking'},done]);
 await assert.rejects(new ForgeRunner(f.options).run('edit'),/provider.*no.*(text|output)/i);
});

test('terminal output snapshot is accepted even if content delta was not sent',async()=>{
 const f=fixture([created,{...done,state:{status:'done',output:answer}}]);
 assert.equal((await new ForgeRunner(f.options).run('question')).status,'done');
});

test('tool-call delta counts as activity even without assistant text',async()=>{
 const f=fixture([created,{id:'m1',type:'model.message.delta',toolCalls:[{id:'c1',function:{name:'read_file',arguments:'{}'}}]},done]);
 assert.equal((await new ForgeRunner(f.options).run('inspect')).status,'done');
});

test('terminal cancellation without output remains cancelled, without fallback',async()=>{
 const f=fixture([created,{...done,state:{status:'cancelled'}}]);f.options.fallbackModel='test/backup';
 assert.equal((await new ForgeRunner(f.options).run('edit')).status,'cancelled');
 assert.equal(f.calls.filter(c=>c.method==='create').length,1);
});

test('partial text followed by interrupted stream never replays',async()=>{
 const f=fixture([created,answer]);f.options.fallbackModel='test/backup';
 await assert.rejects(new ForgeRunner(f.options).run('edit'),/without a terminal/);
 assert.equal(f.calls.filter(c=>c.method==='create').length,1);
});

for (const message of [
 {id:'m1',type:'model.message',content:[{type:'text',text:'Answer'}]},
 {id:'m1',type:'model.message',content:[{type:'refusal',refusal:'Cannot help'}]},
 {id:'m1',type:'model.message.delta',refusal:'Cannot help'},
 {id:'r1',type:'tool.response',toolCallId:'c1',content:''},
]) test(`nonempty content parts, refusals and tool activity are not empty: ${JSON.stringify(message)}`,async()=>{
 const f=fixture([created,message,done]);
 assert.equal((await new ForgeRunner(f.options).run('question')).status,'done');
});

test('no model event at all is still an empty terminal failure',async()=>{
 const f=fixture([created,done]);
 await assert.rejects(new ForgeRunner(f.options).run('edit'),/provider.*no.*(text|output)/i);
});

const questionEvents=[created,
 {id:'qm',type:'model.message',toolCalls:[{id:'qc',function:{arguments:JSON.stringify({question:'Which approach?',options:['Standalone','Existing']})},toolInfo:{type:'truefoundry-system',name:'ask_user_question'}}]},
 {id:'qr',type:'tool.response_required',threadId:'main',toolCalls:[{id:'qc',sourceEventId:'qm'}]},
 {id:'qp',type:'turn.update',state:{status:'paused'}}];
test('built-in user question resumes through TrueForge with actual callback answer',async()=>{
 const f=fixture(questionEvents);let question:any;
 (f.options as any).onQuestion=async(q:any)=>{question=q;return 'Standalone';};
 assert.equal((await new ForgeRunner(f.options).run('task')).status,'done');
 assert.equal(question.question,'Which approach?');assert.deepEqual(question.options,['Standalone','Existing']);
 assert.deepEqual(f.calls.slice(-2).map(x=>x.method),['subscribe','events']);
 assert.deepEqual(f.calls.at(-1)!.args[2].events,[{type:'user.tool_response',threadId:'main',toolCallId:'qc',content:'Standalone'}]);
});
test('dismissed question cancels rather than inventing an answer',async()=>{
 const f=fixture(questionEvents);(f.options as any).onQuestion=async()=>undefined;
 assert.equal((await new ForgeRunner(f.options).run('task')).status,'cancelled');
 assert.equal(f.calls.filter(x=>x.method==='events').length,0);assert.ok(f.calls.some(x=>x.method==='cancel'));
});
test('cancel during pending question never sends a late answer',async()=>{
 const f=fixture(questionEvents);let reached!:()=>void;const ready=new Promise<void>(r=>reached=r);let answer!:(s:string)=>void;
 (f.options as any).onQuestion=()=>{reached();return new Promise<string>(r=>answer=r);};
 const runner=new ForgeRunner(f.options);const task=runner.run('task');await ready;await runner.cancel();assert.equal((await task).status,'cancelled');answer('Standalone');await new Promise(r=>setImmediate(r));assert.equal(f.calls.filter(x=>x.method==='events').length,0);
});
test('unsupported client-side tool cannot be mistaken for a user question',async()=>{
 const initial=structuredClone(questionEvents) as any[];initial[1].toolCalls[0].toolInfo.name='execute_shell';const f=fixture(initial);let asked=false;(f.options as any).onQuestion=async()=>{asked=true;return 'yes';};
 await assert.rejects(new ForgeRunner(f.options).run('task'),/unsupported/i);assert.equal(asked,false);assert.equal(f.calls.filter(x=>x.method==='events').length,0);
});

test('edit runs report no proposals and bounded sanitized recent tool names instead of success',async()=>{
 const f=fixture(); f.options.getStagedProposalCount=()=>0;
 f.options.getRecentToolCalls=()=>Array.from({length:12},(_,i)=>`read_file secret-${i} token=do-not-print`);
 assert.equal((await new ForgeRunner(f.options).run('edit')).status,'error');
 const status=f.events.filter((e:any)=>e.type==='client.status').map((e:any)=>e.message).join('\n');
 assert.match(status,/Agent proposed no edits/);assert.doesNotMatch(status,/secret-|do-not-print/);
 assert.equal((status.match(/read_file/g)||[]).length,8);
 assert.ok(!f.events.some((e:any)=>e.type==='turn.done'&&e.state.status==='done'));
});
test('edit status preserves provider failure while adding no-edits diagnostic',async()=>{
 const f=fixture([created,failed]);f.options.getStagedProposalCount=()=>0;
 assert.equal((await new ForgeRunner(f.options).run('edit')).status,'error');
 assert.ok(f.events.some((e:any)=>e.type==='turn.done'&&e.state.message==='Model unavailable'));
 assert.ok(f.events.some((e:any)=>e.message?.includes('Agent proposed no edits')));
});
test('staged edits retain successful terminal result and alias is approval-required',async()=>{
 const f=fixture();f.options.getStagedProposalCount=()=>1;
 assert.equal((await new ForgeRunner(f.options).run('edit')).status,'done');
 assert.ok(f.calls[0].args[0].agent.spec.mcpServers[0].requireApprovalForTools.includes('propose_write'));
});

test('timeout includes no-edits diagnostic while user cancellation stays distinct',async()=>{
 const f=fixture(approvalEvents);f.options.runTimeoutMs=20;f.options.getStagedProposalCount=()=>0;
 f.options.onApproval=()=>new Promise<boolean>(()=>{});
 assert.equal((await new ForgeRunner(f.options).run('edit')).status,'error');
 assert.ok(f.events.some((e:any)=>e.message?.includes('Agent proposed no edits before the run time limit')));
 const c=fixture(approvalEvents);c.options.getStagedProposalCount=()=>0;
 let reached!:()=>void;const ready=new Promise<void>(r=>reached=r);
 c.options.onApproval=()=>{reached();return new Promise<boolean>(()=>{});};
 const runner=new ForgeRunner(c.options);const running=runner.run('edit');await ready;await runner.cancel();
 assert.equal((await running).status,'cancelled');
 assert.ok(!c.events.some((e:any)=>e.message?.includes('Agent proposed no edits')));
});

function stalledModelFixture() {
 const f=fixture(); let n=0;
 f.sessions.createTurnStream=async()=>{
  if(n++>0)return stream([created,{...answer,finishReason:'stop'},done]) as any;
  return (async function*(){yield created;yield {id:'slow',type:'model.message',threadId:'main'};await new Promise(()=>{});})() as any;
 };
 (f.sessions as any).getTurn=async(...args:any[])=>{f.calls.push({method:'getTurn',args});return {data:{state:{status:'cancelled'}}};};
 f.options.modelCallTimeoutMs=15;f.options.runTimeoutMs=1000;f.options.getStagedProposalCount=()=>0;f.options.fallbackModel='test/backup';
 return f;
}
test('model call timeout confirms exact turn terminal before fallback, no direct provider',async()=>{
 const f=stalledModelFixture();let count=0;f.options.getStagedProposalCount=()=>count;
 f.options.onFallback=()=>{count=1;};
 const result=await new ForgeRunner(f.options).run('edit');
 assert.equal(result.status,'done');
 const methods=f.calls.map(x=>x.method);assert.ok(methods.indexOf('cancel')<methods.indexOf('getTurn'));
 assert.ok(methods.indexOf('getTurn')<methods.lastIndexOf('create'));
 assert.deepEqual(f.calls.find(x=>x.method==='getTurn')!.args.slice(0,2),['s1','t1']);
});
test('model timeout never falls back with staged edits or unconfirmed cancellation',async()=>{
 for(const mode of ['staged','failed-cancel','still-running','unknown-count']){
  const f=stalledModelFixture();
  if(mode==='staged')f.options.getStagedProposalCount=()=>1;
  if(mode==='unknown-count')delete f.options.getStagedProposalCount;
  if(mode==='failed-cancel')f.sessions.cancel=async()=>{throw Error('offline');};
  if(mode==='still-running')(f.sessions as any).getTurn=async()=>({data:{state:{status:'running'}}});
  assert.equal((await new ForgeRunner(f.options).run('edit')).status,'error');
  assert.equal(f.calls.filter(x=>x.method==='create').length,1,mode);
 }
});
test('completed model calls stop timers during tool approval waits',async()=>{
 const f=fixture(approvalEvents.map((e:any)=>e.type==='model.message'?{...e,finishReason:'tool_calls'}:e));
 f.options.modelCallTimeoutMs=10;f.options.onApproval=async()=>{await new Promise(r=>setTimeout(r,30));return true;};
 assert.equal((await new ForgeRunner(f.options).run('edit')).status,'done');
 assert.ok(!f.calls.some(x=>x.method==='cancel'));
});
test('invalid model timeout rejected before creating session',async()=>{
 const f=fixture();f.options.modelCallTimeoutMs=0;
 await assert.rejects(new ForgeRunner(f.options).run('edit'),/Model call timeout/);assert.equal(f.calls.length,0);
});

test('streaming deltas do not reset the per-call wall-clock deadline',async()=>{
 const f=stalledModelFixture();f.options.fallbackModel=undefined;
 f.sessions.createTurnStream=async()=> (async function*(){
  yield created;yield {id:'slow',type:'model.message',threadId:'main'};
  for(let i=0;i<10;i++){await new Promise(r=>setTimeout(r,4));yield {id:'slow',type:'model.message.delta',threadId:'main',content:'x',usage:{outputTokens:i}};}
  yield done;
 })() as any;
 assert.equal((await new ForgeRunner(f.options).run('edit')).status,'error');
 assert.ok(f.calls.some(x=>x.method==='cancel'));
});
test('explicit terminal timeout fallback requires known zero staged proposals',async()=>{
 for(const staged of [0,1,undefined]){
  const f=fixture();let n=0;f.options.fallbackModel='test/backup';
  if(staged!==undefined)f.options.getStagedProposalCount=()=>staged;
  f.sessions.createTurnStream=async()=>stream(n++===0?[created,{...failed,state:{status:'error',message:'Provider request timed out'}}]:[created,answer,done]) as any;
  await new ForgeRunner(f.options).run('edit');
  assert.equal(f.calls.filter(c=>c.method==='create').length,staged===0?2:1);
 }
});
test('each completed model call gets an independent timeout budget',async()=>{
 const f=fixture();f.options.modelCallTimeoutMs=30;
 f.sessions.createTurnStream=async()=>(async function*(){yield created;
  for(let i=0;i<3;i++){yield {id:`model${i}`,type:'model.message',threadId:'main'};await new Promise(r=>setTimeout(r,15));yield {id:`model${i}`,type:'model.message.delta',threadId:'main',content:'x',finishReason:'stop'};}
  yield done;
 })() as any;
 assert.equal((await new ForgeRunner(f.options).run('read')).status,'done');
 assert.ok(!f.calls.some(x=>x.method==='cancel'));
});
test('default model call budget is two minutes, shorter than five-minute run budget',()=>{
 assert.equal(DEFAULT_MODEL_CALL_TIMEOUT_MS,120000);
});
test('user cancellation during timeout confirmation prevents fallback',async()=>{
 const f=stalledModelFixture();let reached!:()=>void;const ready=new Promise<void>(r=>reached=r);let finish!:(v:any)=>void;
 (f.sessions as any).getTurn=async()=>{reached();return await new Promise(r=>finish=r);};
 const runner=new ForgeRunner(f.options);const run=runner.run('edit');await ready;await runner.cancel();finish({data:{state:{status:'cancelled'}}});
 assert.equal((await run).status,'cancelled');
 assert.equal(f.calls.filter(c=>c.method==='create').length,1);
});
test('late events from timed-out attempt cannot approve tools or affect fallback',async()=>{
 const f=stalledModelFixture();let release!:()=>void;const late=new Promise<void>(r=>release=r);let n=0;let approvals=0;let staged=0;
 f.options.getStagedProposalCount=()=>staged;
 f.options.onApproval=async()=>{approvals++;return true;};
 f.options.onFallback=()=>{staged=1;release();};
 f.sessions.createTurnStream=async(...args:any[])=>{
  f.calls.push({method:'stream',args});
  if(n++>0)return stream([created,{...answer,finishReason:'stop'},done]) as any;
  return (async function*(){yield created;yield {id:'slow',type:'model.message',threadId:'main'};await late;for(const event of approvalEvents.slice(1))yield event;})() as any;
 };
 assert.equal((await new ForgeRunner(f.options).run('edit')).status,'done');await new Promise(r=>setImmediate(r));
 assert.equal(approvals,0);assert.equal(f.calls.filter(c=>c.method==='events').length,0);
 const requests=f.calls.filter(c=>c.method==='stream');
 assert.equal(requests[0].args[2].abortSignal.aborted,true);assert.equal(requests[1].args[2].abortSignal.aborted,false);
});

test('native scout uses one turn and keeps inherited editor tools behind a root-thread approval gate',async()=>{
 const child='context-scout';
 const f=fixture();
 const scoutEvents:any[]=[];
 let cleanups=0,reviewed=0;
 f.options.contextScout={mode:'native',mcpName:'saved-source'};
 f.options.onScoutEvent=e=>scoutEvents.push(e);
 f.options.onScoutFinished=async()=>{cleanups++;};
 f.options.onApproval=async details=>{reviewed++;assert.equal(details.threadId,'main');assert.equal(details.name,'validate_candidate');return false;};
 const toolCalls=[
  {thread:child,requested:child,name:'propose_write',connector:'editor'},
  {thread:child,requested:'main',name:'create_file',connector:'editor'},
  {thread:'main',requested:'main',name:'read_file',connector:'editor'},
  {thread:'main',requested:'main',name:'unknown',connector:'editor'},
  {thread:'main',requested:'main',name:'report_plan',connector:'unexpected'},
  {thread:'main',requested:'main',name:'validate_candidate',connector:'editor'}
 ];
 const initial:any[]=[created,{id:'child',type:'thread.created',threadId:child,parent:{threadId:'main'}}];
 toolCalls.forEach(({thread,requested,name,connector},i)=>{
  initial.push({id:'m'+i,type:'model.message',threadId:thread,toolCalls:[{id:'c'+i,function:{arguments:'{}'},toolInfo:{type:'mcp',name,serverName:connector}}]},
   {id:'a'+i,type:'tool.approval_required',threadId:requested,toolCalls:[{id:'c'+i,sourceEventId:'m'+i}]});
 });
 initial.push({id:'paused',type:'turn.update',state:{status:'paused'}});
 f.sessions.createTurnStream=async(...args:any[])=>{f.calls.push({method:'stream',args});return stream(initial) as any;};
 f.sessions.subscribeToTurn=async(...args:any[])=>{f.calls.push({method:'subscribe',args});return stream([{id:'child-done',type:'thread.done',threadId:child},answer,done]) as any;};
 assert.equal((await new ForgeRunner(f.options).run('original task')).status,'done');
 const requests=f.calls.filter(c=>c.method==='create');
 assert.equal(requests.length,1);assert.equal(f.calls.filter(c=>c.method==='stream').length,1);
 const request=requests[0].args[0];await CreateSessionRequest.jsonOrThrow(request,{unrecognizedObjectKeys:'fail'});
 const spec=request.agent.spec;
 assert.equal(spec.config.dynamicSubAgents.enabled,true);
 assert.equal(spec.config.sandbox.enabled,false);assert.equal(spec.config.webSearch.enabled,false);
 assert.deepEqual(spec.mcpServers[0].requireApprovalForTools,['@all']);
 assert.deepEqual(spec.mcpServers[1].enableTools,['find_relevant_files','select_context','read_file','search_workspace']);
 assert.deepEqual(spec.mcpServers[1].requireApprovalForTools,[]);
 assert.match(spec.instructions,/create_sub_agent once/);assert.match(spec.instructions,/saved-source/);
 assert.ok(scoutEvents.some(e=>e.type==='thread.done'));
 assert.ok(!f.events.some((e:any)=>e.type==='model.message'&&e.threadId===child));
 assert.equal(reviewed,1);assert.equal(cleanups,1);
 assert.deepEqual(f.calls.find(c=>c.method==='events')!.args[2].events.map((e:any)=>e.approval.status),['deny','deny','allow','deny','deny','deny']);
});

test('native mode cancels a second child instead of allowing unlimited delegation',async()=>{
 const f=fixture([created,...['first','second'].map(threadId=>({id:threadId,type:'thread.created',threadId,parent:{threadId:'main'}}))]);
 f.options.contextScout={mode:'native',mcpName:'read-only'};
 assert.equal((await new ForgeRunner(f.options).run('task')).status,'cancelled');
 assert.equal(f.calls.filter(c=>c.method==='cancel').length,1);
});

const busy={id:'busy',type:'turn.done',state:{status:'error',message:'HTTP 503 Service Unavailable'}};
test('confirmed rejected generations retry twice with measured backoff before switching models',async()=>{
 const f=fixture(); f.options.fallbackModel='test/backup';
 let attempts=0;
 f.sessions.createTurnStream=async()=>stream(++attempts<4?[created,busy]:[created,answer,done]) as any;
 assert.equal((await new ForgeRunner(f.options).run('edit')).status,'done');
 assert.deepEqual(f.calls.filter(c=>c.method==='create').map(c=>c.args[0].agent.spec.model.name),['test/model','test/model','test/model','test/backup']);
 const messages=f.events.filter((e:any)=>e.type==='client.status').map((e:any)=>e.message);
 assert.match(messages[0],/Retry 1\/2 in 0\.8 s/);assert.match(messages[2],/Retry 2\/2 in 1\.6 s/);
 assert.ok(Number(messages[1].match(/after (\d+) ms/)[1])>=790);
 assert.ok(Number(messages[3].match(/after (\d+) ms/)[1])>=1590);
 assert.match(messages[4],/fallback/);
});

test('honors Google fractional retry seconds without posting an early turn',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture();
 const message='HTTP 429 Too Many Requests. Please retry in 19.703844321s.';
 let attempts=0,scheduled!:()=>void;
 const ready=new Promise<void>(resolve=>scheduled=resolve);
 const logs:string[]=[];
 f.options.onEvent=e=>{if(e.type==='client.status'){logs.push(e.message);if(e.message.includes('Retry 1/2 in'))scheduled();}};
 f.sessions.createTurnStream=async()=>stream(++attempts===1?[created,{...busy,state:{...busy.state,message}}]:[created,answer,done]) as any;
 const run=new ForgeRunner(f.options).run('task');await ready;
 assert.match(logs[0]!,/19\.704 s.*provider/);
 t.mock.timers.tick(19703);await new Promise(resolve=>setImmediate(resolve));assert.equal(attempts,1);
 t.mock.timers.tick(1);assert.equal((await run).status,'done');assert.equal(attempts,2);
});

test('structured millisecond hints and the ordinary backoff act as lower bounds on separate attempts',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture();
 let attempts=0,notify!:()=>void;
 const waiting=()=>new Promise<void>(resolve=>notify=resolve);
 const first=waiting();
 f.options.onEvent=e=>{if(e.type==='client.status' && /Retry [12]\/2 in/.test(e.message))notify();};
 const errors=['HTTP 503 {"retryDelay":"1125ms"}','HTTP 503 retry after 10 milliseconds'];
 f.sessions.createTurnStream=async()=>{
  const message=errors[attempts++];
  return stream(message?[created,{...busy,state:{...busy.state,message}}]:[created,answer,done]) as any;
 };
 const run=new ForgeRunner(f.options).run('task');await first;
 const second=waiting();
 t.mock.timers.tick(1124);await new Promise(resolve=>setImmediate(resolve));assert.equal(attempts,1);
 t.mock.timers.tick(1);await second;
 t.mock.timers.tick(1599);await new Promise(resolve=>setImmediate(resolve));assert.equal(attempts,2);
 t.mock.timers.tick(1);assert.equal((await run).status,'done');assert.equal(attempts,3);
});

test('session creation reads Retry-After delta seconds and HTTP-date from SDK raw response headers',async t=>{
 const start=Date.UTC(2026,0,1);
 t.mock.timers.enable({apis:['setTimeout','Date'],now:start});
 for(const header of ['7',new Date(start+14000).toUTCString()]){
  const f=fixture();let tries=0,scheduled!:()=>void;
  const ready=new Promise<void>(resolve=>scheduled=resolve);
  f.options.onEvent=e=>{if(e.type==='client.status' && e.message.includes('Retry 1/2 in'))scheduled();};
  const create=f.sessions.create;
  f.sessions.create=async(...args:any[])=>{
   if(++tries===1)throw Object.assign(new Error('retry in 900 ms'),{statusCode:503,rawResponse:{headers:new Headers({'retry-after':header})}});
   return create(...args);
  };
  const run=new ForgeRunner(f.options).run('task');await ready;
  t.mock.timers.tick(6999);await new Promise(resolve=>setImmediate(resolve));assert.equal(tries,1,header);
  t.mock.timers.tick(1);assert.equal((await run).status,'done');assert.equal(tries,2);
 }
});

test('provider waits beyond the deadline stop safely without another model, overflow or fallback',async()=>{
 for(const message of ['429 please retry in 61s','503 Retry after 9999999999999 seconds']){
  const f=fixture([created,{...busy,state:{...busy.state,message}}]);
  f.options.runTimeoutMs=60000;f.options.fallbackModel='test/backup';
  assert.equal((await new ForgeRunner(f.options).run('task')).status,'error');
  assert.equal(f.calls.filter(c=>c.method==='create').length,1);
  assert.ok(f.events.some((e:any)=>e.type==='client.status' && /retry wait exceeds/.test(e.message)));
 }
});

test('a retry hint grants no retry for permanent errors or previously billed work',async()=>{
 for(const message of ['HTTP 429 {"quotaValue":"0"}; retry in 3s','HTTP 503: invalid API key; retry in 4s']){
  const f=fixture([created,{...busy,state:{...busy.state,message}}]);
  assert.equal((await new ForgeRunner(f.options).run('task')).status,'error');
  assert.equal(f.calls.filter(c=>c.method==='create').length,1);
 }
 const f=fixture([created,answer,{...busy,state:{...busy.state,message:'HTTP 429 retry in 1s'}}]);
 f.options.fallbackModel='test/backup';
 assert.equal((await new ForgeRunner(f.options).run('task')).status,'error');assert.equal(f.calls.filter(c=>c.method==='create').length,1);
});

test('cancellation during retry backoff never starts another paid turn',async()=>{
 const f=fixture([created,busy]);
 let ready!:()=>void;const scheduled=new Promise<void>(resolve=>ready=resolve);
 f.options.onEvent=e=>{if(e.type==='client.status' && e.message.includes('Retry 1/2 in'))ready();};
 const runner=new ForgeRunner(f.options);
 const run=runner.run('task');await scheduled;await runner.cancel();
 assert.equal((await run).status,'cancelled');assert.equal(f.calls.filter(c=>c.method==='create').length,1);
});

test('staged changes, generated text, tool activity and reported usage prevent provider replay',async()=>{
 for(const scenario of ['staged','generated','reasoning','tools','metrics']){
  const events:any[]=[created];
  if(scenario==='generated')events.push(answer);
  if(scenario==='reasoning')events.push({id:'m',type:'model.message.delta',threadId:'main',reasoningContent:'thinking'});
  if(scenario==='tools')events.push({id:'r',type:'tool.response',threadId:'main'});
  events.push(scenario==='metrics'?{...busy,state:{...busy.state,metrics:{totalInputTokens:7}}}:busy);
  const f=fixture(events);f.options.fallbackModel='test/backup';f.options.getStagedProposalCount=()=>scenario==='staged'?1:0;
  assert.equal((await new ForgeRunner(f.options).run('task')).status,'error',scenario);
  assert.equal(f.calls.filter(c=>c.method==='create').length,1,scenario);
 }
});

test('permanent zero quota and ambiguous gateway statuses skip same-model retries',async()=>{
 for(const message of ['429 quota exceeded: limit: 0','HTTP 504 Gateway Timeout','invalid API key']){
  const f=fixture([created,{...busy,state:{...busy.state,message}}]);
  assert.equal((await new ForgeRunner(f.options).run('task')).status,'error');
  assert.equal(f.calls.filter(c=>c.method==='create').length,1);
 }
});
