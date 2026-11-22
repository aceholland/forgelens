import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {copyPinnedFixtures,userFixturePins} from '../src/candidateFixtures';
import {listWorkspace,readWorkspace} from '../src/workspace';

const fixture='tests/assets/.env.sample';
const git=(root:string,...args:string[])=>execFileSync('git',['-C',root,'-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','-c','core.autocrlf=false',...args],{encoding:'utf8',windowsHide:true}).trim();

test('workspace settings cannot supply or override user-approved test fixtures',()=>{
 const sha='a'.repeat(40);
 assert.deepEqual(userFixturePins({workspaceValue:{[fixture]:sha},workspaceFolderValue:{[fixture]:sha}}),{});
 assert.deepEqual(userFixturePins({globalValue:{[fixture]:sha},workspaceValue:{['tests/.env']:'b'.repeat(40)}}),{[fixture]:sha});
 for(const name of ['.env','src/.env','tests/../.env','tests/.git/.env','tests/node_modules/.env','tests/aux/.env','tests/a./.env','tests/key.txt','tests/a\\.env'])
   assert.throws(()=>userFixturePins({globalValue:{[name]:sha}}),/fixture/i,name);
 assert.throws(()=>userFixturePins({globalValue:{[fixture]:'a123456'}}),/blob ID/);
 assert.throws(()=>userFixturePins({globalValue:Object.fromEntries(Array.from({length:9},(_,i)=>['tests/.env.'+i,sha]))}),/eight/);
});

test('only the pinned regular Git blob reaches the scratch tree even when working-tree contents differ',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'forge-pins-source-'));
 const scratch=await mkdtemp(path.join(tmpdir(),'forge-pins-copy-'));
 t.after(async()=>{await rm(root,{recursive:true,force:true});await rm(scratch,{recursive:true,force:true});});
 git(root,'init','--quiet');
 await mkdir(path.join(root,'tests/assets'),{recursive:true});
 const synthetic='EXAMPLE=public-test-fixture\n';
 await writeFile(path.join(root,fixture),synthetic);
 git(root,'add','-f','--',fixture);git(root,'commit','--quiet','-m','fixture');
 const sha=git(root,'rev-parse','HEAD:'+fixture);
 const pins={[fixture]:sha};
 await writeFile(path.join(root,fixture),'PRIVATE_TEST_SENTINEL=working-tree-only\n');
 await copyPinnedFixtures(root,scratch,pins);
 assert.equal(await readFile(path.join(scratch,fixture),'utf8'),synthetic);
 assert.ok(!(await listWorkspace(root)).includes(fixture));await assert.rejects(readWorkspace(root,fixture),/not allowed/i);
 await assert.rejects(copyPinnedFixtures(root,scratch,{[fixture]:'0'.repeat(40)}),/does not match/i);
 await writeFile(path.join(root,'.forgelensignore'),'tests/assets\n');
 await assert.rejects(copyPinnedFixtures(root,scratch,pins),/excluded by .forgelensignore/);
 await writeFile(path.join(root,'.forgelensignore'),'');
 const nested=path.join(scratch,'nested');
 await mkdir(nested);
 await symlink(path.join(root,'tests'),path.join(nested,'tests'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(copyPinnedFixtures(root,nested,pins),/Unsafe test fixture destination/);
 assert.equal(await readFile(path.join(root,fixture),'utf8'),'PRIVATE_TEST_SENTINEL=working-tree-only\n');
 git(root,'update-index','--add','--cacheinfo','120000,'+sha+','+fixture);git(root,'commit','--quiet','-m','symlink mode');
 await assert.rejects(copyPinnedFixtures(root,scratch,pins),/regular file/i);
 const oversized='tests/assets/.env.large';
 await writeFile(path.join(root,oversized),Buffer.alloc(65537,65));git(root,'add','-f','--',oversized);git(root,'commit','--quiet','-m','oversized fixture');
 await assert.rejects(copyPinnedFixtures(root,scratch,{[oversized]:git(root,'rev-parse','HEAD:'+oversized)}),/64 KiB/);
});
