import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { anchorExcerpt } from '../src/compactContext';
import { selectContext } from '../src/context';
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

test('draft offers one scoped tool, preflights the entire batch and repairs from the current overlay', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'forgelens-draft-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const saved={'widget.py':'def widget(value):\n    return value\n','test_widget.py':'def test_widget():\n    assert widget(2) == 2\n'};
  for(const [name,body] of Object.entries(saved)) await writeFile(path.join(root,name),body);
  await writeFile(path.join(root,'unselected.py'),'UNSELECTED_SENTINEL');
  const selection=selectContext(Object.entries(saved).map(([path,content])=>({path,content})), 'widget tests', 8000,undefined,2000);
  const overlay=new Map([['widget.py','def widget(staged_value):\n    return staged_value\n']]);
  const calls:string[]=[],validated:string[][]=[];
  const bridge=await startMcp({root,budget:8000,draftFromContext:true,compactContext:selection,requireDiscovery:true,
    active:()=>true,pending:name=>overlay.get(name),context:()=>calls.push('context'),command:async()=>{calls.push('command');return '';},
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
  const success=await propose([source,check],['test_widget.py::test_widget']);
  assert.ok(!success.isError);
  assert.match(JSON.stringify(success),/accepted hunk-1.*Candidate pytest exited 0/);
  assert.deepEqual(calls,['plan','review widget.py','review test_widget.py']);
  assert.deepEqual(validated,[['test_widget.py::test_widget']]);
  const fullSuite=await propose([edit('widget.py','staged_value * 2','2 * staged_value')],[]);
  assert.ok(!fullSuite.isError);
  assert.deepEqual(validated.at(-1),[]);
  assert.equal(await readFile(path.join(root,'widget.py'),'utf8'),saved['widget.py']);
});
