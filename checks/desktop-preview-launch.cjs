const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function createFixture(parent) {
  const storage = fs.mkdtempSync(path.join(parent, 'forgelens-desktop-preview-'));
  const folder = path.join(storage, 'workspace');
  fs.mkdirSync(folder);
  const files = {
    '.gitignore': '*.tmp\nignored/\n',
    '.forgelensignore': '# Literal workspace exclusions\nprivate/\n',
    '.env': 'THIS_IS_SYNTHETIC_TEST_DATA=true\n',
    'src/visible.ts': 'export function previewFeature() { return "visible"; }\n',
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
  git('add', '-f', 'src/tracked.tmp');
  return { storage, folder };
}

async function main() {
  const temp = process.env.RUNNER_TEMP || os.tmpdir();
  const { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } = require(path.join(temp, 'forge-preview-harness/node_modules/@vscode/test-electron'));
  const vsix = process.argv[2];
  assert.ok(vsix && fs.statSync(vsix).isFile(), 'Pass the built ForgeLens VSIX to the desktop check');
  const sha256 = createHash('sha256').update(fs.readFileSync(vsix)).digest('hex');
  if (process.env.FORGELENS_VSIX_SHA256) assert.equal(sha256, process.env.FORGELENS_VSIX_SHA256);
  const { storage, folder } = createFixture(temp);
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
  // Test Electron requires a development extension. Give it a separate, inert
  // test driver, so ForgeLens itself can load only from the installed VSIX.
  const driver = path.join(storage, 'test-driver');
  fs.mkdirSync(driver);
  fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({
    name: 'desktop-check', publisher: 'fixture', version: '1.0.0', engines: { vscode: '^1.101.0' },
  }));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  await runTests({
    vscodeExecutablePath: editor,
    extensionDevelopmentPath: driver,
    extensionTestsPath: path.join(__dirname, 'desktop-preview.cjs'),
    extensionTestsEnv: { FORGELENS_PREVIEW_FIXTURE: folder, FORGELENS_PICKER_PORT: String(port),
      FORGELENS_INSTALLED_EXTENSIONS: extensionsDir, FORGELENS_VSIX_SHA256: sha256 },
    // Trust is disabled only in this disposable synthetic workspace/profile.
    launchArgs: [folder, '--disable-gpu', '--skip-welcome', '--skip-release-notes',
      '--disable-workspace-trust', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
      '--user-data-dir', userData, '--extensions-dir', extensionsDir],
  });
}

exports.createFixture = createFixture;
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
