import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { ForgeRunner, registerMcp } from './client';
import { startMcp } from './mcp';
import { confinedPath, listWorkspace, readWorkspace } from './workspace';
import { ReviewStore, createProposal, renderProposal, undoEdit, isWithinSelection, AppliedEdit, FileProposal } from './review';
import { selectContext } from './context';
import { resolveAgentProposal } from './patch';
import { renderWebview } from './webview';

import { instructionsForTools } from './instructions';

export async function activate(context:vscode.ExtensionContext) {
 const store=new ReviewStore(); const undo:AppliedEdit[]=[]; const virtual=new Map<string,string>();
 const output=vscode.window.createOutputChannel('ForgeLens'); context.subscriptions.push(output);
 let panel:vscode.WebviewPanel|undefined; let runner:ForgeRunner|undefined; let active=false; let cancellation=false; let runExpired=false; let reviewing=false;
 let inlineScope:{file:string;start:number;end:number}|undefined;
 let bridge:Awaited<ReturnType<typeof startMcp>>|undefined; let commandAbort:AbortController|undefined;
 const emit=(text:string)=>{output.appendLine(text); void panel?.webview.postMessage({type:'append',text});};
 context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('forgelens',{provideTextDocumentContent:uri=>virtual.get(uri.toString())||''}));
 const root=()=>{const uri=vscode.workspace.workspaceFolders?.[0]?.uri;if(!uri||uri.scheme!=='file')throw new Error('Open a local workspace first.');return uri.fsPath;};
 const getDoc=async(file:string)=>vscode.workspace.openTextDocument(vscode.Uri.file(await confinedPath(root(),file)));
 async function preview(p:FileProposal, hunkId?:string){
  virtual.clear();
  const suffix=randomBytes(5).toString('hex'); const before=vscode.Uri.parse(`forgelens:/before/${suffix}/${p.path}`);const after=vscode.Uri.parse(`forgelens:/after/${suffix}/${p.path}`);
  virtual.set(before.toString(),p.original);
  const chosen=hunkId?{...p,hunks:p.hunks.filter(h=>h.id===hunkId)}:p;
  virtual.set(after.toString(),renderProposal(chosen,'all'));
  await vscode.commands.executeCommand('vscode.diff',before,after,`${p.path}${hunkId?' · '+hunkId:''} · Proposed (not saved)`,{preview:true});
 }
 async function stage(file:string,content:string){
  await confinedPath(root(),file); const doc=await getDoc(file); // existing files only in first version
  if(cancellation || runExpired || !active)throw new Error('Run cancelled');
  const existing=store.get(file);
  if(existing?.proposed===content)return 'Proposal already staged; awaiting human review. It is not on disk; continue other work, do not repeat.';
  const proposal=createProposal(file,doc.getText(),content);
  if(inlineScope && (file!==inlineScope.file || !isWithinSelection(doc.getText(),content,inlineScope.start,inlineScope.end)))throw new Error('Inline proposal changed text outside the selected region. Rejected without writes.');
  const p=existing?store.revise(file,doc.getText(),content):store.stage(file,doc.getText(),content); emit(`Staged ${file}: ${p.hunks.length} hunks. No disk writes.`);await preview(p);return `Staged ${p.hunks.length} hunks for ${file}; not applied. User reviews using Review hunks.`;
 }
 async function review(){
  if(reviewing)return;
  if(active){void vscode.window.showInformationMessage('Finish or cancel the run before applying staged edits.');return;}
  reviewing=true;
  try {for(const p of store.list()){
   for(const h of p.hunks){
    if(h.status!=='pending')continue; await preview(p,h.id);
    const answer=await vscode.window.showInformationMessage(`${p.path} · ${h.id}: review the diff, then choose.`,{modal:true},'Accept hunk','Reject hunk');
    if(!answer)return;store.decide(p.path,h.id,answer==='Accept hunk'?'accepted':'rejected');
   }
   const doc=await getDoc(p.path); const edit=store.prepare(p.path,doc.getText());
   if(edit.before!==edit.after){
    const answer=await vscode.window.showInformationMessage(`Apply accepted hunks to ${p.path}? Rejected hunks stay unchanged.`,{modal:true},'Apply accepted');if(!answer)return;
    if(doc.getText()!==edit.before)throw new Error('File changed during confirmation. Proposal retained; review again.');
    const change=new vscode.WorkspaceEdit();change.replace(doc.uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),edit.after);
    if(!await vscode.workspace.applyEdit(change))throw new Error('Editor did not apply the change. Proposal retained.');
    undo.push(edit);emit(`Applied reviewed hunks to ${p.path}. Buffer is unsaved; Save when ready. Undo available.`);
   }
   store.remove(p.path);
  }}finally{reviewing=false;}
 }
 async function cancel(){cancellation=true;commandAbort?.abort();store.cancel();emit('Cancelled locally. Unapplied proposals discarded; accepted edits unchanged.');void runner?.cancel().catch(()=>emit('Could not confirm server cancellation; local editing tools remain disabled.'));}
 function openPanel(){
  if(panel){panel.reveal();return;}
  panel=vscode.window.createWebviewPanel('forgelens','ForgeLens',vscode.ViewColumn.Beside,{enableScripts:true,retainContextWhenHidden:true});
  const nonce=randomBytes(16).toString('hex');
  panel.webview.html=renderWebview(nonce);
  panel.onDidDispose(()=>{panel=undefined;});panel.webview.onDidReceiveMessage(async(message)=>{try{if(message.type==='run'&&typeof message.prompt==='string')await run(message.prompt);if(message.type==='stop')await cancel();if(message.type==='review')await review();if(message.type==='undo')await undoLast();}catch(error){emit(error instanceof Error?error.message:'Operation failed.');}},undefined,context.subscriptions);
 }
 async function undoLast(){
  const previous=undo.at(-1);if(!previous)return;const doc=await getDoc(previous.path);const text=undoEdit(previous,doc.getText());const change=new vscode.WorkspaceEdit();change.replace(doc.uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),text);if(await vscode.workspace.applyEdit(change)){undo.pop();emit(`Undid ${previous.path}.`);}
 }
 async function run(prompt:string,scope?:{file:string;start:number;end:number}){
  if(reviewing)throw new Error('Finish the active review first.');
  if(active)throw new Error('A run is active. Stop it first.');if(!prompt.trim())return;
  if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before enabling agent tools.');
  if(store.list().length)throw new Error('Review pending proposals or Stop to discard them before starting another run.');
  const config=vscode.workspace.getConfiguration('forgelens');const model=config.get<string>('model','');if(!model)throw new Error('Configure a model in local TrueForge, then set ForgeLens: Model to its ID. No provider key belongs in extension settings.');
  const baseUrl=config.get<string>('baseUrl','http://127.0.0.1:8790');const parsed=new URL(baseUrl);if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname))throw new Error('This build supports local TrueForge only.');
  const recentToolCalls:string[]=[];let modelSwitching=false;runExpired=false;
  active=true;cancellation=false;inlineScope=scope;openPanel();emit('Assembling budgeted context…');
  try{
   const files=[];let total=0;for(const file of await listWorkspace(root())){if(cancellation)return;try{const content=await readWorkspace(root(),file);total+=content.length;if(total>8000000)break;files.push({path:file,content});}catch{}}
   const budget=config.get<number>('contextBudget',24000);const selected=selectContext(files,prompt,budget);
   const showContext=(result:ReturnType<typeof selectContext>,label:string)=>emit(`${label}: ${result.usedChars}/${result.budgetChars} characters:\n${result.items.map(f=>`${f.path}:${f.startLine}-${f.endLine}: ${f.reason}${f.truncated?' (snippet)':''}`).join('\n')}`);showContext(selected,'Initial retrieval preview');
   bridge=await startMcp({root:root(),budget,task:prompt,onToolCall:summary=>{recentToolCalls.push(summary);if(recentToolCalls.length>8)recentToolCalls.shift();},onPlan:files=>{
    output.appendLine(`Agent file plan:\n${files.map(f=>`${f.path}: ${f.reason}`).join('\n')}`);
    void panel?.webview.postMessage({type:'plan',files});
   },pending:file=>store.get(file)?.proposed,active:()=>active&&!cancellation&&!runExpired&&!modelSwitching,context:result=>showContext(result,'Agent discovery'),propose:stage,command:async(command,args)=>{
    const allowed=(command==='pytest'&&args.every(a=>a==='-q'||/^tests\/[\w/.-]+\.py(?:::[\w]+)*$/.test(a)))||(command==='git'&&['status --short','diff --stat','diff'].includes(args.join(' ')))||(command==='flask'&&args.join(' ')==='--help');
    if(!allowed)throw new Error('Command is not in the validation allowlist. Run custom commands yourself in the terminal.');
    const answer=await vscode.window.showWarningMessage(`Run ${command} ${args.join(' ')}? Tests/imports execute workspace code and may write caches.`,{modal:true},'Run command');if(!answer||cancellation||runExpired)throw new Error('Command denied or cancelled');
    commandAbort=new AbortController();return await new Promise<string>((resolve,reject)=>execFile(command,args,{cwd:root(),timeout:60000,maxBuffer:64000,signal:commandAbort!.signal,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}},(error,stdout,stderr)=>{const result=`${stdout}\n${stderr}`;emit(result);if(error)resolve(`Command failed: ${error.message}\n${result}`);else resolve(result);}));
   }});
   if(cancellation)return;
   const mcpName=`forgelens-${randomBytes(4).toString('hex')}`;await registerMcp(baseUrl,mcpName,bridge.url,bridge.token);
   if(cancellation)return;
   const preloadTools=config.get<boolean>('preloadTools',false);
   runner=new ForgeRunner({baseUrl,model,preloadTools,runTimeoutMs:config.get<number>('runTimeoutMinutes',5)*60000,modelCallTimeoutMs:Math.round(config.get<number>('modelCallTimeoutSeconds',120)*1000),onModelCallTimeout:()=>{modelSwitching=true;commandAbort?.abort();},onFallback:()=>{bridge?.resetExploration();modelSwitching=false;},getStagedProposalCount:()=>store.list().length,getRecentToolCalls:()=>recentToolCalls,reasoningEffort:config.get<string>('reasoningEffort')||undefined,fallbackModel:config.get<string>('fallbackModel')||undefined,mcpName,instructions:instructionsForTools(preloadTools),onEvent:event=>{if(cancellation)return;if(event.type==='model.message.delta')emit(String(event.content||''));else if(event.type==='client.status'){if(event.message.startsWith('Run time limit reached.')){runExpired=true;commandAbort?.abort();}emit(event.message);}else if(event.type==='turn.done'&&event.state.status==='error')emit(`Model error: ${event.state.message}`);else emit(event.type);},onQuestion:async details=>{
    if(cancellation||runExpired||modelSwitching)return undefined;
    emit(`Agent question: ${details.question}`);
    const custom={label:'Type a response…',custom:true};
    const picked=details.options.length ? await vscode.window.showQuickPick([...details.options.map(label=>({label,custom:false})),custom],{title:'ForgeLens clarification',placeHolder:details.question,ignoreFocusOut:true}) : custom;
    if(!picked||cancellation)return undefined;
    const answer=picked.custom ? await vscode.window.showInputBox({title:'ForgeLens clarification',prompt:details.question,ignoreFocusOut:true,validateInput:value=>value.trim()?undefined:'Enter an answer or cancel.'}) : picked.label;
    return cancellation?undefined:answer;
   },onApproval:async details=>{
    if(cancellation||runExpired||modelSwitching)return false;
    if((details.name==='propose_edit'||details.name==='propose_write')){
     const file=details.arguments.path;
     if(typeof file!=='string')return {allowed:false,reason:'Proposal validation failed: path must be a string. Correct the tool arguments and retry.'};
     let doc:vscode.TextDocument;let content:string;
     try{doc=await getDoc(file);content=resolveAgentProposal(store.get(file)?.proposed??doc.getText(),details.arguments);}catch(error){return {allowed:false,reason:`Proposal validation failed (not a user rejection): ${error instanceof Error?error.message:'Invalid proposal'}. Read the current file using the editor MCP and retry with exact source text. No edits were staged or applied.`};}
     await preview(createProposal(file,doc.getText(),content));
     return (await vscode.window.showInformationMessage(`TrueForge requests a staged edit to ${file}. Allow the proposal? Applying each hunk is a separate review step.`,{modal:true},'Allow staging'))==='Allow staging'&&!cancellation&&!runExpired;
    }
    if(details.name==='run_command')return (await vscode.window.showInformationMessage('TrueForge requests a validation command. The editor will check and confirm the exact command before execution.',{modal:true},'Allow command request'))==='Allow command request'&&!cancellation&&!runExpired;
    return {allowed:false,reason:`Unsupported tool ${details.name}. Use the editor MCP propose_edit for reviewable changes or run_command for approved validation. No user decision was requested.`};
   }});
   const result=await runner.run(prompt);
   emit(`Session ${result.sessionId}: ${result.status}. ${store.list().length} files staged.`);
   emit(`View session in local TrueForge: ${baseUrl}`);
   if(result.status==='error')emit('Run failed. No unreviewed edits were applied.');
  }catch(error){emit(error instanceof Error?error.message:'TrueForge request failed. No unreviewed edits applied.');}
  finally{await bridge?.close();bridge=undefined;runner=undefined;inlineScope=undefined;active=false;}
 }
 const command=(name:string,fn:()=>unknown)=>context.subscriptions.push(vscode.commands.registerCommand(name,async()=>{try{await fn();}catch(error){void vscode.window.showErrorMessage(error instanceof Error?error.message:'ForgeLens operation failed');}}));
 command('forgelens.start',()=>openPanel());command('forgelens.review',review);command('forgelens.cancel',cancel);command('forgelens.undo',undoLast);
 command('forgelens.inline',async()=>{const editor=vscode.window.activeTextEditor;if(!editor||editor.selection.isEmpty)throw new Error('Select the code you want to change.');const relative=path.relative(root(),editor.document.uri.fsPath).split(path.sep).join('/');const selected=editor.document.getText(editor.selection);const prompt=await vscode.window.showInputBox({prompt:'Describe the change to your selected code'});if(prompt)await run(`Inline edit in @file:${relative}\nOnly modify selected region and directly associated documentation. Selection starts line ${editor.selection.start.line+1}.\nInstruction: ${prompt}\nSelected code:\n${selected}`,{file:relative,start:editor.document.offsetAt(editor.selection.start),end:editor.document.offsetAt(editor.selection.end)});});
 context.subscriptions.push({dispose(){void cancel();void bridge?.close();}});
}
export function deactivate(){}
