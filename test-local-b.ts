/** Real TrueForge integration harness. Never generates model output or writes target files. */
import { spawnSync } from 'node:child_process';
import { ForgeRunner, registerMcp } from './src/client';
import { startMcp } from './src/mcp';
import { ReviewStore } from './src/review';
import { resolveAgentProposal } from './src/patch';
import { readWorkspace } from './src/workspace';
import { validateCandidate } from './src/candidateValidation';
import { instructionsForTools } from './src/instructions';
import { compactContext,compactEvidence,compactInstructions } from './src/compactContext';
import { writeFile, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Metadata,TASK_B_PROMPT,loopbackUrl,toolName,failureMetadata,modelId } from './diagnostics/metadata';

function checkPythonSyntax(python: string, source: string) {
 const check = spawnSync(python, ['-c', 'import ast, sys; ast.parse(sys.stdin.buffer.read())'], {
  input: source,
  encoding: 'utf8',
  timeout: 4000,
 });
 if (check.error || check.status === null) throw new Error('The local Python syntax check could not run.');
 if (check.status !== 0) {
  const line = check.stderr.match(/File "<unknown>", line (\d+)/)?.[1];
  throw new Error(`The proposed Python does not parse${line ? ` at line ${line}` : ''}.`);
 }
}

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
 const python=process.env.FORGELENS_PYTHON;
 const budget=Number(process.env.CONTEXT_BUDGET??6000);
 const compact=process.env.FORGELENS_COMPACT_REQUESTS==='true';
 const preloadTools=compact||process.env.PRELOAD_TOOLS!=='false';
 const prompt=TASK_B_PROMPT;
 const store=new ReviewStore(); let active=true,modelSwitching=false;
 const validateStaged=process.env.FORGELENS_VALIDATE_STAGED==='true';
 if(validateStaged&&!python)throw new Error('Set FORGELENS_PYTHON for staged pytest validation.');
 const persistProposals=()=>writeFile(path.join(out,'proposals.json'),JSON.stringify(Object.fromEntries(store.list().map(p=>[p.path,p.proposed])),null,2));
 try {
 const baseUrl=loopbackUrl(process.env.TRUEFORGE_URL??'http://127.0.0.1:8790');
 if(!model)throw new Error('Set TRUEFORGE_MODEL.');
 phase='mcp_start';
 const selected=compact?await compactContext(root,prompt,budget,3200,()=>!active):undefined;
 if(selected)metadata.paths('discovery',selected.items.map(item=>item.path));
 mcp=await startMcp({root,budget,compactContext:selected,task:prompt,requireDiscovery:true,active:()=>active&&!modelSwitching,pending:p=>store.get(p)?.proposed,
  propose:async(p,c)=>{if(python&&p.endsWith('.py'))checkPythonSyntax(python,c);const current=store.get(p);const original=current?.original??await readWorkspace(root,p); if(current)store.revise(p,original,c);else store.stage(p,original,c);await persistProposals();return `Staged ${p}; not applied. Continue any remaining requested work.`;},
  create:async(p,c)=>{if(python&&p.endsWith('.py'))checkPythonSyntax(python,c);store.stage(p,'',c,'create');await persistProposals();return `Staged new file ${p}; not applied.`;},
  validate:validateStaged?async tests=>{
   const result=await validateCandidate(root,store.list().map(p=>({path:p.path,original:p.original,content:p.proposed,isNew:p.kind==='create'})),tests,python!);
   metadata.events.push({type:'candidate.validation',tests,exitCode:Number(result.match(/pytest exited (\d+)/)?.[1]??-1)});
   return result;
  }:undefined,
  command:async()=> 'Not run: target files remain unchanged. Validate after human review.',context:r=>{const paths=metadata.paths('discovery',r.items.map(i=>i.path));const event={type:'retrieval.context',fileCount:r.items.length,paths};metadata.events.push(event);console.log(JSON.stringify(event));},
  onInitialized:()=>{metadata.initialized++;console.log(JSON.stringify({type:'mcp.initialized'}));},
  onToolRequest:name=>{const safe=toolName(name);metadata.calls.push(safe);console.log(JSON.stringify({type:'mcp.tool_request',name:safe,count:metadata.calls.length}));},
  onPlan:files=>{const paths=metadata.paths('plan',files.map(f=>f.path));const event={type:'agent.plan',fileCount:files.length,paths};metadata.events.push(event);console.log(JSON.stringify(event));},
  onToolCall:summary=>{const name=toolName(summary.split(' · ')[0]!);const flag=['repeat','exhausted','failed','invalid arguments'].find(f=>summary.endsWith(' · '+f));metadata.events.push({type:'mcp.tool_observation',name,...(flag?{flag}:{})});}});
  phase='mcp_registration';
  const mcpName='forgelens-retest-'+Date.now();await registerMcp(baseUrl,mcpName,mcp.url,mcp.token);
  phase='agent_run';
  const runner=new ForgeRunner({baseUrl,model,fallbackModel:process.env.TRUEFORGE_FALLBACK_MODEL||undefined,mcpName,sourceEvidence:selected?.items.length?compactEvidence(selected):undefined,instructions:selected?.items.length?compactInstructions:instructionsForTools(preloadTools),runTimeoutMs:Number(process.env.RUN_TIMEOUT_MS??300000),streamIdleTimeoutMs:Number(process.env.STREAM_IDLE_TIMEOUT_MS??900000),preloadTools,dynamicSubAgents:process.env.DYNAMIC_SUB_AGENTS==='false'?false:undefined,reasoningEffort:process.env.REASONING_EFFORT||undefined,
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
   onApproval:async d=>{
    if(d.name==='propose_changes')return process.env.FORGELENS_COMPACT_REQUESTS==='true'&&Array.isArray(d.arguments.files);
    const file=d.arguments.path;
    if(d.name==='validate_candidate'&&validateStaged)return true;
    if(d.name==='create_file'&&typeof file==='string'&&typeof d.arguments.content==='string'){
     try{if(python&&file.endsWith('.py'))checkPythonSyntax(python,d.arguments.content);return true;}catch{return {allowed:false,reason:'The proposed Python does not parse.'};}
    }
    if(!['propose_edit','propose_write'].includes(d.name)||typeof file!=='string'){
     return {allowed:false,reason:'Validation deferred; no target files have been changed.'};
    }
    try{
     const current=store.get(file)?.proposed??await readWorkspace(root,file);
     const candidate=resolveAgentProposal(current,d.arguments);
     if(python&&file.endsWith('.py'))checkPythonSyntax(python,candidate);
     return true;
    }catch(e){
     return {allowed:false,reason:`Proposal validation failed (not a user rejection): ${e instanceof Error?e.message:String(e)}. Read the staged view and retry exact text.`};
    }
   }});
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
