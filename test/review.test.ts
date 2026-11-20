import test from 'node:test';
import assert from 'node:assert/strict';
import {createProposal, decideHunk, renderProposal, prepareApply, undoEdit, ReviewStore} from '../src/review';

test('stages two line hunks without changing original; accepts and rejects independently', () => {
 const original='one\ntwo\nthree\nfour\n';
 const proposal=createProposal('a.ts',original,'ONE\ntwo\nthree\nFOUR\n');
 assert.equal(proposal.hunks.length,2);
 assert.equal(renderProposal(proposal),original);
 assert.equal(renderProposal(proposal,'all'),'ONE\ntwo\nthree\nFOUR\n');
 const reviewed=decideHunk(decideHunk(proposal,proposal.hunks[0]!.id,'accepted'),proposal.hunks[1]!.id,'rejected');
 assert.equal(renderProposal(reviewed),'ONE\ntwo\nthree\nfour\n');
 assert.equal(proposal.hunks[0]!.status,'pending');
 assert.throws(()=>decideHunk(proposal,'missing','accepted'),/Unknown hunk/);
});

test('applying and undoing reject stale text',()=>{
 const proposal=createProposal('a','a\n','b\n');
 const accepted=decideHunk(proposal,proposal.hunks[0]!.id,'accepted');
 assert.throws(()=>prepareApply(accepted,'edited\n'),/changed/);
 const edit=prepareApply(accepted,'a\n');
 assert.equal(edit.after,'b\n');
 assert.equal(undoEdit(edit,'b\n'),'a\n');
 assert.throws(()=>undoEdit(edit,'another edit\n'),/changed/);
});

test('preserves CRLF, no-final-newline, insertions and deletions',()=>{
 for(const [before,after] of [['a\r\nb\r\n','A\r\nb\r\n'],['a','ab'],['','new\n'],['gone\n',''],['a\nb','a\nx\nb']]){
  const p=createProposal('x',before!,after!);
  assert.equal(renderProposal(p,'all'),after);
 }
});

test('store cancels staged edits across files with no disk mutation',()=>{
 const store=new ReviewStore();
 const p=store.stage('a','old','new'); store.stage('b','old2','new2');
 assert.equal(store.list().length,2);
 store.decide('a',p.hunks[0]!.id,'accepted');
 assert.equal(store.apply('a','old').after,'new');
 assert.equal(store.get('a'),undefined);
 store.cancel(); assert.equal(store.list().length,0);
 assert.throws(()=>store.decide('a','x','accepted'),/Unknown proposal/);
});

test('store never replaces an unreviewed proposal silently',()=>{
 const store=new ReviewStore(); store.stage('a','old','new');
 assert.throws(()=>store.stage('a','old','other'),/already staged/);
});

test('inline scope uses exact character boundaries, not whole-line diff extent',async()=>{
 const {isWithinSelection}=await import('../src/review');
 const original='before\nreturn False\nafter\n';const start=original.indexOf('return'),end=original.indexOf('\nafter');
 assert.equal(isWithinSelection(original,'before\nreturn True\nafter\n',start,end),true);
 assert.equal(isWithinSelection(original,'CHANGED\nreturn True\nafter\n',start,end),false);
 assert.equal(isWithinSelection(original,'before\nreturn True\nCHANGED\n',start,end),false);
 assert.equal(isWithinSelection('aaaa','aaa',2,2),false);
 assert.equal(isWithinSelection(original,original,-1,end),false);
});

test('pending proposal can be revised against same original, never after review or drift',()=>{
 const s=new ReviewStore();s.stage('a','original\n','first\n');
 s.revise('a','original\n','second\n');assert.equal(s.get('a')!.original,'original\n');assert.equal(s.get('a')!.proposed,'second\n');
 assert.throws(()=>s.revise('a','drift\n','third\n'),/changed/);
 s.decide('a',s.get('a')!.hunks[0]!.id,'accepted');assert.throws(()=>s.revise('a','original\n','third\n'),/review/);
});
