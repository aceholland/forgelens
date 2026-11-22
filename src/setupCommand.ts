import * as vscode from 'vscode';
import { inspectSetup, testSetupModel } from './setupCheck';

export function registerSetupCheck(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('ForgeLens Setup');
  const command = vscode.commands.registerCommand('forgelens.checkSetup', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const config = vscode.workspace.getConfiguration('forgelens',folder?.uri);
    const model = config.get<string>('model','');
    const url = config.get<string>('baseUrl','http://127.0.0.1:8790');
    const rows = await inspectSetup({editor:vscode.version, trusted:vscode.workspace.isTrusted,
      localFolder:folder?.uri.scheme==='file' && !vscode.env.remoteName, baseUrl:url, model});
    output.clear();
    output.appendLine('ForgeLens setup check\n');
    for (const row of rows) output.appendLine(`${row.ok ? 'OK' : 'Action needed'}  ${row.name}\n  ${row.detail}\n`);
    output.show(true);
    const ready = rows.every(row=>row.ok);
    const fixes = ready?['Test model','Model settings']:['Model settings','Setup guide'];
    void vscode.window.showInformationMessage(ready?'ForgeLens found your local service and configured model.':
      'ForgeLens setup needs attention. See the Setup output for the next step.',...fixes).then(async choice=>{
      if(choice==='Model settings') await vscode.commands.executeCommand('workbench.action.openSettings','@ext:forgelens-team.forgelens');
      if(choice==='Setup guide') await vscode.env.openExternal(vscode.Uri.parse('https://github.com/aceholland/forgelens#try-it-in-vs-code'));
      if(choice!=='Test model')return;
      if(!vscode.workspace.isTrusted || vscode.workspace.workspaceFolders?.[0]?.uri.toString()!==folder?.uri.toString())return;
      await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Testing the configured model with a short message',cancellable:true},async(_,cancel)=>{
        const controller=new AbortController();
        const deadline=setTimeout(()=>controller.abort(),120000);
        const sub=cancel.onCancellationRequested(()=>controller.abort());
        try { await testSetupModel(url,model,controller.signal); output.appendLine('OK  The configured model returned text through TrueForge.'); }
        catch { output.appendLine(controller.signal.aborted?'Model test stopped before completion.':'Model test failed. Check the connection and provider in TrueForge.'); }
        finally { clearTimeout(deadline);sub.dispose();output.show(true); }
      });
    });
    return rows;
  });
  context.subscriptions.push(command,output);
}
