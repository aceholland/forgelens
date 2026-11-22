import { lstat, readFile } from 'node:fs/promises';

export type TestRunner = 'pytest' | 'node:test';
type Outcome = 'passed' | 'failed' | 'skipped' | 'ambiguous';
export interface TestRun {
  exitCode: number;
  output: string;
  cases?: Map<string,Outcome>;
}
export interface TestComparison {
  runner: TestRunner;
  baselineExitCode: number | null;
  candidateExitCode: number;
  newlyFailing: string[];
  alreadyFailing: string[];
  nowPassing: string[];
  candidateOnlyFailures: string[];
  note?: string;
}

export async function readOutcomes(filename: string) {
  try {
    const info=await lstat(filename);
    if (!info.isFile() || info.size > 4*1024*1024) return;
    const rows=(await readFile(filename,'utf8')).trimEnd().split('\n');
    if (rows.pop() !== '"complete"') return;
    const cases=new Map<string,Outcome>();
    for (const line of rows) {
      const row=JSON.parse(line);
      if (!Array.isArray(row) || typeof row[0]!=='string' || !['passed','failed','skipped'].includes(row[1])) return;
      cases.set(row[0],cases.has(row[0]) ? 'ambiguous' : row[1]);
    }
    return cases;
  } catch { return; }
}

export function compareTestRuns(runner: TestRunner, baseline: TestRun | undefined, candidate: TestRun): TestComparison {
  const comparison:TestComparison={runner,baselineExitCode:baseline?.exitCode??null,candidateExitCode:candidate.exitCode,
    newlyFailing:[],alreadyFailing:[],nowPassing:[],candidateOnlyFailures:[]};
  if (!baseline) {
    comparison.note='The selected tests only exist in the candidate.';
    for(const [id,state] of candidate.cases ?? [])if(state==='failed')comparison.candidateOnlyFailures.push(id);
  }
  else if (!baseline.cases || !candidate.cases || baseline.exitCode>1 || candidate.exitCode>1 ||
    (baseline.exitCode!==0 && !baseline.cases.size) || (candidate.exitCode!==0 && !candidate.cases.size))
    comparison.note='A test run did not produce comparable, complete case results.';
  else {
    for(const [id,state] of candidate.cases) {
      const prior=baseline.cases.get(id);
      if (state==='failed' && prior==='passed') comparison.newlyFailing.push(id);
      if (state==='failed' && prior==='failed') comparison.alreadyFailing.push(id);
      if (state==='passed' && prior==='failed') comparison.nowPassing.push(id);
      if (state==='failed' && (!prior || prior==='skipped')) comparison.candidateOnlyFailures.push(id);
    }
    if ([...candidate.cases.values(),...baseline.cases.values()].includes('ambiguous'))
      comparison.note='Duplicate test identifiers are excluded from individual comparisons.';
  }
  return comparison;
}

export function describeComparison(report:TestComparison) {
  const lines=['Baseline exit '+(report.baselineExitCode??'unavailable')+' Â· Candidate exit '+report.candidateExitCode];
  if (report.note) lines.push(report.note);
  for (const [label, list] of [['Newly failing',report.newlyFailing],['Already failing',report.alreadyFailing],
    ['Now passing',report.nowPassing],['Failed only in candidate selection',report.candidateOnlyFailures]] as const) {
    if (list.length) lines.push(label+' ('+list.length+')\n'+list.slice(0,12).map(id=>'  '+id.slice(0,240)).join('\n'));
  }
  if (!report.note && !report.newlyFailing.length && !report.alreadyFailing.length && !report.nowPassing.length && !report.candidateOnlyFailures.length)
    lines.push('No comparable test changed between passing and failing.');
  return lines.join('\n');
}
