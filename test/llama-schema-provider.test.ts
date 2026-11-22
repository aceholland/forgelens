import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { draftInstructions } from '../src/compactContext';

function port(server: Server) {
  return (server.address() as AddressInfo).port;
}

test('the local schema provider preserves model arguments, rejects truncation and passes through later calls', {timeout: 25000}, async t => {
  const schema = {type: 'object', properties: {files: {type: 'array'}}, required: ['files']};
  const messages = [{role: 'system', content: draftInstructions}, {role: 'user', content: 'Update the example.'}];
  const first = {model: 'fixture', stream: true, messages, tools: [
    {type: 'function', function: {name: 'propose_changes', parameters: schema}},
  ]};
  // Spaces, non-ASCII text and escaped newlines must survive the tool-call conversion.
  const generated = '{ "files": [{ "path": "greeting.txt", "reason": "café", "edits":[{"beforeLine":"end","newText":"hello\\n"}] }] }';
  const originalRequests: string[] = [];
  const forwardedCredentials: (string | undefined)[] = [];
  let mode: 'complete' | 'truncated' | 'passthrough' = 'complete';
  const originalStream = 'data: {"choices":[{"delta":{"content":"Finished."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const model = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part);
    originalRequests.push(Buffer.concat(parts).toString('utf8'));
    forwardedCredentials.push(req.headers.authorization);
    res.writeHead(200, {'content-type': 'text/event-stream'});
    if (mode === 'passthrough') {
      res.end(originalStream);
      return;
    }
    for (const fragment of [generated.slice(0, 19), generated.slice(19)]) {
      res.write('data: ' + JSON.stringify({choices: [{delta: {content: fragment}}]}) + '\n\n');
    }
    res.write('data: ' + JSON.stringify({choices: [{delta: {}, finish_reason: mode === 'truncated' ? 'length' : 'stop'}]}) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  t.after(() => { model.closeAllConnections(); model.close(); });

  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const listenPort = port(reservation);
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const script = fileURLToPath(new URL('../scripts/llama-schema-draft.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, String(listenPort), String(port(model))], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let log = '';
  child.stdout.on('data', part => { log += part.toString(); });
  const base = 'http://127.0.0.1:' + listenPort;
  const deadline = Date.now() + 10000;
  while (true) {
    assert.equal(child.exitCode, null, 'The schema provider closed before startup');
    if (await fetch(base + '/health').then(r => r.ok, () => false)) break;
    assert.ok(Date.now() < deadline, 'The local provider did not start');
    await delay(50);
  }
  const post = (body: string) => fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer fixture'}, body,
  });
  const output = await (await post(JSON.stringify(first))).text();
  const events = output.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  const argumentsText = events.map(e => e.choices[0].delta.tool_calls?.[0].function.arguments || '').join('');
  assert.equal(events[0].choices[0].delta.tool_calls[0].function.name, 'propose_changes');
  assert.equal(argumentsText, generated);
  assert.equal(events.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.ok(output.endsWith('data: [DONE]\n\n'));
  assert.deepEqual(JSON.parse(originalRequests[0]), {
    model: 'fixture', stream: true, messages,
    response_format: {type: 'json_schema', json_schema: {name: 'propose_changes', strict: true, schema}},
  });
  mode = 'truncated';
  await assert.rejects(async () => { await (await post(JSON.stringify(first))).text(); });
  mode = 'passthrough';
  const next = JSON.stringify({...first, messages: [...messages, {role: 'tool', content: 'Review complete.'}]}, null, 2);
  assert.equal(await (await post(next)).text(), originalStream);
  assert.equal(originalRequests.at(-1), next);
  assert.deepEqual(forwardedCredentials, [undefined, undefined, undefined]);
  const records = log.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.equal(records[0].argumentsSha256, createHash('sha256').update(generated).digest('hex'));
});
