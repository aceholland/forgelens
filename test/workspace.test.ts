import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,symlink,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
