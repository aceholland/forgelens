const fs = require('node:fs');
const path = require('node:path');
const temp = process.env.RUNNER_TEMP;
const { runTests } = require(path.join(temp, 'forge-harness/node_modules/@vscode/test-electron'));
const folder = path.join(temp, 'example-project');
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(folder, 'README.md'), '# Example project\n');

runTests({
  version: process.env.EDITOR_BUILD,
  extensionDevelopmentPath: path.join(temp, 'forge-release/extension'),
  extensionTestsPath: path.join(__dirname, 'desktop-test.cjs'),
  launchArgs: [folder, '--disable-extensions', '--disable-gpu', '--skip-welcome', '--skip-release-notes'],
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
