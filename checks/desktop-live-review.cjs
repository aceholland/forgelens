const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { snapshot } = require('./desktop-preview.cjs');

async function until(read, label) {
  const deadline = Date.now() + 60000;
  do {
    const value = await read();
    if (value) return value;
    await delay(150);
  } while (Date.now() < deadline);
  throw Error('Timed out waiting for ' + label);
}

exports.run = async () => {
  const vscode = require('vscode');
  const folder = process.env.FORGELENS_PREVIEW_FIXTURE;
  const original = snapshot(folder);
  const files = ['src/doubles.py','tests/test_doubles.py'];
  assert.deepEqual(Object.keys(original).sort(), files);
  assert.equal(fs.realpathSync(vscode.workspace.workspaceFolders[0].uri.fsPath), fs.realpathSync(folder));
  assert.ok(vscode.workspace.isTrusted);
  const extension = vscode.extensions.getExtension('forgelens-team.forgelens');
  assert.equal(fs.realpathSync(path.dirname(extension.extensionPath)), fs.realpathSync(process.env.FORGELENS_INSTALLED_EXTENSIONS));
  await extension.activate();
  const { chromium } = require(path.join(process.env.RUNNER_TEMP, 'forge-preview-harness/node_modules/playwright-core'));
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + process.env.FORGELENS_PICKER_PORT);
  const page = await until(() => browser.contexts().flatMap(c=>c.pages()).find(p=>/workbench/i.test(p.url())), 'VS Code workbench');
  await vscode.commands.executeCommand('forgelens.start');
  const panel = await until(async () => {
    for (const frame of page.frames()) if (await frame.locator('#task').isVisible()) return frame;
  }, 'ForgeLens panel');

  async function consent(label, expected) {
    const button = page.getByRole('button', {name:label, exact:true});
    const dialog = page.locator('[role=dialog], [role=alertdialog], .monaco-dialog-box').filter({has:button}).last();
    const text = await dialog.innerText({timeout:60000});
    for (const detail of expected) assert.ok(text.includes(detail), 'Consent omitted ' + detail);
    assert.deepEqual(snapshot(folder), original);
    await button.click();
  }
  async function decide(file, labels) {
    const lenses = await until(async () => {
      const after = vscode.workspace.textDocuments.find(d=>d.uri.scheme==='forgelens' && d.uri.path.startsWith('/after/') && d.uri.path.endsWith('/'+file));
      if (!after) return;
      const items = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', after.uri);
      if (items?.some(lens=>lens.command?.command==='forgelens.decideHunk')) return items;
    }, 'native diff CodeLens for '+file);
    for (const label of labels) {
      const command = lenses.find(lens=>lens.command?.title===label)?.command;
      assert.ok(command, 'Missing ' + label);
      await vscode.commands.executeCommand(command.command,...command.arguments);
    }
    assert.deepEqual(snapshot(folder), original);
  }
  try {
    await panel.locator('#task').fill('Change double so it doubles the number. Update the regression test.');
    await panel.getByRole('button', {name:'Draft from context', exact:true}).click();
    await consent('Review files', files);
    await decide(files[0], ['Accept hunk-1','Reject hunk-2']);
    await decide(files[1], ['Accept hunk-1']);
    await consent('Run candidate tests', [...files, '-m pytest -q -p no:cacheprovider -- tests/test_doubles.py']);
    await until(async () => (await panel.locator('#phase').innerText())==='Review ready', 'completed TrueForge turn');
    const output = await panel.locator('#events').innerText();
    assert.match(output, /Candidate pytest exited 0/);
    assert.match(output, /2 passed/);
    assert.deepEqual(snapshot(folder), original);
    assert.ok(!vscode.workspace.textDocuments.some(d=>d.uri.scheme==='file' && d.isDirty));
    console.log('FORGELENS_DESKTOP_LIVE_REVIEW_PASS ' + JSON.stringify({editor:vscode.version, os:process.platform,
      arch:process.arch, vsix:process.env.FORGELENS_VSIX_SHA256, provider:'deterministic loopback',
      accepted:2, rejected:1, pytestPassed:2, originalsUnchanged:true}));
  } catch (error) {
    console.error('ForgeLens panel:', await panel.locator('body').innerText({timeout:5000}).catch(()=>'(unavailable)'));
    throw error;
  }
};
