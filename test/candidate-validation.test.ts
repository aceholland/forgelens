import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reviewedFailureContext, validateCandidate } from '../src/candidateValidation';
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
