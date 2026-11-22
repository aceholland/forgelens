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
async function verifyCommand(vscode, page, folder, label, expectedExitCode) {
  const listeners = [];
  const observed = [];
  const record = (stage, event) => {
    const task = event.execution.task;
    if (task.definition.type === 'forgelens-verify') observed.push({stage, name:task.name, runId:task.definition.runId});
  };
  const isSelectedTask = task => task.definition.type === 'forgelens-verify' && task.name === label;
  listeners.push(vscode.tasks.onDidStartTask(event => record('task started', event)));
  listeners.push(vscode.tasks.onDidStartTaskProcess(event => record('process started', event)));
  const completion = new Promise(resolve => {
    listeners.push(vscode.tasks.onDidEndTaskProcess(event => {
      record('process ended', event);
      const task = event.execution.task;
      if (!isSelectedTask(task)) return;
      const execution = task.execution;
      resolve({ name: task.name, runId:task.definition.runId, exitCode: event.exitCode, processExecution: execution instanceof vscode.ProcessExecution,
        executable: execution?.process, args: execution?.args, cwd: execution?.options?.cwd });
    }));
  });
  const taskEnded = new Promise(resolve => {
    listeners.push(vscode.tasks.onDidEndTask(event => {
      record('task ended', event);
      if (isSelectedTask(event.execution.task)) resolve(event.execution.task.definition.runId);
    }));
  });
  try {
    const picker = page.locator('.quick-input-widget:visible').filter({hasText:'Verify saved changes'});
    for(let attempt=1;attempt<=2;attempt++){
      const command = vscode.commands.executeCommand('forgelens.verify');
      await picker.waitFor({state:'visible', timeout:15000});
      try { await picker.getByText(label, { exact: true }).click({ timeout:5000 }); }
      catch(error){if(await picker.isVisible())throw error;} // The terminal may take focus during the click.
      await bounded(command, 'Verification picker selection', 30000);
      await picker.waitFor({state:'hidden',timeout:5000});
      // executeTask registers its execution before resolving, and the end event
      // is delivered when VS Code removes it. Never relaunch an observed task.
      const registered = vscode.tasks.taskExecutions.filter(e=>e.task.definition.type==='forgelens-verify');
      if (observed.length || registered.length) break;
      console.log('FORGELENS_VERIFICATION_PICKER_DISMISSED '+JSON.stringify({label,expectedExitCode,attempt}));
      assert.equal(attempt,1,'The verification picker closed twice without launching a task');
    }
    // VS Code can report process exit before releasing its dedicated task terminal.
    // Wait for both events before opening the picker for another run of the same task.
    const [result, endedId] = await bounded(Promise.all([completion,taskEnded]), label+' native completion (expected exit '+expectedExitCode+')', 45000)
      .catch(error=>{throw new Error(error.message+'. Observed task events: '+JSON.stringify(observed));});
    assert.ok(result.runId && result.runId === endedId, 'Process and task events must belong to the same verification');
    assert.equal(result.name, label, 'Native chooser selected a different check');
    assert.equal(result.processExecution, true, 'Verification must start a real ProcessExecution');
    assert.equal(result.exitCode, expectedExitCode, 'Observed task-process exit differs from the expected fixture result');
    assert.equal(path.relative(fs.realpathSync(result.cwd), fs.realpathSync(folder)), '');
    assert.equal(path.basename(result.executable).replace(/\.exe$/i, ''), 'git');
    assert.deepEqual(result.args, label === 'Git status' ? ['status', '--short'] : ['diff', '--check']);
    console.log('FORGELENS_NATIVE_VERIFICATION_PROCESS ' + JSON.stringify(result));
    return result;
  } finally { for(const listener of listeners)listener.dispose(); }
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
    assert.ok(extension, 'Editor did not discover the installed ForgeLens VSIX');
    assert.equal(extension.extensionUri.scheme, 'file');
    const installedRoot = fs.realpathSync(process.env.FORGELENS_INSTALLED_EXTENSIONS);
    const installedPath = fs.realpathSync(extension.extensionPath);
    assert.equal(path.relative(installedRoot, path.dirname(installedPath)), '',
      'ForgeLens must activate from a direct child of the isolated CLI installation directory');
    assert.equal(extension.packageJSON.version, require('../package.json').version);
    await extension.activate();
    assert.equal(extension.isActive, true);
    const commands = await vscode.commands.getCommands(true);
    const commandIds = ['start', 'inline', 'review', 'cancel', 'undo', 'previewContext', 'verify', 'exportPatch', 'findRelatedTests', 'compareContextBudgets', 'checkSetup'];
    for (const id of commandIds) assert.ok(commands.includes('forgelens.' + id), `Missing command ${id}`);
    const selected = await bounded(vscode.commands.executeCommand('forgelens.previewContext',
      'Preview @file:src/visible.ts @file:src/tracked.tmp @file:nested/keep.drop'));
    assert.ok(selected && selected.items.length, 'Provider-free context preview must return real selected snippets');
    const selectedPaths = selected.items.map(item => item.path);
    for (const name of ['src/visible.ts', 'src/tracked.tmp', 'nested/keep.drop']) assert.ok(selectedPaths.includes(name), `Missing allowed/tracked path ${name}`);
    assert.ok(selected.usedChars > 0 && selected.usedChars <= selected.budgetChars);
    assert.ok(selected.usedTokens > 0 && selected.usedTokens <= selected.budgetTokens);
    assert.equal(selected.encoding, 'o200k_base');
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
    assert.equal(excluded.usedTokens, 0);
    const panelIsOpen = () => vscode.window.tabGroups.all.some(group =>
      group.tabs.some(tab => tab.label === 'ForgeLens' && tab.input instanceof vscode.TabInputWebview));
    const tabDeadline = Date.now() + 5000;
    while (!panelIsOpen() && Date.now() < tabDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(panelIsOpen(), 'Preview must open the ForgeLens panel');
    assert.deepEqual(snapshot(folder), before, 'Context preview must not change any fixture file, including ignored files');
    assert.ok(!vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file'
      && vscode.workspace.getWorkspaceFolder(document.uri) === vscode.workspace.workspaceFolders[0]));
    assert.equal(requests, 0, 'Local preview must not contact the TrueForge/model endpoint');
    const { chromium } = require(path.join(process.env.RUNNER_TEMP, 'forge-preview-harness/node_modules/playwright-core'));
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.FORGELENS_PICKER_PORT}`);
    const page = browser.contexts().flatMap(context => context.pages()).find(candidate => /workbench/i.test(candidate.url()));
    assert.ok(page, 'Desktop renderer must be available for the native verification picker');
    const captureDir=process.env.FORGELENS_QA_CAPTURE_DIR;
    if(captureDir){
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    }
    const budgetUri = await bounded(vscode.commands.executeCommand('forgelens.compareContextBudgets', '@file:src/visible.ts', 2));
    assert.equal(budgetUri.scheme, 'forgelens-context');
    const comparison = (await vscode.workspace.openTextDocument(budgetUri)).getText();
    assert.match(comparison, /(?:Changed|Removed)  src\/visible\.ts/);
    assert.doesNotMatch(comparison, /export function/);
    assert.equal(config.get('tokenBudget'), 10000);
    if(captureDir){
      await page.locator('.monaco-editor .view-lines:visible').filter({hasText:'src/visible.ts'}).first().waitFor();
      await page.screenshot({path:path.join(captureDir,'context-budgets.png')});
    }
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder, 'src/visible.ts')));
    const selection = vscode.commands.executeCommand('forgelens.findRelatedTests');
    const relatedPicker = page.locator('.quick-input-widget:visible').filter({hasText:'Related tests for src/visible.ts'});
    if(captureDir){
      await relatedPicker.getByText('tests/visible.test.ts',{exact:true}).waitFor();
      await page.screenshot({path:path.join(captureDir,'related-tests.png')});
    }
    await relatedPicker.getByText('tests/visible.test.ts', {exact:true}).click({timeout:30000});
    const opened = await bounded(selection);
    assert.equal(path.relative(folder,opened.fsPath).split(path.sep).join('/'), 'tests/visible.test.ts');
    const checks = [];
    checks.push(await verifyCommand(vscode, page, folder, 'Git status', 0));
    checks.push(await verifyCommand(vscode, page, folder, 'Git diff check', 0));
    // This file is tracked in the fixture, even though *.tmp is ignored for
    // untracked discovery. Git diff --check must observe its on-disk change.
    const target = path.join(folder, 'src', 'tracked.tmp');
    const original = fs.readFileSync(target);
    try {
      fs.appendFileSync(target, '// intentional hosted QA whitespace failure   \n');
      checks.push(await verifyCommand(vscode, page, folder, 'Git diff check', 2));
    } finally { fs.writeFileSync(target, original); }
    assert.deepEqual(snapshot(folder), before, 'Native verification fixture was not restored byte for byte');
    assert.equal(requests, 0, 'Native saved-file checks must not contact the model endpoint');
    const setupServer=createServer((req,res)=>{
      assert.equal(req.url,'/api/v1/models');
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{name:'local/qa'}]}));
    });
    await new Promise(resolve=>setupServer.listen(0,'127.0.0.1',resolve));
    try {
      await config.update('baseUrl','http://127.0.0.1:'+setupServer.address().port,vscode.ConfigurationTarget.Global);
      const unconfigured=await bounded(vscode.commands.executeCommand('forgelens.checkSetup'));
      assert.equal(unconfigured.find(row=>row.name==='Model').ok,false);
      await config.update('model','local/qa',vscode.ConfigurationTarget.Global);
      const configured=await bounded(vscode.commands.executeCommand('forgelens.checkSetup'));
      assert.ok(configured.every(row=>row.ok),JSON.stringify(configured));
      if(captureDir) {
        // Output automatically scrolls to the last row. The title can be above
        // Monaco's rendered viewport, particularly in the VS Code 1.95 panel.
        await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
        try {
          await page.locator('.monaco-editor .view-lines:visible').filter({hasText:'local/qa'}).first().waitFor({timeout:15000});
        } finally { await page.screenshot({path:path.join(captureDir,'check-my-setup.png')}); }
      }
    } finally {
      setupServer.closeAllConnections();
      await new Promise(resolve=>setupServer.close(resolve));
    }
    console.log('FORGELENS_PREVIEW_DESKTOP_PASS ' + JSON.stringify({
      editor: vscode.version, hostNode: process.versions.node, os: process.platform, arch: process.arch,
      version: extension.packageJSON.version, revision: process.env.GITHUB_SHA, commands: commandIds.length,
      contextInspection: {budgetComparison:true, relatedTest:'tests/visible.test.ts'},
      setupCheck: {missingModelDetected:true, configuredCatalogVerified:true},
      installedPackage: { directory: path.basename(installedPath), sha256: process.env.FORGELENS_VSIX_SHA256 },
      selectedPaths, ignoredExplicitMentionsExcluded: true, fixtureUnchanged: true, trueforgeRequests: requests,
      verification: { nativeQuickPick: true, driver: 'Clicked the visible native picker item', actualTaskProcessEvents: checks, fixtureRestored: true },
    }));
  } finally {
    trap.closeAllConnections();
    await new Promise(resolve => trap.close(resolve));
  }
};

exports.snapshot = snapshot;
