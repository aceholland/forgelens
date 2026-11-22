import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const host = '127.0.0.1';
const maximumBodyBytes = 2 * 1024 * 1024;
const maximumWaitMs = 120_000;
const kiloRateWindowMs = 60 * 60_000;
export const routes = {
  kilo: {
    target: 'https://ai-gateway.kilo.ai/api/v1/chat/completions',
    model: 'recursive/flint-v1.0:free',
    interval: 18_100
  },
  ovh: {
    target: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
    model: 'DeepSeek-V4.1-Flash-1017',
    interval: 32_000
  }
};

function errorResponse(response, status, message) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { message } }));
}

function retryDelay(header, now) {
  if (!header) return 61_000;
  const milliseconds = /^\d+(?:\.\d+)?$/.test(header)
    ? Number(header) * 1000
    : Date.parse(header) - now;
  return Number.isFinite(milliseconds) ? Math.max(1000, milliseconds + 500) : 61_000;
}

async function isKiloAccountLimit(response) {
  const data = await response.clone().json().catch(() => null);
  const message = data?.error?.message;
  return typeof message === 'string' && (
    /^sign up for free to continue\b[\s\S]*\bcome back later\b/i.test(message) ||
    /^rate limit exceeded for free models\b/i.test(message)
  );
}

// Each request can reach only one fixed provider and model. The local access
// token is checked at the boundary and never appears in the upstream request.
export function anonymousProvider({
  localToken, provider = 'kilo', model, forward = fetch, wait = sleep,
  now = Date.now, observe, checkPublicInput
} = {}) {
  if (!Object.hasOwn(routes, provider)) throw Error('Choose kilo or ovh.');
  const { target, interval } = routes[provider];
  model ??= routes[provider].model;
  if (provider === 'kilo' && !model.endsWith(':free')) throw Error('Choose an explicit free model ID.');
  if (typeof localToken !== 'string' || localToken.length < 24) {
    throw Error('Set a local access token of at least 24 characters.');
  }
  const auth = Buffer.from('Bearer ' + localToken);
  let nextStart = 0;

  async function waitForSlot(signal) {
    for (;;) {
      signal.throwIfAborted();
      const current = now();
      const delay = nextStart - current;
      if (delay > maximumWaitMs) return delay;
      if (delay <= 0) {
        nextStart = current + interval;
        return 0;
      }
      // Another request can receive a 429 while this one is waiting. Recheck
      // the shared deadline on every wake, before sending anything upstream.
      await wait(delay, undefined, { signal });
    }
  }

  return createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization || '');
    const localHost = host + ':' + request.socket.localPort;
    if (request.headers.origin || request.headers.host !== localHost ||
        supplied.length !== auth.length || !timingSafeEqual(supplied, auth)) {
      return errorResponse(response, 403, 'Local provider access denied.');
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
      return;
    }
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      return errorResponse(response, 404, 'Unknown route.');
    }
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return errorResponse(response, 415, 'JSON required.');
    }

    const controller = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) controller.abort();
    });
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8 * 60_000)]);
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes <= maximumBodyBytes) chunks.push(chunk);
      }
      if (bytes > maximumBodyBytes) return errorResponse(response, 413, 'Request too large.');
      const buffer = Buffer.concat(chunks, bytes);
      let body;
      try {
        body = JSON.parse(buffer.toString('utf8'));
      } catch {
        return errorResponse(response, 400, 'Invalid JSON.');
      }
      if (body?.model !== model || !Array.isArray(body.messages) ||
          'models' in body || 'provider' in body || 'plugins' in body) {
        return errorResponse(response, 400, 'Choose the configured single model and supply messages.');
      }
      if (checkPublicInput && !checkPublicInput(body)) {
        return errorResponse(response, 403, 'Local information in proposed outbound request.');
      }

      for (let attempt = 1; ; attempt++) {
        const held = await waitForSlot(signal);
        if (held) {
          response.setHeader('retry-after', String(Math.ceil(held / 1000)));
          return errorResponse(response, 429, 'Anonymous model quota will become available later.');
        }
        const result = await forward(target, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: buffer, signal, redirect: 'error'
        });
        observe?.({
          time: new Date(now()).toISOString(), status: result.status, attempt, model,
          inputBytes: bytes, maxOutputTokens: body.max_tokens ?? body.max_completion_tokens ?? null,
          retryAfter: result.headers.get('retry-after'), requestId: result.headers.get('x-request-id')
        });
        let retryAfter = result.headers.get('retry-after');
        if (result.status === 429) {
          const accountLimited = provider === 'kilo' && await isKiloAccountLimit(result);
          // An explicit anonymous-account limit applies across Kilo's free models.
          // When no reset is supplied, pause this helper for its documented hourly window.
          if (accountLimited && !retryAfter) retryAfter = String(kiloRateWindowMs / 1000);
          const delay = retryDelay(retryAfter, now());
          nextStart = Math.max(nextStart, now() + delay);
          if (!accountLimited && attempt < 3 && delay <= maximumWaitMs) {
            await result.body?.cancel();
            continue;
          }
        }
        const headers = { 'content-type': result.headers.get('content-type') || 'application/json' };
        if (retryAfter) headers['retry-after'] = retryAfter;
        response.writeHead(result.status, headers);
        response.flushHeaders();
        if (result.body) await pipeline(Readable.fromWeb(result.body), response, { signal });
        else response.end();
        return;
      }
    } catch {
      if (response.headersSent) response.destroy();
      else errorResponse(response, 502, 'The anonymous model request could not finish.');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const provider = process.argv[2] || 'kilo';
  const model = process.argv[3] || routes[provider]?.model;
  const port = Number(process.argv[4] || 18940);
  const token = randomBytes(32).toString('hex');
  const server = anonymousProvider({ localToken: token, provider, model });
  server.listen(port, host, () => {
    console.log('TrueForge provider URL: http://' + host + ':' + server.address().port + '/v1');
    console.log('Model: ' + model + '\nLocal access token: ' + token);
  });
}
