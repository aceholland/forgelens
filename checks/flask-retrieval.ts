/** Replays the published held-out Flask commit IDs using Git parent trees and the shipping selector. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isSafeContextPath,parseMentions,selectContext,type ContextFile} from '../src/context';
import {bm25Scores} from '../src/retrievalIndex';
import {excerptTokenCount} from '../src/tokenBudget';

const checks=path.dirname(fileURLToPath(import.meta.url));
const repo=process.argv[2];
assert.ok(repo,'Run node --import tsx checks/flask-retrieval.ts PATH_TO_FULL_FLASK_CLONE');
const upstream='22d924701a6ae2e4cd01e9a15bbaf3946094af65';
const earlierUpstream='2f0c62f5e6e290843f03c1fa70817c7a3c7fd661';
const tokenBudget=10000;
const charBudget=24000;
const ids=readFileSync(path.join(checks,'flask-heldout-commits.txt'),'utf8').trim().split(/\r?\n/).filter(line=>line && !line.startsWith('#'));
assert.equal(new Set(ids).size,79);assert.ok(ids.every(id=>/^[0-9a-f]{8}$/.test(id)));

function git(args:string[],input?:string):Buffer {
  return execFileSync('git',['--no-replace-objects','-C',repo,...args],{input,windowsHide:true,maxBuffer:48*1024*1024});
}
function gitText(...args:string[]):string {return git(args).toString('utf8');}
const suffixes=new Set('py pyi md rst txt toml cfg ini ts js json yaml yml html jinja j2 css sh'.split(' '));
const indexable=(name:string)=>isSafeContextPath(name) && suffixes.has(path.posix.extname(name).slice(1).toLowerCase());
type Source=ContextFile & {oid:string};
const contents=new Map<string,string>();
const tokenCounts=new Map<string,number>();
function parentFiles(parent:string):Source[]{
  const entries=gitText('ls-tree','-r','-l','-z',parent).split('\0').flatMap(entry=>{
    const match=/^100(?:644|755) blob ([0-9a-f]{40})\s+(\d+)\t([\s\S]+)$/.exec(entry);
    return match && Number(match[2])<=1000000 && indexable(match[3]!)?[{oid:match[1]!,path:match[3]!}]:[];
  });
  const missing=[...new Set(entries.map(e=>e.oid).filter(id=>!contents.has(id)))];
  if(missing.length){
    const batch=git(['cat-file','--batch'],missing.join('\n')+'\n');
    let offset=0;
    for(const expected of missing){
      const end=batch.indexOf(10,offset);
      const [oid,type,length]=batch.toString('ascii',offset,end).split(' ');
      assert.equal(oid,expected);assert.equal(type,'blob');assert.ok(end>=offset);
      offset=end+1;
      contents.set(oid!,batch.toString('utf8',offset,offset+Number(length)));
      offset+=Number(length)+1;
    }
    assert.equal(offset,batch.length);
  }
  return entries.flatMap(e=>{
    const content=contents.get(e.oid)!;
    return content.length<=250000 && !content.includes('\0')?[{...e,content}]:[];
  });
}
function wholeFilePack(files:Source[],query:string){
  const words=[...new Set(query.toLowerCase().match(/[a-z0-9]+/g)??[])];
  const scores=bm25Scores(files.map(f=>({path:f.path,content:f.path+'\n'+f.content})),words);
  const ranked=files.map((file,i)=>({file,score:scores[i]!})).filter(f=>f.score>0 && f.file.content.length>0)
    .sort((a,b)=>b.score-a.score || (a.file.path<b.file.path?-1:1));
  const found:string[]=[];let tokens=0;
  for(const {file} of ranked){
    const cost=tokenCounts.get(file.oid)??excerptTokenCount(file.content);
    tokenCounts.set(file.oid,cost);
    if(tokens+cost<=tokenBudget){tokens+=cost;found.push(file.path);}
  }
  return {files:found,tokens};
}
function audit(targets:string[],pack:{files:string[];tokens:number}){
  const hits=targets.filter(file=>pack.files.includes(file)).length;
  assert.ok(pack.tokens<=tokenBudget);
  return {...pack,hits,all:hits===targets.length};
}
function selectorHash(){
  const hash=createHash('sha256');
  for(const file of ['context.ts','retrievalIndex.ts','tokenBudget.ts'])
    hash.update(readFileSync(path.join(checks,'../src',file),'utf8').replace(/\r\n/g,'\n'));
  return hash.digest('hex');
}
const digest=selectorHash(),start=performance.now();
function modified(parent:string,commit:string){
  return gitText('diff','--no-ext-diff','--no-renames','--diff-filter=M','--name-only','-z',parent,commit)
    .split('\0').filter(p=>p!=='CHANGES.rst' && indexable(p)).sort();
}
function independentIds(){
  const metadata=gitText('log','--no-merges','--format=%H%x09%ct%x09%s',earlierUpstream).trim().split('\n').sort();
  const selected:string[]=[];
  for(const row of metadata){
    const [commit,stamp,...subjectParts]=row.split('\t');
    const date=Number(stamp)*1000,subject=subjectParts.join('\t');
    if(date<Date.UTC(2019,0,1) || date>=Date.UTC(2021,0,1) || subject.length<20 ||
      /^(?:Merge|Bump|Release|\[pre-commit|update requirements)/i.test(subject))continue;
    const targets=modified(commit+'^',commit!);
    if(targets.length<2 || targets.length>8)continue;
    const eligible=new Set(parentFiles(commit+'^').map(file=>file.path));
    if(!targets.every(p=>eligible.has(p)))continue;
    selected.push(commit!);
    if(selected.length===40)break;
  }
  assert.equal(selected.length,40);
  return selected;
}
function replay(commits:string[],label:string,tip:string){
  const ancestry=new Set(gitText('rev-list',tip).trim().split('\n'));
  return commits.map((shortId,i)=>{
    const [commit,parent,subject,...body]=gitText('show','-s','--format=%H%n%P%n%s%n%b',shortId).trimEnd().split('\n');
    assert.ok(ancestry.has(commit!) && /^[0-9a-f]{40}$/.test(parent!),'Expected one upstream parent');
    const query=(subject+'\n'+body.join('\n')).slice(0,600);
    const files=parentFiles(parent!);
    // Both methods receive only immutable parent blobs and the message. Read labels afterwards.
    const selected=selectContext(files,query,charBudget,undefined,tokenBudget);
    const pack=(selection:typeof selected)=>({files:selection.items.map(item=>item.path),tokens:selection.usedTokens});
    const excerptPack=pack(selected);
    const mentions=parseMentions(query);
    const four=mentions.files.length || mentions.symbols.length?selected:selectContext(files,query,charBudget,{maxFiles:4,maxLines:Infinity},tokenBudget);
    assert.equal(excerptPack.tokens,selected.items.reduce((n,item)=>n+excerptTokenCount(item.content),0));
    const baseline=wholeFilePack(files,query);
    const eligible=new Set(files.map(f=>f.path));
    const targets=modified(parent!,commit!).filter(p=>eligible.has(p));
    assert.ok(targets.length>=2 && targets.length<=8,'Unexpected target count for '+shortId);
    if((i+1)%10===0)console.error(label+': '+(i+1)+'/'+commits.length);
    return {commit:commit!,parent:parent!,targets,forgelens:audit(targets,excerptPack),previousFour:audit(targets,pack(four)),wholeFileBm25:audit(targets,baseline)};
  });
}
type Cases=ReturnType<typeof replay>;
function summary(cases:Cases,method:'forgelens'|'previousFour'|'wholeFileBm25'){
  return {
    all:cases.filter(c=>c[method].all).length,
    meanRecall:cases.reduce((n,c)=>n+c[method].hits/c.targets.length,0)/cases.length,
    meanFiles:cases.reduce((n,c)=>n+c[method].files.length,0)/cases.length,
    meanTokens:cases.reduce((n,c)=>n+c[method].tokens,0)/cases.length
  };
}
function report(cases:Cases){
  const differences=cases.map(c=>Number(c.forgelens.all)-Number(c.wholeFileBm25.all));
  let state=7;
  function draw(){state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;}
  const estimates=Array.from({length:10000},()=>{
    let delta=0;
    for(let i=0;i<cases.length;i++)delta+=differences[Math.floor(draw()*cases.length)]!;
    return delta/cases.length;
  }).sort((a,b)=>a-b);
  const metrics={n:cases.length,forgelens:summary(cases,'forgelens'),previousFour:summary(cases,'previousFour'),wholeFileBm25:summary(cases,'wholeFileBm25'),
    forgelensOnly:differences.filter(d=>d===1).length,baselineOnly:differences.filter(d=>d===-1).length,
    pairedDifference:differences.reduce((sum,d)=>sum+d,0)/cases.length,bootstrap95:[estimates[249],estimates[9749]]};
  return {metrics,cases};
}
const published=report(replay(ids,'published',upstream));
const independent=report(replay(independentIds(),'independent',earlierUpstream));
assert.ok(independent.cases.every(a=>!published.cases.some(b=>a.commit===b.commit)));
assert.equal(selectorHash(),digest,'Selector source changed during replay. Run the experiment again.');
const elapsedSeconds=Number(((performance.now()-start)/1000).toFixed(2));
const output={upstream,earlierUpstream,tokenBudget,charBudget,encoding:'o200k_base',selectorSha256:digest,elapsedSeconds,
  node:process.version,platform:process.platform+'-'+process.arch,published,independent};
writeFileSync(path.join(checks,'../docs/flask-retrieval-results.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({published:published.metrics,independent:independent.metrics,elapsedSeconds,selectorSha256:digest},null,2));
