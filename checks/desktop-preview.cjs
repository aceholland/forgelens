const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createServer } = require('node:http');

function snapshot(folder, relative = '') {
  const result = {};
  for (const entry of fs.readdirSync(path.join(folder, relative), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    assert.ok(!entry.isSymbolicLink(), 'The fixture must contain only ordinary files/directories');
    if (entry.isDirectory()) Object.assign(result, snapshot(folder, name));
    else result[name] = createHash('sha256').update(fs.readFileSync(path.join(folder, name))).digest('hex');
  }
  return result;
}
async function bounded(promise, label = 'Context preview', milliseconds = 20000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** Drive the actual workbench QuickPick; never replace showQuickPick or tasks. */
async function verifyCommand(vscode, folder, label, nextCount, expectedExitCode) {
  const commands = await vscode.commands.getCommands(true);
  for (const id of ['workbench.action.acceptSelectedQuickOpenItem', 'workbench.action.quickOpenSelectNext']) assert.ok(commands.includes(id), `Native QuickPick driver unavailable: ${id}`);
  let listener;
  const completion = new Promise(resolve => {
    listener = vscode.tasks.onDidEndTaskProcess(event => {
      const task = event.execution.task;
      if (task.definition.type !== 'forgelens-verify') return;
      const execution = task.execution;
      resolve({ name: task.name, exitCode: event.exitCode, processExecution: execution instanceof vscode.ProcessExecution,
        executable: execution?.process, args: execution?.args, cwd: execution?.options?.cwd });
    });
  });
  try {
    const command = vscode.commands.executeCommand('forgelens.verify');
    // The check list is populated asynchronously after the saved-file guard.
    // Use the real built-in navigation/accept commands once it is displayed.
    await new Promise(resolve => setTimeout(resolve, 1000));
    for (let index = 0; index < nextCount; index++) await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await bounded(command, 'Verification picker selection', 30000);
    const result = await bounded(completion, 'Actual verification task process', 30000);
    assert.equal(result.name, label, 'Native chooser selected a different check');
    assert.equal(result.processExecution, true, 'Verification must start a real ProcessExecution');
    assert.equal(result.exitCode, expectedExitCode, 'Observed task-process exit differs from the expected fixture result');
    assert.equal(path.relative(fs.realpathSync(result.cwd), fs.realpathSync(folder)), '');
    assert.equal(path.basename(result.executable).replace(/\.exe$/i, ''), 'git');
    assert.deepEqual(result.args, label === 'Git status' ? ['status', '--short'] : ['diff', '--check']);
    console.log('FORGELENS_NATIVE_VERIFICATION_PROCESS ' + JSON.stringify(result));
    return result;
  } finally { listener?.dispose(); }
}

exports.run = async () => {
  const vscode = require('vscode');
  const folder = process.env.FORGELENS_PREVIEW_FIXTURE;
  assert.ok(folder, 'The launcher must provide its disposable fixture');
  assert.equal(vscode.workspace.workspaceFolders?.[0].uri.scheme, 'file');
  const editorFolder = fs.realpathSync(vscode.workspace.workspaceFolders[0].uri.fsPath);
  assert.equal(path.relative(editorFolder, fs.realpathSync(folder)), '');
  assert.equal(vscode.workspace.isTrusted, true);
  const before = snapshot(folder);
  let requests = 0;
  const trap = createServer((_request, response) => { requests++; response.writeHead(503); response.end('No model provider exists in this test'); });
  await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve));
  try {
    const config = vscode.workspace.getConfiguration('forgelens');
    await config.update('baseUrl', `http://127.0.0.1:${trap.address().port}`, vscode.ConfigurationTarget.Global);
    assert.equal(config.get('model'), '');
    assert.equal(config.get('contextScout'), false);
    const extension = vscode.extensions.getExtension('forgelens-team.forgelens');
    assert.ok(extension, 'Editor did not discover the source extension');
    assert.equal(extension.packageJSON.version, '0.2.0');
    await extension.activate();
    assert.equal(extension.isActive, true);
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['start', 'inline', 'review', 'cancel', 'undo', 'previewContext', 'verify', 'exportPatch']) assert.ok(commands.includes('forgelens.' + id), `Missing command ${id}`);
    const selected = await bounded(vscode.commands.executeCommand('forgelens.previewContext',
      'Preview @file:src/visible.ts @file:src/tracked.tmp @file:nested/keep.drop'));
    assert.ok(selected && selected.items.length, 'Provider-free context preview must return real selected snippets');
    const selectedPaths = selected.items.map(item => item.path);
    for (const name of ['src/visible.ts', 'src/tracked.tmp', 'nested/keep.drop']) assert.ok(selectedPaths.includes(name), `Missing allowed/tracked path ${name}`);
    assert.ok(selected.usedChars > 0 && selected.usedChars <= selected.budgetChars);
    for (const item of selected.items) {
      assert.ok(Number.isInteger(item.startLine) && item.startLine >= 1);
      assert.ok(Number.isInteger(item.endLine) && item.endLine >= item.startLine);
      assert.ok(item.reason.length > 0);
    }
    const excluded = await bounded(vscode.commands.executeCommand('forgelens.previewContext',
      '@file:ignored/blocked.ts @file:private/blocked.ts @file:nested/blocked.drop @file:.env @file:node_modules/bogus.js'));
    assert.ok(excluded, 'Excluded-only preview must return an explicit empty selection');
    assert.deepEqual(excluded.items, [], 'An explicit mention must not bypass ignored/protected paths');
    assert.equal(excluded.usedChars, 0);
    const panelOpened = vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'ForgeLens' && tab.input instanceof vscode.TabInputWebview));
    assert.ok(panelOpened, 'Preview must open the ForgeLens panel');
    assert.deepEqual(snapshot(folder), before, 'Context preview must not change any fixture file, including ignored files');
    assert.ok(!vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file'
      && vscode.workspace.getWorkspaceFolder(document.uri) === vscode.workspace.workspaceFolders[0]));
    assert.equal(requests, 0, 'Local preview must not contact the TrueForge/model endpoint');
    const checks = [];
    checks.push(await verifyCommand(vscode, folder, 'Git status', 0, 0));
    checks.push(await verifyCommand(vscode, folder, 'Git diff check', 1, 0));
    // This file is tracked in the fixture, even though *.tmp is ignored for
    // untracked discovery. Git diff --check must observe its on-disk change.
    const target = path.join(folder, 'src', 'tracked.tmp');
    const original = fs.readFileSync(target);
    try {
      fs.appendFileSync(target, '// intentional hosted QA whitespace failure   \n');
      checks.push(await verifyCommand(vscode, folder, 'Git diff check', 1, 2));
    } finally { fs.writeFileSync(target, original); }
    assert.deepEqual(snapshot(folder), before, 'Native verification fixture was not restored byte for byte');
    assert.equal(requests, 0, 'Native saved-file checks must not contact the model endpoint');
    console.log('FORGELENS_PREVIEW_DESKTOP_PASS ' + JSON.stringify({
      editor: vscode.version, hostNode: process.versions.node, os: process.platform, arch: process.arch,
      version: extension.packageJSON.version, revision: process.env.GITHUB_SHA, commands: 8,
      selectedPaths, ignoredExplicitMentionsExcluded: true, fixtureUnchanged: true, trueforgeRequests: requests,
      verification: { nativeQuickPick: true, driver: 'Built-in QuickPick navigation and accept commands', actualTaskProcessEvents: checks, fixtureRestored: true },
    }));
  } finally {
    trap.closeAllConnections();
    await new Promise(resolve => trap.close(resolve));
  }
};

exports.snapshot = snapshot;
