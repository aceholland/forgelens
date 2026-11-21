const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { snapshot } = require('./desktop-preview.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, message) {
  for (let i = 0; i < 100; i++) { const value = await read(); if (value) return value; await delay(200); }
  throw new Error(message);
}
exports.run = async () => {
  const vscode = require('vscode');
  const folder = process.env.FORGELENS_DEMO_FIXTURE, output = process.env.FORGELENS_DEMO_OUTPUT, storage = process.env.FORGELENS_DEMO_STORAGE;
  assert.ok(folder && output && storage);
  assert.equal(fs.realpathSync(vscode.workspace.workspaceFolders[0].uri.fsPath), fs.realpathSync(folder));
  const before = snapshot(folder), scenes = [];
  let requests = 0;
  const trap = http.createServer((_req, res) => { requests++; res.writeHead(503); res.end('No model provider'); });
  await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve));
  const { chromium } = require(path.join(process.env.RUNNER_TEMP, 'forge-demo-harness/node_modules/playwright-core'));
  let browser;
  try {
    await vscode.workspace.getConfiguration('forgelens').update('baseUrl', `http://127.0.0.1:${trap.address().port}`, vscode.ConfigurationTarget.Global);
    assert.equal(vscode.workspace.getConfiguration('forgelens').get('model'), '');
    const extension = vscode.extensions.getExtension('forgelens-team.forgelens');
    assert.equal(extension.packageJSON.version, '0.2.0'); await extension.activate();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.FORGELENS_DEMO_PORT}`);
    const page = await until(async () => browser.contexts().flatMap(context => context.pages()).find(candidate => /workbench/i.test(candidate.url())), 'No real VS Code workbench target');
    await page.setViewportSize({ width: 1440, height: 960 });
    async function capture(name, narration) {
      await delay(500);
      const file = `${String(scenes.length + 1).padStart(2, '0')}-${name}.png`;
      const png = await page.screenshot({ path: path.join(output, file) });
      assert.ok(png.readUInt32BE(16) >= 1280 && png.readUInt32BE(20) >= 800, 'Capture must be legible at desktop resolution');
      scenes.push({ image: file, narration, capturedUtc: new Date().toISOString() });
    }
    async function frame() {
      return until(async () => {
        for (const candidate of page.frames()) { try { if (await candidate.locator('#task').isVisible()) return candidate; } catch {} }
      }, 'ForgeLens webview was not visible');
    }
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder, 'README.md')), { preview: false });
    await capture('scope', 'This supplemental demonstration shows local context preview in real VS Code on Linux. It uses no model provider and makes no code changes.');
    await vscode.commands.executeCommand('forgelens.start');
    let panel = await frame();
    await panel.locator('#task').fill('@file:src/visible.ts @file:src/tracked.tmp @file:nested/keep.drop');
    await panel.locator('#inspect').click();
    await panel.locator('button.file').filter({ hasText: 'src/visible.ts' }).waitFor();
    assert.equal(await panel.locator('button.file').count(), 3);
    assert.equal(await panel.locator('#meter').getAttribute('max'), '24000');
    assert.match(await panel.locator('#budget').innerText(), /characters/);
    await capture('preview', 'Preview context shows the selected files, their line ranges, and the excerpt character budget. Tracked files remain available even when a Git ignore pattern matches.');
    await panel.getByRole('button', { name: 'src/visible.ts', exact: true }).click();
    await until(async () => vscode.window.activeTextEditor?.document.uri.fsPath === path.join(folder, 'src/visible.ts'), 'Clicking the excerpt did not open its real source file');
    assert.ok(!vscode.window.activeTextEditor.selection.isEmpty);
    await capture('excerpt', 'Click a file in the preview to open its selected source excerpt. The highlighted range is the actual editor selection.');
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder, '.forgelensignore')), { preview: false });
    await capture('project-exclusions', 'This project excludes the private directory using a literal relative path in dot forgelens ignore. Git ignore rules also apply during discovery.');
    await vscode.commands.executeCommand('forgelens.start'); panel = await frame();
    await panel.locator('#task').fill('@file:private/blocked.ts @file:ignored/blocked.ts @file:nested/blocked.drop');
    await panel.locator('#inspect').click();
    await panel.locator('#files').filter({ hasText: 'No matching excerpts.' }).waitFor();
    assert.equal(await panel.locator('button.file').count(), 0);
    assert.equal(await panel.locator('#queue').isVisible(), false);
    await capture('ignored', 'Even explicit file mentions do not bring these excluded files into context.');
    assert.equal(requests, 0); assert.deepEqual(snapshot(folder), before);
    const marker = path.join(storage, 'terminal-proof-done');
    const proof = path.join(storage, 'proof.cjs');
    fs.writeFileSync(proof, `const assert=require('node:assert/strict');const fs=require('node:fs');const {snapshot}=require(${JSON.stringify(path.join(__dirname, 'desktop-preview.cjs'))});assert.deepEqual(snapshot(${JSON.stringify(folder)}),${JSON.stringify(before)});console.log('PASS: all ${Object.keys(before).length} workspace files unchanged');console.log('Preview: 3 allowed files; 0 excluded files selected');console.log('Observed TrueForge requests: 0; staged changes: none');fs.writeFileSync(${JSON.stringify(marker)},'done');\n`);
    const terminal = vscode.window.createTerminal({ name: 'Local preview check', cwd: folder, shellPath: '/bin/bash', shellArgs: ['--noprofile', '--norc'], env: { FORGELENS_DEMO_PROOF: proof } });
    terminal.show(); terminal.sendText('git diff --exit-code && node "$FORGELENS_DEMO_PROOF"');
    await until(async () => fs.existsSync(marker), 'Native terminal proof did not finish');
    await capture('terminal', `Native terminal verification confirms that all ${Object.keys(before).length} fixture files have the same hashes before and after the preview.`);
    assert.equal(requests, 0); assert.deepEqual(snapshot(folder), before);
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ recordedUtc: new Date().toISOString(), revision: process.env.GITHUB_SHA, version: extension.packageJSON.version, editor: vscode.version, hostNode: process.versions.node, os: process.platform, source: 'Actual VS Code UI screenshots captured after real UI actions', scenes, fixtureFilesUnchanged: Object.keys(before).length, trueforgeRequests: requests, stagedChanges: false, supplementalPostDeadline: true }, null, 2));
    fs.writeFileSync(path.join(output, 'narration.txt'), scenes.map((scene, i) => `${i + 1}. ${scene.narration}`).join('\n\n'));
    console.log('FORGELENS_SUPPLEMENTAL_UI_DEMO_PASS');
  } finally {
    // The extension-test runner owns this editor's lifecycle. Do not issue a
    // Browser.close command to the same Electron host from inside its test.
    trap.closeAllConnections(); await new Promise(resolve => trap.close(resolve));
  }
};
