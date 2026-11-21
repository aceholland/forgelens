const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const FLASK_PIN = '22d924701a6ae2e4cd01e9a15bbaf3946094af65';
const git = (folder, ...args) => execFileSync('git', ['--no-optional-locks', '-c', 'credential.helper=', '-C', folder, ...args], { encoding: 'utf8', timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: 'pipe' });
function trackedSnapshot(folder) {
  return Object.fromEntries(git(folder, 'ls-files', '-z').split('\0').filter(Boolean).map(file => [file,
    createHash('sha256').update(fs.readFileSync(path.join(folder, file))).digest('hex')]));
}
function taskPrompt() {
  const line = fs.readFileSync(path.resolve(__dirname, '../WINDOWS_RUNBOOK.md'), 'utf8').split(/\r?\n/).find(value => value.startsWith('> Add a new built-in CLI command'));
  assert.ok(line, 'The canonical Task B prompt must be present in the runbook');
  const prompt = line.slice(2);
  assert.equal(Buffer.byteLength(prompt), 296);
  assert.equal(createHash('sha256').update(prompt).digest('hex'), 'adf0a71141397baaec45456103eec636889bfb57789532a01a7d9daa5d793fd1');
  return prompt;
}

async function main() {
  assert.equal(process.platform, 'linux', 'Run this demonstration only in its isolated Linux CI job');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Do not launch on a personal desktop');
  const temp = process.env.RUNNER_TEMP;
  assert.ok(temp && process.env.DISPLAY, 'An isolated Xvfb display and runner temporary directory are required');
  const { runTests } = require(path.join(temp, 'forge-demo-harness/node_modules/@vscode/test-electron'));
  const storage = fs.mkdtempSync(path.join(temp, 'forgelens-flask-preview-'));
  const folder = path.join(storage, 'flask');
  fs.mkdirSync(folder);
  git(folder, 'init', '-q');
  git(folder, 'fetch', '--no-tags', '--depth=1', 'https://github.com/pallets/flask.git', FLASK_PIN);
  git(folder, 'checkout', '--detach', 'FETCH_HEAD');
  assert.equal(git(folder, 'rev-parse', 'HEAD').trim(), FLASK_PIN);
  git(folder, 'diff', '--exit-code'); git(folder, 'diff', '--cached', '--exit-code');
  const trackedBefore = trackedSnapshot(folder);
  assert.equal(Object.keys(trackedBefore).length, 235);
  assert.ok(!fs.existsSync(path.join(folder, '.forgelensignore')));
  fs.writeFileSync(path.join(folder, '.forgelensignore'), '# Demo-only exclusion; original Flask files are unchanged\nforgelens-demo-only/\n');
  fs.mkdirSync(path.join(folder, 'forgelens-demo-only'));
  fs.writeFileSync(path.join(folder, 'forgelens-demo-only', 'generated.ts'), '// Synthetic demo file, not part of Flask\nexport const configCommand = "SECRET PASSWORD TOKEN KEY JSON flask configuration";\n');
  assert.deepEqual(trackedSnapshot(folder), trackedBefore);
  const intro = path.join(storage, 'DEMO-SCOPE.md');
  fs.writeFileSync(intro, '# ForgeLens 0.2.0 — local task context\n\nReal Flask 3.1.3, pinned at 22d924701a6ae2e4cd01e9a15bbaf3946094af65.\n\nSupplemental demonstration after the original submission.\nNo model provider, inference or staged edits.\n\nThe original Task B prompt names no files.\nPreview selects implementation, tests and CLI documentation.\n\nOriginal tracked Flask files stay unchanged.\nTwo untracked demo-only files illustrate project exclusions.\n');
  const output = path.join(temp, 'forgelens-preview-demo');
  fs.mkdirSync(output, { recursive: true });
  const userData = path.join(storage, 'profile');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'workbench.startupEditor': 'none',
    'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
    'editor.fontSize': 19, 'terminal.integrated.fontSize': 18, 'window.zoomLevel': 1,
    'workbench.colorTheme': 'Default Dark Modern', 'editor.minimap.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden', 'chat.disableAIFeatures': true,
    'forgelens.model': '', 'forgelens.fallbackModel': '', 'forgelens.contextScout': false,
  }));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  await runTests({
    version: 'stable', cachePath: path.join(storage, 'editor-cache'),
    extensionDevelopmentPath: path.resolve(__dirname, '..'), extensionTestsPath: path.join(__dirname, 'demo-scenario.cjs'),
    extensionTestsEnv: { FORGELENS_DEMO_FIXTURE: folder, FORGELENS_DEMO_STORAGE: storage, FORGELENS_DEMO_OUTPUT: output, FORGELENS_DEMO_PORT: String(port), FORGELENS_DEMO_INTRO: intro },
    launchArgs: [folder, '--disable-extensions', '--disable-gpu', '--skip-welcome', '--skip-release-notes',
      '--disable-workspace-trust', '--force-device-scale-factor=1', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
      '--user-data-dir', userData, '--extensions-dir', path.join(storage, 'extensions')],
  });
  assert.equal(git(folder, 'rev-parse', 'HEAD').trim(), FLASK_PIN);
  assert.deepEqual(trackedSnapshot(folder), trackedBefore);
  git(folder, 'diff', '--exit-code'); git(folder, 'diff', '--cached', '--exit-code');
  require('./demo-render.cjs').render(output);
}
exports.trackedSnapshot = trackedSnapshot;
exports.taskPrompt = taskPrompt;
exports.FLASK_PIN = FLASK_PIN;
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
