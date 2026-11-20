import test from 'node:test';
import assert from 'node:assert/strict';
import {Script} from 'node:vm';
import {renderWebview} from '../src/webview';
function load(){const html=renderWebview('safe-test-nonce');const source=html.match(/<script nonce="safe-test-nonce">([\s\S]*?)<\/script>/)?.[1];assert.ok(source);return {html,script:new Script(source)};}
test('generated webview script parses as JavaScript',()=>{const {html}=load();assert.ok(html.includes("script-src 'nonce-safe-test-nonce'"));});
test('streamed token chunks remain one readable message between status lines',()=>{
 const nodes:Record<string,any>={task:{value:''},events:{textContent:'Ready.'},run:{},stop:{},review:{},undo:{}};let receive:(e:any)=>void=()=>{};
 load().script.runInNewContext({acquireVsCodeApi:()=>({postMessage(){}}),document:{getElementById:(id:string)=>nodes[id]},window:{addEventListener:(_name:string,fn:any)=>{receive=fn;}}});
 receive({data:{type:'append',text:'Running'}});receive({data:{type:'delta',text:'Hello'}});receive({data:{type:'delta',text:' world <script>literal</script>'}});receive({data:{type:'append',text:'Session done'}});
 assert.equal(nodes.events.textContent,'Ready.\nRunning\nHello world <script>literal</script>\nSession done');
});
test('webview controls send actions and streamed text appends safely',()=>{const nodes:Record<string,any>={task:{value:'change this'},events:{textContent:'Ready.'},run:{},stop:{},review:{},undo:{}};const sent:any[]=[];let receive:(e:any)=>void=()=>{};load().script.runInNewContext({acquireVsCodeApi:()=>({postMessage:(m:any)=>sent.push(m)}),document:{getElementById:(id:string)=>nodes[id]},window:{addEventListener:(name:string,fn:any)=>{assert.equal(name,'message');receive=fn;}}});for(const type of ['run','stop','review','undo'])nodes[type].onclick();assert.deepEqual(sent.map(m=>({type:m.type,prompt:m.prompt})),['run','stop','review','undo'].map(type=>({type,prompt:'change this'})));receive({data:{type:'append',text:'Streaming <script>not executable</script>'}});assert.equal(nodes.events.textContent,'Ready.\nStreaming <script>not executable</script>');receive({data:{type:'other',text:'ignored'}});assert.ok(!nodes.events.textContent.includes('ignored'));});
test('file plans render as DOM text, never HTML',()=>{
 const node=()=>({textContent:'',children:[] as any[],appendChild(x:any){this.children.push(x);},replaceChildren(){this.children=[];}});
 const nodes:any={task:{value:''},events:node(),plan:node(),run:{},stop:{},review:{},undo:{}};
 let receive:any;load().script.runInNewContext({acquireVsCodeApi:()=>({postMessage(){}}),document:{getElementById:(id:string)=>nodes[id],createElement:node,createTextNode:(text:string)=>({textContent:text})},window:{addEventListener:(_n:string,fn:any)=>receive=fn}});
 receive({data:{type:'plan',files:[{path:'<img src=x>',reason:'<script>bad()</script>'}]}});
 assert.equal(nodes.plan.children[0].textContent,'Agent file plan');
 assert.equal(nodes.plan.children[1].children[0].textContent,'<img src=x>');
 assert.equal(nodes.plan.children[1].children[1].textContent,': <script>bad()</script>');
 receive({data:{type:'plan',files:[]}});assert.equal(nodes.plan.children.length,1);
});
