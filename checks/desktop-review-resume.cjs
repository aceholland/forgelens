const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {snapshot}=require('./desktop-preview.cjs');

exports.run=async()=>{
  const vscode=require('vscode');
  const folder=process.env.FORGELENS_PREVIEW_FIXTURE;
  const before=snapshot(folder);
  const upstream=require('./desktop-live-model.cjs').files;
  const file='src/doubles.py';
  const extension=vscode.extensions.getExtension('forgelens-team.forgelens');
  assert.equal(path.relative(fs.realpathSync(path.dirname(extension.extensionPath)),fs.realpathSync(process.env.FORGELENS_INSTALLED_EXTENSIONS)),'');
  await extension.activate();
  const {chromium}=require(path.join(process.env.RUNNER_TEMP,'forge-preview-harness/node_modules/playwright-core'));
  const browser=await chromium.connectOverCDP('http://127.0.0.1:'+process.env.FORGELENS_PICKER_PORT);
  async function until(read,label){
    const deadline=Date.now()+45000;
    do{const value=await read();if(value)return value;await delay(100);}while(Date.now()<deadline);
    throw Error('Timed out: '+label);
  }
  const page=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>/workbench/i.test(p.url())),'native workbench');
  await vscode.commands.executeCommand('forgelens.start');
  const panel=await until(async()=>{for(const frame of page.frames())if(await frame.locator('#task').isVisible())return frame;},'review panel');
  const events=panel.locator('#events');
  const waitOutput=(s)=>until(async()=>(await events.innerText()).includes(s),s);
  const capture=async name=>{
    if(process.env.FORGELENS_QA_CAPTURE_DIR){await delay(200);await page.screenshot({path:path.join(process.env.FORGELENS_QA_CAPTURE_DIR,name+'.png')});}
  };
  const group=vscode.window.tabGroups.all.find(g=>g.tabs.some(t=>t.label==='ForgeLens'&&t.input instanceof vscode.TabInputWebview));
  const column=group.viewColumn===vscode.ViewColumn.One?vscode.ViewColumn.Two:vscode.ViewColumn.One;
  const doc=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(folder,file)));
  const editor=await vscode.window.showTextDocument(doc,{viewColumn:column,preview:false});
  const base=doc.getText();
  assert.equal(base,upstream[file]);
  const replace=async text=>assert.ok(await editor.edit(e=>e.replace(new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),text)));
  await panel.getByRole('button',{name:'Resume saved review',exact:true}).waitFor();
  await replace(base+'# changed during restart\n');
  await panel.getByRole('button',{name:'Resume saved review',exact:true}).click();
  await waitOutput('Saved review retained.');
  assert.equal(await panel.locator('#hunks h3').count(),0);
  await replace(base);
  await panel.getByRole('button',{name:'Resume saved review',exact:true}).click();
  await waitOutput('Resumed saved review with its hunk decisions.');
  const restored=await panel.locator('#hunks').innerText();
  assert.ok(restored.includes(file)&&restored.includes('tests/test_doubles.py'));
  assert.equal((restored.match(/hunk-\d+ · accepted/g)||[]).length,2);
  assert.equal((restored.match(/hunk-\d+ · rejected/g)||[]).length,1);
  await capture('resumed-review');
  const local=base.replace('return n\n','return n + 1\n');
  await replace(local);
  const check=panel.getByRole('button',{name:'Check workspace conflicts',exact:true});
  const open=panel.getByRole('button',{name:'Resolve in review',exact:true});
  await check.click();
  await open.click();
  const text=panel.getByLabel('Merged result',{exact:true});
  await text.waitFor();
  assert.equal(await panel.locator('#mergeBase').textContent(),base);
  assert.equal(await panel.locator('#mergeLocal').textContent(),local);
  const proposed=await panel.locator('#mergeProposal').textContent();
  assert.ok(proposed.includes('return n * 2')&&proposed.includes('TAG = "stable"'));
  assert.ok((await text.inputValue()).includes('<<<<<<< Workspace '));
  await panel.getByRole('button',{name:'Stage merged result',exact:true}).click();
  await waitOutput('remove their marker lines');
  const newer='# preserve this unsaved comment\n'+local;
  await replace(newer);
  await text.fill(proposed);
  await panel.getByRole('button',{name:'Stage merged result',exact:true}).click();
  await waitOutput('changed while resolving');
  await open.click();
  await until(async()=>await panel.locator('#mergeLocal').textContent()===newer,'fresh merge inputs');
  const chosen=newer.replace('return n + 1','return n * 2  # reviewed');
  await text.fill(chosen);
  await capture('conflict-resolution');
  await panel.getByRole('button',{name:'Stage merged result',exact:true}).click();
  await waitOutput('Staged merged result for '+file);
  assert.equal(doc.getText(),newer);
  assert.deepEqual(snapshot(folder),before);
  await check.click();
  await until(async()=>(await panel.locator('#conflictResult').innerText()).includes('No conflicts found.'),'resolved check');
  await panel.getByRole('button',{name:'Review hunks',exact:true}).click();
  for(let i=0;i<2;i++){
    const button=page.getByRole('button',{name:'Apply accepted',exact:true});
    await button.click({timeout:30000});
  }
  await waitOutput('Applied reviewed hunks to tests/test_doubles.py');
  assert.equal(doc.getText(),chosen);
  assert.deepEqual(snapshot(folder),before);
  await capture('merged-buffer');
  for(let i=0;i<2;i++)await vscode.commands.executeCommand('forgelens.undo');
  assert.equal(doc.getText(),newer);
  await replace(base);
  if(doc.isDirty)await doc.save();
  assert.deepEqual(snapshot(folder),before);
  return {recovery:{freshExtensionHost:true,changedFileBlocked:true,acceptedRestored:2,rejectedRestored:1},
    merge:{inputsShown:3,markersBlocked:true,newerEditBlocked:true,manualResultApplied:true,undoPreservedLocal:true,originalFilesUnchanged:true}};
};
