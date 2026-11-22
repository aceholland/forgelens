import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectSetup, localSetupUrl, meetsVersion } from '../src/setupCheck';

const input={editor:'1.95.0',trusted:true,localFolder:true,baseUrl:'http://127.0.0.1:8790',model:'local/model'};
test('setup shows the exact missing prerequisite and distinguishes catalog membership from inference',async()=>{
  const node=async()=>'v22.14.0';
  const available=async()=>['local/model'];
  const rows=await inspectSetup(input,node,available);
  assert.ok(rows.every(r=>r.ok));
  assert.match(rows.at(-1)!.detail,/registered/);
  assert.equal((await inspectSetup({...input,model:'other'},node,available)).at(-1)?.ok,false);
  assert.match((await inspectSetup(input,node,async()=>{throw Error();})).at(-1)!.detail,/Start TrueForge/);
  assert.equal(meetsVersion('22.13.9',22,14),false);
  assert.equal(meetsVersion('v24.0.1',22,14),true);
});
test('setup limits requests to trusted local folders and loopback addresses',async()=>{
  const offline=()=>{throw Error('unexpected probe');};
  for(const change of [{trusted:false},{localFolder:false}]){
    const rows=await inspectSetup({...input,...change},offline,offline);
    assert.equal(rows.at(-1)?.ok,false);
  }
  for(const url of ['https://example.org','file://localhost/test','http://user@localhost:8790','http://127.0.0.1/?key=private']){
    assert.throws(()=>localSetupUrl(url));
  }
  assert.equal(localSetupUrl('http://[::1]:8790/'),'http://[::1]:8790');
});
