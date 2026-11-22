const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

async function until(fn, label, timeout = 30000) {
  const deadline=Date.now()+timeout;
  do {
    const result=await fn();
    if (result) return result;
    await delay(150);
  } while(Date.now()<deadline);
  throw Error('Timed out waiting for '+label);
}

exports.run = async dir => {
  const vscode = require('vscode');
  const setup=JSON.parse(fs.readFileSync(path.join(dir,'setup.json'),'utf8'));
  const {chromium} = require(setup.playwright);
  const result={passed:false,submitted:0,operatorAnswers:0,approvals:[],scenes:[],editor:vscode.version,platform:process.platform,
    model:setup.model,mode:setup.mode,flask:setup.pinned,packageSha256:setup.packageHash};
  const save=()=>fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
  save();
  assert.equal(path.relative(fs.realpathSync(setup.workspace),fs.realpathSync(vscode.workspace.workspaceFolders[0].uri.fsPath)),'');
  const ext=vscode.extensions.getExtension('forgelens-team.forgelens');
  assert.ok(ext,'ForgeLens is absent in this editor');
  await ext.activate();
  result.version=ext.packageJSON.version;
  result.bundleSha256=createHash('sha256').update(fs.readFileSync(path.join(ext.extensionPath,'dist/extension.js'))).digest('hex');
  const browser=await chromium.connectOverCDP('http://127.0.0.1:'+setup.port);
  const page=await until(()=>browser.contexts().flatMap(context=>context.pages()).find(p=>/workbench/i.test(p.url())),'workbench');
  await page.setViewportSize({width:1440,height:900});
  const cdp=await page.context().newCDPSession(page);
  let lastFrame=0,frame=0,slow=false;
  cdp.on('Page.screencastFrame',ev=>{
    void cdp.send('Page.screencastFrameAck',{sessionId:ev.sessionId}).catch(()=>{});
    const now=Date.now();
    if (now-lastFrame < (slow ? 7000 : 380)) return;
    lastFrame=now;
    fs.writeFileSync(path.join(dir,'frames',String(++frame).padStart(6,'0')+'-'+now+'.jpg'),Buffer.from(ev.data,'base64'));
  });
  const shot=async name=>{
    if(result.scenes.some(s=>s.name===name))return;
    await page.screenshot({path:path.join(dir,'screens',name+'.png'),timeout:10000});
    result.scenes.push({name,utcMs:Date.now()}); save();
  };
  let panel;
  try {
    for(const cmd of ['workbench.action.closeSidebar','workbench.action.closeAuxiliaryBar','notifications.hideToasts']) {
      await vscode.commands.executeCommand(cmd).catch(()=>{});
    }
    await vscode.commands.executeCommand('forgelens.start');
    panel=await until(async()=>{for(const f of page.frames())if(await f.locator('#task').isVisible())return f;},'ForgeLens panel');
    await cdp.send('Page.startScreencast',{format:'jpeg',quality:77,maxWidth:1440,maxHeight:900,everyNthFrame:1});
    await panel.locator('#task').fill(setup.prompt);
    await shot('01-request');
    result.startedAt=new Date().toISOString();
    await panel.locator('#'+setup.mode).click();
    ++result.submitted;
    await until(()=>panel.locator('#run').isDisabled(),'model run to start');
    const deadline=Date.now()+(setup.minutes+1)*60000;
    slow=true;
    const safeButtons=['Review files','Allow staging','Review test request','Run candidate tests','Allow command request','Run command'];
    const buttonFor=name=>page.getByRole('button',{name,exact:true}).last();
    while(Date.now()<deadline){
      if(await page.getByText('ForgeLens clarification',{exact:true}).first().isVisible()){
        result.status='model requested a clarification';
        throw Error('One-go run was unable to continue without a clarification.');
      }
      if(await panel.locator('#context').isVisible() && !result.scenes.some(s=>s.name==='02-discovery')){
        result.context=(await panel.locator('#files .file').allTextContents()).slice(0,40);
        await shot('02-discovery');
      }
      let clicked=false;
      for(const name of safeButtons){
        const b=buttonFor(name);
        if(!await b.isVisible())continue;
        const detail=await b.evaluate(el=>el.closest('[role=dialog], [role=alertdialog], .monaco-dialog-box')?.innerText||'');
        if(!detail)throw Error('Expected a native modal for '+name);
        // Existing release independently validates both scopes. Only the
        // benchmark's allowed read-only/pytest commands can be approved here.
        if(name==='Run command' && !/^Run (?:git (?:status|diff)|(?:python|pytest)\b)/i.test(detail.trim())){
          throw Error('A command outside the evaluation requested consent.');
        }
        result.approvals.push({control:name,at:new Date().toISOString()});save();
        await b.click({timeout:3000});clicked=true;break;
      }
      if(clicked){await delay(150);continue;}
      const accept=panel.locator('#accept-all');
      if(await accept.isVisible() && await accept.isEnabled()){
        slow=false;
        await shot('03-review');
        result.approvals.push({control:'Accept all pending hunks',files:await panel.locator('#hunks h3').allTextContents()});
        await accept.click({timeout:3000});save();slow=true;continue;
      }
      if(!await panel.locator('#run').isDisabled())break;
      await delay(280);
    }
    slow=false;
    assert.ok(!await panel.locator('#run').isDisabled(),'Run exceeded the editor deadline');
    result.finishedAt=new Date().toISOString();
    const output=await panel.locator('#events').innerText();
    fs.writeFileSync(path.join(dir,'panel-output.txt'),output);
    const session=output.match(/Session ([A-Za-z0-9_-]+): ([a-z_]+)\. (\d+) files staged\./);
    result.status=session?.[2]||'no completed session';
    result.sessionId=session?.[1];result.staged=session?Number(session[3]):0;
    save();
    try {
      assert.ok(result.sessionId,'The editor did not report a TrueForge session receipt');
      const endpoint=new URL('api/v1/sessions/'+encodeURIComponent(result.sessionId)+'/turns',setup.base).href;
      const response=await fetch(endpoint,{signal:AbortSignal.timeout(5000)});
      assert.ok(response.ok,'TrueForge did not return the session turns');
      const {data:turns}=await response.json();
      assert.ok(Array.isArray(turns));
      result.turns=turns.map(t=>({id:t.id,status:t.state?.status,inputTypes:t.input?.map(i=>i.type)}));
      const userText=turns.flatMap(t=>(t.input||[]).filter(i=>i.type==='user.message').map(i=>i.content));
      assert.deepEqual(userText,[setup.prompt]);
      assert.equal(turns.length,1);
      const totals={modelCalls:0,toolCalls:[],userToolResponses:0,approvalInputs:0};
      const url=new URL(endpoint+'/'+encodeURIComponent(turns[0].id)+'/events');
      url.searchParams.set('limit','100');
      for(let pages=0;pages<100;pages++){
        const eventsResponse=await fetch(url,{signal:AbortSignal.timeout(8000)});
        assert.ok(eventsResponse.ok,'Could not load the native turn events');
        const events=await eventsResponse.json();
        assert.ok(Array.isArray(events.data),'Missing native event data');
        for(const row of events.data){
          const e=row.event||row;
          if(e.type==='user.tool_response')totals.userToolResponses++;
          if(e.type==='user.tool_approval')totals.approvalInputs++;
          if(e.type==='model.message'){
            totals.modelCalls++;
            for(const call of e.tool_calls||e.toolCalls||[])totals.toolCalls.push(call.function?.name || call.tool_info?.name || 'unknown');
          }
        }
        const cursor=events.pagination?.next_cursor || events.pagination?.nextCursor;
        const next=events.pagination?.next_page_token || events.pagination?.nextPageToken || cursor;
        if(!next)break;
        assert.ok(pages<99,'Session events exceeded maximum');
        url.searchParams.set(cursor?'cursor':'page_token',next);
      }
      result.trace=totals;
      assert.equal(totals.userToolResponses,0,'Native trace contains user tool responses');
      assert.ok(totals.modelCalls>0,'No native model message in turn trace');
      result.singleOriginalTurn=turns[0].state?.status==='done';
    }catch(error){result.proofError=error.message;}
    save();
    await panel.locator('#events').evaluate(el=>el.scrollIntoView({block:'end'})).catch(()=>{});
    await shot('04-session');
    if (!result.staged) throw Error('The model staged no files.');
    await panel.locator('#review').click();
    const applyUntil=Date.now()+90000;
    while(Date.now()<applyUntil){
      let acted=false;
      for(const name of ['Accept hunk','Apply accepted','Create file']){
        const button=buttonFor(name);if(!await button.isVisible())continue;
        await button.click({timeout:3000});
        result.approvals.push({control:name,at:new Date().toISOString()});acted=true;break;
      }
      if(!acted&&!await panel.locator('#queue').isVisible())break;
      await delay(180);
    }
    assert.ok(!await panel.locator('#queue').isVisible(),'Some staged hunks still await review');
    assert.ok(await vscode.workspace.saveAll(false),'Could not save the reviewed buffers');
    result.files=execFileSync('git',['-C',setup.workspace,'status','--short'],{encoding:'utf8',windowsHide:true}).trimEnd().split('\n');
    save();
    const gradeFile=path.join(setup.root,'checks/task-b-desktop-grade.py');
    const windows=process.platform==='win32';
    const term=vscode.window.createTerminal({name:'ForgeLens · Task B verification',cwd:setup.workspace,
      shellPath:windows?process.env.COMSPEC:'/bin/bash',shellArgs:windows?['/d']:['--noprofile','--norc'],
      env:{FORGELENS_RUN_EVIDENCE:dir,FORGELENS_GRADE_PYTHON:setup.python,FORGELENS_GRADE_SCRIPT:gradeFile,PROMPT:'Flask $G$S',PS1:'Flask $ '}});
    term.show(false);await delay(1000);
    await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    const command=windows?'"%FORGELENS_GRADE_PYTHON%" "%FORGELENS_GRADE_SCRIPT%"':'"$FORGELENS_GRADE_PYTHON" "$FORGELENS_GRADE_SCRIPT"';
    term.sendText(command);
    await until(()=>fs.existsSync(path.join(dir,'cli-checked.json')),'CLI tests',180000);
    await delay(500);await shot('05-cli-tests');fs.writeFileSync(path.join(dir,'camera-cli'),'');
    await until(()=>fs.existsSync(path.join(dir,'json-checked.json')),'CLI help and JSON',90000);
    await delay(500);await shot('06-config');fs.writeFileSync(path.join(dir,'camera-json'),'');
    await until(()=>fs.existsSync(path.join(dir,'terminal-result.json')),'independent Flask checks',650000);
    await delay(500);await shot('07-full-suite');
    result.terminal=JSON.parse(fs.readFileSync(path.join(dir,'terminal-result.json'),'utf8'));
    result.passed=result.status==='done' && result.singleOriginalTurn===true && result.terminal.passed;
    assert.ok(result.passed,'The independent checks or native turn failed.');
  } catch(error){
    result.error=error.message;
    if(panel) fs.writeFileSync(path.join(dir,'panel-output.txt'),await panel.locator('#events').innerText({timeout:2500}).catch(()=>''));
    await shot('failure').catch(()=>{});
    throw error;
  } finally {
    save(); await cdp.send('Page.stopScreencast').catch(()=>{});
  }
};
