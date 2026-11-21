import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,symlink,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {confinedPath,readWorkspace,listWorkspace} from '../src/workspace';

async function fixture(t: { after: (fn:()=>Promise<void>)=>void }) {
 const base=await mkdtemp(path.join(tmpdir(),'forgelens-paths-'));
 const root=path.join(base,'repo'); await mkdir(root);
 t.after(()=>rm(base,{recursive:true,force:true})); return {base,root};
}

test('confines relative reads and denies traversal, secret files and absolute paths',async t=>{
 const {root,base}=await fixture(t);await writeFile(path.join(root,'safe.ts'),'safe');
 await writeFile(path.join(root,'.env'),'secret');await writeFile(path.join(base,'outside'),'outside');
 assert.equal(await readWorkspace(root,'safe.ts'),'safe');
 for(const target of ['../outside',path.join(base,'outside'),'.env','a/../../outside','C:\\outside']) await assert.rejects(confinedPath(root,target));
});

test('denies symlink escape for existing files and proposed nonexistent files',async t=>{
 const {root,base}=await fixture(t); const outside=path.join(base,'external');await mkdir(outside);await writeFile(path.join(outside,'x.ts'),'private');
 await symlink(outside,path.join(root,'linked'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(confinedPath(root,'linked/x.ts'),/Symlink escapes/);
 await assert.rejects(confinedPath(root,'linked/new.ts'),/Symlink escapes/);
});

test('listing excludes secret paths and symlinks; readers reject binary/oversized files',async t=>{
 const {root}=await fixture(t);await mkdir(path.join(root,'src'));await mkdir(path.join(root,'.aws'));
 await writeFile(path.join(root,'src','ok.ts'),'ok');await writeFile(path.join(root,'.aws','config'),'private');
 await writeFile(path.join(root,'binary'),'a\0b');await writeFile(path.join(root,'big'),'a'.repeat(250001));
 await symlink(path.join(root,'src'),path.join(root,'alias'),process.platform==='win32'?'junction':'dir');
 assert.deepEqual((await listWorkspace(root)).sort(),['big','binary','src/ok.ts']);
 await assert.rejects(readWorkspace(root,'binary'),/Binary or oversized/);await assert.rejects(readWorkspace(root,'big'),/Binary or oversized/);
});

test('a safe-looking link cannot alias a protected secret file within workspace',async t=>{
 const {root}=await fixture(t);
 // Directory junctions work on Windows without enabling Developer Mode or
 // requesting symlink privileges. Exercise the same resolved-path boundary.
 if(process.platform==='win32'){
  await mkdir(path.join(root,'.aws'));await writeFile(path.join(root,'.aws','config'),'SECRET');
  await symlink(path.join(root,'.aws'),path.join(root,'ordinary'),'junction');
  await assert.rejects(readWorkspace(root,'ordinary/config'),/Path is not allowed|protected|secret/i);
 }else{
  await writeFile(path.join(root,'.env'),'SECRET');await symlink(path.join(root,'.env'),path.join(root,'ordinary.txt'));
  await assert.rejects(readWorkspace(root,'ordinary.txt'),/Path is not allowed|protected|secret/i);
 }
});

function git(root: string, ...args: string[]) {
 return execFileSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true});
}
async function gitFixture(t: { after: (fn:()=>Promise<void>)=>void }) {
 const fixturePaths=await fixture(t);
 git(fixturePaths.root,'init','-q');
 // Keep the real-Git tests independent of the developer's global excludes.
 const excludes=path.join(fixturePaths.root,'.git','test-global-excludes');
 await writeFile(excludes,'globally-skipped.txt\n');
 git(fixturePaths.root,'config','core.excludesFile',excludes);
 return fixturePaths;
}

test('Git discovery honors nested ignores, negation, local/global excludes and tracked files',async t=>{
 const {root}=await gitFixture(t);
 await mkdir(path.join(root,'nested'));await mkdir(path.join(root,'cache'));
 await writeFile(path.join(root,'.gitignore'),'*.tmp\ncache/\n');
 await writeFile(path.join(root,'nested','.gitignore'),'*.data\n!keep.data\n');
 await writeFile(path.join(root,'.git','info','exclude'),'local-only.txt\n');
 for(const name of ['tracked.tmp','scratch.tmp','local-only.txt','globally-skipped.txt','ordinary file.ts','.env','nested/drop.data','nested/keep.data','cache/generated.ts']) await writeFile(path.join(root,name),'content');
 git(root,'add','-f','tracked.tmp','.env');
 assert.deepEqual((await listWorkspace(root)).sort(),['.gitignore','nested/.gitignore','nested/keep.data','ordinary file.ts','tracked.tmp']);
 // A workspace opened below the repository root returns only workspace-relative paths.
 assert.deepEqual((await listWorkspace(path.join(root,'nested'))).sort(),['.gitignore','keep.data']);
});

test('literal workspace exclusions apply to discovery and manual reads without Git',async t=>{
 const {root}=await fixture(t);
 await mkdir(path.join(root,'private reports'));await mkdir(path.join(root,'nested'));
 await writeFile(path.join(root,'.forgelensignore'),'# literal root-relative paths\n\nprivate reports/\nnotes.txt\n');
 for(const name of ['private reports/report.ts','notes.txt','nested/notes.txt','ordinary.ts']) await writeFile(path.join(root,name),'content');
 assert.deepEqual((await listWorkspace(root)).sort(),['nested/notes.txt','ordinary.ts']);
 await assert.rejects(readWorkspace(root,'.forgelensignore'),/not allowed|protected/i);
 await assert.rejects(readWorkspace(root,'notes.txt'),/excluded.*forgelensignore/i);
 await assert.rejects(confinedPath(root,'private reports/new.ts'),/excluded.*forgelensignore/i);
 assert.equal(await readWorkspace(root,'nested/notes.txt'),'content');
});

test('workspace exclusions override tracked files and cannot be bypassed through directory aliases',async t=>{
 const {root}=await gitFixture(t);
 await mkdir(path.join(root,'private'));await writeFile(path.join(root,'private','report.ts'),'hidden');
 await writeFile(path.join(root,'.forgelensignore'),'private\n');
 git(root,'add','private/report.ts');
 await symlink(path.join(root,'private'),path.join(root,'ordinary'),process.platform==='win32'?'junction':'dir');
 assert.deepEqual(await listWorkspace(root),[]);
 await assert.rejects(readWorkspace(root,'ordinary/report.ts'),/excluded.*forgelensignore/i);
 await assert.rejects(confinedPath(root,'ordinary/new.ts'),/excluded.*forgelensignore/i);
});

test('workspace exclusion cache notices replacement and deletion of the rules file',async t=>{
 const {root}=await fixture(t);const rules=path.join(root,'.forgelensignore');
 await writeFile(path.join(root,'first.ts'),'first');await writeFile(path.join(root,'second-longer.ts'),'second');
 await writeFile(rules,'first.ts\n');
 await assert.rejects(readWorkspace(root,'first.ts'),/excluded/i);
 await writeFile(rules,'second-longer.ts\n');
 assert.equal(await readWorkspace(root,'first.ts'),'first');
 await assert.rejects(readWorkspace(root,'second-longer.ts'),/excluded/i);
 await rm(rules);
 assert.equal(await readWorkspace(root,'second-longer.ts'),'second');
});

test('malformed or indirect workspace exclusion files fail closed with a useful error',async t=>{
 const {root,base}=await fixture(t);const rules=path.join(root,'.forgelensignore');
 await writeFile(path.join(root,'ordinary.ts'),'ordinary');
 for(const entry of ['/private','../private','C:/private','bad\\path','*.ts','!private','a//b','a/./b']) {
  await writeFile(rules,entry+'\n');
  await assert.rejects(readWorkspace(root,'ordinary.ts'),/invalid.*forgelensignore/i,entry);
  await assert.rejects(listWorkspace(root),/invalid.*forgelensignore/i,entry);
 }
 await rm(rules);const outside=path.join(base,'outside-rules');await mkdir(outside);
 await symlink(outside,rules,process.platform==='win32'?'junction':'dir');
 await assert.rejects(readWorkspace(root,'ordinary.ts'),/forgelensignore/i);
});

test('discovery stays bounded in a large Git workspace',async t=>{
 const {root}=await gitFixture(t);
 for(let start=0;start<3010;start+=100) await Promise.all(Array.from({length:Math.min(100,3010-start)},(_,i)=>writeFile(path.join(root,`file-${start+i}.ts`),'x')));
 const files=await listWorkspace(root);
 assert.equal(files.length,3000);assert.equal(new Set(files).size,3000);
 assert.ok(files.every(name=>/^file-\d+\.ts$/.test(name)));
});
