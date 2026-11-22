import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { codeModeCommand, matchesReviewReceipt } from '../src/codeMode';
import { countsTool, reviewCountSnapshot, startReviewCountsBridge } from '../src/codeModeBridge';

const file = {path: 'private/example.ts', pending: 2, rejected: 3, accepted: 4};

test('only anonymous counts and staged test freshness leave the host', () => {
  const files = [file];
  assert.deepEqual(reviewCountSnapshot({files}), {files: [{pending: 2, rejected: 3, accepted: 4}], tests: 'not-run'});
  for (const [exit, changed, expected] of [[0, false, 'passed'], [1, false, 'failed'], [0, true, 'stale']] as const) {
    const latestStagedTest = {candidateExitCode: exit, reviewChangedSinceTest: changed, note: 'sensitive test output'};
    assert.equal(reviewCountSnapshot({files, latestStagedTest}).tests, expected);
    assert.doesNotMatch(JSON.stringify(reviewCountSnapshot({files, latestStagedTest})), /private|sensitive/);
  }
  assert.throws(() => reviewCountSnapshot({files: []}), /Review a proposed edit/);
  assert.throws(() => reviewCountSnapshot({files: Array(2049).fill(file)}), /2,048/);
  assert.throws(() => reviewCountSnapshot({files: [{...file, accepted: -1}]}));
  assert.throws(() => codeModeCommand('external-input'), /Invalid/);
});

test('MCP snapshot is immutable and verifies only an observed successful calculation', async t => {
  const source = {...file};
  const controller = new AbortController();
  const bridge = await startReviewCountsBridge({files: [source]}, controller.signal);
  t.after(() => bridge.close());
  source.pending = 99;
  const envelope = (data: object, exitCode = 0) => JSON.stringify({success: true, response: {exitCode, result: JSON.stringify(data)}});
  const valid = {receipt: bridge.receipt, ...bridge.totals};
  assert.equal(matchesReviewReceipt(envelope(valid), bridge), false);
  assert.equal((await fetch(bridge.url, {method: 'POST'})).status, 401);
  const client = new Client({name: 'test', version: '1'});
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), {requestInit: {headers: {Authorization: 'Bearer ' + bridge.token}}}));
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name), [countsTool]);
  assert.ok(tools[0].annotations?.readOnlyHint);
  const result = await client.callTool({name: countsTool, arguments: {}});
  assert.deepEqual(result.structuredContent, {files: [{accepted: 4, pending: 2, rejected: 3}], tests: 'not-run', receipt: bridge.receipt});
  assert.equal(matchesReviewReceipt(envelope(valid), bridge), true);
  for (const content of [envelope({...valid, pending: 99}), envelope({...valid, receipt: ''}), envelope(valid, 1), JSON.stringify(valid)]) {
    assert.equal(matchesReviewReceipt(content, bridge), false);
  }
  controller.abort();
  await assert.rejects(client.callTool({name: countsTool, arguments: {}}));
});
