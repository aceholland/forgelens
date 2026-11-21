const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { snapshot } = require('./desktop-preview.cjs');
const { trackedSnapshot, taskPrompt, FLASK_PIN } = require('./demo-launch.cjs');
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
  const before = snapshot(folder), trackedBefore = trackedSnapshot(folder), scenes = [];
  const prompt = taskPrompt();
  const expectedPaths = ['src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst'];
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
    const known = new Set(await vscode.commands.getCommands(true));
    async function clearChrome() {
      for (const id of ['workbench.action.closeSidebar', 'workbench.action.closeAuxiliaryBar', 'notifications.clearAll', 'notifications.hideToasts']) {
        if (known.has(id)) await vscode.commands.executeCommand(id);
      }
    }
    async function wideEditor() {
      await clearChrome();
      // ForgeLens intentionally opens beside source. Merge those groups only
      // in this isolated recording so each demonstrated view is readable.
      if (known.has('workbench.action.joinAllGroups')) await vscode.commands.executeCommand('workbench.action.joinAllGroups');
      else if (known.has('workbench.action.maximizeEditor')) await vscode.commands.executeCommand('workbench.action.maximizeEditor');
      else throw new Error('No supported editor-group maximization command');
      await clearChrome();
    }
    await wideEditor();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.FORGELENS_DEMO_PORT}`);
    const page = await until(async () => browser.contexts().flatMap(context => context.pages()).find(candidate => /workbench/i.test(candidate.url())), 'No real VS Code workbench target');
    await page.setViewportSize({ width: 1440, height: 960 });
    async function capture(name, narration) {
      await wideEditor();
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
    await vscode.window.showTextDocument(vscode.Uri.file(process.env.FORGELENS_DEMO_INTRO), { preview: false });
    await capture('scope', 'Here is local task context preview on the pinned Flask repository, in real VS Code. This supplemental demonstration uses no model provider or staged edits.');
    await vscode.commands.executeCommand('forgelens.start');
    await wideEditor();
    let panel = await frame();
    const box = await panel.locator('body').boundingBox();
    const panelViewportWidth = await panel.evaluate(() => window.innerWidth);
    assert.ok(panelViewportWidth >= 900, 'ForgeLens must have a readable full-width frame viewport');
    await panel.locator('#task').fill(prompt);
    await panel.locator('#inspect').click();
    await panel.getByRole('button', { name: 'src/flask/cli.py', exact: true }).waitFor();
    assert.equal(await panel.locator('button.file').count(), 3);
    const items = await panel.locator('#files li').evaluateAll(rows => rows.map(row => ({ path: row.querySelector('button.file').textContent, range: row.querySelector('.range').textContent, reason: row.querySelector('.reason').textContent })));
    assert.deepEqual(items.map(item => item.path).sort(), [...expectedPaths].sort());
    assert.equal(await panel.locator('#meter').getAttribute('max'), '24000');
    const usedChars = Number(await panel.locator('#meter').getAttribute('value'));
    assert.ok(usedChars > 0 && usedChars <= 24000);
    assert.match(await panel.locator('#budget').innerText(), /characters/);
    await capture('preview', 'The original task names no files. Preview finds the Flask command implementation, its tests, and the CLI documentation, within the twenty four thousand character budget.');
    await panel.getByRole('button', { name: 'src/flask/cli.py', exact: true }).click();
    await until(async () => vscode.window.activeTextEditor?.document.uri.fsPath === path.join(folder, 'src/flask/cli.py'), 'Clicking the excerpt did not open the real Flask CLI source');
    assert.ok(!vscode.window.activeTextEditor.selection.isEmpty);
    const editor = vscode.window.activeTextEditor;
    editor.revealRange(new vscode.Range(editor.selection.start, editor.selection.start.translate(20)), vscode.TextEditorRevealType.AtTop);
    const openedExcerpt = { path: 'src/flask/cli.py', startLine: editor.selection.start.line + 1, endLine: editor.selection.end.line + 1 };
    await capture('excerpt', 'Click the implementation to open its selected range in the real Flask source. The highlighted excerpt can be inspected before starting a model run.');
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder, '.forgelensignore')), { preview: false });
    await capture('project-exclusions', 'For a separate exclusion check, two untracked demo files were added. This policy excludes only the synthetic demo directory. No original Flask file was edited.');
    await vscode.commands.executeCommand('forgelens.start'); await wideEditor(); panel = await frame();
    await panel.locator('#task').fill('@file:forgelens-demo-only/generated.ts @file:.forgelensignore');
    await panel.locator('#inspect').click();
    await panel.locator('#files').filter({ hasText: 'No matching excerpts.' }).waitFor();
    assert.equal(await panel.locator('button.file').count(), 0);
    assert.equal(await panel.locator('#queue').isVisible(), false);
    await capture('ignored', 'Even explicit file mentions do not bring these excluded files into context.');
    assert.equal(requests, 0); assert.deepEqual(snapshot(folder), before); assert.deepEqual(trackedSnapshot(folder), trackedBefore);
    const marker = path.join(storage, 'terminal-proof-done');
    const proof = path.join(storage, 'proof.cjs');
    fs.writeFileSync(proof, `const assert=require('node:assert/strict');const fs=require('node:fs');const {trackedSnapshot}=require(${JSON.stringify(path.join(__dirname, 'demo-launch.cjs'))});assert.deepEqual(trackedSnapshot(${JSON.stringify(folder)}),${JSON.stringify(trackedBefore)});console.log('PASS: all ${Object.keys(trackedBefore).length} original Flask tracked-file hashes unchanged');console.log('Pinned source 22d9247; 3 task files selected; 0 excluded files selected');console.log('Demo-only exclusions are untracked additions, not original Flask changes');fs.writeFileSync(${JSON.stringify(marker)},'done');\n`);
    const terminal = vscode.window.createTerminal({ name: 'Local preview check', cwd: folder, shellPath: '/bin/bash', shellArgs: ['--noprofile', '--norc'], env: { FORGELENS_DEMO_PROOF: proof } });
    terminal.show(); terminal.sendText('git rev-parse --short HEAD && git diff --exit-code && git diff --cached --exit-code && node "$FORGELENS_DEMO_PROOF"');
    await until(async () => fs.existsSync(marker), 'Native terminal proof did not finish');
    await capture('terminal', `The native terminal confirms that all ${Object.keys(trackedBefore).length} original tracked Flask files have unchanged hashes.`);
    assert.equal(requests, 0); assert.deepEqual(snapshot(folder), before); assert.deepEqual(trackedSnapshot(folder), trackedBefore);
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ recordedUtc: new Date().toISOString(), revision: process.env.GITHUB_SHA, version: extension.packageJSON.version, editor: vscode.version, hostNode: process.versions.node, os: process.platform, source: 'Actual VS Code UI screenshots captured after real UI actions', scenes, flaskSource: { url: 'https://github.com/pallets/flask.git', commit: FLASK_PIN, originalTrackedFilesUnchanged: Object.keys(trackedBefore).length, diffExitCode: 0, cachedDiffExitCode: 0, wholeGitIndexCleanClaimed: false }, prompt: { text: prompt, bytes: 296, sha256: 'adf0a71141397baaec45456103eec636889bfb57789532a01a7d9daa5d793fd1', namesFiles: false }, selection: { items, usedChars, budgetChars: 24000, panelViewportWidth, centeredBodyWidth: box?.width }, openedExcerpt, demoOnlyUntrackedAdditions: ['.forgelensignore', 'forgelens-demo-only/generated.ts'], explicitExcludedSelectionCount: 0, trueforgeRequests: requests, stagedChanges: false, supplementalPostDeadline: true }, null, 2));
    fs.writeFileSync(path.join(output, 'narration.txt'), scenes.map((scene, i) => `${i + 1}. ${scene.narration}`).join('\n\n'));
    console.log('FORGELENS_SUPPLEMENTAL_UI_DEMO_PASS');
  } finally {
    // The extension-test runner owns this editor's lifecycle. Do not issue a
    // Browser.close command to the same Electron host from inside its test.
    trap.closeAllConnections(); await new Promise(resolve => trap.close(resolve));
  }
};
