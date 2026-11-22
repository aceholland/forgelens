import * as vscode from 'vscode';
import { runCodeModeReview } from './codeMode';
import type { ReviewInput } from './codeModeBridge';

const testAdvice = {
  'not-run': 'Run staged tests to check the proposed changes.',
  stale: 'The review changed after the last staged test. Run staged tests again.',
  failed: 'The staged candidate failed its last test run. Inspect the staged test comparison.',
  passed: 'The staged candidate passed its last test run.',
};

export function registerCodeModeReview(context: vscode.ExtensionContext, getReview: () => ReviewInput) {
  const output = vscode.window.createOutputChannel('ForgeLens Review Analysis');
  let active: AbortController | undefined;
  const command = vscode.commands.registerCommand('forgelens.analyzeReviewInSandbox', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file' || vscode.env.remoteName || !vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('Open a trusted local workspace to analyze a ForgeLens review.');
      return;
    }
    if (active) { void vscode.window.showInformationMessage('A ForgeLens review analysis is already running.'); return; }
    const snapshot = getReview();
    if (!snapshot.files.length) { void vscode.window.showInformationMessage('Review a proposed edit in ForgeLens first.'); return; }
    const captured = new Date().toISOString();
    const config = vscode.workspace.getConfiguration('forgelens', folder.uri);
    const model = config.get<string>('model', '').trim();
    if (!model) { void vscode.window.showWarningMessage('Set ForgeLens: Model to a registered TrueForge model first.'); return; }
    const controller = new AbortController();
    active = controller;
    try {
      const consent = await vscode.window.showInformationMessage('Analyze this review with TrueForge?', {
        modal: true,
        detail: `ForgeLens registers the pinned review checklist in your local TrueForge service and runs it with ${model}. The sandbox receives anonymous hunk counts and staged test status.`,
      }, 'Run analysis');
      if (consent !== 'Run analysis' || controller.signal.aborted || !vscode.workspace.isTrusted ||
          vscode.workspace.workspaceFolders?.[0]?.uri.toString() !== folder.uri.toString()) return;
      return await vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
        title: 'ForgeLens is analyzing the review in TrueForge', cancellable: true}, async (_, token) => {
        const cancelled = token.onCancellationRequested(() => controller.abort());
        const foldersChanged = vscode.workspace.onDidChangeWorkspaceFolders(() => controller.abort());
        const timeoutMs = config.get<number>('runTimeoutMinutes', 5) * 60_000;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const result = await runCodeModeReview(config.get<string>('baseUrl', 'http://127.0.0.1:8790'),
            model, snapshot, controller.signal);
          controller.signal.throwIfAborted();
          output.clear();
          output.appendLine('ForgeLens review captured ' + captured);
          output.appendLine(`${result.files} files · ${result.accepted} accepted · ${result.pending} pending · ${result.rejected} rejected`);
          if (result.pending) output.appendLine('Use the ForgeLens review panel to accept or reject the remaining hunks.');
          output.appendLine(testAdvice[result.tests]);
          output.appendLine('Verified TrueForge skill, sandbox and Code Mode session ' + result.sessionId);
          output.show(true);
          return result;
        } catch (error) {
          const message = controller.signal.aborted ? 'Review analysis stopped before completion.'
            : error instanceof Error ? error.message : 'TrueForge could not analyze the review.';
          void vscode.window.showWarningMessage(message);
        } finally { clearTimeout(timer); cancelled.dispose(); foldersChanged.dispose(); }
      });
    } finally { active = undefined; }
  });
  context.subscriptions.push(command, output, {dispose: () => active?.abort()});
}
