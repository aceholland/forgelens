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

test('an explicit doc update is checked before review, and the model can repair its original draft', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'forge-inline-docs-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file='scale.py';
  const original='def scale(value):\n    """Describe the scale."""\n    return value * 2\n';
  const changed=original.replace('value * 2','value * 3');
  await writeFile(path.join(root,file),original);
  const proposals:string[]=[];
  const bridge=await startMcp({root,budget:4000,task:'Triple the scale and update the docstring.',
    inlineSelection:new InlineSelection(file,original,0,original.length),active:()=>true,
    propose:async(_path,text)=>{proposals.push(text);return 'reviewed';},command:async()=>'',context:()=>{}});
  t.after(()=>bridge.close());
  const client=new Client({name:'doc-review',version:'1'});t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:'Bearer '+bridge.token}}}));
  const call=(name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args});
  const draft=await call('prepare_selection',{replacement:changed});
  const receipt=JSON.parse((draft.content as {text:string}[])[0]!.text);
  assert.equal(receipt.readyForReview,false);
  assert.match(receipt.issues.join(' '),/original documentation wording/);
  const failed=await call('propose_selection',{draftId:receipt.draftId});
  assert.equal(failed.isError,true);
  assert.deepEqual(proposals,[]);
  const repaired=changed.replace('Describe the scale.','Return three times the supplied value.');
  const reviewed=await call('propose_selection',{draftId:receipt.draftId,replacement:repaired});
  assert.ok(!reviewed.isError);
  assert.deepEqual(proposals,[repaired]);
  assert.equal(await readFile(path.join(root,file),'utf8'),original);
});

test('recognizes leading Python literals, JSDoc and line docs and compares their wording',()=>{
  for(const [file,original,request] of [
    ['scale.py','def scale(x):\n    "Return twice x."\n    return x * 2','Update its docstring.'],
    ['scale.ts','/** Return twice x. */\nexport function scale(x: number) { return x * 2; }','Update the JSDoc.'],
    ['scale.js','// Return twice x.\nconst scale = x => x * 2;','Update the leading comment.'],
  ] as const){
    const scope=new InlineSelection(file,original,0,original.length);
    const changed=original.replace('x * 2','x * 3');
    assert.equal(scope.prepare(original,changed,request).readyForReview,false);
    assert.equal(scope.prepare(original,changed.replace('twice x','twice   x'),request).readyForReview,false);
    assert.equal(scope.prepare(original,changed.replace('twice','three times'),request).readyForReview,true);
    assert.equal(scope.prepare(original,original,request).readyForReview,true);
    assert.equal(scope.prepare(original,changed,'Change the multiplier.').readyForReview,true);
    assert.equal(scope.prepare(original,changed,'Do not update the docstring or comments.').readyForReview,true);
  }
});

test('recognizes removed docs and direct docstring selections, and skips partial or example selections',()=>{
  const original="def scale(x):\n    '''Return twice x.'''\n    return x * 2\n";
  const request='Update the docstring.';
  const scope=new InlineSelection('scale.py',original,0,original.length);
  assert.equal(scope.prepare(original,original.replace("    '''Return twice x.'''\n",''),request).readyForReview,false);
  assert.equal(scope.prepare(original,'def scale(x): return 3 * x',request).readyForReview,false);
  assert.equal(scope.prepare(original,'',request).readyForReview,false);
  const start=original.indexOf("'''");
  const direct=new InlineSelection('scale.py',original,start,original.lastIndexOf("'''")+3);
  assert.equal(direct.prepare(original,"pass",request).readyForReview,false);
  assert.equal(direct.prepare(original,'"Return the product."',request).readyForReview,true);
  const text='cases = """\n'+original+'"""\n';
  const example=new InlineSelection('example.py',text,text.indexOf(original),text.indexOf(original)+original.length);
  assert.equal(example.prepare(text,original.replace('x * 2','x * 3'),request).readyForReview,true);
  const body=new InlineSelection('scale.py',original,original.indexOf('return x'),original.length);
  assert.equal(body.prepare(original,'return x * 3\n',request).readyForReview,true);
  const generic=new InlineSelection('sample.md',original,0,original.length);
  assert.equal(generic.prepare(original,original.replace('x * 2','x * 3'),request).readyForReview,true);
});

test('an unchanged candidate still needs to satisfy a requested exhaustive description',()=>{
  const request='Update the docstring to list every value that returns false.';
  const source='def permits(options) -> bool:\n    """Return the configured result."""\n    entry = options.get("permit")\n    return bool(entry and entry.lower() not in {"paused", "hold"})';
  const scope=new InlineSelection('examples.py',source,0,source.length);
  const draft=scope.prepare(source,source,request);
  assert.equal(draft.readyForReview,false);
  assert.match(draft.issues.join(' '),/paused/);
  assert.throws(()=>scope.proposal(draft.draftId,undefined,source),/hold/);
  assert.throws(()=>scope.proposal(draft.draftId,undefined,source,request),/hold/);
  const repaired=source.replace('Return the configured result.','Returns False for an absent key, an empty string, "paused", or "hold".');
  assert.equal(scope.proposal(draft.draftId,repaired,source,request),repaired);
  const complete=new InlineSelection('examples.py',repaired,0,repaired.length);
  assert.equal(complete.prepare(repaired,repaired,request).readyForReview,true);
});
