import assert from 'node:assert/strict';
import test from 'node:test';
import {createProposal, decideHunk} from '../src/review';
import {nextPendingHunk, ReviewSummary} from '../src/reviewSummary';

test('summary keeps the latest counts per file, all-rejected files and completed test metadata', () => {
  const report = new ReviewSummary();
  const file = createProposal('app.py', 'PRIVATE_SOURCE\nkeep\nend\n', 'PRIVATE_PATCH\nkeep\nnew\n');
  const other = decideHunk(createProposal('tests/test_app.py', '', 'PRIVATE_TEST'), 'hunk-1', 'rejected');
  report.observe(file);
  report.observe(other);
  assert.equal(report.snapshot().latestStagedPytest, null);
  const reviewed = decideHunk(file, 'hunk-1', 'accepted');
  report.observe(reviewed);
  const revision = report.revision;
  report.recordTest(1, revision);
  const snapshot = report.snapshot();
  assert.deepEqual(snapshot.files, [
    {path:'app.py', accepted:1, rejected:0, pending:1},
    {path:'tests/test_app.py', accepted:0, rejected:1, pending:0},
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_/);
  assert.equal(snapshot.latestStagedPytest?.reviewChangedSinceTest, false);
  report.observe(decideHunk(reviewed, 'hunk-2', 'rejected'));
  assert.equal(report.snapshot().latestStagedPytest?.reviewChangedSinceTest, true);
  assert.equal(report.snapshot().latestStagedPytest?.exitCode, 1);
  report.recordTest(0, report.revision);
  assert.equal(report.snapshot().latestStagedPytest?.exitCode, 0);
  assert.deepEqual(snapshot.files[0], {path:'app.py', accepted:1, rejected:0, pending:1});
});

test('pending navigation rotates through files, skips decided hunks and handles a retired cursor', () => {
  const file = createProposal('a', 'one\nkeep\ntwo\n', 'ONE\nkeep\nTWO\n');
  const other = createProposal('b', 'old', 'new');
  const entries = [file, other];
  const first = nextPendingHunk(entries)!;
  assert.equal(first.hunk.id, 'hunk-1');
  assert.equal(nextPendingHunk(entries, {path:'a',id:'hunk-1'})?.hunk.id, 'hunk-2');
  assert.equal(nextPendingHunk(entries, {path:'a',id:'hunk-2'})?.file.path, 'b');
  assert.equal(nextPendingHunk(entries, {path:'b',id:'hunk-1'})?.file.path, 'a');
  const accepted = decideHunk(file,'hunk-1','accepted');
  assert.equal(nextPendingHunk([accepted,other], {path:'retired',id:'hunk-1'})?.hunk.id, 'hunk-2');
  assert.equal(nextPendingHunk([decideHunk(accepted,'hunk-2','rejected')]), undefined);
  assert.equal(nextPendingHunk([]), undefined);
});
