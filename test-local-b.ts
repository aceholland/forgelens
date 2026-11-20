/** Real TrueForge integration harness. Never generates model output or writes target files. */
import { ForgeRunner, registerMcp } from './src/client';
import { startMcp } from './src/mcp';
import { ReviewStore } from './src/review';
import { resolveAgentProposal } from './src/patch';
import { readWorkspace } from './src/workspace';
import { instructionsForTools } from './src/instructions';
import { writeFile, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Metadata,TASK_B_PROMPT,loopbackUrl,toolName,failureMetadata,modelId } from './diagnostics/metadata';
async function main() {
 const startedAt=new Date().toISOString(),started=performance.now();
 const root=path.resolve(process.env.FLASK_ROOT??'../../flask');
 const out=path.resolve(process.env.EVIDENCE_DIR??'../../live-b');
 // Resolve symlinked ancestors before creating any evidence directory.
 const canonical=async(p:string):Promise<string>=>{try{return await realpath(p);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;const parent=path.dirname(p);if(parent===p)throw e;return path.join(await canonical(parent),path.basename(p));}};
 const [realRoot,realOut]=await Promise.all([canonical(root),canonical(out)]);
 const relative=path.relative(realRoot,realOut);
 if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw new Error('Evidence directory must be outside the target workspace.');
 await mkdir(out,{recursive:true});
 const metadata=new Metadata();
 let phase='configuration',status='error',sessionId='',failure:unknown;
 let mcp:Awaited<ReturnType<typeof startMcp>>|undefined;
 const model=process.env.TRUEFORGE_MODEL;
 const budget=Number(process.env.CONTEXT_BUDGET??6000);
 const preloadTools=process.env.PRELOAD_TOOLS!=='false';
 const prompt=TASK_B_PROMPT;
 const store=new ReviewStore(); let active=true,modelSwitching=false;
 try {
 const baseUrl=loopbackUrl(process.env.TRUEFORGE_URL??'http://127.0.0.1:8790');
 if(!model)throw new Error('Set TRUEFORGE_MODEL.');
 phase='mcp_start';
 mcp=await startMcp({root,budget,task:prompt,requireDiscovery:true,active:()=>active&&!modelSwitching,pending:p=>store.get(p)?.proposed,
  propose:async(p,c)=>{const original=await readWorkspace(root,p); if(store.get(p))store.revise(p,original,c);else store.stage(p,original,c);await writeFile(path.join(out,'proposals.json'),JSON.stringify(Object.fromEntries(store.list().map(p=>[p.path,p.proposed])),null,2));return `Staged ${p}; not applied. Continue any remaining requested work. Validation sees disk only.`;},
  command:async()=> 'Not run: target files remain unchanged. Validate after human review.',context:r=>{const paths=metadata.paths('discovery',r.items.map(i=>i.path));const event={type:'retrieval.context',fileCount:r.items.length,paths};metadata.events.push(event);console.log(JSON.stringify(event));},
  onInitialized:()=>{metadata.initialized++;console.log(JSON.stringify({type:'mcp.initialized'}));},
  onToolRequest:name=>{const safe=toolName(name);metadata.calls.push(safe);console.log(JSON.stringify({type:'mcp.tool_request',name:safe,count:metadata.calls.length}));},
  onPlan:files=>{const paths=metadata.paths('plan',files.map(f=>f.path));const event={type:'agent.plan',fileCount:files.length,paths};metadata.events.push(event);console.log(JSON.stringify(event));},
  onToolCall:summary=>{const name=toolName(summary.split(' · ')[0]!);const flag=['repeat','exhausted','failed','invalid arguments'].find(f=>summary.endsWith(' · '+f));metadata.events.push({type:'mcp.tool_observation',name,...(flag?{flag}:{})});}});
  phase='mcp_registration';
  const mcpName='forgelens-retest-'+Date.now();await registerMcp(baseUrl,mcpName,mcp.url,mcp.token);
  phase='agent_run';
  const runner=new ForgeRunner({baseUrl,model,fallbackModel:process.env.TRUEFORGE_FALLBACK_MODEL||undefined,mcpName,instructions:instructionsForTools(preloadTools),runTimeoutMs:Number(process.env.RUN_TIMEOUT_MS??300000),streamIdleTimeoutMs:Number(process.env.STREAM_IDLE_TIMEOUT_MS??900000),preloadTools,dynamicSubAgents:process.env.DYNAMIC_SUB_AGENTS==='false'?false:undefined,reasoningEffort:process.env.REASONING_EFFORT||undefined,
   modelCallTimeoutMs:Number(process.env.MODEL_CALL_TIMEOUT_MS??120000),onModelCallTimeout:()=>{metadata.modelTimeouts++;modelSwitching=true;},onFallback:()=>{metadata.fallback();mcp!.resetExploration();modelSwitching=false;},
   getStagedProposalCount:()=>store.list().length,getRecentToolCalls:()=>metadata.calls,
   onEvent:e=>{if(e.type==='client.status'&&e.message.startsWith('Run time limit reached.'))active=false;const safe=metadata.add(e);if(e.type!=='model.message.delta')console.log(JSON.stringify(safe));},
   onQuestion:async q=>{
    metadata.events.push({type:'operator.question',toolCallId:q.toolCallId});
    await writeFile(path.join(out,'pending-question.json'),JSON.stringify({toolCallId:q.toolCallId,sessionId:q.sessionId,instructions:'Inspect the question in TrueForge. Raw question text is excluded from this evidence.'},null,2));
    console.log(JSON.stringify({type:'operator.question',toolCallId:q.toolCallId}));
    // A human/operator must inspect each question and write a matching answer.
    // No generic default, fabricated approval, or arbitrary question auto-answer.
    for(let i=0;i<600&&active;i++) {
      try {const answer=JSON.parse(await readFile(path.join(out,'operator-answer.json'),'utf8'));
       if(answer.toolCallId===q.toolCallId && typeof answer.content==='string') {
        metadata.events.push({type:'operator.answer',toolCallId:q.toolCallId});return answer.content;
       }
      }catch{}
      await new Promise(r=>setTimeout(r,1000));
    }
    return undefined;
   },
   onApproval:async d=>{if(!['propose_edit','propose_write'].includes(d.name)||typeof d.arguments.path!=='string')return {allowed:false,reason:'Validation deferred; no target files have been changed.'};try{resolveAgentProposal(store.get(d.arguments.path)?.proposed??await readWorkspace(root,d.arguments.path),d.arguments);return true;}catch(e){return {allowed:false,reason:`Proposal validation failed (not a user rejection): ${e instanceof Error?e.message:String(e)}. Read the staged view and retry exact text.`};}}});
  const result=await runner.run(prompt);status=result.status;sessionId=result.sessionId;phase='finished';
 }catch(error){failure=failureMetadata(error);}
 finally {
  active=false;
  if(mcp)try{await mcp.close();}catch{failure??={category:'mcp_cleanup_failure'};status='error';}
  const result={status,requestedModel:modelId(model)??null,requestedFallbackModel:modelId(process.env.TRUEFORGE_FALLBACK_MODEL)??null,preloadTools,sessionId:sessionId||null,phase,startedAt,finishedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started),...metadata.summary(),proposalCount:store.list().length,paths:store.list().map(p=>p.path),targetFilesApplied:false,benchmarkStatus:store.list().length?(status==='done'?'staged_candidate_unvalidated':'interrupted_with_staged_candidate'):'no_candidate',officialTaskBPass:false,...(failure?{failure}:{})};
  await writeFile(path.join(out,'events.json'),JSON.stringify(metadata.events,null,2));
  await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  if(status!=='done')process.exitCode=1;
 }
}
main().catch(()=>{console.error('Harness failed before evidence output could be created. Check the evidence path and permissions. Raw error omitted.');process.exitCode=1});
