import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { anchorExcerpt, compactContext, compactEvidence, draftInsertionOffsets } from '../src/compactContext';
import { resolveAgentProposal } from '../src/patch';
import { startMcp } from '../src/mcp';

test('a context draft requires retrieved source before opening an editing endpoint', async () => {
  await assert.rejects(startMcp({root:'.',budget:4000,draftFromContext:true,active:()=>true,
    propose:async()=>'',context:()=>{},command:async()=>''}), /nonempty editable source/);
});

test('anchor recovery preserves the matching line when nearby lines exceed the window', () => {
  const current=['a'.repeat(1500), 'def calculate_total(value):','    return value', 'z'.repeat(2000)].join('\n');
  const excerpt=anchorExcerpt(current,'def calculate_total(item):',1);
  assert.equal(excerpt.startLine,2);
  assert.ok(excerpt.content.startsWith('def calculate_total(value):'));
  assert.ok(excerpt.content.length<=1200);
});

test('draft insertions use the immutable retrieved line, reject ambiguity and retain original CRLF bytes', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'forgelens-position-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file='widget.py';
  const saved='first\r\nrepeat\r\nrepeat\r\nlast\r\n';
  await writeFile(path.join(root,file),saved);
  const selection=(await compactContext(root,'@file:widget.py',8000,2000,()=>false))!;
  assert.match(compactEvidence(selection,true),/3\| repeat/);
  assert.match(compactEvidence(selection,true),/end of file/);
  const offsets=draftInsertionOffsets(selection,file,saved);
  const resolve=(edits:unknown[])=>resolveAgentProposal(saved,{edits},offsets);
  assert.equal(resolve([{beforeLine:3,newText:'inserted\n'},{beforeLine:'end',newText:'final\n'},
    {oldText:'first',newText:'updated'}]),'updated\r\nrepeat\r\ninserted\r\nrepeat\r\nlast\r\nfinal\r\n');
  assert.throws(()=>resolve([{beforeLine:3,oldText:'repeat',newText:'inserted'}]),/beforeLine and nonempty newText only/);
  assert.throws(()=>resolve([{beforeLine:3,newText:'one'},{beforeLine:3,newText:'two'}]),/overlap/);
  assert.throws(()=>draftInsertionOffsets(selection,file,saved.replace('first','changed')),/stale/);
  const clipped={...selection,items:[{...selection.items[0]!,startLine:2,endLine:3,content:'repeat\r\nrep'}]};
  assert.deepEqual([...draftInsertionOffsets(clipped,file,saved).keys()],[2]);
  assert.doesNotMatch(compactEvidence(clipped,true),/end of file/);
});

test('a draft reserves real ends for each editable file before adding optional excerpts', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'forgelens-tails-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const names=['widget.py','test_widget.py','widget.md'];
  const saved=names.map((name,i)=>`widget entry ${i}\n` + ('body '+name+' '+ 'q'.repeat(140)+'\n').repeat(65)+`    final boundary ${i}\n`);
  for(const [i,name] of names.entries())await writeFile(path.join(root,name),saved[i]!);
  const task=names.map(name=>'@file:'+name).join(' ');
  const select=(chars:number,tokens:number)=>compactContext(root,task,chars,tokens,()=>false,true);
  const available=(await select(2600,850))!;
  assert.deepEqual(new Set(available.items.map(i=>i.path)),new Set(names));
  for(const [i,name] of names.entries()){
    assert.equal(draftInsertionOffsets(available,name,saved[i]!).get('end'),saved[i]!.length);
    assert.ok(available.items.some(item=>item.path===name && item.content.endsWith(`    final boundary ${i}\n`)));
  }
  assert.ok(available.usedChars<=2600 && available.usedTokens<=850);
  const wide='widget\n'+('body '+ 'q'.repeat(55)+'\n').repeat(280)+'    end\n';
  await writeFile(path.join(root,'wide.py'),wide);
  const generous=(await compactContext(root,'@file:wide.py',14000,3200,()=>false,true))!;
  assert.ok(generous.items.some(item=>item.path==='wide.py' && item.endLine===wide.split('\n').length &&
    item.endLine!-item.startLine!+1>=22));
  await writeFile(path.join(root,names[0]!),saved[0]!.trimEnd()+'x'.repeat(18000));
  const limited=(await select(2600,850))!;
  const changed=await readFile(path.join(root,names[0]!),'utf8');
  assert.equal(draftInsertionOffsets(limited,names[0]!,changed).has('end'),false);
  assert.ok(limited.usedChars<=2600 && limited.usedTokens<=850);
});

test('draft offers one scoped tool, preflights the entire batch and repairs from the current overlay', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'forgelens-draft-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const saved={'widget.py':'def widget(value):\n    return value\n','test_widget.py':'def test_widget():\n    assert widget(2) == 2\n'};
  for(const [name,body] of Object.entries(saved)) await writeFile(path.join(root,name),body);
  const selection=(await compactContext(root,'widget tests',8000,2000,()=>false))!;
  await writeFile(path.join(root,'unselected.py'),'UNSELECTED_SENTINEL');
  const overlay=new Map([['widget.py','def widget(staged_value):\n    return staged_value\n']]);
  const calls:string[]=[],validated:string[][]=[];
  const bridge=await startMcp({root,budget:8000,draftFromContext:true,compactContext:selection,requireDiscovery:true,
    active:()=>true,pending:name=>overlay.get(name),autoValidateReviewedTests:true,context:()=>calls.push('context'),command:async()=>{calls.push('command');return '';},
    onPlan:()=>calls.push('plan'),propose:async(name,content)=>{calls.push('review '+name);overlay.set(name,content);return 'accepted hunk-1';},
    validate:async paths=>{validated.push(paths);return 'Candidate pytest exited 0';}});
  t.after(()=>bridge.close());
  const client=new Client({name:'draft-test',version:'1'});
  t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:'Bearer '+bridge.token}}}));
  const {tools}=await client.listTools();
  assert.deepEqual(tools.map(tool=>tool.name),['propose_changes']);
  const schema=tools[0]!.inputSchema.properties as any;
  assert.deepEqual([...schema.files.items.properties.path.enum].sort(),Object.keys(saved).sort());
  const editSchema=schema.files.items.properties.edits.items;
  const variants=editSchema.anyOf ?? editSchema.oneOf;
  assert.deepEqual(variants.map((variant:any)=>[variant.required,variant.additionalProperties]),[
    [['oldText','newText'],false],[['beforeLine','newText'],false]
  ]);
  for (const malformed of [{oldTextBefore:'UNTRUSTED_VALUE',oldTextNull:null,newText:'replacement'},
     {oldText:'UNTRUSTED_VALUE',beforeLine:2,newText:'replacement'}]) {
    const rejected=await client.callTool({name:'propose_changes',arguments:{files:[{path:'widget.py',reason:'Update widget',edits:[malformed]}]}});
    assert.equal(rejected.isError,true);
    const feedback=JSON.stringify(rejected);
    assert.match(feedback,/oldText, newText/);
    assert.match(feedback,/beforeLine, newText/);
    if('oldTextBefore' in malformed)assert.match(feedback,/oldTextBefore, oldTextNull/);
    assert.doesNotMatch(feedback,/UNTRUSTED_VALUE/);
    assert.deepEqual(calls,[]);
  }
  for(const name of ['find_relevant_files','read_file','search_workspace','select_context','create_file','propose_edit','run_command','validate_candidate','report_plan']){
    const denied=await client.callTool({name,arguments:{path:'unselected.py'}});
    assert.equal(denied.isError,true,name);
    assert.doesNotMatch(JSON.stringify(denied),/UNSELECTED_SENTINEL/);
  }
  const edit=(path:string,oldText:string,newText:string)=>({path,reason:'Update the widget',edits:[{oldText,newText}]});
  const propose=(files:ReturnType<typeof edit>[],tests?:string[])=>client.callTool({name:'propose_changes',arguments:{files,tests}});
  const source=edit('widget.py','return staged_value','return staged_value * 2');
  const check=edit('test_widget.py','widget(2) == 2','widget(2) == 4');
  const outside=await propose([check,edit('unselected.py','x','y')]);
  assert.equal(outside.isError,true);
  assert.doesNotMatch(JSON.stringify(outside),/UNSELECTED_SENTINEL/);
  assert.equal((await propose([source],['unselected.py'])).isError,true);
  assert.equal((await propose([source,source])).isError,true);
  const failure=await propose([check,edit('widget.py','def widget(missing):','pass')]);
  assert.equal(failure.isError,true);
  assert.match(JSON.stringify(failure),/oldText must match exactly once/);
  assert.match(JSON.stringify(failure),/def widget\(staged_value\)/);
  assert.deepEqual(calls,[]);
  assert.deepEqual(validated,[]);
  const both=await propose([edit('widget.py','not-there','new'),edit('test_widget.py','also-missing','new')]);
  assert.equal(both.isError,true);
  assert.match(JSON.stringify(both),/widget\.py: oldText.*test_widget\.py: oldText/);
  assert.deepEqual(calls,[]);
  const stale=await client.callTool({name:'propose_changes',arguments:{files:[{path:'widget.py',reason:'Update widget',
    edits:[{beforeLine:2,newText:'    assert value\n'}]}]}});
  assert.equal(stale.isError,true);
  assert.match(JSON.stringify(stale),/stale.*staged_value/);
  assert.deepEqual(calls,[]);
  const success=await propose([source,check],['test_widget.py::test_widget']);
  assert.ok(!success.isError);
  assert.match(JSON.stringify(success),/accepted hunk-1.*Candidate pytest exited 0/);
  assert.deepEqual(calls,['plan','review widget.py','review test_widget.py']);
  assert.deepEqual(validated,[['test_widget.py::test_widget']]);
  const fullSuite=await propose([edit('widget.py','staged_value * 2','2 * staged_value')],[]);
  assert.ok(!fullSuite.isError);
  assert.deepEqual(validated.at(-1),[]);
  const tested=await propose([edit('test_widget.py','widget(2) == 4','widget(3) == 6')]);
  assert.ok(!tested.isError);
  assert.deepEqual(validated.at(-1),['test_widget.py']);
  const unchanged=await propose([edit('test_widget.py','widget(3) == 6','widget(3) == 6')]);
  assert.ok(!unchanged.isError);
  assert.equal(validated.length,3);
  overlay.delete('test_widget.py');
  const inserted=await client.callTool({name:'propose_changes',arguments:{files:[{path:'test_widget.py',reason:'Add coverage',
    edits:[{beforeLine:'end',newText:'\ndef test_ready():\n    assert True\n'}]}]}});
  assert.ok(!inserted.isError,JSON.stringify(inserted));
  assert.equal(overlay.get('test_widget.py'),saved['test_widget.py']+'\ndef test_ready():\n    assert True\n');
  assert.deepEqual(validated.at(-1),['test_widget.py']);
  assert.equal(await readFile(path.join(root,'widget.py'),'utf8'),saved['widget.py']);
});
