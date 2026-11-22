/** Resolve a proposal without writing. All exact matches refer to one immutable original. */
export function resolveAgentProposal(original:string,input:{content?:unknown;edits?:unknown}, insertionOffsets?:ReadonlyMap<number|'end',number>):string {
 if(input.content!==undefined || !Array.isArray(input.edits))throw new Error('Agent proposals require exact edits [{oldText,newText}], not full-file content. Use a unique anchor from the current file.');
 return resolveProposal(original,{edits:input.edits},insertionOffsets);
}

export function resolveProposal(original:string,input:{content?:unknown;edits?:unknown}, insertionOffsets?:ReadonlyMap<number|'end',number>):string {
 // Models commonly emit LF even when the editor uses CRLF. Adapt incoming
 // text only; original offsets and unrelated bytes must remain unchanged.
 const hasCRLF=original.includes('\r\n');
 const newline=hasCRLF
  ? /[\r\n]/.test(original.replace(/\r\n/g,'')) ? undefined : '\r\n'
  : original.includes('\r') ? undefined : '\n';
 const normalize=(text:string)=>newline===undefined?text:text.replace(/\r\n/g,'\n').replace(/\n/g,newline);
 if(typeof input.content==='string' && input.edits===undefined){
  const result=normalize(input.content);
  if(result.length>250000)throw new Error('Proposed file exceeds limit.');
  return result;
 }
 if(input.content!==undefined || !Array.isArray(input.edits) || !input.edits.length || input.edits.length>20)throw new Error('Provide content OR 1–20 exact edits, never both.');
 const ranges=input.edits.map((e:unknown)=>{
  if(!e||typeof e!=='object')throw new Error('Invalid exact edit');
  const {oldText,newText,beforeLine}=e as {oldText?:unknown;newText?:unknown;beforeLine?:unknown};
  if (beforeLine !== undefined) {
    if (!insertionOffsets || oldText !== undefined || typeof newText !== 'string' || !newText ||
        (typeof beforeLine !== 'number' && beforeLine !== 'end')) {
      throw new Error('A draft insertion requires beforeLine and nonempty newText only.');
    }
    const at = insertionOffsets.get(beforeLine);
    if (at === undefined) throw new Error('Choose a complete numbered line shown for this file, or a displayed end of file.');
    return {start: at, end: at, newText: normalize(newText)};
  }
  if(typeof oldText!=='string'||!oldText.length||typeof newText!=='string')throw new Error('Exact edit requires nonempty oldText and string newText.');
  const anchor=normalize(oldText);
  const start=original.indexOf(anchor);
  if(start<0||original.indexOf(anchor,start+1)>=0)throw new AnchorMismatch(anchor);
  return {start,end:start+anchor.length,newText:normalize(newText)};
 }).sort((a,b)=>a.start-b.start);
 for(let i=1;i<ranges.length;i++)if(ranges[i]!.start<ranges[i-1]!.end || ranges[i]!.start===ranges[i-1]!.start)throw new Error('Exact edits overlap.');
 let result=original;for(const r of ranges.reverse())result=result.slice(0,r.start)+r.newText+result.slice(r.end);
 if(result.length>250000)throw new Error('Proposed file exceeds limit.');return result;
}
export class AnchorMismatch extends Error {
 constructor(readonly anchor:string) {
  super('oldText must match exactly once. Read current file and include more surrounding context.');
 }
}
