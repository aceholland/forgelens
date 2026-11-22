import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reviewedFailureContext, runCandidateTests, validateCandidate } from '../src/candidateValidation';
import { reviewedCandidate } from '../src/editorReview';
import { createProposal, decideHunk } from '../src/review';

const python = process.env.FORGELENS_TEST_PYTHON || 'python';
test('failure excerpts describe the tested overlay and preserve rejected hunks and private paths', () => {
  const original=['def widget():','    return 1',...Array(12).fill('# boundary'),'SAVED = 4',''].join('\r\n');
  const proposed=original.replace('return 1','return 0').replace('SAVED = 4','REJECTED_CONTENT = 5');
  let file=createProposal('widget.py',original,proposed);
  file=decideHunk(file,'hunk-1','accepted');file=decideHunk(file,'hunk-2','rejected');
  const approved=reviewedCandidate([file],true,false);
  const output='private.py:1: error\nwidget.py:2: AssertionError\nwidget.py:15: other output';
  const summary=reviewedFailureContext([...approved,{path:'private.py',original:'a',content:'PRIVATE_CONTENT'}],new Set(['widget.py']),output);
  const excerpts=summary.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
  assert.ok(excerpts.length);
  for(const e of excerpts){
    assert.equal(e.content,approved[0]!.content.split(/\r?\n/).slice(e.startLine-1,e.endLine).join('\n'));
    assert.equal(e.path,'widget.py');
  }
  assert.match(summary,/return 0/);assert.doesNotMatch(summary,/PRIVATE_CONTENT|REJECTED_CONTENT|SAVED = 4/);
  assert.equal(reviewedFailureContext([{path:'wide.py',original:'old',content:'x'.repeat(9000)}],new Set(['wide.py']),''),'');
});
test('pytest sees accepted edits and new files only in the candidate copy, including failure and repair', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-source-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const original = 'value = 0\n';
  await writeFile(path.join(root,'values.py'), original);
  await writeFile(path.join(root,'private.txt'), 'fixture excluded');
  await writeFile(path.join(root,'.forgelensignore'), 'private.txt\n');
  const testFile = {path:'test_values.py', isNew:true, original:'',
    content:"from pathlib import Path\nfrom values import value\n\ndef test_value():\n    assert not Path('private.txt').exists()\n    assert value == 2\n"};
  const proposal = {path:'values.py', original, content:'value = 1\n'};
  const tests = ['test_values.py::test_value'];
  const regularFailure=await validateCandidate(root,[proposal,testFile],tests,python);
  assert.match(regularFailure,/pytest exited 1[\s\S]+1 failed/);
  assert.doesNotMatch(regularFailure,/Current reviewed source/);
  const scoped=new Set(['values.py']);
  const draftFailure=await validateCandidate(root,[proposal,testFile],tests,python,undefined,{},scoped);
  const repair=draftFailure.split('Current reviewed source')[1];
  assert.ok(repair);
  assert.match(repair,/exact oldText/);
  assert.match(repair,/"path":"values.py"/);
  assert.match(repair,/value = 1/);
  assert.doesNotMatch(repair,/value == 2|test_values|private.txt/);
  assert.ok(repair.length<=3200);
  const repaired=await validateCandidate(root,[{...proposal,content:'value = 2\n'},testFile],tests,python,undefined,{},scoped);
  assert.match(repaired,/pytest exited 0/);assert.doesNotMatch(repaired,/Current reviewed source/);
  assert.match(await validateCandidate(root, [{...proposal,content:'value = 2\n'},testFile], tests, python), /pytest exited 0[\s\S]+1 passed/);
  assert.equal(await readFile(path.join(root,'values.py'),'utf8'), original);
  assert.deepEqual((await readdir(root)).sort(), ['.forgelensignore','private.txt','values.py']);
});

test('stale, colliding, excluded and unsafe candidates fail before pytest can start', async t => {
  const root = await mkdtemp(path.join(tmpdir(),'forge-stale-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'code.py'),'edited in editor');
  const file={path:'code.py',original:'original',content:'candidate'};
  await assert.rejects(validateCandidate(root,[file],[],'unused'), /stale/i);
  await assert.rejects(validateCandidate(root,[{...file,isNew:true}],[],'unused'), /already exists/i);
  await assert.rejects(validateCandidate(root,[{...file,path:'.env',isNew:true}],[],'unused'), /not allowed/i);
  for (const name of ['../outside.py','-x','/absolute','test.py::thing;hi']) {
    await assert.rejects(validateCandidate(root,[file],[name],'unused'), /relative test/);
  }
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(validateCandidate(root,[file],[],'unused',cancel.signal), {name:'AbortError'});
});

test('Node compares saved and accepted JavaScript with named TypeScript cases, leaving the workspace untouched', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'forgelens-node-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const original='module.exports=0;\n', content='module.exports=1;\n';
  const file='comparison.test.mts';
  await writeFile(path.join(root,'value.cjs'),original);
  await writeFile(path.join(root,file),[
    "import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import value from './value.cjs';", "const typed:number=value;",
    "test('old',()=>assert.equal(typed,0));", "test('new',()=>assert.equal(typed,1));",
    "test('legacy',()=>assert.fail('existing failure'));", "test.skip('pending',()=>{});","",
  ].join('\n'));
  const result=await runCandidateTests(root,[{path:'value.cjs',original,content}],[file],python);
  assert.equal(result.exitCode,1,result.feedback);
  assert.deepEqual(result.comparison,{runner:'node:test',baselineExitCode:1,candidateExitCode:1,
    newlyFailing:[file+'::old'],alreadyFailing:[file+'::legacy'],nowPassing:[file+'::new'],candidateOnlyFailures:[]});
  assert.equal(await readFile(path.join(root,'value.cjs'),'utf8'),original);
  assert.deepEqual((await readdir(root)).sort(),[file,'value.cjs']);
  await assert.rejects(runCandidateTests(root,[{path:'value.cjs',original,content}],[file,'test_other.py'],python),/separate runs/);
});

test('pytest compares named baseline and candidate outcomes and reports a candidate-only failing test', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'forgelens-py-comparison-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const original='value=0\n',content='value=1\n';
  const file='test_compare.py';
  await writeFile(path.join(root,'value.py'),original);
  await writeFile(path.join(root,file),[
    'from value import value','def test_old():','    assert value == 0',
    'def test_new():','    assert value == 1','def test_legacy():','    assert False','',
  ].join('\n'));
  const newFile={path:'test_created.py',original:'',content:'def test_extra():\n    assert False\n',isNew:true};
  const result=await runCandidateTests(root,[{path:'value.py',original,content},newFile],[file,newFile.path],python);
  assert.deepEqual(result.comparison,{runner:'pytest',baselineExitCode:1,candidateExitCode:1,
    newlyFailing:[file+'::test_old'],alreadyFailing:[file+'::test_legacy'],nowPassing:[file+'::test_new'],
    candidateOnlyFailures:['test_created.py::test_extra']},result.feedback);
  assert.equal(await readFile(path.join(root,'value.py'),'utf8'),original);
  assert.deepEqual((await readdir(root)).sort(),[file,'value.py']);
});
