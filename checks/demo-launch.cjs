const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createFixture } = require('./desktop-preview-launch.cjs');

async function main() {
  assert.equal(process.platform, 'linux', 'Run this demonstration only in its isolated Linux CI job');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Do not launch on a personal desktop');
  const temp = process.env.RUNNER_TEMP;
  assert.ok(temp && process.env.DISPLAY, 'An isolated Xvfb display and runner temporary directory are required');
  const { runTests } = require(path.join(temp, 'forge-demo-harness/node_modules/@vscode/test-electron'));
  const { storage, folder } = createFixture(temp);
  const output = path.join(temp, 'forgelens-preview-demo');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(folder, 'README.md'), '# ForgeLens 0.2.0 — local context preview\n\nSupplemental demonstration, recorded after the original submission.\n\nThis is real VS Code on an isolated Linux desktop.\nNo provider, model run, staged edit or workspace change is demonstrated.\n\nPreview a task, inspect line ranges and open an excerpt.\nGit ignores and project exclusions keep unwanted files out.\n');
  const userData = path.join(storage, 'profile');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'workbench.startupEditor': 'none',
    'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
    'editor.fontSize': 19, 'terminal.integrated.fontSize': 18, 'window.zoomLevel': 1,
    'workbench.colorTheme': 'Default Dark Modern', 'editor.minimap.enabled': false,
    'forgelens.model': '', 'forgelens.fallbackModel': '', 'forgelens.contextScout': false,
  }));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  await runTests({
    version: 'stable', cachePath: path.join(storage, 'editor-cache'),
    extensionDevelopmentPath: path.resolve(__dirname, '..'), extensionTestsPath: path.join(__dirname, 'demo-scenario.cjs'),
    extensionTestsEnv: { FORGELENS_DEMO_FIXTURE: folder, FORGELENS_DEMO_STORAGE: storage, FORGELENS_DEMO_OUTPUT: output, FORGELENS_DEMO_PORT: String(port) },
    launchArgs: [folder, '--disable-extensions', '--disable-gpu', '--skip-welcome', '--skip-release-notes',
      '--disable-workspace-trust', '--force-device-scale-factor=1', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
      '--user-data-dir', userData, '--extensions-dir', path.join(storage, 'extensions')],
  });
  require('./demo-render.cjs').render(output);
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
