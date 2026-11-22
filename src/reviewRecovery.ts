import {createHash} from 'node:crypto';
import {isSafeContextPath} from './context';
import {createProposal, renderProposal, type FileProposal, type HunkDecision} from './review';

interface SavedFile {
  path: string; original: string; proposed: string; originalHash: string;
  decisions: HunkDecision[]; kind?: 'create';
}
export interface ReviewCheckpoint {schema: 1; staged: SavedFile[]; live: SavedFile[]}
const hash=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');

export function saveReview(staged: FileProposal[], live: FileProposal[]): ReviewCheckpoint {
  function save(file:FileProposal):SavedFile {
    return {path:file.path,original:file.original,proposed:file.proposed,originalHash:hash(file.original),
      decisions:file.hunks.map(h=>h.status),...(file.kind?{kind:file.kind}:{})};
  }
  return {schema:1, staged:staged.map(save), live:live.map(save)};
}

/** Rebuild offsets from text, and verify every workspace base before activating any decision. */
export async function restoreReview(raw:unknown, read:(file:FileProposal)=>Promise<string>) {
  const data=raw as Partial<ReviewCheckpoint>|null;
  if(data?.schema!==1 || !Array.isArray(data.staged) || !Array.isArray(data.live)) throw Error('Unsupported saved review.');
  function decode(group:SavedFile[]) {
    const seen=new Set<string>();
    return group.map(file=>{
      if(!file || typeof file.path!=='string'||!isSafeContextPath(file.path)||seen.has(file.path) ||
        typeof file.original!=='string'||typeof file.proposed!=='string'||file.proposed.length>250000 ||
        file.original.includes('\0')||file.proposed.includes('\0')||hash(file.original)!==file.originalHash ||
        (file.kind!==undefined && file.kind!=='create') || !Array.isArray(file.decisions)) throw Error('Invalid saved review.');
      seen.add(file.path);
      const proposal=createProposal(file.path,file.original,file.proposed);
      if(proposal.hunks.length!==file.decisions.length || file.decisions.some(d=>!['accepted','rejected','pending'].includes(d))) throw Error('Invalid saved hunk decisions.');
      proposal.hunks.forEach((h,i)=>{h.status=file.decisions[i]!;});
      if(file.kind)proposal.kind=file.kind;
      return proposal;
    });
  }
  const staged=decode(data.staged), live=decode(data.live);
  const bases=new Map(staged.map(f=>[f.path,f]));
  for(const delta of live){
    const base=bases.get(delta.path);
    if(base && (base.kind!==delta.kind || renderProposal(base)!==delta.original))throw Error('Saved review layers do not match.');
    if(!base)bases.set(delta.path,delta);
  }
  const changed:string[]=[];
  for(const file of bases.values()){
    if(file.kind==='create' && file.original!=='')throw Error('Invalid base for a saved new file.');
    try {if(hash(await read(file))!==hash(file.original))changed.push(file.path);}
    catch{changed.push(file.path);}
  }
  if(changed.length)throw Error('Saved review retained. These files have changed or are unavailable: '+changed.join(', ')+'. Restore their original contents to resume, or discard the saved review.');
  return {staged,live};
}

type LocalState={get<T>(key:string):T|undefined;update(key:string,value:unknown):PromiseLike<void>};
type JournalEntry={checkpoint?:ReviewCheckpoint};
export class ReviewJournal {
  private readonly cached=new Map<string,JournalEntry|undefined>();
  private timer:Promise<void>=Promise.resolve();
  private previous?:{folder:string;staged:FileProposal[];live:FileProposal[]};
  constructor(private state:LocalState, private error:(e:unknown)=>void){}
  get(folder:string) {
    if(!this.cached.has(folder))this.cached.set(folder,this.state.get<JournalEntry>(this.key(folder)));
    return this.cached.get(folder);
  }
  private key(folder:string){return 'forgelens.reviewRecovery.1.'+folder;}
  private change(folder:string,value:JournalEntry|undefined){
    this.cached.set(folder,value);
    // Memento writes are ordered so Stop or Apply cannot resurrect an older queue.
    this.timer=this.timer.then(()=>this.state.update(this.key(folder),value)).catch(this.error);
  }
  flush(){return this.timer;}
  enable(folder:string,enabled:boolean){
    this.previous=undefined;
    this.change(folder,enabled?{}:undefined);
  }
  capture(folder:string,staged:FileProposal[],live:FileProposal[]){
    if(!this.get(folder))return;
    const last=this.previous, same=(a:FileProposal[],b:FileProposal[])=>a.length===b.length&&a.every((v,i)=>v===b[i]);
    if(last?.folder===folder && same(staged,last.staged)&&same(live,last.live))return;
    this.previous={folder,staged,live};
    if(staged.length||live.length)this.change(folder,{checkpoint:saveReview(staged,live)});
    else if(this.get(folder)?.checkpoint)this.change(folder,{});
  }
}
