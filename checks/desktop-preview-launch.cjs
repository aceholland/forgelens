const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

function createFixture(parent, liveReview = false) {
  const storage = fs.mkdtempSync(path.join(parent, 'forgelens-desktop-preview-'));
  const folder = path.join(storage, 'workspace');
  fs.mkdirSync(folder);
  const files = liveReview ? require('./desktop-live-model.cjs').files : {
    '.gitignore': '*.tmp\nignored/\n',
    '.forgelensignore': '# Literal workspace exclusions\nprivate/\n',
    '.env': 'THIS_IS_SYNTHETIC_TEST_DATA=true\n',
    'src/visible.ts': 'export function previewFeature() { return "visible"; }\n',
    'tests/visible.test.ts': 'import { previewFeature } from "../src/visible";\nexport const observed = previewFeature();\n',
    'src/tracked.tmp': 'export const trackedPreview = "tracked";\n',
    'ignored/blocked.ts': 'export const previewIgnored = "git exclusion";\n',
    'private/blocked.ts': 'export const previewPrivate = "workspace exclusion";\n',
    'node_modules/bogus.js': 'module.exports = "synthetic dependency";\n',
    'nested/.gitignore': '*.drop\n!keep.drop\n',
    'nested/blocked.drop': 'preview excluded nested artifact\n',
    'nested/keep.drop': 'preview included nested negation\n',
  };
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(folder, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const git = (...args) => execFileSync('git', ['-C', folder, ...args], { windowsHide: true, stdio: 'pipe' });
  git('init', '-q');
  const excludes = path.join(folder, '.git', 'fixture-global-excludes');
  fs.writeFileSync(excludes, '');
  git('config', 'core.excludesFile', excludes);
  if (!liveReview) git('add', '-f', 'src/tracked.tmp');
  return { storage, folder };
}

async function main() {
  const temp = process.env.RUNNER_TEMP || os.tmpdir();
  const { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } = require(path.join(temp, 'forge-preview-harness/node_modules/@vscode/test-electron'));
  const vsix = process.argv[2];
  assert.ok(vsix && fs.statSync(vsix).isFile(), 'Pass the built ForgeLens VSIX to the desktop check');
  const sha256 = createHash('sha256').update(fs.readFileSync(vsix)).digest('hex');
  if (process.env.FORGELENS_VSIX_SHA256) assert.equal(sha256, process.env.FORGELENS_VSIX_SHA256);
  const liveReview = process.argv[3] === '--live-review';
  const { storage, folder } = createFixture(temp, liveReview);
  const userData = path.join(storage, 'user-data');
  const extensionsDir = path.join(storage, 'extensions');
  fs.mkdirSync(extensionsDir);
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
    'chat.disableAIFeatures': true,
    'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
    'forgelens.model': '', 'forgelens.fallbackModel': '', 'forgelens.contextScout': false,
  }));
  const editor = process.env.FORGELENS_EDITOR_EXECUTABLE || await downloadAndUnzipVSCode({
    version: process.env.EDITOR_BUILD || 'stable', cachePath: path.join(storage, 'editor-cache'),
  });
  const cli = resolveCliPathFromVSCodeExecutablePath(editor);
  fs.copyFileSync(vsix, path.join(storage, 'bundle.vsix'));
  // The Windows CLI is a .cmd shim. Its package and profile arguments are
  // fixed relative names so they work even when the temporary path has spaces.
  execFileSync(process.platform === 'win32' ? `"${cli}"` : cli,
    ['--user-data-dir', 'user-data', '--extensions-dir', 'extensions', '--install-extension', 'bundle.vsix', '--force'],
    { cwd: storage, shell: process.platform === 'win32', windowsHide: true, encoding: 'utf8', timeout: 90000 });
  const manifest = require('../package.json');
  const expectedId = `${manifest.publisher}.${manifest.name}@${manifest.version}`;
  // Validate the installed files directly. On Linux 1.101.0 a second CLI
  // process can hang during shutdown after printing the extension inventory.
  const installed = fs.readdirSync(extensionsDir, { withFileTypes: true }).filter(entry => {
    const file = path.join(extensionsDir, entry.name, 'package.json');
    if (!entry.isDirectory() || !fs.existsSync(file)) return false;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return `${pkg.publisher}.${pkg.name}@${pkg.version}` === expectedId;
  });
  assert.equal(installed.length, 1, `The CLI must install exactly one copy of ${expectedId}`);
  console.log('FORGELENS_VSIX_INSTALLED', expectedId, sha256);
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const extensionTestsEnv = { RUNNER_TEMP: temp, FORGELENS_PREVIEW_FIXTURE: folder, FORGELENS_PICKER_PORT: String(port),
    FORGELENS_INSTALLED_EXTENSIONS: extensionsDir, FORGELENS_VSIX_SHA256: sha256 };
  // Workspace trust is disabled only in this disposable synthetic workspace/profile.
  const launchArgs = [folder, '--disable-gpu', '--skip-welcome', '--skip-release-notes',
    '--disable-workspace-trust', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
    '--user-data-dir', userData, '--extensions-dir', extensionsDir];
  const driverManifest = { name: 'desktop-check', publisher: 'fixture', version: '1.0.0', engines: { vscode: manifest.engines.vscode } };
  if (!liveReview) {
    const driver = path.join(storage, 'test-driver');
    fs.mkdirSync(driver);
    fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify(driverManifest));
    await runTests({ vscodeExecutablePath: editor, extensionDevelopmentPath: driver, extensionTestsEnv,
      extensionTestsPath: path.join(__dirname, 'desktop-preview.cjs'), launchArgs });
    return;
  }
  const live = await require('./desktop-live-model.cjs').start(storage, temp);
  try {
    const settings = path.join(userData, 'User', 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ ...JSON.parse(fs.readFileSync(settings, 'utf8')),
      'forgelens.model': 'fixture/primary', 'forgelens.fallbackModels': ['fixture/first-fallback', 'fixture/scripted'],
      'forgelens.baseUrl': live.url, 'forgelens.liveReview': true,
      'forgelens.pythonPath': process.env.FORGELENS_QA_PYTHON || 'python',
      'editor.codeLens': true, 'diffEditor.codeLens': true, 'window.dialogStyle': 'custom', 'files.simpleDialog.enable': true }));
    // VS Code's extension-test mode rejects native consent dialogs. Activate a
    // small driver in a normal workbench using this same isolated VSIX installation.
    const driver = path.join(storage, 'live-driver');
    fs.mkdirSync(driver);
    fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({...driverManifest,
      main:'./driver.cjs', activationEvents:['onStartupFinished']}));
    const resultPath = path.join(storage, 'live-result.json');
    fs.writeFileSync(path.join(driver, 'driver.cjs'), `
      exports.activate = () => setImmediate(async () => {
        let result;
        try {
          const suite=process.env.FORGELENS_RESUME_CHECK==='1' ? 'desktop-review-resume.cjs' : 'desktop-live-review.cjs';
          result = { evidence:await require(require('node:path').join(${JSON.stringify(__dirname)},suite)).run(), hostPid:process.pid };
        }
        catch (error) { result = { error:String(error.stack || error) }; }
        require('node:fs').writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
        await require('vscode').commands.executeCommand('workbench.action.quit');
      });`);
    // The GitHub-hosted Linux VM runs the unpacked editor without a setuid
    // helper. Match Test Electron's Chromium flag only in that disposable VM.
    if (process.platform==='linux' && process.env.GITHUB_ACTIONS==='true' && process.env.RUNNER_ENVIRONMENT==='github-hosted') {
      launchArgs.push('--no-sandbox');
    }
    async function runHost(resume){
    const host = spawn(editor, ['--new-window','--no-first-run','--disable-renderer-backgrounding',
      '--extensionDevelopmentPath='+driver, ...launchArgs],
      { env:{...process.env,...extensionTestsEnv,FORGELENS_RESUME_CHECK:resume?'1':'0'}, stdio:'inherit', windowsHide:true });
    let timer;
    try {
      await new Promise((resolve,reject) => {
        timer = setTimeout(() => reject(Error('Live editor fixture timed out')), 180000);
        host.once('error', reject);
        host.once('exit', code => code===0 ? resolve() : reject(Error('Editor exited with code '+code)));
      });
    } finally { clearTimeout(timer); if (host.exitCode===null && host.signalCode===null) host.kill(); }
    const result = JSON.parse(fs.readFileSync(resultPath,'utf8'));
    assert.ok(result.evidence, result.error || 'The live editor driver did not finish');
    return result;
    }
    const result=await runHost(false);
    fs.unlinkSync(resultPath);
    const resumed=await runHost(true);
    assert.notEqual(result.hostPid,resumed.hostPid,'Recovery must run in a fresh extension host');
    const modelRequests = live.assertComplete();
    console.log('FORGELENS_DESKTOP_LIVE_REVIEW_PASS '+JSON.stringify({...result.evidence,...resumed.evidence, modelRequests}));
  } finally { await live.close(); }
}

exports.createFixture = createFixture;
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
