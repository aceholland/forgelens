import type { FileProposal } from './review';

interface FileCounts { path: string; accepted: number; rejected: number; pending: number }

/** Keep only the latest review counts per file, including files already applied or rejected. */
export class ReviewSummary {
  private files = new Map<string, FileCounts>();
  private latestTest?: { exitCode: number; completedAt: string; revision: number };
  revision = 0;

  get available() { return this.files.size > 0; }

  observe(file: FileProposal) {
    const counts = {path: file.path, accepted: 0, rejected: 0, pending: 0};
    for (const hunk of file.hunks) counts[hunk.status]++;
    this.files.set(file.path, counts);
    this.revision++;
  }

  recordTest(exitCode: number, testedRevision: number) {
    this.latestTest = {exitCode, completedAt: new Date().toISOString(), revision: testedRevision};
  }

  snapshot() {
    const test = this.latestTest;
    return {
      files: [...this.files.values()],
      latestStagedPytest: test ? {
        exitCode: test.exitCode,
        completedAt: test.completedAt,
        reviewChangedSinceTest: this.revision !== test.revision,
      } : null,
    };
  }
}

export function nextPendingHunk(files: FileProposal[], previous?: {path: string; id: string}) {
  const entries = files.flatMap(file => file.hunks.map(hunk => ({file, hunk})));
  const start = previous ? entries.findIndex(({file, hunk}) => file.path === previous.path && hunk.id === previous.id) + 1 : 0;
  for (let offset = 0; offset < entries.length; offset++) {
    const entry = entries[(start + offset) % entries.length]!;
    if (entry.hunk.status === 'pending') return entry;
  }
}
