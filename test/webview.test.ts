import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import { renderWebview } from '../src/webview';

function load() {
  const html = renderWebview('test-nonce');
  const js = html.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(js);
  class Element {
    value = ''; textContent = ''; hidden = false; disabled = false;
    children: Element[] = [];
    onclick?: () => void;
    appendChild(child: Element) { this.children.push(child); }
    append(...children: Element[]) { this.children.push(...children); }
    replaceChildren() { this.children = []; this.textContent = ''; }
  }
  const nodes = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(m => [m[1]!, new Element()]));
  nodes.events!.textContent = 'Ready.';
  const sent: any[] = [];
  const handlers: Record<string, (event:any) => void> = {};
  new Script(js).runInNewContext({
    acquireVsCodeApi: () => ({postMessage: (message: unknown) => sent.push(message)}),
    document: {getElementById: (id:string) => nodes[id], createElement: () => new Element(),
      createTextNode: (value:string) => Object.assign(new Element(), {textContent:value})},
    window: {addEventListener: (name:string, handler:(event:any)=>void) => {handlers[name]=handler;}}
  });
  return {html, nodes, sent, handlers, receive: (data:unknown) => handlers.message!({data})};
}

test('panel declares a nonce policy, renders and requests initial state',()=>{
  const ui=load();
  assert.ok(ui.html.includes("script-src 'nonce-test-nonce'"));
  assert.equal(ui.sent[0].type,'ready');
});
test('run output keeps streamed text in one message and displays markup literally',()=>{
  const ui=load();
  for(const [type,text] of [['append','Running'],['delta','Hello'],['delta',' <script>world</script>'],['append','Done']])ui.receive({type,text});
  assert.equal(ui.nodes.events!.textContent,'Ready.\nRunning\nHello <script>world</script>\nDone');
});
test('buttons pass the task and Escape stops only an active run',()=>{
  const ui=load();
  ui.nodes.task!.value='find tests';
  for(const type of ['run','inspect','review','undo','verify','export'])ui.nodes[type]!.onclick!();
  assert.deepEqual(ui.sent.slice(1).map(m=>[m.type,m.prompt]),['run','inspect','review','undo','verify','export'].map(t=>[t,'find tests']));
  const key={key:'Escape',preventDefault(){}};
  ui.handlers.keydown!(key);
  assert.equal(ui.sent.length,7);
  ui.receive({type:'state',phase:'Running',active:true});
  ui.handlers.keydown!(key);
  assert.equal(ui.sent.at(-1).type,'stop');
  assert.equal(ui.nodes.review!.disabled,true);
});
test('context meter, literal path/reason and excerpt selection use the current snapshot',()=>{
  const ui=load();
  ui.receive({type:'context',id:8,label:'Local context preview',preview:{usedChars:12,budgetChars:30,items:[
    {path:'a<b>.py',startLine:5,endLine:7,reason:'<tag>'}
  ]}});
  const [file,range,reason]=ui.nodes.files!.children[0]!.children;
  assert.equal(file!.textContent,'a<b>.py'); assert.equal(range!.textContent,'L5–7'); assert.equal(reason!.textContent,'<tag>');
  assert.match(ui.nodes.budget!.textContent,/12 \/ 30/); file!.onclick!();
  assert.deepEqual({...ui.sent.at(-1)},{type:'openContext',id:8,index:0});
  ui.receive({type:'context',id:9,label:'Preview',preview:{usedChars:0,budgetChars:30,items:[]}});
  assert.equal(ui.nodes.files!.textContent,'No matching excerpts.');
});
test('Draft from context sends the current task and follows the run lifecycle',()=>{
  const ui=load();
  ui.nodes.task!.value='Update the calculation, its test and the example.';
  ui.nodes.draft!.onclick!();
  assert.deepEqual({...ui.sent.at(-1)},{type:'draft',prompt:ui.nodes.task!.value});
  ui.receive({type:'state',phase:'Drafting from context',active:true});
  assert.equal(ui.nodes.phase!.textContent,'Drafting from context');
  assert.equal(ui.nodes.draft!.disabled,true);
  assert.equal(ui.nodes.run!.disabled,true);
  ui.receive({type:'state',phase:'Review ready',active:false});
  assert.equal(ui.nodes.draft!.disabled,false);
});
test('staged hunk actions carry the displayed proposal version and cannot apply a file',()=>{
  const ui=load();
  ui.receive({type:'queue',editable:true,version:3,files:[{path:'example.py',hunks:[{id:'hunk-1',status:'rejected'}]}]});
  const row=ui.nodes.hunks!.children[1]!;
  assert.equal(row.children[3]!.disabled,true);
  row.children[2]!.onclick!();
  assert.deepEqual({...ui.sent.at(-1)},{type:'hunk',version:3,path:'example.py',id:'hunk-1',action:'accepted'});
  ui.receive({type:'queue',editable:false,version:4,files:[]});
  assert.equal(ui.nodes.queue!.hidden,true);
});
test('plan paths and reasons render as text nodes',()=>{
  const ui=load();
  ui.receive({type:'plan',files:[{path:'<img>',reason:'<script>'}]});
  const [heading,row]=ui.nodes.plan!.children;
  assert.equal(heading!.textContent,'Agent file plan');
  assert.deepEqual(row!.children.map(c=>c.textContent),['<img>',': <script>']);
  ui.receive({type:'plan',files:[]});assert.equal(ui.nodes.plan!.hidden,true);
});

test('next hunk uses the visible review version and summary export sends no task or source',()=>{
  const ui=load();
  ui.nodes.task!.value='private request';
  ui.receive({type:'state',canExportSummary:true});
  assert.equal(ui.nodes.exportSummary!.disabled,false);
  ui.nodes.exportSummary!.onclick!();
  assert.deepEqual({...ui.sent.at(-1)},{type:'exportSummary'});
  ui.receive({type:'queue',version:9,editable:true,files:[{path:'sample.py',hunks:[{id:'hunk-2',status:'pending'}]}]});
  assert.equal(ui.nodes.nextHunk!.disabled,false);
  ui.nodes.nextHunk!.onclick!();
  assert.deepEqual({...ui.sent.at(-1)},{type:'nextHunk',version:9});
  ui.receive({type:'queue',version:10,editable:true,files:[{path:'sample.py',hunks:[{id:'hunk-2',status:'rejected'}]}]});
  assert.equal(ui.nodes.nextHunk!.disabled,true);
});
test('live queue exposes new files, file and group controls, and the token meter uses its own limit',()=>{
  const ui=load();
  ui.receive({type:'queue',editable:true,version:17,files:[{path:'fresh.py',kind:'create',editable:true,hunks:[{id:'h1',status:'pending'}]}]});
  assert.match(ui.nodes.hunks!.children[0]!.textContent,/New file.*fresh.py/);
  const group=ui.nodes.hunks!.children[2]!;
  group.children[0]!.onclick!(); assert.equal(ui.sent.at(-1).type,'reviewSource');
  group.children[1]!.onclick!(); assert.deepEqual({...ui.sent.at(-1)},{type:'hunks',version:17,path:'fresh.py',action:'accepted'});
  ui.nodes['reject-all']!.onclick!();assert.deepEqual({...ui.sent.at(-1)},{type:'allHunks',version:17,action:'rejected'});
  ui.receive({type:'context',preview:{items:[],usedChars:40,budgetChars:100,usedTokens:9,budgetTokens:21,encoding:'o200k_base'}});
  assert.match(ui.nodes.budget!.textContent,/9 \/ 21 excerpt tokens \(o200k_base\).*40 \/ 100 characters/);
  assert.equal((ui.nodes.meter as any).value,9); assert.equal((ui.nodes.meter as any).max,21);
});
