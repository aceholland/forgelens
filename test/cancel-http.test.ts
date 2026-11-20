import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {ForgeRunner} from '../src/client';

test('deadline cleanup waits for bounded server cancellation before destroying transport',async()=>{
 let cancelCompleted=false;const started=performance.now();const requests:{url:string|undefined;at:number}[]=[];
 const server=http.createServer((req,res)=>{
  requests.push({url:req.url,at:Math.round(performance.now()-started)});req.resume();
  if(req.url==='/api/v1/sessions'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{id:'session-one'}}));return;}
  if(req.url?.endsWith('/cancel')){const timer=setTimeout(()=>{cancelCompleted=true;res.setHeader('content-type','application/json');res.end('{}');},150);res.on('close',()=>clearTimeout(timer));return;}
  if(req.url?.endsWith('/turns')){res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({id:'e1',type:'model.message.delta',thread_id:'main',content:'hello'})}\n\n`);return;}
  res.writeHead(404).end();
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address() as {port:number};
 try{
  // Allow real HTTP session startup under Windows load. The assertion checks
  // that deadline cleanup waits for cancellation, not sub-100ms startup speed.
  const runner=new ForgeRunner({baseUrl:`http://127.0.0.1:${address.port}`,model:'test/model',mcpName:'test',instructions:'test',runTimeoutMs:2000,onEvent:()=>{},onApproval:async()=>false});
  const result=await runner.run('test');assert.equal(result.status,'error');assert.equal(cancelCompleted,true,JSON.stringify({requests,result,elapsed:Math.round(performance.now()-started)}));
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
