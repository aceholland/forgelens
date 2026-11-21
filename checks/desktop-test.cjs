const assert = require('node:assert/strict');
const vscode = require('vscode');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.run = async () => {
  const extension = vscode.extensions.getExtension('forgelens-team.forgelens');
  assert.ok(extension, 'editor did not discover the released extension');
  assert.equal(extension.packageJSON.version, '0.1.13');
  assert.equal(vscode.workspace.workspaceFolders?.[0].uri.scheme, 'file');
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const id of ['start', 'inline', 'review', 'cancel', 'undo']) {
    assert.ok(commands.includes('forgelens.' + id), 'missing command: ' + id);
  }
  await vscode.commands.executeCommand('forgelens.start');
  const panelIsOpen = () => vscode.window.tabGroups.all.some(group =>
    group.tabs.some(tab => tab.label === 'ForgeLens' && tab.input instanceof vscode.TabInputWebview));
  for (let i = 0; i < 50 && !panelIsOpen(); i++) await delay(100);
  assert.ok(panelIsOpen(), 'Open Agent must create a visible ForgeLens webview tab');
  console.log('FORGELENS_DESKTOP_PASS ' + JSON.stringify({
    editor: vscode.version, hostNode: process.versions.node, os: process.platform,
    arch: process.arch, version: extension.packageJSON.version, commands: 5, panelOpened: true,
  }));
};
