import {readFile,readdir,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
const sections=[],missing=[];
for(const location of Object.keys(lock.packages).filter(p=>p.startsWith('node_modules/')&&!lock.packages[p].dev).sort()){
 const dir=path.resolve(root,location);
 if(!dir.startsWith(path.join(root,'node_modules')+path.sep))throw new Error('Dependency escaped node_modules');
 let pkg;
 try{pkg=JSON.parse(await readFile(path.join(dir,'package.json'),'utf8'));}
 catch(error){if(error.code==='ENOENT'&&lock.packages[location].optional)continue;throw error;}
 const files=[];
 for(const name of await readdir(dir)){
  if(!/^(licen[sc]e|copying|notice)([.\-_]|$)/i.test(name))continue;
  const target=path.join(dir,name);
  if((await stat(target)).isFile())files.push(name);
 }
 if(!files.length){missing.push(`${pkg.name}@${pkg.version}`);continue;}
 const texts=await Promise.all(files.sort().map(async name=>`### ${name}\n\n${(await readFile(path.join(dir,name),'utf8')).replace(/\r\n/g,'\n').split('\n').map(line=>line.trimEnd()).join('\n').trim()}`));
 sections.push(`## ${pkg.name} ${pkg.version}\n\n${texts.join('\n\n')}`);
}
if(missing.length)throw new Error(`License text not found: ${missing.join(', ')}`);
await writeFile(path.join(root,'THIRD_PARTY_NOTICES.md'),`# Third-party notices\n\nDependency distributions retain their respective licenses. Generated from the installed lockfile for runtime dependencies. Development tools retain their licenses in their npm distributions.\n\n${sections.join('\n\n')}\n`,'utf8');
console.log(`Recorded license/notice text for ${sections.length} installed dependency entries.`);
