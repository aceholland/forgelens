import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { registerMcp } from '../src/client';

test('MCP registration reaches an IPv6 loopback TrueForge API without the process-wide fetch', async t => {
  let requestBody: { manifest: { name: string; type: string; url: string; auth?: unknown } } | undefined;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, '/api/v1/settings/mcp-servers');
    assert.equal(req.method, 'POST');
    let body = '';
    for await (const chunk of req) body += chunk;
    requestBody = JSON.parse(body);
    const { auth: _auth, ...manifest } = requestBody!.manifest;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { manifest, name: manifest.name, authStatus: { status: 'authenticated' } } }));
  });
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '::1', resolve));
  } catch (err) {
    if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes((err as NodeJS.ErrnoException).code ?? '')) {
      t.skip('IPv6 loopback unavailable');
      return;
    }
    throw err;
  }
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  // Model a global dispatcher that cannot reach ::1, without touching proxy environment settings.
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('test global dispatcher could not reach IPv6 loopback'); });
  await registerMcp(`http://[::1]:${address.port}`, 'local-test', 'http://127.0.0.1:1234/mcp', 'test-only-bearer');
  assert.equal(requestBody?.manifest.name, 'local-test');
  assert.equal(requestBody?.manifest.type, 'remote');
  assert.equal(requestBody?.manifest.url, 'http://127.0.0.1:1234/mcp');
  assert.deepEqual(requestBody?.manifest.auth, { type: 'header', headers: { Authorization: 'Bearer test-only-bearer' } });
});

test('loopback MCP registration does not follow a redirect with the manifest or bearer token', async t => {
  const server = http.createServer((_req, res) => {
    res.writeHead(307, { location: 'http://invalid.example/api/v1/settings/mcp-servers' });
    res.end();
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  // A redirect-policy failure, rather than a network lookup of the target.
  await assert.rejects(registerMcp(`http://127.0.0.1:${address.port}`, 'local-test', 'http://127.0.0.1:1234/mcp', 'test-only-bearer'),
    (err: unknown) => {
      const wrapped = err as {cause?: {cause?: {message?: string}}};
      return /unexpected redirect/i.test(wrapped.cause?.cause?.message ?? '');
    });
});
