import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import test, { type TestContext } from 'node:test';

const moduleUrl = new URL('../scripts/anonymous-model-provider.mjs', import.meta.url).href;
const localToken = 'loopback-provider-test-000000000';
const headers = { authorization: 'Bearer ' + localToken, 'content-type': 'application/json' };

async function listen(server: Server, t: TestContext) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1/chat/completions';
}

test('anonymous provider preserves native calls and never forwards credentials or paid alternatives', async t => {
  const { anonymousProvider, routes } = await import(moduleUrl);
  const model = routes.kilo.model;
  const delays: number[] = [], forwarded: RequestInit[] = [];
  let currentTime = 100_000;
  const fixture = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}\n\ndata: [DONE]\n\n';
  const server = anonymousProvider({
    localToken,
    now: () => currentTime,
    wait: async (duration: number) => { delays.push(duration); currentTime += duration; },
    forward: async (url: string, request: RequestInit) => {
      assert.equal(url, 'https://ai-gateway.kilo.ai/api/v1/chat/completions');
      forwarded.push(request);
      return forwarded.length === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '45' } })
        : new Response(fixture, { headers: { 'content-type': 'text/event-stream' } });
    }
  });
  const url = await listen(server, t);
  const draft = { model, messages: [{ role: 'user', content: 'Public coding fixture' }],
    tools: [{ type: 'function', function: { name: 'fixture' } }], stream: true };
  const body = JSON.stringify(draft);
  assert.equal((await fetch(url, { method: 'POST', body })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://example.org' }, body })).status, 403);
  assert.throws(() => anonymousProvider({ localToken, model: 'paid/alternative' }), /free model/);
  for (const changes of [{ model: 'paid/alternative' }, { models: ['paid/alternative'] }, { provider: { allow_fallbacks: true } }]) {
    const refused = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...draft, ...changes }) });
    assert.equal(refused.status, 400);
  }
  assert.equal(forwarded.length, 0);
  const reply = await fetch(url, { method: 'POST', headers, body });
  assert.equal(await reply.text(), fixture);
  assert.equal(forwarded.length, 2);
  for (const request of forwarded) {
    assert.deepEqual(request.headers, { 'content-type': 'application/json' });
    assert.equal(Buffer.from(request.body as Uint8Array).toString(), body);
    assert.equal(request.redirect, 'error');
  }
  assert.deepEqual(delays, [45_500]);
});

test('a queued caller rechecks a long 429 hold imposed by an earlier in-flight generation', async t => {
  const { anonymousProvider, routes } = await import(moduleUrl);
  const longLimit = '3456000';
  let currentTime = 100_000, forwarded = 0;
  let finishFirst!: (response: Response) => void, wakeSecond!: () => void;
  let markQueued!: () => void, markStarted!: () => void;
  const firstStarted = new Promise<void>(resolve => { markStarted = resolve; });
  const secondQueued = new Promise<void>(resolve => { markQueued = resolve; });
  const server = anonymousProvider({
    localToken, provider: 'ovh', now: () => currentTime,
    wait: (duration: number) => {
      assert.equal(duration, routes.ovh.interval);
      markQueued();
      return new Promise<void>(resolve => { wakeSecond = () => { currentTime += duration; resolve(); }; });
    },
    forward: () => {
      forwarded++;
      markStarted();
      return new Promise<Response>(resolve => { finishFirst = resolve; });
    }
  });
  const url = await listen(server, t);
  const options = { method: 'POST', headers, body: JSON.stringify({ model: routes.ovh.model, messages: [] }) };
  const first = fetch(url, options);
  await firstStarted;
  const second = fetch(url, options);
  await secondQueued;
  finishFirst(new Response('busy', { status: 429, headers: { 'retry-after': longLimit } }));
  const limited = await first;
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), longLimit);
  assert.equal(await limited.text(), 'busy');
  wakeSecond();
  const queued = await second;
  assert.equal(queued.status, 429);
  assert.ok(Number(queued.headers.get('retry-after')) >= Number(longLimit) - 32);
  assert.equal((await fetch(url, options)).status, 429);
  assert.equal(forwarded, 1);
});
