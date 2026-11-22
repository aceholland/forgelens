import { decideHunk, renderProposal, type FileProposal, type ReviewHunk } from './review';

export type Decision = 'accepted' | 'rejected';
export function batchForReview(files:unknown) {
  if (!Array.isArray(files) || files.length<1 || files.length>12 ||
      files.some(file=>!file || typeof file!=='object' || Array.isArray(file))) {
    return {allowed:false as const,reason:'The files field requires a JSON array of 1–12 file objects. Resend the same edits as objects directly in that array. A quoted string containing JSON cannot be reviewed.'};
  }
  return {files};
}
/** Pytest may see only completed live reviews, including just the accepted side of a mixed decision. */
export function reviewedCandidate(files: FileProposal[], liveMode: boolean, hasLiveProposal: boolean) {
  if (!liveMode || hasLiveProposal || files.some(file => file.hunks.some(hunk => hunk.status === 'pending'))) {
    throw new Error('Finish live hunk review before running candidate tests. With deferred review, apply and save your decisions and choose Verify saved changes.');
  }
  return files.map(file => ({path: file.path, original: file.original, content: renderProposal(file), isNew: file.kind === 'create'}))
    .filter(file => file.content !== file.original);
}

export interface LiveRequest {
  proposal: FileProposal;
  result: Promise<FileProposal>;
  finish(proposal: FileProposal): void;
  fail(error: Error): void;
}

/** Each MCP call waits only for decisions on its own immutable input delta. */
export class LiveReviews {
  private readonly requests = new Map<string, LiveRequest>();

  begin(proposal: FileProposal): LiveRequest {
    if (this.requests.has(proposal.path)) throw new Error('Another proposal for this file is under review. Read the accepted staged text and retry.');
    let finish!: LiveRequest['finish'], fail!: LiveRequest['fail'];
    const result = new Promise<FileProposal>((resolve, reject) => { finish = resolve; fail = reject; });
    const request = { proposal, result, finish, fail };
    this.requests.set(proposal.path, request);
    return request;
  }

  get(path: string) { return this.requests.get(path); }
  list() { return [...this.requests.values()].map(request => request.proposal); }
  decide(request: LiveRequest, id: string | undefined, decision: Decision) {
    if (this.get(request.proposal.path) !== request) return;
    if (request.proposal.hunks.every(hunk => hunk.status !== 'pending')) return;
    request.proposal = id ? decideHunk(request.proposal, id, decision) : {
      ...request.proposal,
      hunks: request.proposal.hunks.map(hunk => hunk.status === 'pending' ? { ...hunk, status: decision } : hunk),
    };
    if (request.proposal.hunks.every(hunk => hunk.status !== 'pending')) request.finish(request.proposal);
  }
  end(request: LiveRequest) {
    if (this.get(request.proposal.path) === request) this.requests.delete(request.proposal.path);
  }
  cancel(reason: string) {
    for (const request of this.requests.values()) request.fail(new Error(reason));
    this.requests.clear();
  }
}

/** Offsets are in the immutable original. Each replacement moves subsequent lenses. */
export function lensOffsets(proposal: FileProposal, displayed: ReviewHunk[] = proposal.hunks) {
  let shift = 0;
  return displayed.map(hunk => {
    const offset = hunk.startOffset + shift;
    shift += hunk.after.length - hunk.before.length;
    return { id: hunk.id, offset };
  });
}

export function reviewFeedback(proposal: FileProposal) {
  return JSON.stringify({
    path: proposal.path,
    result: 'Human review complete; accepted changes are staged in memory. Read the staged file before further edits. Respect each rejection.',
    hunks: proposal.hunks.map(h => ({ id: h.id, decision: h.status,
      originalStart: h.startOffset, originalEndExclusive: h.endOffset })),
  });
}
