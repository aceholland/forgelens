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
  assert.equal(path.relative(fs.realpathSync(vscode.workspace.workspaceFolders[0].uri.fsPath), fs.realpathSync(folder)), '');
  assert.ok(vscode.workspace.isTrusted);
  const extension = vscode.extensions.getExtension('forgelens-team.forgelens');
  assert.equal(path.relative(fs.realpathSync(path.dirname(extension.extensionPath)), fs.realpathSync(process.env.FORGELENS_INSTALLED_EXTENSIONS)), '');
  await extension.activate();
  const { chromium } = require(path.join(process.env.RUNNER_TEMP, 'forge-preview-harness/node_modules/playwright-core'));
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + process.env.FORGELENS_PICKER_PORT);
  const page = await until(() => browser.contexts().flatMap(c=>c.pages()).find(p=>/workbench/i.test(p.url())), 'VS Code workbench');
  await vscode.commands.executeCommand('forgelens.start');
  const panel = await until(async () => {
    for (const frame of page.frames()) if (await frame.locator('#task').isVisible()) return frame;
  }, 'ForgeLens panel');
  const captureDir = process.env.FORGELENS_QA_CAPTURE_DIR;
  if(captureDir) {
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  }
  const markers = {};
  const captureStart = Date.now();
  const capture = async name => {
    if (captureDir) {
      await delay(500);
      await page.screenshot({path:path.join(captureDir,name+'.png')});
      markers[name]=(Date.now()-captureStart)/1000;
    }
  };
  let recording = Boolean(captureDir);
  const frames = [];
  const recordFrames = async () => {
    while (recording) {
      const file='frame-'+String(frames.length).padStart(4,'0')+'.jpg';
      const time=(Date.now()-captureStart)/1000;
      await page.screenshot({path:path.join(captureDir,file),type:'jpeg',quality:86});
      frames.push({file,time});
      await delay(250);
    }
  };
  const captureDone=recordFrames().catch(error=>{recording=false;return error;});

  async function consent(label, expected) {
    const button = page.getByRole('button', {name:label, exact:true});
    const dialog = page.locator('[role=dialog], [role=alertdialog], .monaco-dialog-box').filter({has:button}).last();
    const text = await dialog.innerText({timeout:60000});
    for (const detail of expected) assert.ok(text.includes(detail), 'Consent omitted ' + detail);
    assert.deepEqual(snapshot(folder), original);
    await button.click();
  }
  const visits = [];
  async function visit(file, id, expectedLine, decision) {
    await panel.getByRole('heading',{name:file,exact:true}).waitFor();
    await panel.getByRole('button',{name:'Next pending hunk',exact:true}).click();
    const lens = await until(async () => {
      const tab = vscode.window.tabGroups.all.map(group=>group.activeTab)
        .find(tab=>tab?.label.startsWith(file+' · '+id+' ·') && tab.input instanceof vscode.TabInputTextDiff);
      if (!tab) return;
      const items = await vscode.commands.executeCommand('vscode.executeCodeLensProvider',tab.input.modified);
      return items?.find(item=>item.command?.title===(decision || 'Accept')+' '+id);
    }, 'targeted diff for '+file+' '+id);
    assert.equal(lens.range.start.line+1, expectedLine);
    visits.push({file,hunk:id,line:expectedLine});
    await capture('next-'+visits.length);
    if (decision) await vscode.commands.executeCommand(lens.command.command,...lens.command.arguments);
    assert.deepEqual(snapshot(folder), original);
  }
  try {
    await panel.locator('#task').fill('Change double so it doubles the number. Update the regression test.');
    await panel.getByRole('button', {name:'Draft from context', exact:true}).click();
    await consent('Review files', files);
    await visit(files[0],'hunk-1',2);
    await visit(files[0],'hunk-2',5,'Reject');
    await visit(files[0],'hunk-1',2,'Accept');
    await visit(files[1],'hunk-1',4,'Accept');
    await consent('Run candidate tests', [...files, '-m pytest -q -p no:cacheprovider -- tests/test_doubles.py']);
    await until(async () => (await panel.locator('#phase').innerText())==='Review ready', 'completed TrueForge turn');
    const output = await panel.locator('#events').innerText();
    assert.match(output, /Candidate pytest exited 0/);
    assert.match(output, /2 passed/);
    assert.deepEqual(snapshot(folder), original);
    const destination=path.join(path.dirname(folder),'forgelens-review.json');
    await panel.getByRole('button',{name:'Export review summary…',exact:true}).click();
    const saveInput=page.locator('.quick-input-widget:visible input:visible').first();
    await saveInput.fill(destination);
    await saveInput.press('Enter');
    const report=await until(()=>fs.existsSync(destination) && JSON.parse(fs.readFileSync(destination,'utf8')), 'exported JSON review summary');
    assert.deepEqual(report.files,[
      {path:files[0],accepted:1,rejected:1,pending:0},
      {path:files[1],accepted:1,rejected:0,pending:0},
    ]);
    assert.equal(report.latestStagedPytest.exitCode,0);
    assert.equal(report.latestStagedPytest.reviewChangedSinceTest,false);
    assert.ok(Number.isFinite(Date.parse(report.latestStagedPytest.completedAt)));
    if (captureDir) {
      await vscode.commands.executeCommand('workbench.action.editorLayoutSingle');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(destination),{viewColumn:vscode.ViewColumn.One});
      await capture('exported-review');
    }
    assert.deepEqual(snapshot(folder),original);
    assert.ok(!vscode.workspace.textDocuments.some(d=>d.uri.scheme==='file' && d.isDirty));
    return {editor:vscode.version, os:process.platform,
      arch:process.arch, vsix:process.env.FORGELENS_VSIX_SHA256, provider:'deterministic loopback',
      accepted:2, rejected:1, pytestPassed:2, originalsUnchanged:true, pendingHunkVisits:visits, exportedReview:report};
  } catch (error) {
    const diagnostic = await panel.locator('body').innerText({timeout:5000}).catch(()=>'(unavailable)');
    throw Error(String(error)+'\nFixture panel:\n'+diagnostic.slice(-3000));
  } finally {
    recording=false;
    const captureError=await captureDone;
    if(captureError)throw captureError;
    if(captureDir)fs.writeFileSync(path.join(captureDir,'frames.json'),JSON.stringify({markers,frames}));
  }
};
