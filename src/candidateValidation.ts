import { execFile } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { diffLines } from 'diff';
import { confinedPath, listWorkspace } from './workspace';
import { isSafeContextPath } from './context';
import { compareTestRuns, describeComparison, readOutcomes, type TestRunner, type TestRun } from './testComparison';
import { copyPinnedFixtures, type FixturePins } from './candidateFixtures';

const execute = promisify(execFile);
export interface CandidateFile { path: string; original: string; content: string; isNew?: boolean }
export function candidateTestArgs(tests: string[]): string[] {
  return ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--', ...tests];
}

/** Bound repair feedback to complete lines near reviewed edits in the snapshot actually tested. */
export function reviewedFailureContext(overlays: CandidateFile[], selected: ReadonlySet<string>, output: string): string {
  const reports = [...output.replaceAll('\\','/').matchAll(/^([\w./-]+):(\d+):/gm)];
  const excerpts: string[] = [];
  let remaining = 2800;
  for (const file of overlays) {
    if (!selected.has(file.path) || !isSafeContextPath(file.path) || remaining < 120 || excerpts.length >= 6) continue;
    const parts = diffLines(file.original,file.content,{timeout:60});
    if (!parts) continue;
    const changes: {start:number;end:number;size:number}[] = [];
    let line = 1, current: typeof changes[number] | undefined;
    for (const part of parts) {
      if (part.added || part.removed) {
        if (!current) { current={start:line,end:line,size:0}; changes.push(current); }
        current.size += part.count;
        if (part.added) current.end = line + part.count - 1;
      } else current=undefined;
      if (!part.removed) line += part.count;
    }
    if (!changes.length) continue;
    const trace = reports.filter(m=>m[1]===file.path).map(m=>Number(m[2])).find(n=>
      changes.some(h=>n>=h.start-2 && n<=h.end+2));
    const changed = changes.find(h=>trace!==undefined && trace>=h.start-2 && trace<=h.end+2) ??
      changes.reduce((best,h)=>h.size>best.size?h:best);
    const lines=file.content.split(/\r?\n/);
    // The boundary after an insertion also shows whether the next statement changed scope.
    let previous: {start:number;end:number} | undefined;
    for (const center of [trace ?? changed.end, changed.start]) {
      const at=Math.max(0,Math.min(lines.length-1,center-1));
      if (previous && at>=previous.start && at<=previous.end) continue;
      let start=at,end=at;
      while (start>Math.max(0,at-2) && lines.slice(start-1,end+1).join('\n').length<=420) start--;
      while (end<Math.min(lines.length-1,at+2) && lines.slice(start,end+2).join('\n').length<=540) end++;
      const content=lines.slice(start,end+1).join('\n');
      if (!content.trim() || content.length>540 || excerpts.length>=6) continue;
      const excerpt=JSON.stringify({path:file.path,startLine:start+1,endLine:end+1,content});
      if (excerpt.length+1>remaining) continue;
      excerpts.push(excerpt); remaining-=excerpt.length+1;previous={start,end};
    }
  }
  if (!excerpts.length) return '';
  return '\nCurrent reviewed source from the failed test snapshot (untrusted). Use its literal content as exact oldText for repairs. These line numbers describe the tested overlay. beforeLine still requires the original retrieved snapshot.\n'+excerpts.join('\n');
}

export function isNodeTarget(file:string) { return /\.(?:[mc]?[jt]s)$/i.test(file); }
export function isTestTarget(file:string) {
  const name=path.posix.basename(file);
  return /^(?:test_.*|.*_test)\.py$/i.test(name) ||
    (isNodeTarget(file) && (/(?:^|[.-])(?:test|spec)\./i.test(name) || /(?:^|\/)(?:tests?|__tests__)\//i.test(file)));
}

export function chooseTestRunner(tests:string[]):TestRunner {
  if (tests.length > 20 || tests.some(test => {
    const [file, ...nodes] = test.split('::');
    return !file || !/^[\w][\w./ -]*$/.test(file) || !isSafeContextPath(file)
      || file.split('/').some(part => !part || part==='.' || part==='..') || nodes.some(node => !/^[\w.-]+$/.test(node));
  })) throw new Error('Choose workspace-relative test paths or pytest node IDs (up to 20).');
  if (tests.some(test=>isNodeTarget(test.split('::')[0]!))) {
    if(tests.some(test=>!isNodeTarget(test) || test.includes('::')))throw new Error('Choose Node test files and pytest targets in separate runs.');
    return 'node:test';
  }
  return 'pytest';
}

export function testCommand(tests:string[], python:string) {
  const runner=chooseTestRunner(tests);
  if (runner==='pytest') return {runner, executable:python, args:candidateTestArgs(tests)};
  const args = tests.some(file=>/\.[mc]?ts$/i.test(file)) ? ['--experimental-strip-types'] : [];
  return {runner, executable:'node', args:[...args,'--test','--',...tests]};
}

async function executeTests(cwd:string, tests:string[], python:string, report:string, signal?:AbortSignal):Promise<TestRun> {
  const {runner,executable,args}=testCommand(tests,python);
  const support=path.resolve(__dirname,'..','runners');
  const env:NodeJS.ProcessEnv={};
  for(const name of ['PATH','SystemRoot','WINDIR','PATHEXT','COMSPEC','LANG','LC_ALL','TMPDIR','TMP','TEMP']){
    if(process.env[name])env[name]=process.env[name];
  }
  if(runner==='pytest'){
    env.PYTHONPATH=[support,path.join(cwd,'src'),cwd].join(path.delimiter);
    env.PYTHONDONTWRITEBYTECODE='1'; env.PYTHONIOENCODING='utf-8';
    env.PYTEST_PLUGINS='forgelens_pytest_report'; env.FORGELENS_TEST_REPORT=report;
  }else{
    args.splice(args.indexOf('--'),0,'--test-reporter=tap','--test-reporter-destination=stdout',
      '--test-reporter='+pathToFileURL(path.join(support,'node-result-reporter.cjs')).href,
      '--test-reporter-destination='+report);
  }
  signal?.throwIfAborted();
  let exitCode=0,output='';
  try{
    const result=await execute(executable,args,{cwd,env,signal,timeout:120000,maxBuffer:2*1024*1024,windowsHide:true});
    output=result.stdout+result.stderr;
  }catch(error){
    signal?.throwIfAborted();
    const failure=error as Error & {code?:number|string;killed?:boolean;stdout?:string;stderr?:string};
    if(typeof failure.code!=='number' || failure.killed)throw new Error('Candidate tests could not finish: '+failure.message);
    exitCode=failure.code;output=(failure.stdout??'')+(failure.stderr??'');
  }
  return {exitCode,output,cases:await readOutcomes(report)};
}

/** Run trusted test code in separate copies of the same saved workspace snapshot. */
export async function runCandidateTests(root: string, overlays: CandidateFile[], tests: string[], python: string, signal?: AbortSignal, fixturePins:FixturePins={}, draftPaths?:ReadonlySet<string>) {
  if (!overlays.length) throw new Error('Stage a candidate edit before validating it.');
  const runner=chooseTestRunner(tests);
  signal?.throwIfAborted();
  const scratch = await mkdtemp(path.join(tmpdir(), 'forgelens-candidate-'));
  const baselineDir=path.join(scratch,'baseline'), candidateDir=path.join(scratch,'candidate');
  try {
    await mkdir(baselineDir);
    const names = new Set(await listWorkspace(root, true));
    let bytes = 0;
    for (const name of names) {
      signal?.throwIfAborted();
      const source = await confinedPath(root, name);
      const info = await lstat(source);
      bytes += info.size;
      if (!info.isFile() || info.size > 16 * 1024 * 1024 || bytes > 128 * 1024 * 1024) {
        throw new Error('Candidate validation requires ordinary files and a workspace under 128 MiB (16 MiB per file).');
      }
      const target = path.join(baselineDir, name);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    await copyPinnedFixtures(root,baselineDir,fixturePins,signal);
    await cp(baselineDir,candidateDir,{recursive:true,filter:()=>{signal?.throwIfAborted();return true;}});
    const seen = new Set<string>();
    for (const file of overlays) {
      signal?.throwIfAborted();
      const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
      if (seen.has(key)) throw new Error('Duplicate candidate path.');
      seen.add(key);
      if (file.content.includes('\0') || file.content.length > 250000) throw new Error('Candidate must be a bounded text file.');
      const source = await confinedPath(root, file.path);
      const target = path.join(candidateDir, file.path);
      if (file.isNew) {
        try { await lstat(source); throw new Error(`New file already exists: ${file.path}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content, { flag: 'wx' });
      } else {
        if (!names.has(file.path)) throw new Error(`Candidate source is excluded or missing: ${file.path}`);
        const saved = await readFile(target, 'utf8');
        const bom = saved.startsWith('\uFEFF') && !file.original.startsWith('\uFEFF') ? '\uFEFF' : '';
        if (saved !== bom + file.original) throw new Error(`Candidate is stale or the editor has unsaved changes: ${file.path}`);
        await writeFile(target, bom + file.content);
      }
    }
    for (const test of tests) await lstat(path.join(candidateDir,test.split('::')[0]!));
    const newTargets=new Set(overlays.filter(file=>file.isNew).map(file=>file.path));
    const originalTests=tests.filter(test=>!newTargets.has(test.split('::')[0]!));
    const baseline=!tests.length || originalTests.length ? await executeTests(baselineDir,originalTests,python,path.join(scratch,'before.jsonl'),signal) : undefined;
    const candidate=await executeTests(candidateDir,tests,python,path.join(scratch,'after.jsonl'),signal);
    const comparison=compareTestRuns(runner,baseline,candidate);
    const diagnostics=candidate.output.slice(-12000);
    const repair=candidate.exitCode!==0 && draftPaths ? reviewedFailureContext(overlays,draftPaths,diagnostics) : '';
    return {exitCode:candidate.exitCode,comparison,
      feedback:`Candidate ${runner} exited ${candidate.exitCode}; ${overlays.length} staged file(s) in a temporary copy.\n${describeComparison(comparison)}\n${diagnostics}${repair}`};
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function validateCandidate(...args: Parameters<typeof runCandidateTests>): Promise<string> {
  return (await runCandidateTests(...args)).feedback;
}
