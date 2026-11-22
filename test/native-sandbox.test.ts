import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { assertLocalNativeSandbox } from '../src/nativeSandbox';

function sandboxServer(enabled: boolean, providerStatus = 404, providerMessage = 'No sandbox provider configured', managed = false) {
  const calls: string[] = [];
  const client = new TrueForge({
    baseUrl: 'http://127.0.0.1:8790',
    fetch: async (input) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      calls.push(path);
      const json = (body: unknown, status = 200) => Response.json(body, {status});
      if (path.endsWith('/capabilities')) return json({data: {
        sandbox: {enabled, environments: {enabled: true}},
        settings: {sandbox_providers: {enabled: !managed, manage_providers: !managed}}
      }});
      if (path.endsWith('/auth/me')) return json({data: {type: 'default', tenant_id: 'test', roles: [], subject: {}}});
      if (path.endsWith('/settings/sandbox-providers')) return providerStatus === 200
        ? json({data: {manifest: {type: 'daytona'}}})
        : json({error: {message: providerMessage}}, providerStatus);
      throw Error('Unexpected request ' + path);
    }
  });
  return {client, calls};
}

const signal = new AbortController().signal;
test('permits the native standalone sandbox only when the server reports local support and no configured provider', async () => {
  const {client, calls} = sandboxServer(true);
  await assertLocalNativeSandbox(client, signal);
  assert.equal(calls.length, 3);
});

test('unavailable and managed sandboxes are rejected before a session can start', async () => {
  const unavailable = sandboxServer(false);
  await assert.rejects(assertLocalNativeSandbox(unavailable.client, signal), /no native sandbox/);
  assert.equal(unavailable.calls.length, 1);
  const managed = sandboxServer(true, 404, undefined, true);
  await assert.rejects(assertLocalNativeSandbox(managed.client, signal), /standalone/);
  await assert.rejects(assertLocalNativeSandbox(sandboxServer(true, 200).client, signal), /external sandbox/);
});

test('an unrelated 404 and a denied provider lookup both fail closed', async () => {
  for (const code of [403, 404]) {
    const {client} = sandboxServer(true, code, 'Wrong endpoint');
    await assert.rejects(assertLocalNativeSandbox(client, signal));
  }
});
