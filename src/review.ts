import { diffLines } from 'diff';

export type HunkDecision = 'pending' | 'accepted' | 'rejected';
export interface ReviewHunk {
  id: string;
  startOffset: number;
  endOffset: number;
  before: string;
  after: string;
  status: HunkDecision;
}
export interface FileProposal { path: string; original: string; proposed: string; hunks: ReviewHunk[] }
export interface AppliedEdit { path: string; before: string; after: string }

/** Pure staging: all offsets address the immutable original, never the filesystem. */
export function createProposal(path: string, original: string, proposed: string): FileProposal {
  const hunks: ReviewHunk[] = [];
  let offset = 0;
  let pending: ReviewHunk | undefined;
  const flush = () => { if (pending) hunks.push(pending); pending = undefined; };
  for (const part of diffLines(original, proposed)) {
    if (!part.added && !part.removed) { flush(); offset += part.value.length; continue; }
    pending ??= { id: `hunk-${hunks.length + 1}`, startOffset: offset, endOffset: offset, before: '', after: '', status: 'pending' };
    if (part.removed) {
      pending.before += part.value;
      offset += part.value.length;
      pending.endOffset = offset;
    } else pending.after += part.value;
  }
  flush();
  return { path, original, proposed, hunks };
}

export function decideHunk(proposal: FileProposal, id: string, status: Exclude<HunkDecision, 'pending'>): FileProposal {
  if (!proposal.hunks.some(h => h.id === id)) throw new Error(`Unknown hunk: ${id}`);
  return { ...proposal, hunks: proposal.hunks.map(h => h.id === id ? { ...h, status } : { ...h }) };
}

/** 'all' previews the full suggestion; 'accepted' materializes only reviewed hunks. */
export function renderProposal(proposal: FileProposal, mode: 'accepted' | 'all' = 'accepted'): string {
  let text = proposal.original;
  for (const hunk of [...proposal.hunks].reverse()) {
    if (mode === 'all' || hunk.status === 'accepted') {
      text = text.slice(0, hunk.startOffset) + hunk.after + text.slice(hunk.endOffset);
    }
  }
  return text;
}

export function prepareApply(proposal: FileProposal, current: string): AppliedEdit {
  if (current !== proposal.original) throw new Error('File changed since review began. Refresh the proposal before applying.');
  return { path: proposal.path, before: current, after: renderProposal(proposal) };
}

export function undoEdit(edit: AppliedEdit, current: string): string {
  if (current !== edit.after) throw new Error('File changed after applying. Use editor undo or resolve the conflict manually.');
  return edit.before;
}

/** Caller applies returned text through VS Code WorkspaceEdit, then calls remove. */
export class ReviewStore {
  private readonly proposals = new Map<string, FileProposal>();
  stage(path: string, original: string, proposed: string): FileProposal {
    if (this.proposals.has(path)) throw new Error(`A proposal is already staged for ${path}. Review it first.`);
    const proposal = createProposal(path, original, proposed);
    this.proposals.set(path, proposal);
    return proposal;
  }
  revise(path: string, current: string, proposed: string): FileProposal {
    const previous=this.require(path);
    if(previous.original!==current)throw new Error('File changed since staging.');
    if(previous.hunks.some(h=>h.status!=='pending'))throw new Error('Cannot revise after hunk review.');
    const next=createProposal(path,previous.original,proposed);this.proposals.set(path,next);return next;
  }
  get(path: string): FileProposal | undefined { return this.proposals.get(path); }
  list(): FileProposal[] { return [...this.proposals.values()]; }
  decide(path: string, id: string, decision: 'accepted' | 'rejected'): FileProposal {
    const proposal = this.require(path);
    const result = decideHunk(proposal, id, decision);
    this.proposals.set(path, result);
    return result;
  }
  prepare(path: string, current: string): AppliedEdit { return prepareApply(this.require(path), current); }
  remove(path: string): void { this.proposals.delete(path); }
  /** Pure convenience for consumers that own the persistence transaction. */
  apply(path: string, current: string): AppliedEdit {
    const result = this.prepare(path, current);
    this.remove(path);
    return result;
  }
  discardPending(): void { this.proposals.clear(); }
  cancel(): void { this.discardPending(); }
  private require(path: string): FileProposal {
    const proposal = this.get(path);
    if (!proposal) throw new Error(`Unknown proposal: ${path}`);
    return proposal;
  }
}

/** Exact scope check: line-based diff hunks can include an unchanged boundary newline. */
export function isWithinSelection(original:string,proposed:string,start:number,end:number):boolean {
 if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>original.length)return false;
 const prefix=original.slice(0,start),suffix=original.slice(end);
 return proposed.length>=prefix.length+suffix.length && proposed.startsWith(prefix) && proposed.endsWith(suffix);
}
