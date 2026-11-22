import * as vscode from 'vscode';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { compareBudgets, relatedTests } from './contextInspection';
import { readContextFiles } from './contextPreview';
import { confinedPath } from './workspace';

export function registerContextTools(context: vscode.ExtensionContext) {
  const reports = new Map<string,string>();
  const scheme = 'forgelens-context';
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(scheme, { provideTextDocumentContent: uri => reports.get(uri.toString()) }),
    vscode.workspace.onDidCloseTextDocument(doc => { if (doc.uri.scheme === scheme) reports.delete(doc.uri.toString()); })
  );
  function register(id: string, action: (...args: any[]) => Promise<unknown>) {
    context.subscriptions.push(vscode.commands.registerCommand('forgelens.' + id, async (...args) => {
      try { return await action(...args); }
      catch (err) { void vscode.window.showErrorMessage(err instanceof Error ? err.message : 'Context inspection failed.'); }
    }));
  }
  function localFolder(uri?: vscode.Uri) {
    const folder = uri ? vscode.workspace.getWorkspaceFolder(uri) : vscode.workspace.workspaceFolders?.[0];
    if (!vscode.workspace.isTrusted || folder?.uri.scheme !== 'file') throw Error('Open a trusted local workspace folder first.');
    return folder;
  }
  function inWorkspace(folder: vscode.WorkspaceFolder) {
    return vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.some(f => f.uri.toString() === folder.uri.toString());
  }
  async function scan(folder: vscode.WorkspaceFolder) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Reading workspace context', cancellable: true },
      (_,token) => readContextFiles(folder.uri.fsPath, () => token.isCancellationRequested || !inWorkspace(folder)));
  }
  register('compareContextBudgets', async (request?: string, candidateBudget?: number) => {
    const folder = localFolder();
    const config = vscode.workspace.getConfiguration('forgelens', folder.uri);
    const current = config.get<number>('tokenBudget',10000);
    const query = request ?? await vscode.window.showInputBox({title:'Compare context budgets', prompt:'Enter the task to retrieve context for'});
    if (!query?.trim()) return;
    const valid = (value: string) => /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 100000 && Number(value) !== current;
    const input = candidateBudget === undefined ? await vscode.window.showInputBox({
      title:'Alternative excerpt token budget', prompt:`Current budget is ${current} tokens. Settings stay unchanged.`,
      value:String(current < 2 ? 2 : Math.floor(current/2)),
      validateInput: value => valid(value) ? undefined : 'Choose a different whole number from 1 to 100,000.'
    }) : String(candidateBudget);
    if (input === undefined) return;
    if (!valid(input)) throw Error('Choose a different whole number from 1 to 100,000.');
    const files = await scan(folder);
    if (!files || !inWorkspace(folder)) return;
    const report = compareBudgets(files, query, config.get<number>('contextBudget',24000), current, Number(input));
    const uri = vscode.Uri.from({scheme,path:'/Context budget comparison.txt',query:randomUUID()});
    reports.set(uri.toString(), report);
    try { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {preview:true}); }
    catch (err) { reports.delete(uri.toString()); throw err; }
    return uri;
  });
  register('findRelatedTests', async (target?: vscode.Uri) => {
    const uri = target ?? vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme !== 'file') throw Error('Open a source file in the editor first.');
    const folder = localFolder(uri);
    const source = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
    await confinedPath(folder.uri.fsPath,source);
    const files = await scan(folder);
    if (!files || !inWorkspace(folder)) return;
    const matches = relatedTests(files,source);
    if (!matches.length) { void vscode.window.showInformationMessage('No related tests found by static imports or filename.'); return; }
    const pick = await vscode.window.showQuickPick(matches.map(item => ({label:item.path,description:item.reason})),
      {title:'Related tests for ' + source,placeHolder:'Open a test file',matchOnDescription:true});
    if (pick && inWorkspace(folder)) {
      const testUri = vscode.Uri.file(await confinedPath(folder.uri.fsPath,pick.label));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(testUri), {preview:true});
      return testUri;
    }
  });
}
