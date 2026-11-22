import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReviewStore } from '../src/review';
import { exportAcceptedPatch } from '../src/reviewExport';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
 const root=await mkdtemp(path.join(tmpdir(),'forgelens-patch-export-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 execFileSync('git',['init','-q',root],{windowsHide:true});
 execFileSync('git',['-C',root,'config','core.autocrlf','false'],{windowsHide:true});
 return root;
}
function apply(root: string, patch: string, check: boolean) {
 execFileSync('git',['-C',root,'apply',...(check?['--check']:[]),'-'],{input:Buffer.from(patch),windowsHide:true,stdio:['pipe','pipe','pipe']});
}

test('exports only accepted hunks without mutating review decisions or files',async t=>{
 const root=await fixture(t);const store=new ReviewStore();
 const original='one\ntwo\nthree\nfour\nfive\n';
 const proposal=store.stage('main.ts',original,'ONE\ntwo\nTHREE\nfour\nFIVE\n');
 assert.equal(proposal.hunks.length,3);
 store.decide('main.ts',proposal.hunks[0]!.id,'accepted');
 store.decide('main.ts',proposal.hunks[1]!.id,'rejected');
 store.stage('pending.ts','old\n','unreviewed\n');
 await writeFile(path.join(root,'main.ts'),original);await writeFile(path.join(root,'pending.ts'),'old\n');
 const snapshot=JSON.stringify(store.list());
 const patch=exportAcceptedPatch(store);
 assert.match(patch,/diff --git /);assert.ok(!patch.includes('+THREE'));assert.ok(!patch.includes('+FIVE'));assert.ok(!patch.includes('pending.ts'));
 assert.equal(JSON.stringify(store.list()),snapshot);
 assert.equal(await readFile(path.join(root,'main.ts'),'utf8'),original);
 apply(root,patch,true);
 assert.equal(await readFile(path.join(root,'main.ts'),'utf8'),original);
 apply(root,patch,false);
 assert.equal(await readFile(path.join(root,'main.ts'),'utf8'),'ONE\ntwo\nthree\nfour\nfive\n');
 assert.equal(await readFile(path.join(root,'pending.ts'),'utf8'),'old\n');
});

test('Git accepts multi-file export with spaces, Unicode, CRLF and missing final newlines',async t=>{
 const root=await fixture(t);const store=new ReviewStore();
 const cases=[
  ['src/naïve file.ts','first\r\nlast\r\n','FIRST\r\nlast\r\n'],
  ['notes/雪.txt','before','after'],
  ['add-newline.txt','line','line\n'],
  ['remove-newline.txt','line\n','line'],
  ['empty.txt','','inserted\n'],
  ['truncate.txt','removed\n',''],
  ['mixed-lines.txt','a\r\nb\nend','a\r\nB\nend'],
 ] as const;
 for(const [file,before,after] of cases){
  await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),before);
  const proposal=store.stage(file,before,after);
  for(const hunk of proposal.hunks)store.decide(file,hunk.id,'accepted');
 }
 const snapshot=JSON.stringify(store.list());const patch=exportAcceptedPatch(store);
 assert.match(patch,/\\ No newline at end of file/);
 assert.equal(JSON.stringify(store.list()),snapshot);
 apply(root,patch,true);apply(root,patch,false);
 for(const [file,,after] of cases)assert.deepEqual(await readFile(path.join(root,file)),Buffer.from(after));
});

test('export is explicitly empty for no accepted changes',()=>{
 const store=new ReviewStore();assert.equal(exportAcceptedPatch(store),'');
 const proposal=store.stage('pending.ts','old\n','new\n');assert.equal(exportAcceptedPatch(store),'');
 store.decide('pending.ts',proposal.hunks[0]!.id,'rejected');assert.equal(exportAcceptedPatch(store),'');
 store.stage('unchanged.ts','same','same');assert.equal(exportAcceptedPatch(store),'');
});

test('a per-file patch applies only accepted hunks from the selected file',async t=>{
 const root=await fixture(t),store=new ReviewStore();
 const before='one\ntwo\nthree\n',proposed='ONE\ntwo\nTHREE\n';
 for(const file of ['a.txt','b.txt']){
  await writeFile(path.join(root,file),before);
  const proposal=store.stage(file,before,proposed);
  store.decide(file,proposal.hunks[0]!.id,'accepted');
  store.decide(file,proposal.hunks[1]!.id,'rejected');
 }
 assert.equal(exportAcceptedPatch(store,'missing.txt'),'');
 const patch=exportAcceptedPatch(store,'b.txt');
 assert.doesNotMatch(patch,/a\.txt|\+THREE/);
 apply(root,patch,true);apply(root,patch,false);
 assert.equal(await readFile(path.join(root,'a.txt'),'utf8'),before);
 assert.equal(await readFile(path.join(root,'b.txt'),'utf8'),'ONE\ntwo\nthree\n');
});

test('an approved new file produces a real Git creation patch and retains its undo kind after revision',async t=>{
 const root=await fixture(t),store=new ReviewStore();
 const p=store.stage('new file.txt','','created\n','create');
 assert.equal(exportAcceptedPatch(store),'');
 store.decide(p.path,'hunk-1','accepted');
 const prior=store.get(p.path)!;
 const {createProposal,decideHunk}=await import('../src/review');
 store.commitReviewed('',prior,decideHunk(createProposal(p.path,'created\n','revised\n'),'hunk-1','accepted'));
 assert.equal(store.prepare(p.path,'').kind,'create');
 const patch=exportAcceptedPatch(store);
 assert.match(patch,/new file mode 100644/);assert.match(patch,/--- \/dev\/null/);
 apply(root,patch,true);apply(root,patch,false);
 assert.equal(await readFile(path.join(root,p.path),'utf8'),'revised\n');
});

test('export refuses unsafe paths and binary content rather than emitting a misleading patch',()=>{
 for(const file of ['../outside','/absolute','C:/outside','a\\b','a//b','bad\0name','.env']){
  const store=new ReviewStore();const proposal=store.stage(file,'old','new');store.decide(file,proposal.hunks[0]!.id,'accepted');
  assert.throws(()=>exportAcceptedPatch(store),/path/i,file);
 }
 const store=new ReviewStore();const proposal=store.stage('binary.dat','a\0b','c\0d');store.decide('binary.dat',proposal.hunks[0]!.id,'accepted');
 assert.throws(()=>exportAcceptedPatch(store),/binary/i);
});
