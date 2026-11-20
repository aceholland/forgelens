import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const host = '127.0.0.1';
const port = 11435;
const route = '/openai/v1/chat/completions';
const destination = `https://api.groq.com${route}`;
const maximumBodyBytes = 2 * 1024 * 1024;
const retryLimit = 3;
const deadlineMs = 210_000;
const cushionMs = 350;
const maximumToolErrorBytes = 64 * 1024;

function reject(response, status, message) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    Connection: 'close',
  });
  response.end(JSON.stringify({ error: { message } }));
}

function retryDelay(header) {
  if (!header) return null;
  const milliseconds = /^\d+$/.test(header)
    ? Number(header) * 1000
    : Date.parse(header) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) + cushionMs : null;
}

async function isRejectedToolGeneration(response) {
  if (response.status !== 400 || !response.headers.get('content-type')?.includes('application/json')) {
    return false;
  }
  const reader = response.clone().body?.getReader();
  if (!reader) return false;

  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximumToolErrorBytes) {
        void reader.cancel().catch(() => {});
        return false;
      }
      chunks.push(value);
    }
    const { error } = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    return error?.code === 'tool_use_failed' || (
      typeof error?.failed_generation === 'string' &&
      typeof error?.message === 'string' &&
      error.message.startsWith('Parsing failed.')
    );
  } catch {
    return false;
  }
}

function providerBody(buffer) {
  const request = JSON.parse(buffer.toString('utf8'));
  if (!['openai/gpt-oss-120b', 'openai/gpt-oss-20b'].includes(request.model)) return buffer;

  // Groq supports tool calls with reasoning output disabled, and rejects the
  // reasoning_content field that generic clients can attach to assistant history.
  request.include_reasoning = false;
  for (const message of request.messages ?? []) {
    if (message.role === 'assistant') delete message.reasoning_content;
  }
  return Buffer.from(JSON.stringify(request));
}

function gateway(forward = fetch) {
  return createServer(async (request, response) => {
    if (request.url !== route) return reject(response, 404, 'Not found');
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      return reject(response, 405, 'POST required');
    }
    const authorization = request.headers.authorization;
    if (!authorization || !/^Bearer [A-Za-z0-9._~+/=-]+$/i.test(authorization)) {
      return reject(response, 401, 'Bearer authorization required');
    }
    if (Number(request.headers['content-length']) > maximumBodyBytes) {
      return reject(response, 413, 'Request body too large');
    }

    const disconnected = new AbortController();
    response.once('close', () => disconnected.abort());
    const deadline = performance.now() + deadlineMs;
    const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(deadlineMs)]);
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > maximumBodyBytes) return reject(response, 413, 'Request body too large');
        chunks.push(chunk);
      }
      let body;
      try {
        body = providerBody(Buffer.concat(chunks, length));
      } catch {
        return reject(response, 400, 'Invalid chat completion body');
      }
      let upstream;
      let toolGenerationRetried = false;
      for (let retries = 0; ; retries++) {
        upstream = await forward(destination, {
          method: 'POST',
          headers: {
            Authorization: authorization,
            'Content-Type': 'application/json',
          },
          body,
          redirect: 'error',
          signal,
        });
        let delay = upstream.status === 429 && retries < retryLimit
          ? retryDelay(upstream.headers.get('retry-after'))
          : null;
        // A provider rejection returned no tool call to the editor. Retry that
        // generation once, keeping the submitted prompt and approved tools intact.
        if (delay === null && retries < retryLimit && !toolGenerationRetried &&
            await isRejectedToolGeneration(upstream)) {
          delay = 1000;
          toolGenerationRetried = true;
        }
        if (delay === null || performance.now() + delay >= deadline) break;
        await upstream.body?.cancel();
        await sleep(delay, undefined, { signal });
      }

      for (const header of ['content-type', 'retry-after']) {
        const value = upstream.headers.get(header);
        if (value !== null) response.setHeader(header, value);
      }
      response.writeHead(upstream.status);
      if (upstream.body) {
        await pipeline(Readable.fromWeb(upstream.body), response, { signal });
      } else {
        response.end();
      }
    } catch {
      if (disconnected.signal.aborted) return;
      if (response.headersSent) {
        response.destroy();
      } else if (signal.aborted) {
        reject(response, 504, 'Request deadline elapsed');
      } else {
        reject(response, 502, 'Upstream connection failed');
      }
    }
  });
}

async function selfCheck() {
  let calls = 0;
  const server = gateway(async (url, options) => {
    assert.equal(url, destination);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer self-check');
    const body = JSON.parse(options.body.toString());
    assert.equal(body.include_reasoning, false);
    assert.deepEqual(body.messages, [{ role: 'assistant', content: 'test' }]);
    calls++;
    if (calls === 1) {
      return new Response('retry', { status: 429, headers: { 'Retry-After': '0' } });
    }
    if (calls === 2 || calls === 4 || calls === 5) {
      return Response.json({ error: { code: 'tool_use_failed' } }, { status: 400 });
    }
    if (calls === 3) return new Response('upstream error', { status: 503 });
    return Response.json({ error: { code: 'invalid_request_error' } }, { status: 400 });
  });
  server.listen(0, host);
  await once(server, 'listening');
  try {
    const base = `http://${host}:${server.address().port}`;
    assert.equal((await fetch(base + '/wrong')).status, 404);
    assert.equal((await fetch(base + route)).status, 405);
    assert.equal((await fetch(base + route, { method: 'POST' })).status, 401);
    const headers = { Authorization: 'Bearer self-check' };
    assert.equal((await fetch(base + route, {
      method: 'POST', headers, body: Buffer.alloc(maximumBodyBytes + 1),
    })).status, 413);
    assert.equal(calls, 0);
    const body = JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'assistant', content: 'test', reasoning_content: 'test' }],
    });
    const result = await fetch(base + route, { method: 'POST', headers, body });
    assert.equal(result.status, 503);
    assert.equal(await result.text(), 'upstream error');
    assert.equal(calls, 3);

    const exhausted = await fetch(base + route, { method: 'POST', headers, body });
    assert.equal(exhausted.status, 400);
    assert.deepEqual(await exhausted.json(), { error: { code: 'tool_use_failed' } });
    assert.equal(calls, 5);

    const invalid = await fetch(base + route, { method: 'POST', headers, body });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: { code: 'invalid_request_error' } });
    assert.equal(calls, 6);
    process.stdout.write('Groq gateway self-check passed without external requests.\n');
  } finally {
    server.close();
  }
}

const [option, ...extra] = process.argv.slice(2);
if (option === '--self-check' && extra.length === 0) {
  await selfCheck();
} else if (option === undefined) {
  gateway().listen(port, host, () => {
    process.stdout.write(`Groq demo gateway listening on http://${host}:${port}\n`);
  });
} else {
  process.stderr.write('Usage: node groq-demo-gateway.mjs [--self-check]\n');
  process.exitCode = 2;
}
