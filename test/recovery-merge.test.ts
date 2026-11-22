import test from 'node:test';
import assert from 'node:assert/strict';
import {createProposal,decideHunk,renderProposal,ReviewStore} from '../src/review';
import {prepareMerge,resolveMerge} from '../src/reviewMerge';
import {ReviewJournal,saveReview,restoreReview} from '../src/reviewRecovery';

const file=()=>{let p=createProposal('lib/a.ts','a\nb\nc\nd\ne\n','A\nb\nC\nd\nE\n');p=decideHunk(p,'hunk-1','accepted');return decideHunk(p,'hunk-2','rejected');};
test('recovery rebuilds all decisions and preserves an in-flight second round against its accepted overlay',async()=>{
  const first=file();const base=renderProposal(first);
  const delta=createProposal(first.path,base,base+'f\n');
  const restored=await restoreReview(saveReview([first],[delta]),async()=>first.original);
  assert.deepEqual(restored,{staged:[first],live:[delta]});
  await assert.rejects(restoreReview(saveReview([first],[delta]),async()=>'external edit'),/have changed/);
  await assert.rejects(restoreReview(saveReview([first],[createProposal(first.path,first.original,'different')]),async()=>first.original),/layers do not match/);
});
test('saved new files require a still-missing path and malformed state or stale hashes cannot be restored',async()=>{
  const p=createProposal('notes/new.txt','','created');p.kind='create';
  const snap=saveReview([p],[]);assert.deepEqual((await restoreReview(snap,async f=>{assert.equal(f.kind,'create');return '';})).staged,[p]);
  await assert.rejects(restoreReview(snap,async()=>{throw Error('collision');}),/notes\/new.txt/);
  snap.staged[0]!.originalHash='wrong';await assert.rejects(restoreReview(snap,async()=>''),/Invalid saved review/);
});
test('only opted-in folders persist, changes flush in order and an applied review cannot reappear',async()=>{
  const entries=new Map<string,unknown>();const adapter={get:<T>(key:string)=>entries.get(key) as T|undefined,update:async(k:string,v:unknown)=>{entries.set(k,v);}};
  const j=new ReviewJournal(adapter,e=>assert.fail(String(e)));const p=file();j.capture('folder',[p],[]);assert.equal(entries.size,0);
  j.enable('folder',true);j.capture('folder',[p],[]);await j.flush();
  const restored=new ReviewJournal(adapter,e=>assert.fail(String(e)));assert.ok(restored.get('folder')?.checkpoint);assert.equal(restored.get('other'),undefined);
  j.capture('folder',[],[]);await j.flush();assert.deepEqual(new ReviewJournal(adapter,e=>assert.fail(String(e))).get('folder'),{});
});
test('three-way text merge combines disjoint edits and keeps conflict resolution in memory',()=>{
  const p=decideHunk(createProposal('a.ts','one\ntwo\nthree\n','one\nTWO\nthree\n'),'hunk-1','accepted');
  const local='local one\ntwo\nthree\n';const merge=prepareMerge(p,local,'abc');
  assert.equal(merge.conflicts,0);assert.equal(merge.merged,'local one\nTWO\nthree\n');
  const resolved=resolveMerge(p,merge,local,merge.merged);assert.equal(renderProposal(resolved),merge.merged);assert.equal(resolved.original,local);
  const overlap=prepareMerge(p,'one\nlocal two\nthree\n','token');assert.equal(overlap.conflicts,1);
  assert.match(overlap.merged,/<<<<<<< Workspace token\nlocal two\n/);assert.match(overlap.merged,/\|\|\|\|\|\|\| Original token\ntwo\n/);
  assert.throws(()=>resolveMerge(p,overlap,overlap.local,overlap.merged),/marker lines/);
  assert.throws(()=>resolveMerge(p,overlap,'newer content','user choice'),/changed while resolving/);
  assert.equal(renderProposal(resolveMerge(p,overlap,overlap.local,'user choice')),'user choice');
});
test('a new-file collision becomes a reviewed edit of the local file, and stale review decisions cannot be overwritten',()=>{
  const store=new ReviewStore();const created=store.stage('a.txt','','proposal','create');const p=store.decide(created.path,'hunk-1','accepted');
  const merge=prepareMerge(p,'local','id');const resolved=resolveMerge(p,merge,'local','both');
  assert.equal(resolved.kind,undefined);assert.equal(resolved.original,'local');
  store.replaceResolved(p,resolved);assert.equal(store.prepare(p.path,'local').after,'both');
  assert.throws(()=>store.replaceResolved(p,resolved),/changed while resolving/);
});
