import * as vscode from 'vscode';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { confinedPath } from './workspace';

export async function verifySavedWorkspace(report: (text: string) => void) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!vscode.workspace.isTrusted || folder?.uri.scheme !== 'file') {
    throw new Error('Open a trusted local folder before running a check.');
  }
  const root = folder.uri.fsPath;
  const checks = [
    { label: 'Git status', executable: 'git', args: ['status', '--short'] },
    { label: 'Git diff check', executable: 'git', args: ['diff', '--check'] }
  ];
  const cliTest = 'tests/test_cli.py';
  try {
    const file = await confinedPath(root, cliTest);
    if ((await lstat(file)).isFile()) {
      const python = vscode.workspace.getConfiguration('forgelens').get<string>('pythonPath')?.trim() || 'python';
      checks.push({ label: 'Flask CLI tests', executable: python, args: ['-m', 'pytest', cliTest, '-q'] });
    }
  } catch { /* A workspace need not contain the Flask CLI suite. */ }
  const dirty = vscode.workspace.textDocuments.some(doc =>
    doc.isDirty && doc.uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.toString() === folder.uri.toString());
  const choice = await vscode.window.showQuickPick(checks.map(check => ({
    ...check, description: [path.basename(check.executable), ...check.args].join(' ')
  })), {
    title: 'Verify saved changes',
    placeHolder: dirty ? 'Unsaved buffers are excluded. Choose a check to run on disk.' : 'Choose a command to run in the VS Code terminal.'
  });
  if (!choice) return;
  const runId = randomUUID();
  const task = new vscode.Task({ type: 'forgelens-verify', runId }, folder, choice.label, 'ForgeLens',
    new vscode.ProcessExecution(choice.executable, choice.args, { cwd: root }));
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, echo: true, clear: true };
  const start = performance.now();
  const listener = vscode.tasks.onDidEndTaskProcess(event => {
    if (event.execution.task.definition.runId !== runId) return;
    listener.dispose();
    ended.dispose();
    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    const result = event.exitCode === undefined ? 'stopped without an exit code' : `exit ${event.exitCode}`;
    report(`${choice.label}: ${result} after ${elapsed} s. See the task terminal for output.`);
  });
  const ended = vscode.tasks.onDidEndTask(event => {
    if (event.execution.task.definition.runId !== runId) return;
    listener.dispose();
    ended.dispose();
  });
  try {
    await vscode.tasks.executeTask(task);
  } catch (error) {
    listener.dispose();
    ended.dispose();
    throw error;
  }
}
