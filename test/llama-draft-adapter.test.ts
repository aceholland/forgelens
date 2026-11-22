import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { draftInstructions, compactInstructions } from '../src/compactContext';

const endpoint = '/v1/chat/completions';
const schema = {type:'function',function:{name:'propose_changes',parameters:{type:'object',properties:{files:{type:'array'}}}}};
const time = {type:'function',function:{name:'get_current_datetime'}};
const initial = {model:'fixture',stream:true,tools:[time,schema],
  messages:[{role:'system',content:draftInstructions},{role:'user',content:'Update the example.'}]};
const port = (server:Server) => (server.address() as AddressInfo).port;
const post = (url:string, body:string, extra:RequestInit={}) => fetch(url+endpoint,
  {method:'POST',headers:{'content-type':'application/json'},body,...extra});

test('local adapter selects the single native proposal, streams raw model bytes and leaves all other choices unchanged', async t => {
  const {startAdapter} = await import(new URL('../scripts/llama-draft-adapter.mjs',import.meta.url).href);
  const bodies:string[] = [];
  let release!:()=>void;
  const finish = new Promise<void>(resolve => {release=resolve;});
  const firstChunk = 'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"propose_changes"}}]}}]}\n\n';
  const secondChunk = 'data: [DONE]\n\n';
  const upstream=createServer(async (req,res) => {
    const chunks:Buffer[]=[];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks).toString('utf8'));
    assert.equal(req.headers.authorization,undefined);
    if(bodies.length===1) {
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write(firstChunk);
      await finish;
      res.end(secondChunk);
    } else res.writeHead(429,{'content-type':'application/json','retry-after':'13'}).end('{"error":"busy"}');
  });
  upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
  const audit:unknown[]=[];
  const adapter:Server=startAdapter(0,port(upstream),(record:unknown)=>audit.push(record));
  await once(adapter,'listening');
  t.after(()=>{release();adapter.closeAllConnections();upstream.closeAllConnections();adapter.close();upstream.close();});
  const url='http://127.0.0.1:'+port(adapter);
  const result=await post(url,JSON.stringify(initial),{headers:{'content-type':'application/json',authorization:'Bearer placeholder'}});
  const reader=result.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value),firstChunk);
  release();
  assert.equal(new TextDecoder().decode((await reader.read()).value),secondChunk);
  assert.equal((await reader.read()).done,true);
  assert.deepEqual(JSON.parse(bodies[0]!),{...initial,tools:[schema],tool_choice:'required'});
  assert.deepEqual(audit[0],{event:'llama_adapter_request',request:1,forcedProposalToolChoice:true});
  await (await post(url,JSON.stringify({...initial,tool_choice:'auto'}))).text();
  assert.deepEqual(JSON.parse(bodies[1]!),{...initial,tools:[schema],tool_choice:'required'});
  assert.deepEqual(audit[1],{event:'llama_adapter_request',request:2,forcedProposalToolChoice:true});
  const untouched = [
    {...initial,messages:[...initial.messages,{role:'assistant',content:'Working'}]},
    {...initial,messages:[...initial.messages,{role:'tool',content:'review feedback'}]},
    {...initial,tool_choice:'none'}, {...initial,tool_choice:'required'}, {...initial,tool_choice:{type:'function',function:{name:'get_current_datetime'}}},
    {...initial,tools:[schema,{type:'function',function:{name:'read_file'}}]},
    {...initial,tool_choice:'auto',messages:[{role:'system',content:compactInstructions},{role:'user',content:draftInstructions}]},
    {model:'fixture',messages:[{role:'user',content:'Title'}]},
  ];
  for(const body of untouched) {
    const raw=JSON.stringify(body,null,2);
    const reply=await post(url,raw);
    assert.equal(reply.status,429); assert.equal(reply.headers.get('retry-after'),'13');
    assert.equal(await reply.text(),'{"error":"busy"}');
    assert.equal(bodies.at(-1),raw);
  }
  assert.deepEqual(audit.slice(2),untouched.map((_,i)=>({event:'llama_adapter_request',request:i+3,forcedProposalToolChoice:false})));
  assert.equal((await post(url,'x'.repeat(2*1024*1024+1))).status,413);
  assert.equal((await post(url,'{')).status,400);
  assert.equal((await post(url,'{}',{headers:{'content-type':'application/json',origin:'https://example.com'}})).status,403);
  assert.equal((await fetch(url+'/unexpected')).status,404);
  assert.equal(bodies.length,untouched.length+2);
});

test('closing a streaming client closes the outstanding upstream inference', async t=>{
  const {startAdapter}=await import(new URL('../scripts/llama-draft-adapter.mjs',import.meta.url).href);
  let closed!:()=>void;
  const disconnected = new Promise<void>(resolve=>{closed=resolve;});
  const upstream=createServer((req,res)=>{
    req.resume();res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: start\n\n');res.once('close',closed);
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const adapter:Server=startAdapter(0,port(upstream));
  await once(adapter,'listening');
  t.after(()=>{adapter.closeAllConnections();upstream.closeAllConnections();adapter.close();upstream.close();});
  const controller=new AbortController();
  const res=await post('http://127.0.0.1:'+port(adapter),JSON.stringify(initial),{signal:controller.signal});
  await res.body!.getReader().read();
  controller.abort();
  await disconnected;
});
