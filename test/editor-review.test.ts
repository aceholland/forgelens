import test from 'node:test';
import assert from 'node:assert/strict';
import { createProposal, decideHunk, renderProposal, ReviewStore } from '../src/review';
import { LiveReviews, lensOffsets, reviewFeedback } from '../src/editorReview';

test('a live tool receives exact original offsets and per-hunk review without writing', async () => {
  const live = new LiveReviews(), store = new ReviewStore();
  const before = 'a\nx\nc\n', proposal = createProposal('f', before, 'alphabet\nx\nC\n');
  const request = live.begin(proposal);
  assert.deepEqual(lensOffsets(proposal), [{id:'hunk-1',offset:0},{id:'hunk-2',offset:11}]);
  assert.deepEqual(lensOffsets(proposal,[proposal.hunks[1]!]),[{id:'hunk-2',offset:4}]);
  live.decide(request, 'hunk-2', 'rejected');
  live.decide(request, undefined, 'accepted');
  const reviewed = await request.result;
  const feedback = JSON.parse(reviewFeedback(reviewed));
  assert.deepEqual(feedback.hunks, [
    {id:'hunk-1',decision:'accepted',originalStart:0,originalEndExclusive:2},
    {id:'hunk-2',decision:'rejected',originalStart:4,originalEndExclusive:6},
  ]);
  store.commitReviewed(before, undefined, reviewed);
  assert.equal(renderProposal(store.get('f')!), 'alphabet\nx\nc\n');
  live.end(request);
  const next = live.begin(createProposal('f', 'alphabet\nx\nc\n', 'alphabet\nx\nlast\n'));
  live.decide(request, 'hunk-2', 'accepted');
  assert.equal(next.proposal.hunks[0]!.status,'pending');
  live.decide(next, undefined,'accepted');
  store.commitReviewed(before, store.get('f'), await next.result);
  assert.deepEqual(store.prepare('f', before),{path:'f',before,after:'alphabet\nx\nlast\n'});
});

test('parallel tool calls review separate files and cancel every pending wait', async () => {
  const live = new LiveReviews();
  const first = live.begin(createProposal('a','old','new'));
  const second = live.begin(createProposal('b','first','second'));
  assert.throws(()=>live.begin(createProposal('a','old','other')), /under review/);
  const refused = Promise.all([assert.rejects(first.result,/closed/),assert.rejects(second.result,/closed/)]);
  live.cancel('panel closed');
  await refused;
  live.decide(first,undefined,'accepted');
  assert.deepEqual(live.list(),[]);
});

test('all rejected edits, partially decided deltas and stale overlay snapshots cannot introduce changes', () => {
  const store = new ReviewStore(), delta = createProposal('f','before','after');
  assert.throws(()=>store.commitReviewed('before',undefined,delta), /incomplete/);
  store.commitReviewed('before',undefined,decideHunk(delta,'hunk-1','rejected'));
  assert.equal(store.get('f'),undefined);
  store.stage('f','before','different');
  assert.throws(()=>store.commitReviewed('before',undefined,decideHunk(delta,'hunk-1','accepted')), /changed/);
  assert.equal(store.get('f')!.proposed,'different');
});
