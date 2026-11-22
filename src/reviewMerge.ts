import {createProposal, renderProposal, type FileProposal, type ReviewHunk} from './review';

export function prepareMerge(file:FileProposal, local:string, token:string) {
  if(file.hunks.some(h=>h.status==='pending'))throw Error('Finish the pending hunk decisions for this file before resolving its conflict.');
  const base=file.original, proposed=renderProposal(file);
  const newline=local.includes('\r\n')?'\r\n':base.includes('\r\n')?'\r\n':'\n';
  const markers=['<<<<<<< Workspace '+token,'||||||| Original '+token,'======= '+token,'>>>>>>> Proposed '+token];
  const changes=[
    ...createProposal(file.path,base,local).hunks.map(h=>({h,side:'local' as const})),
    ...createProposal(file.path,base,proposed).hunks.map(h=>({h,side:'proposed' as const})),
  ].sort((a,b)=>a.h.startOffset-b.h.startOffset || a.h.endOffset-b.h.endOffset);
  let merged='', offset=0, conflicts=0;
  for(let i=0;i<changes.length;){
    const start=changes[i]!.h.startOffset;
    const sides:{local:ReviewHunk[];proposed:ReviewHunk[]}={local:[],proposed:[]};
    let end=start;
    do {
      const {h,side}=changes[i++]!;
      sides[side].push(h);
      end=Math.max(end,h.endOffset);
    } while(i<changes.length && (changes[i]!.h.startOffset<end || changes[i]!.h.startOffset===start));
    const original=base.slice(start,end);
    function segment(hunks:ReviewHunk[]){
      let text=original;
      for(const h of [...hunks].reverse())text=text.slice(0,h.startOffset-start)+h.after+text.slice(h.endOffset-start);
      return text;
    }
    const ours=segment(sides.local), theirs=segment(sides.proposed);
    merged+=base.slice(offset,start);
    if(ours===theirs || theirs===original)merged+=ours;
    else if(ours===original)merged+=theirs;
    else {
      conflicts++;
      // Each marker starts on a separate line even if the source ended without a newline.
      const block=(s:string)=>s&&!s.endsWith('\n')?s+newline:s;
      merged=block(merged)+markers[0]+newline+block(ours)+markers[1]+newline+block(original)+markers[2]+newline+block(theirs)+markers[3]+newline;
    }
    offset=end;
  }
  merged+=base.slice(offset);
  return {base,local,proposed,merged,conflicts,markers};
}

export function resolveMerge(file:FileProposal, merge:ReturnType<typeof prepareMerge>, current:string, result:string) {
  if(current!==merge.local)throw Error('Workspace contents changed while resolving. Open the conflict again.');
  if(result.length>250000||result.includes('\0'))throw Error('Merged result must be bounded text.');
  if(result.split(/\r?\n/).some(line=>merge.markers.some(marker=>line.trim()===marker)))throw Error('Edit the highlighted conflict sections and remove their marker lines before staging the result.');
  const resolved=createProposal(file.path,current,result);
  for(const h of resolved.hunks)h.status='accepted';
  // An existing path, including one created independently during a new-file review, is always edited in-place.
  return resolved;
}
