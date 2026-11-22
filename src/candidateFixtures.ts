import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat,mkdir,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {isSafeContextPath} from './context';
import {excludedByWorkspaceIgnore} from './workspace';

const execute=promisify(execFile);
const maxBytes=64*1024;
export type FixturePins=Record<string,string>;

/** Workspace and workspace-folder settings can never select protected test fixtures. */
export function userFixturePins(setting:{globalValue?:unknown;workspaceValue?:unknown;workspaceFolderValue?:unknown}|undefined):FixturePins {
  const value=setting?.globalValue;
  if(value===undefined)return {};
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Pinned test fixtures must map paths to Git blob IDs.');
  const entries=Object.entries(value);
  if(entries.length>8)throw new Error('At most eight pinned test fixtures are allowed.');
  const seen=new Set<string>();
  for(const [name,hash] of entries){
    const parts=name.split('/');
    const validPath=/^(?:test|tests)\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*\.env(?:\.[A-Za-z0-9_-]+)*$/.test(name);
    const unsafeDirectory=parts.slice(0,-1).some(p=>p.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
    if(name.length>400 || !validPath || unsafeDirectory || !isSafeContextPath(path.posix.dirname(name)+'/fixture.txt'))
      throw new Error('Only named .env test fixtures inside ordinary test or tests directories are allowed.');
    if(typeof hash!=='string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(hash))throw new Error('Pin each test fixture to its complete Git blob ID.');
    const key=process.platform==='win32'?name.toLowerCase():name;
    if(seen.has(key))throw new Error('Duplicate pinned test fixture.');
    seen.add(key);
  }
  return Object.fromEntries(entries.map(([name,hash])=>[name,String(hash).toLowerCase()]));
}

/** Only Git's exact HEAD blob enters the private scratch copy. The working-tree .env is never opened. */
export async function copyPinnedFixtures(root:string,scratch:string,input:FixturePins,signal?:AbortSignal):Promise<void> {
  const pins=Object.entries(userFixturePins({globalValue:input}));
  if(!pins.length)return;
  const env:NodeJS.ProcessEnv={GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1'};
  for(const key of ['PATH','SystemRoot','WINDIR','PATHEXT','COMSPEC','TMP','TEMP','TMPDIR'])if(process.env[key])env[key]=process.env[key];
  const git=async(args:string[])=>{
    const {stdout}=await execute('git',['--no-replace-objects','--literal-pathspecs','-C',root,...args],{env,signal,encoding:'buffer',maxBuffer:maxBytes+2048,timeout:5000,windowsHide:true});
    return stdout;
  };
  const base=await realpath(scratch);
  const head=async()=>(await git(['rev-parse','--verify','HEAD^{commit}'])).toString('ascii').trim();
  const commit=await head();
  let total=0;
  for(const [name,hash] of pins){
    signal?.throwIfAborted();
    if(await excludedByWorkspaceIgnore(root,name))throw new Error('Pinned test fixture excluded by .forgelensignore: '+name);
    const entry=(await git(['ls-tree','-l','-z',commit,'--',name])).toString('utf8');
    const match=/^100(?:644|755) blob ([a-f0-9]+)\s+(\d+)\t([^\0]+)\0$/.exec(entry);
    if(!match || match[1]!==hash || match[3]!==name)throw new Error('Pinned test fixture does not match the regular file at Git HEAD: '+name);
    const size=Number(match[2]);total+=size;
    if(size>maxBytes || total>256*1024)throw new Error('Pinned test fixtures exceed the 64 KiB per-file or 256 KiB total limit.');
    const bytes=await git(['cat-file','blob',hash]);
    const digest=createHash(hash.length===40?'sha1':'sha256').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
    if(bytes.length!==size || bytes.includes(0) || digest!==hash)throw new Error('Git test fixture contents did not match the approved text blob.');
    let parent=base;
    for(const part of name.split('/').slice(0,-1)){
      parent=path.join(parent,part);
      try {await mkdir(parent);} catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
      const info=await lstat(parent);
      if(info.isSymbolicLink() || !info.isDirectory() || path.relative(parent,await realpath(parent))!=='')throw new Error('Unsafe test fixture destination.');
    }
    signal?.throwIfAborted();
    if(await excludedByWorkspaceIgnore(root,name))throw new Error('Pinned test fixture excluded by .forgelensignore: '+name);
    await writeFile(path.join(parent,path.posix.basename(name)),bytes,{flag:'wx',mode:0o600,signal});
  }
  if(await head()!==commit)throw new Error('Git HEAD changed during candidate fixture preparation.');
}
