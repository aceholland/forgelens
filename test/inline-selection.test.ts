import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcp } from '../src/mcp';
import { InlineSelection } from '../src/inlineSelection';

test('a review pass can correct its draft before the first hunk reaches the editor', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-inline-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const file = 'length.ts', body = 'return key?.length ?? -1;';
  const source = 'function length(key?: string) {\r\n  ' + body + '\r\n}\r\n// ' + body;
  const start = source.indexOf(body);
  await writeFile(path.join(root, file), source);
  const selection = new InlineSelection(file, source, start, start + body.length);
  const proposals: string[] = [];
  let editorText = source;
  const bridge = await startMcp({root, budget:4000, inlineSelection:selection, inlineDocument:async()=>editorText, active:()=>true,
    propose:async (p, text, base) => {
      assert.equal(p,file); assert.equal(base,source);
      proposals.push(text); return 'one accepted hunk';
    }, command:async()=>'', context:()=>{}});
  t.after(()=>bridge.close());
  const client=new Client({name:'inline-test',version:'1'});
  t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:'Bearer '+bridge.token}}}));
  const call=(name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args});
  const read = await call('read_selection', {offset:6});
  assert.deepEqual(JSON.parse((read.content as {text:string}[])[0]!.text), {offset:6, text:body.slice(6), remaining:0});
  assert.equal((await call('propose_selection',{draftId:'made-up'})).isError,true);
  const draft=await call('prepare_selection',{replacement:'// number of characters\n'+body});
  assert.ok(!draft.isError);
  const receipt=JSON.parse((draft.content as {text:string}[])[0]!.text);
  assert.equal(receipt.candidate,'// number of characters\r\n'+body);
  assert.ok(receipt.draftId);
  assert.deepEqual(proposals,[]);
  assert.equal((await call('propose_edit',{path:file,edits:[{oldText:body,newText:'return 0;'}]})).isError,true);
  const revised='// Character count, or -1 when no key is supplied.\n'+body;
  const final=await call('propose_selection',{draftId:receipt.draftId,replacement:revised});
  assert.ok(!final.isError,JSON.stringify(final));
  assert.deepEqual(proposals,[source.slice(0,start)+revised.replace('\n','\r\n')+source.slice(start+body.length)]);
  assert.equal((await call('propose_selection',{draftId:receipt.draftId})).isError,true);
  const second = await call('prepare_selection', {replacement:'return 1;'});
  const secondId = JSON.parse((second.content as {text:string}[])[0]!.text).draftId;
  editorText = source + '\n// unsaved edit';
  assert.equal((await call('propose_selection', {draftId:secondId})).isError, true);
  editorText = source;
  bridge.resetExploration();
  assert.equal((await call('propose_selection', {draftId:secondId})).isError, true);
  assert.equal(proposals.length, 1);
  assert.equal(await readFile(path.join(root,file),'utf8'), source);
});

test('a changed document, discarded draft or superseded draft cannot enter review',()=>{
  const scope=new InlineSelection('file.txt','aaa bbb ccc',4,7);
  const draft=scope.prepare('aaa bbb ccc','x');
  assert.throws(()=>scope.proposal(draft.draftId,undefined,'aaa bbb ccc!'));
  const next=scope.prepare('aaa bbb ccc','y');
  assert.throws(()=>scope.proposal(draft.draftId,undefined,'aaa bbb ccc'));
  scope.reset();
  assert.throws(()=>scope.proposal(next.draftId,undefined,'aaa bbb ccc'));
});

test('initial evidence is bounded to a prefix of the selection and identifies the next offset', () => {
  const scope = new InlineSelection('note.txt', 'private\nfirst word\nsecond word\nprivate', 8, 30);
  const context = scope.context(14, 2);
  const item = context.items[0]!;
  assert.ok(item.content.length > 0 && item.content.length <= 14);
  assert.ok(context.usedTokens <= 2);
  assert.ok(scope.text.startsWith(item.content));
  assert.equal(item.truncated, true);
  assert.equal(item.startLine, 2);
  assert.ok(scope.evidence(context).includes(`offset ${item.content.length}`));
  assert.ok(!scope.evidence(context).includes('private'));
});

test('a prepared draft can be submitted verbatim or corrected to an empty selection', () => {
  const scope = new InlineSelection('letter.txt', 'one two three', 4, 7);
  const draft = scope.prepare(scope.original, 'four');
  assert.equal(scope.proposal(draft.draftId, undefined, scope.original), 'one four three');
  assert.equal(scope.proposal(draft.draftId, '', scope.original), 'one  three');
});
