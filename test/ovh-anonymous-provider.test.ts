import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';

test('anonymous provider preserves native tool calls, paces requests and keeps local credentials on loopback',async t=>{
  const {anonymousProvider,defaultModel}=await import(new URL('../scripts/ovh-anonymous-provider.mjs',import.meta.url).href);
  const key='local-gateway-test-only-12345678', gaps:number[]=[], forwarded:RequestInit[]=[];
  const fixture='data: {"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}\n\ndata: [DONE]\n\n';
  const server=anonymousProvider({localToken:key,wait:async (gap:number)=>{gaps.push(gap);},
    forward:async(url:string,init:RequestInit)=>{
      assert.equal(url,'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions');
      forwarded.push(init);
      return forwarded.length===1?new Response('',{status:429,headers:{'retry-after':'45'}})
        :new Response(fixture,{headers:{'content-type':'text/event-stream'}});
    }});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const url='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/v1/chat/completions';
  const body=JSON.stringify({model:defaultModel,messages:[{role:'user',content:'Public coding fixture'}],
    tools:[{type:'function',function:{name:'fixture'}}],stream:true});
  const send=(extra:Record<string,string>={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...extra},body});
  assert.equal((await send()).status,403);
  assert.equal((await send({authorization:'Bearer '+key,origin:'https://example.org'})).status,403);
  const reply=await send({authorization:'Bearer '+key});
  assert.equal(await reply.text(),fixture);
  assert.equal(forwarded.length,2);
  for(const req of forwarded){
    assert.deepEqual(req.headers,{'content-type':'application/json'});
    assert.equal(Buffer.from(req.body as Uint8Array).toString(),body);
    assert.equal(req.redirect,'error');
  }
  assert.equal(gaps.length,1);
  assert.ok(gaps[0]!>=45_000);
});

test('long anonymous quota waits are returned immediately and block later forwarding',async t=>{
  const {anonymousProvider,defaultModel}=await import(new URL('../scripts/ovh-anonymous-provider.mjs',import.meta.url).href);
  const localToken='loopback-quota-test-000000000', longLimit='3456000';
  let forwarded=0;
  const server=anonymousProvider({localToken,
    wait:async()=>{throw Error('A weeks-long limit must not schedule a timer');},
    forward:async()=>{forwarded++; return new Response('busy',{status:429,headers:{'retry-after':longLimit}});}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const url='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/v1/chat/completions';
  const options={method:'POST',headers:{authorization:'Bearer '+localToken,'content-type':'application/json'},
    body:JSON.stringify({model:defaultModel,messages:[{role:'user',content:'example'}]})};
  const limited=await fetch(url,options);
  assert.equal(limited.status,429);
  assert.equal(limited.headers.get('retry-after'),longLimit);
  assert.equal(await limited.text(),'busy');
  const next=await fetch(url,options);
  assert.equal(next.status,429);
  assert.ok(Number(next.headers.get('retry-after'))>=Number(longLimit)-1);
  assert.equal(forwarded,1);
});
