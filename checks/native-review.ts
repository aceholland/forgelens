import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { codeModeCommand, runCodeModeReview } from '../src/codeMode';
import { reviewSkillReadCommand, reviewSkillManifest } from '../src/nativeSkill';

async function listen(server: http.Server) {
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

// Only the model is scripted. The service downloads the skill and runs its Python
// helper in its OS sandbox. The helper reaches the product's actual editor MCP.
async function main() {
  const cli = process.env.TRUEFORGE_CLI;
  assert.ok(cli && path.isAbsolute(cli));
  const scratch = await mkdtemp('/tmp/flr-'); // Short path for Darwin Unix-domain sockets.
  await mkdir(path.join(scratch, 'home'));
  const project = path.join(scratch, 'project');
  await mkdir(project);
  const original = 'export const answer = 42;\n';
  await writeFile(path.join(project, 'sample.ts'), original);
  const providerSteps: string[] = [];
  let failure: unknown;
  const provider = http.createServer(async (req, res) => {
    try {
      if (req.url?.endsWith('/models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({object: 'list', data: [{id: 'scripted', object: 'model'}]}));
        return;
      }
      assert.ok(req.url?.endsWith('/chat/completions'), req.url);
      const body: Buffer[] = [];
      for await (const part of req) body.push(part);
      const request = JSON.parse(Buffer.concat(body).toString());
      const history = JSON.stringify(request.messages);
      assert.ok(!history.includes('PRIVATE_FIXTURE_PATH'), 'A file path reached the model.');
      const connector = history.match(/forgelens-review-[0-9a-f]{16}/)?.[0];
      assert.ok(connector, 'Missing per-review connector in the actual request');
      const commands = [reviewSkillReadCommand, codeModeCommand(connector)];
      const step = providerSteps.length;
      assert.ok(step <= commands.length, 'Unexpected model retry');
      let delta: object;
      let finish: string;
      if (step < commands.length) {
        const names = request.tools.map((tool: {function: {name: string}}) => tool.function.name);
        const name = names.find((item: string) => /(?:^|_)exec$/.test(item));
        assert.ok(name, 'Missing native sandbox exec in ' + names.join(', '));
        if (step === 1) assert.ok(history.includes('Read the `tests` field'), 'The skill contents did not reach the model: ' + history.slice(-1800));
        delta = {role:'assistant', tool_calls:[{index:0, id:'sandbox-call-' + step, type:'function',
          function:{name, arguments:JSON.stringify({command:commands[step], intent:step === 0 ? 'Read the review checklist' : 'Summarize review counts'})}}]};
        providerSteps.push(step === 0 ? 'read-checklist' : 'run-python-mcp');
        finish = 'tool_calls';
      } else {
        assert.ok(history.includes('receipt') && history.includes('stale'), 'Expected native Python output: ' + history.slice(-1600));
        delta = {role:'assistant', content:'Resolve the pending change and rerun the staged tests.'};
        providerSteps.push('report');
        finish = 'stop';
      }
      res.writeHead(200, {'content-type':'text/event-stream'});
      for (const [data, reason] of [[delta,null], [{},finish]]) {
        res.write('data: ' + JSON.stringify({id:'review-' + step, object:'chat.completion.chunk', created:1,
          model:'scripted', choices:[{index:0, delta:data, finish_reason:reason}]}) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      failure = error;
      res.writeHead(400).end(JSON.stringify({error:{message:'Unexpected deterministic provider request'}}));
    }
  });
  const providerPort = await listen(provider);
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const base = 'http://127.0.0.1:' + port;
  const output = createWriteStream(path.join(scratch, 'server.log'));
  // A real desktop project and the service's private application data are siblings.
  const child = spawn(process.execPath, [cli, '--port', String(port)], {cwd:project, stdio:['ignore','pipe','pipe'],
    env:{PATH:process.env.PATH, HOST:'127.0.0.1', HOME:path.join(scratch,'home'), TMPDIR:'/tmp',
      STANDALONE:'true', SQLITE_PATH:path.join(scratch,'state.sqlite'), NODE_ENV:'test', SENTRY_ENABLED:'false',
      LOG_LEVEL:'warn', ACCESS_LOGS:'false', NETWORK_POLICY_ENABLED:'true',
      OUTBOUND_URL_ALLOWED_HOSTS:'["127.0.0.1","github.com","api.github.com","codeload.github.com","raw.githubusercontent.com"]',
      MODEL_HTTP_MAX_RETRIES:'0', OUTBOUND_HTTP_MAX_RETRIES:'0'}});
  child.stdout.pipe(output, {end:false});
  child.stderr.pipe(output, {end:false});
  let passed = false;
  try {
    for (let tries=0; ; tries++) {
      assert.equal(child.exitCode, null, 'TrueForge exited before health check');
      try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
      assert.ok(tries < 240, 'TrueForge startup timeout');
      await delay(250);
    }
    const client = new TrueForge({baseUrl:base, maxRetries:0});
    await client.settings.modelProviders.create({manifest:{type:'custom',name:'local-review',
      baseUrl:'http://127.0.0.1:' + providerPort + '/v1',auth:{apiKey:'synthetic-loopback-fixture'},
      models:[{name:'scripted',modelId:'scripted',properties:{contextLength:32000,maxOutputTokens:2048}}]}});
    const files = [{path:'PRIVATE_FIXTURE_PATH/a',accepted:2,rejected:0,pending:0},
      {path:'PRIVATE_FIXTURE_PATH/b',accepted:1,rejected:2,pending:1}];
    const receipt = await runCodeModeReview(base,'local-review/scripted',
      {files, latestStagedTest:{candidateExitCode:0,reviewChangedSinceTest:true}}, AbortSignal.timeout(180000));
    assert.deepEqual(providerSteps, ['read-checklist','run-python-mcp','report']);
    const {sessionId, ...counts} = receipt;
    assert.ok(sessionId);
    assert.deepEqual(counts, {files:2,accepted:3,pending:1,rejected:2,tests:'stale'});
    const registrations = await client.settings.mcpServers.list();
    assert.ok(registrations.data.every(item => !item.name.startsWith('forgelens-review-')));
    assert.deepEqual(await readdir(project), ['sample.ts']);
    assert.equal(await readFile(path.join(project,'sample.ts'),'utf8'), original);
    console.log('FORGELENS_NATIVE_REVIEW_PASS ' + JSON.stringify({platform:process.platform,
      skillCommit:reviewSkillManifest.ref, provider:'deterministic loopback', steps:providerSteps, ...receipt}));
    passed = true;
  } catch (error) {
    const log = await readFile(path.join(scratch,'server.log'),'utf8').catch(() => '');
    console.error(log.split('\n').slice(-12).join('\n'));
    throw failure ?? error;
  } finally {
    child.kill();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    output.end();
    if (passed) await rm(scratch, {recursive:true, force:true});
  }
}

main().catch(error => {console.error(error); process.exitCode = 1;});
