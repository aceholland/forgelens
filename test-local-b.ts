/** Real TrueForge integration harness. Never generates model output or writes target files. */
import { ForgeRunner, registerMcp } from './src/client';
import { startMcp } from './src/mcp';
import { ReviewStore } from './src/review';
import { resolveProposal } from './src/patch';
import { readWorkspace } from './src/workspace';
import { instructionsForTools } from './src/instructions';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
async function main() {
 const root=path.resolve(process.env.FLASK_ROOT??'../../flask');
 const out=path.resolve(process.env.EVIDENCE_DIR??'../../live-b'); await mkdir(out,{recursive:true});
 const baseUrl=process.env.TRUEFORGE_URL??'http://127.0.0.1:8790';
 const model=process.env.TRUEFORGE_MODEL; if(!model)throw new Error('Set TRUEFORGE_MODEL to an existing model configured in TrueForge.');
 const budget=Number(process.env.CONTEXT_BUDGET??6000);
 const prompt=`Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`;
 const store=new ReviewStore(), events:unknown[]=[], toolCalls:string[]=[]; let active=true,modelSwitching=false;
 const mcp=await startMcp({root,budget,active:()=>active&&!modelSwitching,pending:p=>store.get(p)?.proposed,
  propose:async(p,c)=>{const original=await readWorkspace(root,p); if(store.get(p))store.revise(p,original,c);else store.stage(p,original,c);await writeFile(path.join(out,'proposals.json'),JSON.stringify(Object.fromEntries(store.list().map(p=>[p.path,p.proposed])),null,2));return `Staged ${p}; not applied. Continue any remaining requested work. Validation sees disk only.`;},
  command:async()=> 'Not run: target files remain unchanged. Validate after human review.',context:r=>events.push({context:r}),
  onPlan:files=>{events.push({agentPlan:files});console.log(JSON.stringify({agentPlan:files}));},
  onToolCall:summary=>{if(!summary.endsWith(' · repeat'))toolCalls.push(summary);console.log(JSON.stringify({toolCall:summary}));}});
 try {
  const mcpName='forgelens-retest-'+Date.now();await registerMcp(baseUrl,mcpName,mcp.url,mcp.token);
  const runner=new ForgeRunner({baseUrl,model,fallbackModel:process.env.TRUEFORGE_FALLBACK_MODEL||undefined,mcpName,instructions:instructionsForTools(true),runTimeoutMs:Number(process.env.RUN_TIMEOUT_MS??300000),streamIdleTimeoutMs:Number(process.env.STREAM_IDLE_TIMEOUT_MS??900000),preloadTools:true,dynamicSubAgents:process.env.DYNAMIC_SUB_AGENTS==='false'?false:undefined,reasoningEffort:process.env.REASONING_EFFORT||undefined,
   modelCallTimeoutMs:Number(process.env.MODEL_CALL_TIMEOUT_MS??120000),onModelCallTimeout:()=>{modelSwitching=true;},onFallback:()=>{mcp.resetExploration();modelSwitching=false;},
   getStagedProposalCount:()=>store.list().length,getRecentToolCalls:()=>toolCalls,
   onEvent:e=>{if(e.type==='client.status'&&e.message.startsWith('Run time limit reached.'))active=false;events.push(e);if(e.type!=='model.message.delta')console.log(JSON.stringify(e));},
   onQuestion:async q=>{
    events.push({operatorQuestion:q});
    await writeFile(path.join(out,'pending-question.json'),JSON.stringify(q,null,2));
    console.log(JSON.stringify({operatorQuestion:q}));
    // A human/operator must inspect each question and write a matching answer.
    // No generic default, fabricated approval, or arbitrary question auto-answer.
    for(let i=0;i<600;i++) {
      try {const answer=JSON.parse(await readFile(path.join(out,'operator-answer.json'),'utf8'));
       if(answer.toolCallId===q.toolCallId && typeof answer.content==='string') {
        events.push({operatorAnswer:answer});return answer.content;
       }
      }catch{}
      await new Promise(r=>setTimeout(r,1000));
    }
    return undefined;
   },
   onApproval:async d=>{if(!['propose_edit','propose_write'].includes(d.name)||typeof d.arguments.path!=='string')return {allowed:false,reason:'Validation deferred; no target files have been changed.'};try{resolveProposal(store.get(d.arguments.path)?.proposed??await readWorkspace(root,d.arguments.path),d.arguments);return true;}catch(e){return {allowed:false,reason:`Proposal validation failed (not a user rejection): ${e instanceof Error?e.message:String(e)}. Read the staged view and retry exact text.`};}}});
  try{const result=await runner.run(prompt);await writeFile(path.join(out,'result.json'),JSON.stringify({...result,paths:store.list().map(p=>p.path),toolCalls:toolCalls.length,lastToolCalls:toolCalls.slice(-8)},null,2));console.log(JSON.stringify({result,paths:store.list().map(p=>p.path),toolCalls:toolCalls.length,lastToolCalls:toolCalls.slice(-8)}));}
  finally{await writeFile(path.join(out,'events.json'),JSON.stringify(events,null,2));}
 }finally{active=false;await mcp.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1});
