/**
 * Replay archived model output through the shipping review store and candidate validator.
 * Usage: node --import tsx checks/replay-reviewed-task-b.ts FLASK_CLONE PYTHON [REPORT_JSON]
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyPatch,parsePatch} from 'diff';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {candidateTestArgs,validateCandidate} from '../src/candidateValidation';
import {userFixturePins,type FixturePins} from '../src/candidateFixtures';
import {compactContext} from '../src/compactContext';
import {LiveReviews,reviewedCandidate,reviewFeedback} from '../src/editorReview';
import {startMcp} from '../src/mcp';
import {createProposal,renderProposal,ReviewStore} from '../src/review';
import {listWorkspace} from '../src/workspace';

const checks=path.dirname(fileURLToPath(import.meta.url));
const archive=path.join(checks,'../docs/evidence/task-b-flash-lite');
const sha256=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
function git(cwd:string,args:string[]){
  return execFileSync('git',['-c','core.autocrlf=false','-C',cwd,...args],{windowsHide:true,encoding:'utf8'});
}
async function trackedHashes(root:string){
  const names=git(root,['ls-files','-z']).split('\0').filter(Boolean).sort();
  const digest=createHash('sha256');
  for(const name of names)digest.update(name+'\0'+sha256(await readFile(path.join(root,name)))+'\n');
  return {files:names.length,sha256:digest.digest('hex')};
}
function pytestResult(output:string){
  const code=/^Candidate pytest exited (\d+);/.exec(output);
  assert.ok(code,'Candidate validator did not return a pytest exit code.');
  const lines=output.trimEnd().split(/\r?\n/);
  const summary=lines.at(-1)!.trim();
  assert.match(summary,/\d+ (?:failed|passed)/);
  return {exitCode:Number(code[1]),summary,failedTests:lines.filter(l=>l.startsWith('FAILED ')).map(l=>l.slice(7).split(' - ')[0]!)};
}

async function main(){
  const [cloneArg,pythonArg,reportPath]=process.argv.slice(2);
  assert.ok(cloneArg && pythonArg,'Supply a Flask clone and the Python executable with Flask test dependencies');
  const clone=path.resolve(cloneArg),python=path.resolve(pythonArg);
  const run=JSON.parse(await readFile(path.join(archive,'run.json'),'utf8'));
  const patch=(await readFile(path.join(archive,'candidate.patch'),'utf8')).replace(/\r\n/g,'\n');
  assert.equal(sha256(patch),run.patchSha256,'Archived patch digest changed');
  const pythonVersion=execFileSync(python,['-c','import platform; print(platform.python_version())'],{encoding:'utf8',windowsHide:true}).trim();
  const scratch=await mkdtemp(path.join(tmpdir(),'forgelens-reviewed-replay-'));
  const root=path.join(scratch,'flask');
  let bridge:Awaited<ReturnType<typeof startMcp>>|undefined, client:Client|undefined;
  try {
    git(scratch,['clone','--quiet','--local','--no-hardlinks','--no-checkout',clone,root]);
    git(root,['checkout','--quiet','--detach',run.upstreamFlaskCommit]);
    assert.equal(git(root,['rev-parse','HEAD']).trim(),run.upstreamFlaskCommit);
    const before=await trackedHashes(root);
    assert.equal(git(root,['status','--porcelain','--untracked-files=all']),'');
    const expected=new Map<string,string>();
    const files=[];
    for(const file of parsePatch(patch)){
      const name=file.newFileName.replace(/^b\//,'');
      assert.ok(run.plannedPaths.includes(name) && !expected.has(name));
      const original=await readFile(path.join(root,name),'utf8');
      const materialized=applyPatch(original,file);
      assert.ok(typeof materialized==='string','Could not reconstruct archived patch');
      expected.set(name,materialized);
      const edits=file.hunks.map(hunk=>{
        const side=(marker:string)=>hunk.lines.filter(l=>l.startsWith(' ') || l.startsWith(marker)).map(l=>l.slice(1)).join('\n');
        return {oldText:side('-'),newText:side('+')};
      });
      files.push({path:name,reason:'Replay this archived file for staged validation.',edits});
    }
    assert.equal(files.length,4);
    const selected=await compactContext(root,run.userRequest,24000,10000,()=>false);
    assert.ok(selected?.items.length);
    const live=new LiveReviews(),store=new ReviewStore();
    const accepted:{path:string;hunks:number}[]=[];
    let pins:FixturePins={};
    const checksRun:{targets:string[];commandArguments:string[];fixturePins:FixturePins;elapsedMs:number;result:ReturnType<typeof pytestResult>}[]=[];
    const checkpoints:Record<string,typeof before>={before};
    bridge=await startMcp({root,budget:24000,tokenBudget:10000,task:run.userRequest,requireDiscovery:true,compactContext:selected,
      active:()=>true,context:()=>{},command:async()=>{throw Error('Saved-workspace commands are outside this replay');},
      pending:name=>{const previous=store.get(name);return previous && renderProposal(previous);},
      propose:async(name,content,base)=>{
        assert.equal(content,expected.get(name),'Exact proposal differs from the archived Git patch');
        assert.equal(base,await readFile(path.join(root,name),'utf8'));
        const request=live.begin(createProposal(name,base!,content));
        try {
          for(const hunk of request.proposal.hunks)live.decide(request,hunk.id,'accepted');
          const reviewed=await request.result;
          store.commitReviewed(base!,undefined,reviewed);
          accepted.push({path:name,hunks:reviewed.hunks.length});
          return reviewFeedback(reviewed);
        } finally {live.end(request);}
      },
      validate:async(tests,signal)=>{
        const overlays=reviewedCandidate(store.list(),true,live.list().length>0);
        assert.equal(overlays.length,expected.size);
        for(const overlay of overlays)assert.equal(overlay.content,expected.get(overlay.path));
        checkpoints.beforeTests=await trackedHashes(root);assert.deepEqual(checkpoints.beforeTests,before);
        const start=performance.now();
        const verification=await validateCandidate(root,overlays,tests,python,signal,pins);
        checksRun.push({targets:tests,commandArguments:candidateTestArgs(tests),fixturePins:{...pins},elapsedMs:Math.round(performance.now()-start),result:pytestResult(verification)});
        return verification;
      }
    });
    client=new Client({name:'archived-patch-replay',version:'1'});
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:'Bearer '+bridge.token}}}));
    const result=await client.callTool({name:'propose_changes',arguments:{files,tests:[]}},undefined,{timeout:160000});
    assert.equal(checksRun.length,1);assert.deepEqual(checksRun[0]!.targets,[]);
    assert.ok(!result.isError && JSON.stringify(result.content).includes('Candidate pytest exited '+checksRun[0]!.result.exitCode));
    const focused=await client.callTool({name:'validate_candidate',arguments:{tests:['tests/test_cli.py::TestConfig::test_config']}},undefined,{timeout:160000});
    assert.ok(!focused.isError && checksRun[1]?.result.exitCode===0,'The newly added Task B test did not pass');
    checkpoints.afterTests=await trackedHashes(root);assert.deepEqual(checkpoints.afterTests,before);
    // Identical bytes satisfy the validator's nonempty-overlay contract without changing pristine Flask.
    const pristine=store.list()[0]!;
    const control=pytestResult(await validateCandidate(root,[{path:pristine.path,original:pristine.original,content:pristine.original}],[],python));
    checkpoints.afterControl=await trackedHashes(root);assert.deepEqual(checkpoints.afterControl,before);
    pins=userFixturePins({globalValue:JSON.parse(await readFile(path.join(archive,'public-fixture-pins.json'),'utf8'))});
    for(const [tests,expectedPasses] of [[['tests/test_cli.py'],59],[[],491]] as const){
      const checked=await client.callTool({name:'validate_candidate',arguments:{tests}},undefined,{timeout:160000});
      assert.ok(!checked.isError,'Pinned candidate validation failed: '+JSON.stringify(checked.content).slice(-1200));
      const latest=checksRun.at(-1)!.result;
      assert.ok(latest.exitCode===0 && latest.summary.startsWith(expectedPasses+' passed'),JSON.stringify(latest));
    }
    checkpoints.afterPinnedTests=await trackedHashes(root);assert.deepEqual(checkpoints.afterPinnedTests,before);
    const allowed=new Set(await listWorkspace(root,true));
    const fixturePaths=['tests/test_apps/.env','tests/test_apps/.flaskenv'].map(name=>({path:name,
      tracked:git(root,['ls-files','--',name]).trim()===name,inCandidateCopy:allowed.has(name)}));
    assert.equal(git(root,['status','--porcelain','--untracked-files=all']),'');
    const report={scope:'Replay of the archived Task B patch using compact MCP, programmatic hunk acceptance and staged candidate validation.',
      flaskCommit:run.upstreamFlaskCommit,archivedPatchSha256:run.patchSha256,pythonVersion,
      source:'Archived model output. No model or TrueForge turn was started for this replay.',
      transport:'Authenticated local MCP over HTTP',toolCalls:['propose_changes (default full suite)','validate_candidate (added test)','validate_candidate (pinned fixture CLI suite)','validate_candidate (pinned fixture full suite)'],
      consent:'The replay driver accepted every hunk and requested the full suite. No interactive editor approvals were recorded.',
      accepted,checksRun,unchangedFlaskControl:control,defaultFixturePaths:fixturePaths,checkpoints,
      cleanGitStatus:true,appliedWorkspaceChanges:false};
    const json=JSON.stringify(report,null,2)+'\n';
    if(reportPath)await writeFile(reportPath,json);
    process.stdout.write(json);
  } finally {
    await client?.close();await bridge?.close();
    assert.equal(path.dirname(scratch),path.resolve(tmpdir()));assert.ok(path.basename(scratch).startsWith('forgelens-reviewed-replay-'));
    await rm(scratch,{recursive:true,force:true,maxRetries:3});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
