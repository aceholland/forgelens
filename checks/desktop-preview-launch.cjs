const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  const { runTests } = require(path.join(temp, 'forge-preview-harness/node_modules/@vscode/test-electron'));
  const extension = path.resolve(__dirname, '..');
  assert.equal(JSON.parse(fs.readFileSync(path.join(extension, 'package.json'), 'utf8')).version, '0.2.0');
  assert.ok(fs.existsSync(path.join(extension, 'dist', 'extension.js')), 'Build the source before launching the desktop check');
  const { storage, folder } = createFixture(temp);
  const userData = path.join(storage, 'user-data');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
    'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
    'forgelens.model': '', 'forgelens.fallbackModel': '', 'forgelens.contextScout': false,
  }));
  await runTests({
    version: process.env.EDITOR_BUILD || 'stable',
    cachePath: path.join(storage, 'editor-cache'),
    extensionDevelopmentPath: extension,
    extensionTestsPath: path.join(__dirname, 'desktop-preview.cjs'),
    extensionTestsEnv: { FORGELENS_PREVIEW_FIXTURE: folder },
    // Trust is disabled only in this disposable synthetic workspace/profile.
    launchArgs: [folder, '--disable-extensions', '--disable-gpu', '--skip-welcome', '--skip-release-notes',
      '--disable-workspace-trust', '--user-data-dir', userData, '--extensions-dir', path.join(storage, 'extensions')],
  });
}

exports.createFixture = createFixture;
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
