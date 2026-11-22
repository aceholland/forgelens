import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Metadata,loopbackUrl,failureMetadata,TASK_B_PROMPT} from '../diagnostics/metadata';
import {createForgeTransport} from '../src/transport';
import {startMcp} from '../src/mcp';
test('diagnostic metadata drops arbitrary content and deduplicates usage snapshots',()=>{
 const m=new Metadata();
 const raw={type:'model.message',id:'event-1',threadId:'main',model:{name:'provider/model'},usage:{inputTokens:12,outputTokens:3},content:'sensitive-fixture',reasoningContent:'sensitive-fixture',toolCalls:[{arguments:'sensitive-fixture'}]};
 m.add(raw);m.add({...raw,type:'model.message.delta'});
 m.add({type:'client.status',message:'sensitive-fixture'});
 assert.equal(JSON.stringify(m.events).includes('sensitive-fixture'),false);
 assert.deepEqual(m.summary().tokenUsage,{inputTokens:12,outputTokens:3,reportedModelMessages:1});
 m.fallback();m.add(raw);assert.equal(m.summary().tokenUsage?.inputTokens,24);
 assert.equal(m.summary().fallbackTransitions,1);
 assert.equal(JSON.stringify(failureMetadata(new Error('sensitive-fixture'))).includes('sensitive-fixture'),false);
 assert.equal(new Metadata().summary().tokenUsage,null);
 m.paths('discovery',['src/flask/cli.py','../../outside','/absolute','a\\bad']);
 m.paths('plan',['tests/test_cli.py']);
 m.add({type:'client.status',message:'Model call time limit reached. private-data'});
 assert.deepEqual(m.summary().discoveredPaths,['src/flask/cli.py']);
 assert.deepEqual(m.summary().plannedPaths,['tests/test_cli.py']);
 assert.ok(m.summary().statusCategories.includes('model_timeout'));
 assert.equal(JSON.stringify(m.events).includes('private-data'),false);
 assert.ok(TASK_B_PROMPT.startsWith('Add a new built-in CLI command flask config'));
});
test('loopback URL accepts bracketed IPv6 without changing binding or policy',async t=>{
 assert.equal(loopbackUrl('http://[::1]:8790'),'http://[::1]:8790');
 for(const u of ['http://example.com','http://user:pass@localhost','http://localhost/?token=private'])assert.throws(()=>loopbackUrl(u));
 const server=http.createServer((_req,res)=>res.end('loopback-ok'));
 try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'::1',resolve);});}
 catch(e){if((e as NodeJS.ErrnoException).code==='EADDRNOTAVAIL'){t.skip('IPv6 loopback unavailable in this environment');return;}throw e;}
 const transport=createForgeTransport(1000);
 try{const address=server.address() as {port:number};const r=await transport.fetch(`http://[::1]:${address.port}`);assert.equal(await r.text(),'loopback-ok');}
 finally{await transport.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('real MCP callbacks distinguish initialization and count repeats, invalid calls and gated calls',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mcp-diag-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'a.ts'),'export const x=1;');
 let initialized=0;const requests:string[]=[];
 const bridge=await startMcp({root,budget:100,active:()=>true,propose:async()=>'',command:async()=>'',context:()=>{},onInitialized:()=>initialized++,onToolRequest:n=>requests.push(n)});
 t.after(()=>bridge.close());assert.equal(initialized,0);
 const client=new Client({name:'diagnostic-test',version:'1'});t.after(()=>client.close());
 await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 assert.equal(initialized,1);await client.listTools();assert.equal(requests.length,0);
 await client.callTool({name:'read_file',arguments:{path:7}});
 for(let i=0;i<7;i++)await client.callTool({name:'read_file',arguments:{path:'a.ts'}});
 assert.equal(requests.length,8);assert.ok(requests.every(n=>n==='read_file'));
});

test('registration failure persists diagnostic result and events without raw secrets or target writes',async t=>{
 const {spawn}=await import('node:child_process');const {readFile,readdir}=await import('node:fs/promises');
 const base=await mkdtemp(path.join(tmpdir(),'diagnostic-unit-fixture-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const target=path.join(base,'target');const {mkdir}=await import('node:fs/promises');await mkdir(target);
 const server=http.createServer((_req,res)=>{res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({message:'sensitive-error-fixture'}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const port=(server.address() as {port:number}).port;const out=path.join(base,'evidence');
 let stdout='';const child=spawn(process.execPath,['--import','tsx','test-local-b.ts'],{cwd:process.cwd(),env:{...process.env,FORGELENS_UNATTENDED:'true',TRUEFORGE_MODEL:'test-fixture/not-a-provider',TRUEFORGE_URL:`http://127.0.0.1:${port}`,FLASK_ROOT:target,EVIDENCE_DIR:out}});
 child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stdout+=b);
 const timer=setTimeout(()=>child.kill(),20000);const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});clearTimeout(timer);
 assert.equal(code,1);const result=JSON.parse(await readFile(path.join(out,'result.json'),'utf8'));
 assert.equal(result.operatorQuestions,false);
 assert.equal(result.phase,'mcp_registration');assert.equal(result.status,'error');assert.equal(result.mcpInitialized,false);assert.equal(result.toolCalls,0);assert.equal(result.tokenUsage,null);
 assert.deepEqual(JSON.parse(await readFile(path.join(out,'events.json'),'utf8')),[]);assert.deepEqual(await readdir(target),[]);
 assert.equal(stdout.includes('sensitive-error-fixture'),false);
});

test('diagnostic syntax gate rejects invalid combined proposals before changing staged state or evidence',async t=>{
 const {spawnSync}=await import('node:child_process');
 const {readFile,mkdir}=await import('node:fs/promises');
 const {runInNewContext}=await import('node:vm');
 const ts=await import('typescript');
 const {readWorkspace}=await import('../src/workspace');
 const {resolveAgentProposal}=await import('../src/patch');
 const {ReviewStore}=await import('../src/review');
 const python=process.env.FORGELENS_PYTHON??(process.platform==='win32'?'python':'python3');
 if(spawnSync(python,['-c','import ast']).status!==0){t.skip('Optional syntax-gate regression requires Python; set FORGELENS_PYTHON.');return;}
 const base=await mkdtemp(path.join(tmpdir(),'diagnostic-syntax-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const root=path.join(base,'target'),out=path.join(base,'evidence');await mkdir(root);await mkdir(out);
 const original='x = a + b\n';await writeFile(path.join(root,'sample.py'),original);
 const source=await readFile(path.join(process.cwd(),'test-local-b.ts'),'utf8');
 const tree=ts.createSourceFile('test-local-b.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 let syntaxCheck='',persist='',approve='',propose='';
 const visit=(node:import('typescript').Node)=>{
  if(ts.isFunctionDeclaration(node)&&node.name?.text==='checkPythonSyntax')syntaxCheck=node.getText(tree);
  if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='persistProposals')persist=node.getText(tree);
  if(ts.isPropertyAssignment(node)){
   if(node.name.getText(tree)==='onApproval')approve=node.initializer.getText(tree);
   if(node.name.getText(tree)==='propose')propose=node.initializer.getText(tree);
  }
  ts.forEachChild(node,visit);
 };
 visit(tree);assert.ok(syntaxCheck&&approve&&propose,'Use the actual diagnostic callbacks without running a model.');
 const store=new ReviewStore();
 const compiled=ts.transpileModule(`${syntaxCheck}\nconst ${persist};\n({approve:${approve},propose:${propose}})`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const gate=runInNewContext(compiled,{spawnSync,readWorkspace,resolveAgentProposal,writeFile,path,root,out,python,store,validateStaged:false});
 const a={path:'sample.py',edits:[{oldText:'a + b',newText:'a if cond else + b'}]};
 const b={path:'sample.py',edits:[{oldText:'+ b',newText:''}]};
 // TrueForge requests approvals for a batch before dispatching either tool.
 assert.equal(await gate.approve({name:'propose_write',arguments:a}),true);
 assert.equal(await gate.approve({name:'propose_write',arguments:b}),true);
 await gate.propose(a.path,resolveAgentProposal(original,a));
 assert.equal(store.get(a.path)?.proposed,'x = a if cond else + b\n');
 const evidence=await readFile(path.join(out,'proposals.json'),'utf8');
 const invalid=resolveAgentProposal(store.get(b.path)!.proposed,b);
 assert.equal(invalid,'x = a if cond else \n');
 await assert.rejects(gate.propose(b.path,invalid),/does not parse/);
 assert.equal(store.get(a.path)?.proposed,'x = a if cond else + b\n');
 assert.equal(await readFile(path.join(out,'proposals.json'),'utf8'),evidence);
 assert.equal(await readFile(path.join(root,'sample.py'),'utf8'),original);
});
