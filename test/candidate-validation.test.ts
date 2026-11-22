import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateCandidate } from '../src/candidateValidation';

const python = process.env.FORGELENS_TEST_PYTHON || 'python';
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
  assert.match(await validateCandidate(root, [proposal,testFile], tests, python), /pytest exited 1[\s\S]+1 failed/);
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
