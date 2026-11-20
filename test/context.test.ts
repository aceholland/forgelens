import test from 'node:test';
import assert from 'node:assert/strict';
import {selectContext,parseMentions,isSafeContextPath} from '../src/context';

test('retrieves relevant code with deterministic reasons and hard character budget',()=>{
 const files=[{path:'src/cli.py',content:'def config():\n    return config_json\n'},{path:'docs/cli.md',content:'CLI commands and configuration reference'},{path:'src/unrelated.py',content:'random weather'}];
 const result=selectContext(files,'Add configuration CLI command',100);
 assert.ok(result.items.some(x=>x.path==='docs/cli.md'));
 assert.ok(result.items.every(x=>x.reason.length>0));
 assert.ok(result.usedChars<=100);
 assert.equal(result.usedChars,result.items.reduce((n,x)=>n+x.content.length,0));
 assert.deepEqual(result,selectContext([...files].reverse(),'Add configuration CLI command',100));
});

test('explicit file and symbol mentions outrank lexical matches',()=>{
 assert.deepEqual(parseMentions('@file:src/a.py @symbol:build @src/b.py'),{files:['src/a.py','src/b.py'],symbols:['build']});
 const result=selectContext([{path:'src/a.py',content:'aaaa'},{path:'src/b.py',content:'bbbb',symbols:['build']},{path:'src/config.py',content:'config config config'}],'config @file:src/a.py @symbol:build',8);
 assert.deepEqual(result.items.map(x=>x.path),['src/a.py','src/b.py']);
 assert.match(result.items[1]!.reason,/symbol/);
});

test('secrets and excluded directories never enter context even when mentioned',()=>{
 for(const path of ['.env','.env.local','x/private.pem','.git/config','node_modules/a.js','../x','/etc/passwd','C:\\secret','secrets.json','credentials.json']) assert.equal(isSafeContextPath(path),false,path);
 assert.equal(isSafeContextPath('src/config.ts'),true);
 const r=selectContext([{path:'.env',content:'SECRET'},{path:'src/x.ts',content:'safe'}],'@file:.env',100);
 assert.equal(r.items.length,0);
});

test('truncates relevant input to budget, handles zero and invalid budget',()=>{
 const r=selectContext([{path:'a.ts',content:'config'.repeat(100)}],'@file:a.ts',9);
 assert.equal(r.usedChars,9); assert.equal(r.items[0]!.truncated,true);
 assert.equal(selectContext([],'x',0).usedChars,0);
 assert.throws(()=>selectContext([],'x',-1),/budget/);
});

test('excludes credential directories and tool credential files',()=>{
 for(const path of ['.ssh/config','.aws/config','.config/gcloud/application_default_credentials.json','.npmrc','.netrc','.pypirc','.GIT/config','x/credentials-prod.json']) {
  assert.equal(isSafeContextPath(path),false,path);
 }
});

test('natural punctuation after explicit mentions is not part of file or symbol',()=>{
 assert.deepEqual(parseMentions('Edit @file:src/flask/helpers.py. Check @symbol:get_debug_flag.'),{files:['src/flask/helpers.py'],symbols:['get_debug_flag']});
});

test('automatic retrieval shares budget across relevant implementation tests and docs',()=>{
 const files=['src/cli.py','tests/test_cli.py','docs/cli.rst'].map(path=>({path,content:'header\n'.repeat(100)+'config command JSON\n'+'tail\n'.repeat(1000)}));
 const result=selectContext(files,'config command JSON',1200);
 assert.equal(result.items.length,3);
 assert.ok(result.items.every(x=>x.content.includes('config command JSON')));
 assert.ok(result.usedChars<=1200);
});

test('retrieves a relevant line window instead of the first generic header match',()=>{
 const content='import framework\n'+'unrelated header\n'.repeat(80)+'def config_command():\n    """Print application configuration as JSON."""\n'+'unrelated tail\n'.repeat(80);
 const r=selectContext([{path:'src/cli.py',content}],'framework config command application configuration JSON',240);
 assert.match(r.items[0]!.content,/def config_command/);
 assert.equal(r.items[0]!.content,content.split('\n').slice(r.items[0]!.startLine!-1,r.items[0]!.endLine).join('\n'));
 assert.ok(r.usedChars<=240);
});

test('explicit symbol snippet is centered on the requested symbol, not an unrelated header',()=>{
 const content='header\n'.repeat(80)+'def target_symbol():\n    return 1\n'+'tail\n'.repeat(80);
 const r=selectContext([{path:'src/a.py',content}],'@symbol:target_symbol',150);
 assert.match(r.items[0]!.content,/def target_symbol/);
});

test('generated test and type-check caches never enter retrieval',()=>{
 for(const path of ['.pytest_cache/v/cache/nodeids','src/__pycache__/module.pyc','.mypy_cache/3.12/cache.json','.ruff_cache/cache'])assert.equal(isSafeContextPath(path),false,path);
 const result=selectContext([{path:'.pytest_cache/v/cache/nodeids',content:'config command JSON '.repeat(100)},{path:'src/cli.py',content:'config command JSON'}],'config command JSON',100);
 assert.deepEqual(result.items.map(x=>x.path),['src/cli.py']);
});

test('automatic retrieval stops at four useful snippets instead of filling leftover budget with fragments',()=>{
 const files=Array.from({length:8},(_,i)=>({path:`area${i}/target.ts`,content:('target meaningful line\n').repeat(50)}));
 const result=selectContext(files,'target',401);
 assert.equal(result.items.length,4);
 assert.ok(result.items.every(x=>x.content.length>=80));
 assert.ok(result.usedChars<=401);
});

test('feature retrieval follows the implementation module into its tests and documentation',()=>{
 const filler='The loaded application saves key values for JSON configuration.\n'.repeat(90);
 const files=[
  {path:'src/console.py', content:filler+'def register_action(name):\n    actions.register_action("status")\n'+filler},
  {path:'tests/test_console.py',content:filler+'def test_console_help():\n    result = runner.invoke(["--help"])\n    assert result.exit_code == 0\n'+filler},
  {path:'docs/console.rst',content:filler+'Adding Console Actions\n----------------------\n\nUse register_action to expose it in the console.\n'+filler},
  {path:'docs/configuration.rst',content:filler},
  {path:'tests/test_json.py',content:filler},
  {path:'CHANGES.rst',content:filler},
 ];
 const result=selectContext(files,'Add a built-in console action that prints loaded application key values for JSON configuration and appears in console --help. Add tests and documentation.',3000);
 const found = new Map(result.items.map(x=>[x.path,x]));
 assert.match(found.get('src/console.py')!.content,/actions\.register_action/);
 assert.match(found.get('tests/test_console.py')!.content,/runner\.invoke/);
 assert.match(found.get('docs/console.rst')!.content,/Adding Console Actions/);
 assert.ok(!found.has('CHANGES.rst'));
});

test('file discovery keeps five unique bounded windows ranked by keywords and symbols',()=>{
 const paths=['src/cli.py','other/cli.py','docs/cli.rst','tests/test_cli.py','support/cli.py','src/unrelated.py','.env'];
 const body=('marker: console action\n').repeat(150);
 const files=paths.map(path=>({path,content:path==='src/unrelated.py'?'weather service':body}));
 files.push({path:'src/cli.py',content:body});
 const selection=selectContext(files,'console action cli tests and documentation @symbol:marker',4000,{maxFiles:5,maxLines:40});
 assert.equal(selection.items.length,5);
 assert.equal(new Set(selection.items.map(f=>f.path)).size,5);
 assert.ok(selection.items.every(f=>f.endLine!-f.startLine!<40 && f.reason.includes('symbol')));
 assert.ok(selection.items.every(f=>f.path!=='.env' && f.path!=='src/unrelated.py'));
 assert.ok(selection.usedChars<=4000);
});

test('automatic discovery spends the preview budget on the matching source test and docs family',()=>{
 const content=('console command configuration JSON meaningful source line\n').repeat(200);
 const files=['src/console.py','tests/test_console.py','docs/console.rst','CHANGES.rst','settings/config.yaml'].map(path=>({path,content}));
 const result=selectContext(files,'Add a console command with tests and documentation',4000,{maxFiles:5,maxLines:40});
 assert.deepEqual(result.items.map(item=>item.path),['src/console.py','tests/test_console.py','docs/console.rst']);
 assert.ok(result.items.every(item=>item.content.length>1000));
 assert.ok(result.usedChars<=4000);
});
