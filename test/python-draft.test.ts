import assert from 'node:assert/strict';
import test from 'node:test';
import { guardPythonDraftInsertions } from '../src/pythonDraft';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startMcp} from '../src/mcp';
import {selectContext} from '../src/context';

const source = ['@cache(','    size=2,',')','# Keep the decorator','def read():','    sample = 1','',
  '    return sample','','def next_sample():','    pass',''].join('\n');
const all = new Map<number|'end',number>(source.split('\n').map((_,i)=>[i+1,0]));
all.set('end',source.length);
const addition = '\n\n@mark\nasync def inspect_sample():\n    return 1\n\n';
const check = (line:number|'end', text=addition, visible=all) =>
  guardPythonDraftInsertions('sample.py',source,[{beforeLine:line,newText:text}],visible);

test('reject a standalone module declaration splitting a Python suite and return a displayed safe anchor',()=>{
  assert.throws(()=>check(7),/inside an existing Python block.*beforeLine 10.*next_sample/s);
  assert.throws(()=>check(8),/exact oldText/s);
  const onlyBody = new Map<number|'end',number>([[7,0],['end',source.length]]);
  assert.throws(()=>check(7,addition,onlyBody),/beforeLine "end"/);
  assert.doesNotThrow(()=>check(10));
  assert.doesNotThrow(()=>check('end'));
  assert.doesNotThrow(()=>check(8,'    def nested():\n        pass\n'));
  assert.doesNotThrow(()=>guardPythonDraftInsertions('sample.md',source,[{beforeLine:8,newText:addition}],all));
  assert.doesNotThrow(()=>guardPythonDraftInsertions('sample.py',source,[{oldText:'sample = 1',newText:addition}],all));
});

test('keep a multiline Python decorator attached to its original declaration',()=>{
  assert.throws(()=>check(4),/decorator/);
  assert.throws(()=>check(5),/decorator/);
  assert.doesNotThrow(()=>check(1));
  assert.doesNotThrow(()=>check(5,'@another_decorator\n'));
});

test('allow declaration examples inside a multiline string and after a completed decorated function',()=>{
  const text=['def document():','    return """Sample:','    indented explanation','@literal','def literal():','"""','','def real():','    return 1'].join('\n');
  for(const line of [3,4,5,6,7,8]){
    assert.doesNotThrow(()=>guardPythonDraftInsertions('sample.py',text,[{beforeLine:line,newText:addition}],all));
  }
});

test('the real Draft tool returns the verified boundary to the model before any hunk review',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'forge-python-boundary-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file='sample.py',lines=source.split('\n');
  await writeFile(path.join(root,file),source);
  const compact=selectContext([{path:file,content:source}],'sample',5000);
  compact.items=[{...compact.items[0]!,path:file,startLine:1,endLine:lines.length,content:source}];
  compact.draftFiles=new Map([[file,{hash:createHash('sha256').update(source).digest('hex'),lineCount:lines.length,lastLineLength:0}]]);
  const staged:string[]=[];
  const bridge=await startMcp({root,budget:5000,compactContext:compact,draftFromContext:true,active:()=>true,
    propose:async(_path,content)=>{staged.push(content);return 'Reviewed';},command:async()=>'',context:()=>{}});
  t.after(()=>bridge.close());
  const client=new Client({name:'boundary-test',version:'1'});t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:'Bearer '+bridge.token}}}));
  const propose=(line:number)=>client.callTool({name:'propose_changes',arguments:{files:[{path:file,reason:'sample',
    edits:[{beforeLine:line,newText:addition}]}]}});
  const invalid=await propose(7);
  assert.ok(invalid.isError);assert.match(JSON.stringify(invalid.content),/beforeLine 10/);assert.equal(staged.length,0);
  assert.ok(!(await propose(10)).isError);assert.equal(staged.length,1);
});
