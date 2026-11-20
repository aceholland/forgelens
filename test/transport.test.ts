import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createForgeTransport} from '../src/transport';
async function server(gap:number){
 const s=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');const t=setTimeout(()=>res.end('data: done\n\n'),gap);res.on('close',()=>clearTimeout(t));});
 await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const addr=s.address() as {port:number};
 return {url:`http://127.0.0.1:${addr.port}`,close:async()=>{s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}};
}
test('stream transport enforces its configured inactivity bound',async()=>{
 const s=await server(1800),t=createForgeTransport(100);
 try{await assert.rejects(async()=>{const r=await t.fetch(s.url);await r.text();});}finally{await t.close();await s.close();}
});
test('a longer inactivity allowance permits slow chunks and remains cancellable',async()=>{
 const s=await server(1200),t=createForgeTransport(3000);
 try{const r=await t.fetch(s.url);assert.match(await r.text(),/done/);
 const c=new AbortController();const next=await t.fetch(s.url,{signal:c.signal});c.abort();await assert.rejects(next.text());
 }finally{await t.close();await s.close();}
});
