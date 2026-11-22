// Launch a normal isolated VS Code window against a fresh pinned Flask checkout.
// The extension runs its real configured model. The driver supplies the original
// request once and handles review controls, never model answers or source edits.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pinned = '22d924701a6ae2e4cd01e9a15bbaf3946094af65';
const sha = value => createHash('sha256').update(value).digest('hex');
const git = (args, cwd) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
  cwd, encoding:'utf8', windowsHide:true, stdio:['ignore', 'pipe', 'pipe']
}).trim();

async function main() {
  if (!process.argv[2]) throw Error('Usage: node checks/task-b-desktop-launch.cjs NEW_EVIDENCE_DIR [VSIX]');
  const dir = path.resolve(process.argv[2]);
  const env = process.env;
  const repo = path.resolve(env.FLASK_ROOT || '');
  const editor = env.FORGELENS_EDITOR_EXECUTABLE;
  const python = env.FORGELENS_PYTHON;
  const playwright = env.PLAYWRIGHT_CORE || require.resolve('playwright-core');
  assert.ok(env.FLASK_ROOT && editor && python && env.TRUEFORGE_MODEL, 'Set FLASK_ROOT, FORGELENS_EDITOR_EXECUTABLE, FORGELENS_PYTHON and TRUEFORGE_MODEL');
  const base = new URL(env.TRUEFORGE_URL || 'http://127.0.0.1:8790');
  assert.ok(['127.0.0.1','[::1]','localhost'].includes(base.hostname) && !base.username && !base.password && !base.search);
  const mode = env.FORGELENS_EDITOR_MODE || 'run';
  assert.ok(['run','draft'].includes(mode));
  const minutes = Number(env.FORGELENS_EDITOR_MINUTES || '70');
  assert.ok(Number.isFinite(minutes) && minutes >= 1 && minutes <= 90);
  assert.equal(fs.existsSync(dir),false,'Use a new output directory for each attempt');
  fs.mkdirSync(dir,{recursive:true});
  for (const folder of ['profile/User','extensions','screens','frames','temp','home','app','local']) fs.mkdirSync(path.join(dir,folder),{recursive:true});
  const workspace = path.join(dir,'flask');
  git(['clone','--no-checkout','--local','--no-hardlinks',repo,workspace],dir);
  git(['config','core.autocrlf','false'],workspace);
  git(['checkout','--detach',pinned],workspace);
  assert.equal(git(['rev-parse','HEAD'],workspace),pinned);
  assert.equal(git(['status','--porcelain'],workspace),'');
  const vsix = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
  const extensions = path.join(dir,'extensions');
  let bundle = path.join(root,'dist','extension.js');
  if (vsix) {
    // No interpolated names are passed through a command shell. The relative
    // arguments work even when the CI scratch directory contains spaces.
    fs.copyFileSync(vsix,path.join(dir,'package.vsix'));
    const cli = env.FORGELENS_EDITOR_CLI;
    assert.ok(cli && fs.existsSync(cli),'Set FORGELENS_EDITOR_CLI when passing a VSIX');
    execFileSync(process.platform==='win32' ? '"'+cli+'"' : cli, [
      '--user-data-dir','profile','--extensions-dir','extensions','--install-extension','package.vsix','--force'
    ],{cwd:dir,shell:process.platform==='win32',windowsHide:true,stdio:'inherit'});
    const installed = fs.readdirSync(extensions,{withFileTypes:true}).filter(entry=>entry.isDirectory() && /^forgelens-team\.forgelens-\d/i.test(entry.name));
    assert.equal(installed.length,1,'Expected one installed ForgeLens package in the isolated profile');
    bundle = path.join(extensions,installed[0].name,'dist','extension.js');
  }
  const config = {
    'forgelens.model':env.TRUEFORGE_MODEL,'forgelens.baseUrl':base.href,'forgelens.fallbackModel':'',
    'forgelens.runTimeoutMinutes':minutes,'forgelens.modelCallTimeoutSeconds':Math.min(minutes*60,1800),
    'forgelens.pythonPath':python,'forgelens.liveReview':true,
    'forgelens.candidateTestFixtures':JSON.parse(fs.readFileSync(path.join(root,'docs/evidence/task-b-flash-lite/public-fixture-pins.json'),'utf8')),
    'window.dialogStyle':'custom','workbench.startupEditor':'none','editor.codeLens':true,'diffEditor.codeLens':true,
    'editor.fontSize':16,'terminal.integrated.fontSize':17,'editor.minimap.enabled':false,'chat.disableAIFeatures':true,
    'telemetry.telemetryLevel':'off','update.mode':'none','extensions.autoUpdate':false,'extensions.autoCheckUpdates':false,
    'terminal.integrated.gpuAcceleration':'off','terminal.integrated.enablePersistentSessions':false
  };
  for (const [source,setting] of [['FORGELENS_ASK_QUESTIONS','forgelens.askQuestions'],['FORGELENS_PRELOAD_TOOLS','forgelens.preloadTools'],['FORGELENS_COMPACT_REQUESTS','forgelens.compactRequests']]) {
    if (env[source] === undefined) continue;
    assert.ok(['true','false'].includes(env[source]),source+' must be true or false');
    config[setting] = env[source] === 'true';
  }
  if(env.FORGELENS_REASONING_EFFORT!==undefined){
    const setting='forgelens.reasoningEffort';
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
    assert.ok(manifest.contributes.configuration.properties[setting].enum.includes(env.FORGELENS_REASONING_EFFORT),'Unsupported reasoning effort');
    config[setting]=env.FORGELENS_REASONING_EFFORT;
  }
  fs.writeFileSync(path.join(dir,'profile/User/settings.json'),JSON.stringify(config));
  const prompt = fs.readFileSync(path.join(root,'diagnostics/metadata.ts'),'utf8').match(/export const TASK_B_PROMPT = `([^`]+)`;/)[1];
  assert.equal(sha(prompt),'adf0a71141397baaec45456103eec636889bfb57789532a01a7d9daa5d793fd1');
  const socket=net.createServer();
  await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;
  await new Promise(resolve=>socket.close(resolve));
  const evidence = {root,dir,workspace,base:base.href,model:env.TRUEFORGE_MODEL,mode,minutes,port,python,playwright,prompt,
    pinned,source:git(['rev-parse','HEAD'],root),bundleHash:sha(fs.readFileSync(bundle)),
    packageHash:vsix && sha(fs.readFileSync(vsix)),askQuestions:config['forgelens.askQuestions'],preloadTools:config['forgelens.preloadTools'],compactRequests:config['forgelens.compactRequests'],reasoningEffort:config['forgelens.reasoningEffort']};
  fs.writeFileSync(path.join(dir,'setup.json'),JSON.stringify(evidence,null,2));
  const driver=path.join(extensions,'acesentry.task-b-check-1.0.0');
  fs.mkdirSync(driver);
  fs.writeFileSync(path.join(driver,'package.json'),JSON.stringify({name:'task-b-check',publisher:'acesentry',version:'1.0.0',
    engines:{vscode:'^1.101.0'},main:'./driver.cjs',activationEvents:['onStartupFinished']}));
  fs.writeFileSync(path.join(driver,'driver.cjs'),`exports.activate=()=>setImmediate(async()=>{
    try {await require(${JSON.stringify(path.join(__dirname,'task-b-desktop-run.cjs'))}).run(${JSON.stringify(dir)});}
    catch(error){require('node:fs').writeFileSync(${JSON.stringify(path.join(dir,'driver-error.txt'))},String(error.stack||error));}
    finally{await require('vscode').commands.executeCommand('workbench.action.quit');}
  });`);
  const launchEnv={};
  for(const name of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','LANG','LC_ALL','DBUS_SESSION_BUS_ADDRESS','XAUTHORITY']) {
    if(env[name]) launchEnv[name]=env[name];
  }
  const scratch=path.join(dir,'temp');
  Object.assign(launchEnv,{TMP:scratch,TEMP:scratch,TMPDIR:scratch,GIT_CEILING_DIRECTORIES:dir,PYTHONDONTWRITEBYTECODE:'1',
    HOME:path.join(dir,'home'),USERPROFILE:path.join(dir,'home'),APPDATA:path.join(dir,'app'),LOCALAPPDATA:path.join(dir,'local')});
  const launchArgs=['--new-window','--disable-gpu','--skip-welcome','--skip-release-notes','--disable-workspace-trust',
    '--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--no-first-run','--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port='+port,'--user-data-dir='+path.join(dir,'profile'),'--extensions-dir='+extensions];
  if (vsix) launchArgs.push('--extensionDevelopmentPath='+driver);
  else launchArgs.push('--extensionDevelopmentPath='+root);
  if(process.platform==='linux' && env.GITHUB_ACTIONS==='true' && env.RUNNER_ENVIRONMENT==='github-hosted') launchArgs.push('--no-sandbox');
  launchArgs.push(workspace);
  const log=fs.openSync(path.join(dir,'editor.log'),'w');
  const child=spawn(editor,launchArgs,{cwd:workspace,env:launchEnv,windowsHide:true,stdio:['ignore',log,log]});
  fs.closeSync(log);
  const timer=setTimeout(()=>child.kill(),(minutes+12)*60000);
  try {
    await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    const result=JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8'));
    console.log(JSON.stringify({session:result.sessionId,status:result.status,passed:result.passed,files:result.files,turns:result.turns}));
    assert.equal(result.passed,true,'The live one-turn Task B did not meet every check. Inspect result.json and driver-error.txt.');
  } finally { clearTimeout(timer); }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
