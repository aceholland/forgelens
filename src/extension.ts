import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { ForgeRunner, registerMcp } from './client';
import { startMcp } from './mcp';
import { confinedPath } from './workspace';
import { ReviewStore, createProposal, renderProposal, undoEdit, isWithinSelection, AppliedEdit, FileProposal } from './review';
import type { ContextSelection } from './context';
import { describeContext, previewWorkspace } from './contextPreview';
import { verifySavedWorkspace } from './validation';
import { exportAcceptedPatch } from './reviewExport';
import { resolveAgentProposal } from './patch';
import { renderWebview } from './webview';

import { instructionsForTools } from './instructions';

export async function activate(context:vscode.ExtensionContext) {
 const store=new ReviewStore(); const undo:AppliedEdit[]=[]; const virtual=new Map<string,string>();
 const output=vscode.window.createOutputChannel('ForgeLens'); context.subscriptions.push(output);
 let panel:vscode.WebviewPanel|undefined; let runner:ForgeRunner|undefined; let active=false; let cancellation=false; let runExpired=false; let reviewing=false;
 let inlineScope:{file:string;start:number;end:number}|undefined;
 let bridge:Awaited<ReturnType<typeof startMcp>>|undefined; let commandAbort:AbortController|undefined;
 let scoutBridge:Awaited<ReturnType<typeof startMcp>>|undefined;
 let previewGeneration=0;
 let lastContext:{type:'context'; id:number; label:string; preview:ReturnType<typeof describeContext>; root:string}|undefined;
 let contextId=0;
 let phase='Ready';
 let reviewVersion=0;
 const updateState=()=>{
  const files=store.list();
  void panel?.webview.postMessage({type:'state',phase,active,pending:files.length>0,canUndo:undo.length>0,
   canExport:files.some(f=>f.hunks.some(h=>h.status==='accepted'))});
  void panel?.webview.postMessage({type:'queue',version:++reviewVersion,editable:!active&&!reviewing,
   files:files.map(f=>({path:f.path,hunks:f.hunks.map(h=>({id:h.id,status:h.status}))}))});
 };
 let outputStreaming=false;
 const emit=(text:string)=>{if(outputStreaming)output.appendLine('');outputStreaming=false;output.appendLine(text);void panel?.webview.postMessage({type:'append',text});};
 const emitDelta=(text:string)=>{if(!text)return;output.append(text);outputStreaming=true;void panel?.webview.postMessage({type:'delta',text});};
 context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('forgelens',{provideTextDocumentContent:uri=>virtual.get(uri.toString())||''}));
 const root=()=>{const uri=vscode.workspace.workspaceFolders?.[0]?.uri;if(!uri||uri.scheme!=='file')throw new Error('Open a local workspace first.');return uri.fsPath;};
 let workspaceKey=vscode.workspace.workspaceFolders?.[0]?.uri.toString();
 context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(()=>{
  const next=vscode.workspace.workspaceFolders?.[0]?.uri.toString();
  if(next===workspaceKey)return;
  workspaceKey=next;
  ++previewGeneration;lastContext=undefined;undo.length=0;
  void cancel();store.cancel();virtual.clear();
  void panel?.webview.postMessage({type:'reset'});
  updateState();
 }));
 const getDoc=async(file:string)=>vscode.workspace.openTextDocument(vscode.Uri.file(await confinedPath(root(),file)));
 function showContext(result:ContextSelection,label:string,folder:string) {
  const preview=describeContext(result);
  lastContext={type:'context',id:++contextId,label,preview,root:folder};
  void panel?.webview.postMessage(lastContext);
  output.appendLine(`${label}: ${preview.usedChars}/${preview.budgetChars} characters; ${preview.items.length} files`);
  return preview;
 }
 async function inspectContext(prompt:string) {
  if(active)throw new Error('Wait for the current run to finish.');
  if(!vscode.workspace.isTrusted)throw new Error('Open a trusted local folder to preview context.');
  if(!prompt.trim())throw new Error('Enter a task to preview its context.');
  const folder=root();
  const request=++previewGeneration;
  const stopped=()=>request!==previewGeneration || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath!==folder;
  const budget=vscode.workspace.getConfiguration('forgelens').get<number>('contextBudget',24000);
  openPanel();
  const result=await previewWorkspace(folder,prompt,budget,stopped);
  if(result&&!stopped())return showContext(result,'Local context preview',folder);
 }
 async function openExcerpt(id:unknown,index:unknown) {
  if(!lastContext || id!==lastContext.id || typeof index!=='number' || !Number.isInteger(index) || root()!==lastContext.root) return;
  const item=lastContext.preview.items[index];
  if(!item)return;
  const doc=await getDoc(item.path);
  const range=doc.validateRange(new vscode.Range(item.startLine-1,0,item.endLine-1,Number.MAX_SAFE_INTEGER));
  await vscode.window.showTextDocument(doc,{viewColumn:vscode.ViewColumn.One,selection:range,preview:true});
 }
 async function exportPatch(){
  if(active||reviewing)return;
  const folder=root();
  const version=reviewVersion;
  const files=store.list().filter(p=>p.hunks.some(h=>h.status==='accepted'));
  if(!files.length){void vscode.window.showInformationMessage('Mark at least one hunk Accepted in the panel to export a patch.');return;}
  const destination=await vscode.window.showSaveDialog({title:'Export accepted hunks as a Git patch',
   defaultUri:vscode.Uri.file(path.join(root(),'forgelens-accepted.patch')),filters:{'Git patch':['patch','diff']}});
  if(!destination)return;
  if(destination.scheme!=='file'||!(/\.(patch|diff)$/i).test(destination.fsPath))throw new Error('Choose a local .patch or .diff file.');
  for(const file of files)await confinedPath(folder,file.path);
  if(version!==reviewVersion||folder!==root())throw new Error('The review changed. Export again with your current decisions.');
  const patch=exportAcceptedPatch(store);
  await vscode.workspace.fs.writeFile(destination,Buffer.from(patch,'utf8'));
  emit(`Exported accepted hunks to ${path.basename(destination.fsPath)}.`);
 }
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
  if(inlineScope && (file!==inlineScope.file || !isWithinSelection(doc.getText(),content,inlineScope.start,inlineScope.end)))throw new Error('Inline proposal changed text outside the selected region. Rejected without writes.');
  const p=existing?store.revise(file,doc.getText(),content):store.stage(file,doc.getText(),content);updateState();emit(`Staged ${file}: ${p.hunks.length} hunks. No disk writes.`);await preview(p);return `Staged ${p.hunks.length} hunks for ${file}; not applied. User reviews using Review hunks.`;
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
  }}finally{reviewing=false;updateState();}
 }
 async function cancel(){
  if(reviewing)return;
  if(!active&&!store.list().length)return;
  if(active&&cancellation)return;
  const start=performance.now();
  cancellation=true;commandAbort?.abort();store.cancel();
  const elapsed=(performance.now()-start).toFixed(1);
  phase=active?'Stopping':'Ready';
  emit(`Local edit gate closed and pending proposals cleared in ${elapsed} ms. Server cancellation is separate.`);
  updateState();
  void runner?.cancel().catch(()=>emit('Could not confirm server cancellation; local editing tools remain disabled.'));
 }
 function openPanel(){
  if(panel){panel.reveal();return;}
  panel=vscode.window.createWebviewPanel('forgelens','ForgeLens',vscode.ViewColumn.Beside,{enableScripts:true,retainContextWhenHidden:true});
  const nonce=randomBytes(16).toString('hex');
  panel.webview.html=renderWebview(nonce);
  panel.onDidDispose(()=>{panel=undefined;});
  panel.webview.onDidReceiveMessage(async(message)=>{
   try {
    switch(message?.type) {
     case 'ready': updateState(); if(lastContext&&lastContext.root===vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)void panel?.webview.postMessage(lastContext); break;
     case 'run': if(typeof message.prompt==='string')await run(message.prompt); break;
     case 'inspect': if(typeof message.prompt==='string')await inspectContext(message.prompt); break;
     case 'openContext': await openExcerpt(message.id,message.index); break;
     case 'hunk': {
      if(active||reviewing||message.version!==reviewVersion||typeof message.path!=='string')break;
      const proposal=store.get(message.path);
      if(!proposal?.hunks.some(h=>h.id===message.id))break;
      if(message.action==='preview')await preview(proposal,message.id);
      if(message.action==='accepted'||message.action==='rejected'){
       store.decide(proposal.path,message.id,message.action);
       updateState();
      }
      break;
     }
     case 'verify': await verifySavedWorkspace(emit); break;
     case 'export': await exportPatch(); break;
     case 'stop': await cancel(); break;
     case 'review': await review(); break;
     case 'undo': await undoLast(); break;
    }
   }catch(error){emit(error instanceof Error?error.message:'Operation failed.');}
  },undefined,context.subscriptions);
 }
 async function undoLast(){
  if(active||reviewing)return;
  const previous=undo.at(-1);if(!previous)return;const doc=await getDoc(previous.path);const text=undoEdit(previous,doc.getText());const change=new vscode.WorkspaceEdit();change.replace(doc.uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),text);if(await vscode.workspace.applyEdit(change)){undo.pop();emit(`Undid ${previous.path}.`);updateState();}
 }
 async function run(prompt:string,scope?:{file:string;start:number;end:number}){
  if(reviewing)throw new Error('Finish the active review first.');
  if(active)throw new Error('A run is active. Stop it first.');if(!prompt.trim())return;
  if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before enabling agent tools.');
  if(store.list().length)throw new Error('Review pending proposals or Stop to discard them before starting another run.');
  const config=vscode.workspace.getConfiguration('forgelens');const model=config.get<string>('model','');if(!model)throw new Error('Configure a model in local TrueForge, then set ForgeLens: Model to its ID. No provider key belongs in extension settings.');
  const baseUrl=config.get<string>('baseUrl','http://127.0.0.1:8790');const parsed=new URL(baseUrl);if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname))throw new Error('This build supports local TrueForge only.');
  const recentToolCalls:string[]=[];let modelSwitching=false;runExpired=false;
  const folder=root();
  ++previewGeneration;active=true;cancellation=false;inlineScope=scope;phase='Running';openPanel();updateState();
  void vscode.commands.executeCommand('setContext','forgelens.running',true);
  void panel?.webview.postMessage({type:'plan',files:[]});
  emit('Assembling budgeted context…');
  try{
   const budget=config.get<number>('contextBudget',24000);
   const selected=await previewWorkspace(folder,prompt,budget,()=>cancellation);
   if(!selected||cancellation)return;
   showContext(selected,'Initial retrieval preview',folder);
   bridge=await startMcp({root:root(),budget,task:prompt,requireDiscovery:!scope,onToolCall:summary=>{recentToolCalls.push(summary);if(recentToolCalls.length>8)recentToolCalls.shift();},onPlan:files=>{
    output.appendLine(`Agent file plan:\n${files.map(f=>`${f.path}: ${f.reason}`).join('\n')}`);
    void panel?.webview.postMessage({type:'plan',files});
   },pending:file=>store.get(file)?.proposed,active:()=>active&&!cancellation&&!runExpired&&!modelSwitching,context:result=>showContext(result,'Agent discovery',folder),propose:stage,command:async(command,args)=>{
    const allowed=(command==='pytest'&&args.every(a=>a==='-q'||/^tests\/[\w/.-]+\.py(?:::[\w]+)*$/.test(a)))||(command==='git'&&['status --short','diff --stat','diff'].includes(args.join(' ')))||(command==='flask'&&args.join(' ')==='--help');
    if(!allowed)throw new Error('Command is not in the validation allowlist. Run custom commands yourself in the terminal.');
    const answer=await vscode.window.showWarningMessage(`Run ${command} ${args.join(' ')}? Tests/imports execute workspace code and may write caches.`,{modal:true},'Run command');if(!answer||cancellation||runExpired)throw new Error('Command denied or cancelled');
    commandAbort=new AbortController();return await new Promise<string>((resolve,reject)=>execFile(command,args,{cwd:root(),timeout:60000,maxBuffer:64000,signal:commandAbort!.signal,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}},(error,stdout,stderr)=>{const result=`${stdout}\n${stderr}`;emit(result);if(error)resolve(`Command failed: ${error.message}\n${result}`);else resolve(result);}));
   }});
   if(cancellation)return;
   const mcpName=`forgelens-${randomBytes(4).toString('hex')}`;await registerMcp(baseUrl,mcpName,bridge.url,bridge.token);
   if(cancellation)return;
   const preloadTools=config.get<boolean>('preloadTools',false);
   let contextScout:{mcpName:string}|undefined;
   if(!scope&&config.get<boolean>('contextScout',false)){
    const deny=async()=>{throw new Error('The context scout is read-only.');};
    scoutBridge=await startMcp({root:folder,budget,task:prompt,readOnly:true,requireDiscovery:true,active:()=>active&&!cancellation&&!runExpired,
     propose:deny,command:deny,context:result=>showContext(result,'Scout discovery',folder)});
    if(cancellation)return;
    const name=`forgelens-scout-${randomBytes(6).toString('hex')}`;
    await registerMcp(baseUrl,name,scoutBridge.url,scoutBridge.token);
    contextScout={mcpName:name};
   }
   if(cancellation)return;
   runner=new ForgeRunner({baseUrl,model,preloadTools,contextScout,onScoutFinished:async()=>{
    const completed=scoutBridge;scoutBridge=undefined;await completed?.close();
   },runTimeoutMs:config.get<number>('runTimeoutMinutes',5)*60000,modelCallTimeoutMs:Math.round(config.get<number>('modelCallTimeoutSeconds',120)*1000),onModelCallTimeout:()=>{modelSwitching=true;commandAbort?.abort();},onFallback:()=>{bridge?.resetExploration();modelSwitching=false;},getStagedProposalCount:()=>store.list().length,getRecentToolCalls:()=>recentToolCalls,reasoningEffort:config.get<string>('reasoningEffort')||undefined,fallbackModel:config.get<string>('fallbackModel')||undefined,mcpName,instructions:instructionsForTools(preloadTools),onEvent:event=>{if(cancellation)return;if(event.type==='model.message.delta')emitDelta(String(event.content||''));else if(event.type==='client.status'){if(event.message.startsWith('Run time limit reached.')){runExpired=true;commandAbort?.abort();}emit(event.message);}else if(event.type==='turn.done'&&event.state.status==='error')emit(`Model error: ${event.state.message}`);else emit(event.type);},onQuestion:async details=>{
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
  finally{try{await Promise.all([bridge?.close(),scoutBridge?.close()]);}finally{bridge=undefined;scoutBridge=undefined;runner=undefined;inlineScope=undefined;active=false;phase=store.list().length?'Review ready':'Ready';updateState();void vscode.commands.executeCommand('setContext','forgelens.running',false);}}
 }
 const command=(name:string,fn:()=>unknown)=>context.subscriptions.push(vscode.commands.registerCommand(name,async()=>{try{await fn();}catch(error){void vscode.window.showErrorMessage(error instanceof Error?error.message:'ForgeLens operation failed');}}));
 command('forgelens.start',()=>openPanel());command('forgelens.review',review);command('forgelens.cancel',cancel);command('forgelens.undo',undoLast);
 command('forgelens.verify',()=>verifySavedWorkspace(emit));
 command('forgelens.exportPatch',exportPatch);
 context.subscriptions.push(vscode.commands.registerCommand('forgelens.previewContext',async (input?:string)=>{
  const prompt=typeof input==='string'?input:await vscode.window.showInputBox({prompt:'Describe the task to preview its source context'});
  if(!prompt)return;
  try{return await inspectContext(prompt);}catch(error){void vscode.window.showErrorMessage(error instanceof Error?error.message:'Context preview failed.');}
 }));
 command('forgelens.inline',async()=>{
  const editor=vscode.window.activeTextEditor;
  if(!editor||editor.document.uri.scheme!=='file'||editor.selection.isEmpty)throw new Error('Select code in a local file.');
  const target=root();
  const doc=editor.document;
  const file=path.relative(target,doc.uri.fsPath).split(path.sep).join('/');
  await confinedPath(target,file);
  const selection=editor.selection;
  const version=doc.version;
  const prompt=await vscode.window.showInputBox({prompt:'Describe the change to your selected code'});
  if(!prompt)return;
  if(doc.version!==version || target!==root())throw new Error('The selection changed. Select the code again.');
  await confinedPath(target,file);
  await run(`Inline edit in @file:${file}\nOnly modify selected region and directly associated documentation. Selection starts line ${selection.start.line+1}.\nInstruction: ${prompt}\nSelected code:\n${doc.getText(selection)}`,{file,start:doc.offsetAt(selection.start),end:doc.offsetAt(selection.end)});
 });
 context.subscriptions.push({dispose(){void cancel();void bridge?.close();}});
}
export function deactivate(){}
