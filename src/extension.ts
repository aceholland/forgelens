import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ForgeRunner, registerMcp, TurnStreamInterrupted, type ForgeOptions } from './client';
import { startMcp } from './mcp';
import { confinedPath } from './workspace';
import { ReviewStore, createProposal, renderProposal, undoEdit, isWithinSelection, AppliedEdit, FileProposal } from './review';
import type { ContextSelection } from './context';
import { describeContext, previewWorkspace } from './contextPreview';
import { compactContext, compactEvidence, compactInstructions, draftInstructions, sequentialDraftInstructions } from './compactContext';
import { verifySavedWorkspace } from './validation';
import { exportAcceptedPatch } from './reviewExport';
import { LiveReviews, batchForReview, lensOffsets, reviewFeedback, reviewedCandidate, type Decision } from './editorReview';
import { candidateTestArgs, runCandidateTests } from './candidateValidation';
import { nextPendingHunk, ReviewSummary } from './reviewSummary';
import { userFixturePins } from './candidateFixtures';
import { resolveAgentProposal } from './patch';
import { renderWebview } from './webview';

import { instructionsForTools } from './instructions';
import { SequentialDraft } from './sequentialDraft';

export async function activate(context:vscode.ExtensionContext) {
 const store=new ReviewStore(); const undo:(AppliedEdit & {identity?:string})[]=[]; const virtual=new Map<string,string>();
 const live=new LiveReviews();
 const lensesChanged=new vscode.EventEmitter<void>();
 const lenses=new Map<string,{file:string; offsets:ReturnType<typeof lensOffsets>; current:()=>FileProposal|undefined}>();
 context.subscriptions.push(lensesChanged);
 let liveMode=true,undoing=false;
 const output=vscode.window.createOutputChannel('ForgeLens'); context.subscriptions.push(output);
 let panel:vscode.WebviewPanel|undefined; let runner:ForgeRunner|undefined; let active=false; let cancellation=false; let runExpired=false; let reviewing=false;
 let inlineScope:{file:string;start:number;end:number}|undefined;
 let bridge:Awaited<ReturnType<typeof startMcp>>|undefined; let commandAbort:AbortController|undefined;
 let scoutBridge:Awaited<ReturnType<typeof startMcp>>|undefined;
 let previewGeneration=0;
 let lastContext:{type:'context'; id:number; label:string; preview:ReturnType<typeof describeContext>; root:string}|undefined;
 let contextId=0;
 let phase='Ready',runningPhase='Running';
 let reviewVersion=0;
 let reviewEpoch=0;
 let summary = new ReviewSummary();
 let lastVisitedHunk: {path: string; id: string} | undefined;
 const reviewFiles=()=>[...store.list().filter(file=>!live.get(file.path)),...live.list()];
 const currentOverlay=(file:string)=>{const proposal=store.get(file);return proposal ? liveMode?renderProposal(proposal):proposal.proposed : undefined;};
 const updateState=()=>{
  const files=reviewFiles();
  void panel?.webview.postMessage({type:'state',phase,active,pending:files.length>0,canUndo:undo.length>0,
   canExport:files.some(f=>f.hunks.some(h=>h.status==='accepted')),canExportSummary:summary.available});
  void panel?.webview.postMessage({type:'queue',version:++reviewVersion,editable:!reviewing&&(!active||live.list().length>0),
   files:files.map(f=>({path:f.path,kind:f.kind,editable:!reviewing&&(!active||!!live.get(f.path)),hunks:f.hunks.map(h=>({id:h.id,status:h.status}))}))});
  lensesChanged.fire();
 };
 let outputStreaming=false;
 const emit=(text:string)=>{if(outputStreaming)output.appendLine('');outputStreaming=false;output.appendLine(text);void panel?.webview.postMessage({type:'append',text});};
 const emitDelta=(text:string)=>{if(!text)return;output.append(text);outputStreaming=true;void panel?.webview.postMessage({type:'delta',text});};
 context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('forgelens',{provideTextDocumentContent:uri=>virtual.get(uri.toString())||''}));
 context.subscriptions.push(vscode.languages.registerCodeLensProvider({scheme:'forgelens'},{
  onDidChangeCodeLenses:lensesChanged.event,
  provideCodeLenses(doc){
   const key=doc.uri.toString(), view=lenses.get(key), proposal=view?.current();
   if(!view || !proposal || reviewing)return [];
   const controls=view.offsets.flatMap(({id,offset})=>{
    const hunk=proposal.hunks.find(h=>h.id===id);
    if(!hunk)return [];
    const position=doc.positionAt(offset),range=new vscode.Range(position.line,0,position.line,0);
    return (['accepted','rejected'] as const).map(status=>new vscode.CodeLens(range,{
     title:(status==='accepted'?'Accept':'Reject')+' '+id+(hunk.status===status?' ✓':''),
     command:'forgelens.decideHunk',arguments:[key,id,status]}));
   });
   if(controls.length && view.offsets.length===proposal.hunks.length && proposal.hunks.filter(h=>h.status==='pending').length>1){
    for(const status of ['accepted','rejected'] as const)controls.push(new vscode.CodeLens(controls[0].range,{
     title:status==='accepted'?'Accept pending hunks in file':'Reject pending hunks in file',command:'forgelens.decideFile',arguments:[key,status]}));
   }
   return controls;
  }
 }));
 context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc=>{if(doc.uri.scheme==='forgelens'){virtual.delete(doc.uri.toString());lenses.delete(doc.uri.toString());}}));
 const root=()=>{const uri=vscode.workspace.workspaceFolders?.[0]?.uri;if(!uri||uri.scheme!=='file')throw new Error('Open a local workspace first.');return uri.fsPath;};
 let workspaceKey=vscode.workspace.workspaceFolders?.[0]?.uri.toString();
 context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(()=>{
  const next=vscode.workspace.workspaceFolders?.[0]?.uri.toString();
  if(next===workspaceKey)return;
  workspaceKey=next;
  summary=new ReviewSummary();lastVisitedHunk=undefined;
  ++previewGeneration;lastContext=undefined;undo.length=0;
  void cancel();store.cancel();virtual.clear();lenses.clear();
  void panel?.webview.postMessage({type:'reset'});
  updateState();
 }));
 const getDoc=async(file:string)=>vscode.workspace.openTextDocument(vscode.Uri.file(await confinedPath(root(),file)));
 async function newFileUri(file:string){
  if(file.split('/').some(part=>!part || /[:<>|"?*\x00-\x1f]|[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))throw new Error('Choose a portable relative file name.');
  const base=await realpath(root()),target=await confinedPath(base,file);
  if(path.relative(path.resolve(base,file),target)!=='')throw new Error('New file paths cannot use linked directories.');
  try{await lstat(target);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return vscode.Uri.file(target);throw error;}
  throw new Error('The new file already exists. Choose a different path or edit the existing file.');
 }
 async function originalText(file:string,created:boolean){
  if(created){await newFileUri(file);return '';}
  return (await getDoc(file)).getText();
 }
 function showContext(result:ContextSelection,label:string,folder:string) {
  const preview=describeContext(result);
  lastContext={type:'context',id:++contextId,label,preview,root:folder};
  void panel?.webview.postMessage(lastContext);
  output.appendLine(`${label}: ${preview.usedTokens}/${preview.budgetTokens} excerpt tokens (${preview.encoding}), ${preview.usedChars}/${preview.budgetChars} characters`);
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
  const result=await previewWorkspace(folder,prompt,budget,stopped,vscode.workspace.getConfiguration('forgelens').get<number>('tokenBudget',10000));
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
  const exportTarget=await resolvedExportPath(destination.fsPath);
  for(const file of store.list()){
   if(!path.relative(await confinedPath(folder,file.path),exportTarget))throw new Error('Choose a patch destination separate from the reviewed files.');
   if(files.includes(file)&&await originalText(file.path,file.kind==='create')!==file.original)throw new Error(`The workspace changed at ${file.path}. Refresh the proposal before exporting.`);
  }
  if(version!==reviewVersion||folder!==root())throw new Error('The review changed. Export again with your current decisions.');
  const patch=exportAcceptedPatch(store);
  await vscode.workspace.fs.writeFile(destination,Buffer.from(patch,'utf8'));
  emit(`Exported accepted hunks to ${path.basename(destination.fsPath)}.`);
 }
 async function resolvedExportPath(filename:string){
  return realpath(filename).catch(async(error:NodeJS.ErrnoException)=>{
   if(error.code!=='ENOENT')throw error;
   const info=await lstat(filename).catch((err:NodeJS.ErrnoException)=>{if(err.code!=='ENOENT')throw err;return undefined;});
   if(info?.isSymbolicLink())throw new Error('Choose an export destination without a broken symbolic link.');
   return path.join(await realpath(path.dirname(filename)),path.basename(filename));
  });
 }
 async function exportSummary(){
  if(!summary.available)return;
  const folder=root(), current=summary, snapshot=summary.snapshot();
  const destination=await vscode.window.showSaveDialog({title:'Export review summary',defaultUri:vscode.Uri.file(path.join(folder,'forgelens-review.json')),filters:{'JSON':['json']}});
  if(!destination)return;
  if(destination.scheme!=='file'||!destination.fsPath.toLowerCase().endsWith('.json'))throw new Error('Choose a local JSON file.');
  const target=await resolvedExportPath(destination.fsPath);
  for(const file of snapshot.files){
   if(!path.relative(await confinedPath(folder,file.path),target))throw new Error('Choose a summary destination separate from the reviewed files.');
  }
  if(folder!==root()||current!==summary||!isDeepStrictEqual(snapshot,summary.snapshot()))throw new Error('The review changed. Export again with the current results.');
  await vscode.workspace.fs.writeFile(destination,Buffer.from(JSON.stringify(snapshot,null,2)+'\n','utf8'));
  emit(`Exported review summary to ${path.basename(destination.fsPath)}.`);
 }
 async function preview(p:FileProposal, hunkId?:string,controls=true,sourceTab=false){
  const suffix=randomBytes(8).toString('hex');
  const before=vscode.Uri.from({scheme:'forgelens',path:`/before/${suffix}/${p.path}`});
  const after=vscode.Uri.from({scheme:'forgelens',path:`/after/${suffix}/${p.path}`});
  const viewColumn=panel?.viewColumn===vscode.ViewColumn.One?vscode.ViewColumn.Two:vscode.ViewColumn.One;
  virtual.set(before.toString(),p.original);
  const chosen=hunkId?{...p,hunks:p.hunks.filter(h=>h.id===hunkId)}:p;
  virtual.set(after.toString(),renderProposal(chosen,'all'));
  if(controls){
   const request=live.get(p.path);
   const epoch=reviewEpoch;
   const current=()=>{
    if(epoch!==reviewEpoch)return undefined;
    if(request)return live.get(p.path)===request ? request.proposal : undefined;
    const staged=store.get(p.path);
    return !active&&staged?.original===p.original&&staged.proposed===p.proposed ? staged : undefined;
   };
   lenses.set(after.toString(),{file:p.path,offsets:lensOffsets(p,chosen.hunks),current});
  }
  try{if(sourceTab){
   virtual.delete(before.toString());
   await vscode.window.showTextDocument(after,{viewColumn,preview:true});
  }else{
   const position=hunkId && chosen.hunks[0] ? (await vscode.workspace.openTextDocument(after)).positionAt(chosen.hunks[0].startOffset) : undefined;
   await vscode.commands.executeCommand('vscode.diff',before,after,`${p.path}${hunkId?' · '+hunkId:''} · Proposed (not saved)`,
    {preview:true,viewColumn,selection:position?new vscode.Range(position,position):undefined});
  }}catch(error){virtual.delete(before.toString());virtual.delete(after.toString());lenses.delete(after.toString());throw error;}
 }
 function decide(file:string,id:string|undefined,decision:Decision) {
  if(reviewing)return;
  const request=live.get(file);
  if(request)live.decide(request,id,decision);
  else if(!active){
   const proposal=store.get(file);
   if(!proposal)return;
   for(const hunk of proposal.hunks)if(id?hunk.id===id:hunk.status==='pending')store.decide(file,hunk.id,decision);
  }
  const updated=request?.proposal??store.get(file);
  if(updated)summary.observe(updated);
  updateState();
 }
 context.subscriptions.push(vscode.commands.registerCommand('forgelens.decideHunk',(key:unknown,id:unknown,status:unknown)=>{
  if(typeof key!=='string'||typeof id!=='string'||(status!=='accepted'&&status!=='rejected'))return;
  const view=lenses.get(key),p=view?.current();
  if(view&&p&&view.offsets.some(h=>h.id===id))decide(p.path,id,status);
 }));
 context.subscriptions.push(vscode.commands.registerCommand('forgelens.decideFile',(key:unknown,status:unknown)=>{
  if(typeof key!=='string'||(status!=='accepted'&&status!=='rejected'))return;
  const view=lenses.get(key),p=view?.current();
  if(view&&p&&view.offsets.length===p.hunks.length)decide(p.path,undefined,status);
 }));
 async function stage(file:string,content:string,expectedBase?:string,create=false,signal?:AbortSignal){
  const epoch=reviewEpoch,folder=root(),existing=store.get(file),created=create||existing?.kind==='create';
  if(create&&existing)throw new Error('A file with this name is already staged.');
  if(create&&(!content.length||content.includes('\0')||content.length>250000))throw new Error('A new file needs nonempty text within the edit limit.');
  const original=await originalText(file,created);
  const base=currentOverlay(file)??original;
  if(expectedBase!==undefined&&base!==expectedBase)throw new Error('Staged text changed before review. Read the current file and retry.');
  if(existing&&existing.original!==original)throw new Error('The workspace file changed since staging.');
  if(signal?.aborted || cancellation || runExpired || !active || reviewEpoch!==epoch || root()!==folder)throw new Error('Run or tool call cancelled');
  if(base===content)return 'No change to the current staged view.';
  if(inlineScope && (created || file!==inlineScope.file || !isWithinSelection(original,content,inlineScope.start,inlineScope.end)))throw new Error('Inline proposal changed text outside the selected region. Rejected without writes.');
  if(!liveMode){
   const p=existing?store.revise(file,original,content):store.stage(file,original,content,created?'create':undefined);
   summary.observe(p);updateState();emit(`Staged ${file}: ${p.hunks.length} hunks. No disk writes.`);
   await preview(p);return `Staged ${p.hunks.length} hunks for ${file}; not applied. User reviews using Review hunks.`;
  }
  const delta=createProposal(file,base,content);
  if(created)delta.kind='create';
  const request=live.begin(delta);
  summary.observe(delta);
  const abort=()=>{request.fail(new Error('TrueForge cancelled this proposal.'));live.end(request);};
  signal?.addEventListener('abort',abort,{once:true});
  phase='Review requested';updateState();
  emit(`Review ${file} in the diff or panel. TrueForge will receive your hunk decisions.`);
  try{
   const [reviewed]=await Promise.all([request.result,preview(delta)]);
   const current=await originalText(file,created);
   if(signal?.aborted||!active||cancellation||runExpired||root()!==folder||live.get(file)!==request||current!==original)throw new Error('Review expired or the workspace changed. No edits were added.');
   store.commitReviewed(original,existing,reviewed);
   const accepted=reviewed.hunks.filter(h=>h.status==='accepted').length;
   emit(`${file}: ${accepted} accepted, ${reviewed.hunks.length-accepted} rejected. Sent decisions to TrueForge.`);
   return reviewFeedback(reviewed);
  }finally{signal?.removeEventListener('abort',abort);live.end(request);if(active&&!cancellation&&!runExpired)phase=live.list().length?'Review requested':runningPhase;updateState();}
 }
 async function fileIdentity(file:string){
  const stat=await lstat(file,{bigint:true});
  return stat.isFile()?`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`:undefined;
 }
 async function review(){
  if(reviewing||undoing)return;
  if(active){void vscode.window.showInformationMessage('Finish or cancel the run before applying staged edits.');return;}
  const folder=root();
  reviewing=true;updateState();
  try {for(const p of store.list()){
   for(const h of p.hunks){
    if(h.status!=='pending')continue; await preview(p,h.id);
    const answer=await vscode.window.showInformationMessage(`${p.path} · ${h.id}: review the diff, then choose.`,{modal:true},'Accept hunk','Reject hunk');
    if(!answer||root()!==folder||!store.get(p.path))return;summary.observe(store.decide(p.path,h.id,answer==='Accept hunk'?'accepted':'rejected'));
   }
   const created=p.kind==='create';
   const edit=store.prepare(p.path,await originalText(p.path,created));
   if(edit.before!==edit.after){
    const answer=await vscode.window.showInformationMessage(created?`Create ${p.path} on disk with the accepted content?`:`Apply accepted hunks to ${p.path}?`,{modal:true},created?'Create file':'Apply accepted');
    if(!answer||root()!==folder||!store.get(p.path))return;
    const change=new vscode.WorkspaceEdit();
    if(created){
     change.createFile(await newFileUri(p.path),{overwrite:false,ignoreIfExists:false,contents:Buffer.from(edit.after,'utf8')});
    }else{
     const doc=await getDoc(p.path);
     if(doc.getText()!==edit.before)throw new Error('File changed during confirmation. Proposal retained; review again.');
     change.replace(doc.uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),edit.after);
    }
    if(!await vscode.workspace.applyEdit(change))throw new Error('Editor did not apply the change. Proposal retained.');
    const identity=created?await fileIdentity(await confinedPath(folder,p.path)).catch(()=>undefined):undefined;
    undo.push({...edit,identity});emit(created?`Created ${p.path}. Undo available.`:`Applied reviewed hunks to ${p.path}. Buffer is unsaved; Save when ready. Undo available.`);
   }
   store.remove(p.path);
  }}finally{reviewing=false;phase=store.list().length?'Review ready':'Ready';updateState();}
 }
 async function cancel(){
  if(reviewing)return;
  if(!active&&!store.list().length)return;
  if(active&&cancellation)return;
  const start=performance.now();
  ++reviewEpoch;cancellation=true;commandAbort?.abort();live.cancel('Run cancelled during hunk review.');store.cancel();
  summary=new ReviewSummary();lastVisitedHunk=undefined;
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
  panel.onDidDispose(()=>{panel=undefined;if(active)void cancel();});
  panel.webview.onDidReceiveMessage(async(message)=>{
   try {
    switch(message?.type) {
     case 'ready': updateState(); if(lastContext&&lastContext.root===vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)void panel?.webview.postMessage(lastContext); break;
     case 'run': case 'draft': if(typeof message.prompt==='string')await run(message.prompt,undefined,message.type==='draft'); break;
     case 'inspect': if(typeof message.prompt==='string')await inspectContext(message.prompt); break;
     case 'openContext': await openExcerpt(message.id,message.index); break;
     case 'hunk': case 'hunks': case 'reviewSource':{
      if(reviewing||message.version!==reviewVersion||typeof message.path!=='string')break;
      const proposal=live.get(message.path)?.proposal??(!active?store.get(message.path):undefined);
      if(!proposal)break;
      if(message.type==='reviewSource'){await preview(proposal,undefined,true,true);break;}
      if(message.type==='hunk'&&!proposal.hunks.some(h=>h.id===message.id))break;
      if(message.action==='preview')await preview(proposal,message.id);
      if(message.action==='accepted'||message.action==='rejected')decide(proposal.path,message.type==='hunks'?undefined:message.id,message.action);
      break;
     }
     case 'allHunks':{
      if(reviewing||message.version!==reviewVersion||(message.action!=='accepted'&&message.action!=='rejected'))break;
      for(const proposal of active?live.list():store.list())decide(proposal.path,undefined,message.action);
      break;
     }
     case 'verify': await verifySavedWorkspace(emit); break;
     case 'export': await exportPatch(); break;
     case 'exportSummary': await exportSummary(); break;
     case 'nextHunk': {
      if(reviewing||message.version!==reviewVersion)break;
      const next=nextPendingHunk(active?live.list():store.list(),lastVisitedHunk);
      if(next){
       lastVisitedHunk={path:next.file.path,id:next.hunk.id};
       await preview(next.file,next.hunk.id);
      }
      break;
     }
     case 'stop': await cancel(); break;
     case 'review': await review(); break;
     case 'undo': await undoLast(); break;
    }
   }catch(error){emit(error instanceof Error?error.message:'Operation failed.');}
  },undefined,context.subscriptions);
 }
 async function undoLast(){
  if(active||reviewing||undoing)return;
  const previous=undo.at(-1);if(!previous)return;
  undoing=true;
  try{
  const folder=root(),doc=await getDoc(previous.path);
  const change=new vscode.WorkspaceEdit();
  if(previous.kind==='create'){
   const answer=await vscode.window.showInformationMessage(`Undo creation and remove ${previous.path}?`,{modal:true},'Undo creation');
   if(!answer||folder!==root()||undo.at(-1)!==previous)return;
   const target=await confinedPath(folder,previous.path),lexical=path.join(await realpath(folder),previous.path);
   if(path.relative(lexical,target)!==''||!previous.identity||await fileIdentity(target)!==previous.identity||doc.isDirty||doc.getText()!==previous.after||!(await readFile(target)).equals(Buffer.from(previous.after,'utf8')))throw new Error('Created file changed. Undo refused.');
   change.deleteFile(doc.uri,{recursive:false,ignoreIfNotExists:false});
  }else{
   const text=undoEdit(previous,doc.getText());
   change.replace(doc.uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),text);
  }
  if(root()===folder&&undo.at(-1)===previous&&await vscode.workspace.applyEdit(change)){if(undo.at(-1)===previous)undo.pop();emit(`Undid ${previous.path}.`);updateState();}
  }finally{undoing=false;}
 }
 async function run(prompt:string,scope?:{file:string;start:number;end:number},draftFromContext=false){
  if(reviewing||undoing)throw new Error('Finish the active edit operation first.');
  if(active)throw new Error('A run is active. Stop it first.');if(!prompt.trim())return;
  if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before enabling agent tools.');
  if(store.list().length)throw new Error('Review pending proposals or Stop to discard them before starting another run.');
  const config=vscode.workspace.getConfiguration('forgelens');const model=config.get<string>('model','');if(!model)throw new Error('Configure a model in local TrueForge, then set ForgeLens: Model to its ID. No provider key belongs in extension settings.');
  const baseUrl=config.get<string>('baseUrl','http://127.0.0.1:8790');const parsed=new URL(baseUrl);if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname))throw new Error('This build supports local TrueForge only.');
  const recentToolCalls:string[]=[];let modelSwitching=false;runExpired=false;
  const sequentialDraft=draftFromContext && config.get<boolean>('sequentialDraft',false) ? new SequentialDraft() : undefined;
  const folder=root();
  runningPhase=draftFromContext?'Drafting from context':'Running';
  summary=new ReviewSummary();lastVisitedHunk=undefined;
  ++previewGeneration;++reviewEpoch;active=true;cancellation=false;liveMode=!!sequentialDraft||config.get<boolean>('liveReview',true);inlineScope=scope;phase=runningPhase;openPanel();updateState();
  void vscode.commands.executeCommand('setContext','forgelens.running',true);
  void panel?.webview.postMessage({type:'plan',files:[]});
  emit('Assembling budgeted context…');
  try{
   const budget=config.get<number>('contextBudget',24000);
   const tokenBudget=config.get<number>('tokenBudget',10000);
   const compact=draftFromContext||(!scope && config.get<boolean>('compactRequests',false));
   const selected=compact?await compactContext(folder,prompt,budget,tokenBudget,()=>cancellation,draftFromContext):await previewWorkspace(folder,prompt,budget,()=>cancellation,tokenBudget);
   if(!selected||cancellation)return;
   showContext(selected,draftFromContext?'Draft source context':'Initial retrieval preview',folder);
   if(draftFromContext&&!selected.items.length)throw new Error('No files matched this draft. Refine the task, mention a file, or choose Run agent.');
   if(draftFromContext)emit('Draft from context · proposals are limited to the retrieved files.');
   bridge=await startMcp({root:folder,budget,tokenBudget,draftFromContext,sequentialDraft,
    draftModelIntervalSeconds:config.get<number>('draftModelIntervalSeconds',0),
    onDraftWait:ms=>emit('Draft model interval · waiting '+Math.ceil(ms/1000)+'s before returning the tool result.'),
    compactContext:compact?selected:undefined,task:prompt,requireDiscovery:!scope,onToolCall:summary=>{recentToolCalls.push(summary);if(recentToolCalls.length>8)recentToolCalls.shift();emit('Editor tool · '+summary);},onPlan:files=>{
    output.appendLine(`Agent file plan:\n${files.map(f=>`${f.path}: ${f.reason}`).join('\n')}`);
    void panel?.webview.postMessage({type:'plan',files});
   },pending:currentOverlay,autoValidateReviewedTests:liveMode,active:()=>active&&!cancellation&&!runExpired&&!modelSwitching,context:result=>showContext(result,'Agent discovery',folder),
   propose:(file,content,base,signal)=>stage(file,content,base,false,signal),create:(file,content,signal)=>stage(file,content,'',true,signal),validate:async(tests,signal)=>{
    const snapshot=()=>reviewedCandidate(store.list(),liveMode,live.list().length>0);
    const overlays=snapshot();
    if(!overlays.length)throw new Error('There are no staged changes to test.');
    const python=config.get<string>('pythonPath','python');
    const fixtureSetting=()=>userFixturePins(vscode.workspace.getConfiguration('forgelens').inspect('candidateTestFixtures'));
    const fixtures=fixtureSetting();
    const pinned=Object.entries(fixtures).map(([file,hash])=>file+'  '+hash);
    const fixtureDetail=pinned.length?'\nPinned Git test fixtures (committed bytes):\n'+pinned.join('\n'):'';
    const epoch=reviewEpoch;
    const choice=await vscode.window.showWarningMessage('Run the staged changes in an isolated workspace copy?',{
     modal:true,detail:`Command: ${[python,...candidateTestArgs(tests)].map(arg=>/\s/.test(arg)?JSON.stringify(arg):arg).join(' ')}\nStaged files: ${overlays.map(p=>p.path).join(', ')}${fixtureDetail}\nTests execute project code with your user permissions.`
    },'Run candidate tests');
    if(choice!=='Run candidate tests'||signal?.aborted||!active||cancellation||runExpired||modelSwitching||epoch!==reviewEpoch||!vscode.workspace.isTrusted||root()!==folder)throw new Error('Candidate validation declined or expired.');
    if(!isDeepStrictEqual(snapshot(),overlays))throw new Error('Reviewed files changed during confirmation. Request validation again.');
    if(!isDeepStrictEqual(fixtureSetting(),fixtures))throw new Error('Pinned fixtures changed during approval. Request validation again.');
    if(commandAbort)throw new Error('Another verification process is already active.');
    const controller=new AbortController();commandAbort=controller;
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    const repairPaths=draftFromContext?new Set(selected.items.map(item=>item.path)):undefined;
    const testedSummary=summary, testedRevision=summary.revision;
    try{
     const result=await runCandidateTests(folder,overlays,tests,python,controller.signal,fixtures,repairPaths);
     if(summary===testedSummary)summary.recordTest(result.exitCode,testedRevision);
     emit(result.feedback);return result.feedback;
    }
    finally{signal?.removeEventListener('abort',abort);if(commandAbort===controller)commandAbort=undefined;}
   },command:async(command,args,signal)=>{
    const allowed=(command==='pytest'&&args.every(a=>a==='-q'||/^tests\/[\w/.-]+\.py(?:::[\w]+)*$/.test(a)))||(command==='git'&&['status --short','diff --stat','diff'].includes(args.join(' ')))||(command==='flask'&&args.join(' ')==='--help');
    if(!allowed)throw new Error('Command is not in the validation allowlist. Run custom commands yourself in the terminal.');
    const epoch=reviewEpoch;
    const current=()=>active&&!cancellation&&!runExpired&&!modelSwitching&&epoch===reviewEpoch&&vscode.workspace.isTrusted&&root()===folder;
    if(signal?.aborted||!current())throw new Error('Saved-workspace command request expired.');
    const answer=await vscode.window.showWarningMessage(`Run ${command} ${args.join(' ')}? Tests/imports execute workspace code and may write caches.`,{modal:true},'Run command');
    if(answer!=='Run command'||signal?.aborted||!current())throw new Error('Command denied or cancelled.');
    if(commandAbort)throw new Error('Another verification process is already active.');
    const controller=new AbortController();commandAbort=controller;
    const processSignal=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
    try{return await new Promise<string>((resolve,reject)=>execFile(command,args,{cwd:folder,timeout:60000,maxBuffer:64000,signal:processSignal,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}},(error,stdout,stderr)=>{
     if(processSignal.aborted){reject(new Error('Saved-workspace command was cancelled.'));return;}
     const result=`${stdout}\n${stderr}`;emit(result);
     resolve(error?`Command failed: ${error.message}\n${result}`:result);
    }));}
    finally{if(commandAbort===controller)commandAbort=undefined;}
   }});
   if(cancellation)return;
   const mcpName=`forgelens-${randomBytes(4).toString('hex')}`;await registerMcp(baseUrl,mcpName,bridge.url,bridge.token);
   if(cancellation)return;
   emit('Connected to TrueForge · '+model);
   const preloadTools=compact || config.get<boolean>('preloadTools',false);
   let contextScout:ForgeOptions['contextScout'];
   if(!scope&&!draftFromContext&&config.get<boolean>('contextScout',false)){
    const deny=async()=>{throw new Error('The context scout is read-only.');};
    scoutBridge=await startMcp({root:folder,budget,tokenBudget,task:prompt,readOnly:true,requireDiscovery:true,active:()=>active&&!cancellation&&!runExpired,
     propose:deny,command:deny,onToolCall:summary=>emit('Read-only scout · '+summary),context:result=>showContext(result,'Scout discovery',folder)});
    if(cancellation)return;
    const name=`forgelens-scout-${randomBytes(6).toString('hex')}`;
    await registerMcp(baseUrl,name,scoutBridge.url,scoutBridge.token);
    contextScout={mcpName:name,mode:'native'};
    emit('Read-only child scout enabled for this turn.');
   }
   if(cancellation)return;
   runner=new ForgeRunner({baseUrl,model,preloadTools,draftFromContext,sequentialDraft,contextScout,onScoutFinished:async()=>{
    const completed=scoutBridge;scoutBridge=undefined;await completed?.close();
   },runTimeoutMs:config.get<number>('runTimeoutMinutes',5)*60000,
   modelCallTimeoutMs:Math.round(config.get<number>('modelCallTimeoutSeconds',120)*1000),
   onModelCallTimeout:()=>{++reviewEpoch;modelSwitching=true;commandAbort?.abort();live.cancel('Model call timed out during hunk review.');},
   onFallback:()=>{bridge?.resetExploration();modelSwitching=false;},
   getStagedProposalCount:()=>store.list().length+live.list().length,getRecentToolCalls:()=>recentToolCalls,
   reasoningEffort:config.get<string>('reasoningEffort')||undefined,fallbackModel:config.get<string>('fallbackModel')||undefined,
   fallbackModels:config.get<string[]>('fallbackModels'),
   mcpName,instructions:sequentialDraft?sequentialDraftInstructions:draftFromContext?draftInstructions:compact&&selected.items.length?compactInstructions:instructionsForTools(preloadTools),
   sourceEvidence:compact&&selected.items.length?compactEvidence(selected,draftFromContext):undefined,onEvent:event=>{
    if(cancellation)return;
    if(event.type==='model.message.delta')emitDelta(String(event.content||''));
    else if(event.type==='client.status'){
     if(event.message.startsWith('Run time limit reached.')){runExpired=true;commandAbort?.abort();live.cancel('Run timed out during hunk review.');}
     emit(event.message);
    }else if(event.type==='thread.context_compaction_started')
     emit(`TrueForge is summarizing the conversation (threshold ${event.trigger.thresholdTokens.toLocaleString()} tokens).`);
    else if(event.type==='thread.context_compaction_finished')emit('TrueForge summarized the conversation. Continuing this turn.');
    else if(event.type==='turn.done'&&event.state.status==='error')emit(`Model error: ${event.state.message}`);
    else emit(event.type);
   },onQuestion:draftFromContext || !config.get<boolean>('askQuestions',true) ? undefined : async details=>{
    if(cancellation||runExpired||modelSwitching)return undefined;
    emit(`Agent question: ${details.question}`);
    const custom={label:'Type a response…',custom:true};
    const picked=details.options.length ? await vscode.window.showQuickPick([...details.options.map(label=>({label,custom:false})),custom],{title:'ForgeLens clarification',placeHolder:details.question,ignoreFocusOut:true}) : custom;
    if(!picked||cancellation)return undefined;
    const answer=picked.custom ? await vscode.window.showInputBox({title:'ForgeLens clarification',prompt:details.question,ignoreFocusOut:true,validateInput:value=>value.trim()?undefined:'Enter an answer or cancel.'}) : picked.label;
    return cancellation?undefined:answer;
   },onApproval:async details=>{
    if(cancellation||runExpired||modelSwitching)return false;
    const epoch=reviewEpoch;
    const permitted=()=>active&&!cancellation&&!runExpired&&!modelSwitching&&epoch===reviewEpoch&&folder===root();
    if(details.name==='propose_changes' && compact && !scope) {
     const batch=batchForReview(details.arguments.files);
     if(batch.allowed===false)return batch;
     const names:string[]=[];
     try{
      for(const file of batch.files){
       if(typeof file?.path!=='string')throw new Error('Expected a workspace-relative path for every file.');
       if(draftFromContext&&!selected.items.some(item=>item.path===file.path))throw new Error('Use Run agent to edit a file outside the retrieved context.');
       await confinedPath(folder,file.path);
       names.push(file.path);
      }
     }catch(error){return {allowed:false,reason:'Invalid proposal path: '+(error instanceof Error?error.message:'correct the paths and try again')};}
     return (await vscode.window.showInformationMessage('Allow TrueForge to propose changes for review?',{modal:true,detail:names.join('\n')},'Review files'))==='Review files'&&permitted();
    }
    if(details.name==='propose_edit'||details.name==='propose_write'||details.name==='create_file'){
     const file=details.arguments.path;
     if(typeof file!=='string')return {allowed:false,reason:'Proposal validation failed: path must be a string. Correct the tool arguments and retry.'};
     const creating=details.name==='create_file';
     try{
      const base=await originalText(file,creating||store.get(file)?.kind==='create');
      const current=currentOverlay(file)??base;
      const content=creating?details.arguments.content:resolveAgentProposal(current,details.arguments);
      if(typeof content!=='string'||content.includes('\0')||content.length>250000||(creating&&!content))throw new Error('Expected a bounded text proposal.');
      if(scope&&(creating||file!==scope.file||!isWithinSelection(base,content,scope.start,scope.end)))throw new Error('Change escapes the selected text.');
      await preview(createProposal(file,current,content),undefined,false);
     }catch(error){return {allowed:false,reason:`Proposal validation failed: ${error instanceof Error?error.message:'Invalid proposal'}. Read the current staged view before retrying.`};}
     return (await vscode.window.showInformationMessage(`Allow TrueForge to propose ${creating?'a new file':'edits'} at ${file} for review?`,{modal:true},'Allow staging'))==='Allow staging'&&permitted();
    }
    if(details.name==='validate_candidate')return (await vscode.window.showInformationMessage('Allow a staged test request? You will review the files and command before execution.',{modal:true},'Review test request'))==='Review test request'&&permitted();
    if(details.name==='run_command')return (await vscode.window.showInformationMessage('TrueForge requests a validation command. The editor will check and confirm the exact command before execution.',{modal:true},'Allow command request'))==='Allow command request'&&permitted();
    return {allowed:false,reason:`Unsupported tool ${details.name}. Use the editor MCP propose_edit for reviewable changes or run_command for approved validation. No user decision was requested.`};
   }});
   const result=await runner.run(prompt);
   emit(`Session ${result.sessionId}: ${result.status}. ${store.list().length} files staged.`);
   emit(`View session in local TrueForge: ${baseUrl}`);
   if(result.status==='error')emit('Run failed. No unreviewed edits were applied.');
  }catch(error){
   emit(error instanceof Error?error.message:'TrueForge request failed. No unreviewed edits applied.');
   if(error instanceof TurnStreamInterrupted){
    emit(`Session ${error.sessionId}: interrupted. ${store.list().length} files staged.`);
    const target='api/v1/sessions/'+encodeURIComponent(error.sessionId)+'/turns'+(error.turnId?'/'+encodeURIComponent(error.turnId):'');
    emit('Inspect the original TrueForge turn: '+new URL(target,baseUrl.endsWith('/')?baseUrl:baseUrl+'/').href);
   }
  }
  finally{live.cancel('Run ended during hunk review.');commandAbort?.abort();try{await Promise.all([bridge?.close(),scoutBridge?.close()]);}finally{bridge=undefined;scoutBridge=undefined;runner=undefined;inlineScope=undefined;active=false;phase=store.list().length?'Review ready':'Ready';updateState();void vscode.commands.executeCommand('setContext','forgelens.running',false);}}
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
