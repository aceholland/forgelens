const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { TrueForge } = require('@truefoundry/trueforge-sdk');

const files = {
  'src/doubles.py': 'def double(n):\n    return n\n\n\nTAG = "stable"\n',
  'tests/test_doubles.py': 'from doubles import double, TAG\n\ndef test_double():\n    assert double(2) == 2\n\ndef test_tag():\n    assert TAG == "stable"\n',
};
const proposal = { files: [
  { path: 'src/doubles.py', reason: 'Double the number', edits: [
    { oldText: 'return n', newText: 'return n * 2' },
    { oldText: 'TAG = "stable"', newText: 'TAG = "experimental"' }] },
  { path: 'tests/test_doubles.py', reason: 'Cover the new behavior', edits: [
    { oldText: 'double(2) == 2', newText: 'double(2) == 4' }] },
], tests: ['tests/test_doubles.py'] };

async function listen(server) {
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

// The model response is scripted; the HTTP server, SDK turn, MCP, editor and pytest are real.
async function start(storage, temp) {
  const cli = process.env.TRUEFORGE_CLI || path.join(temp, 'forge-preview-harness/node_modules/@truefoundry/trueforge/dist/cli.js');
  assert.ok(fs.existsSync(cli), 'Install the pinned TrueForge CLI in the harness or set TRUEFORGE_CLI');
  let calls = 0, failure, child;
  const model = http.createServer(async (req, res) => {
    try {
      if (req.url.endsWith('/models')) return res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({object:'list', data:[{id:'scripted', object:'model'}]}));
      if (!req.url.endsWith('/chat/completions')) return res.writeHead(404).end();
      const parts = [];
      for await (const chunk of req) parts.push(chunk);
      const input = JSON.parse(Buffer.concat(parts).toString());
      assert.ok(calls < 2, 'Unexpected model request');
      assert.ok(input.tools.some(tool => tool.function.name === 'propose_changes'));
      let delta;
      if (++calls === 1) {
        assert.ok(input.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('def double(n):')));
        delta = {role:'assistant', tool_calls:[{index:0, id:'review-fixture', type:'function', function:{name:'propose_changes', arguments:JSON.stringify(proposal)}}]};
      } else {
        const feedback = JSON.stringify(input.messages.filter(m => m.role === 'tool').at(-1)?.content);
        for (const observed of ['accepted', 'rejected', 'originalStart', 'Candidate pytest exited 0', '2 passed', '2 staged file(s)']) {
          assert.ok(feedback?.includes(observed), 'Missing model feedback: ' + observed);
        }
        delta = {role:'assistant', content:'Reviewed the two files and observed two passing candidate tests.'};
      }
      res.writeHead(200, {'content-type':'text/event-stream'});
      const send = (delta, finish_reason) => res.write('data: ' + JSON.stringify({id:'chatcmpl-fixture', object:'chat.completion.chunk',
        created:Math.floor(Date.now()/1000), model:'scripted', choices:[{index:0, delta, finish_reason}]}) + '\n\n');
      send(delta, null); send({}, calls === 1 ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
    } catch (error) {
      failure = error;
      console.error(error.message);
      res.writeHead(400).end(JSON.stringify({error:{message:error.message}}));
    }
  });
  const close = async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    model.closeAllConnections();
    if (model.listening) await new Promise(resolve => model.close(resolve));
  };
  try {
    const modelPort = await listen(model);
    const socket = http.createServer();
    const port = await listen(socket);
    await new Promise(resolve => socket.close(resolve));
    const url = 'http://127.0.0.1:' + port;
    const home = path.join(storage, 'trueforge-home');
    fs.mkdirSync(home);
    const env = {HOST:'127.0.0.1', STANDALONE:'true', SQLITE_PATH:path.join(home,'fixture.sqlite'),
      HOME:home, USERPROFILE:home, LOCALAPPDATA:home, APPDATA:home, TMP:home, TEMP:home, TMPDIR:home,
      NODE_ENV:'test', SENTRY_ENABLED:'false', NETWORK_POLICY_ENABLED:'true', OUTBOUND_URL_ALLOWED_HOSTS:'["127.0.0.1"]',
      MODEL_HTTP_MAX_RETRIES:'0', OUTBOUND_HTTP_MAX_RETRIES:'0', LOG_LEVEL:'warn'};
    for (const key of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT']) if (process.env[key]) env[key] = process.env[key];
    child = spawn(process.execPath, [cli, '--port', String(port)], {cwd:home, env, stdio:'inherit', windowsHide:true});
    child.once('error', error => { failure = error; });
    const deadline = Date.now() + 90000;
    for (;;) {
      if (failure) throw failure;
      assert.equal(child.exitCode, null, 'TrueForge stopped during startup');
      try { if ((await fetch(url + '/api/v1/models', {signal:AbortSignal.timeout(1000)})).ok) break; } catch {}
      assert.ok(Date.now() < deadline, 'TrueForge startup timed out'); await delay(250);
    }
    const sdk = new TrueForge({baseUrl:url, maxRetries:0});
    await sdk.settings.modelProviders.create({manifest:{type:'custom', name:'fixture',
      baseUrl:'http://127.0.0.1:' + modelPort + '/v1', auth:{apiKey:'synthetic-fixture'},
      models:[{name:'scripted', modelId:'scripted', properties:{contextLength:32000, maxOutputTokens:2048}}]}});
    return { url, close, assertComplete() { if (failure) throw failure; assert.equal(calls, 2); } };
  } catch (error) { await close(); throw error; }
}
module.exports = { files, start };
