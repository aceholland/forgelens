export type DraftFile = {path:string; reason:string};

/** One model-authored plan per native turn. Review decisions always win. */
export class SequentialDraft {
  private plan: DraftFile[] = [];
  private cursor = 0;
  private failures = 0;
  private repairs = 0;
  private validationFailed = false;
  private validationPending = false;
  private tests?: string[];
  stopped?: string;

  begin(path:string, plan?:DraftFile[]): boolean {
    if (this.stopped) throw new Error(this.stopped);
    const first = this.plan.length === 0;
    if (first) {
      if (!plan?.length || plan[0]!.path !== path || new Set(plan.map(f=>f.path)).size !== plan.length)
        throw new Error('Supply an ordered plan with distinct paths and edit its first file.');
      this.plan = plan;
    } else if (plan && (plan.length !== this.plan.length || this.plan.some((f,i)=>f.path!==plan[i]!.path || f.reason!==plan[i]!.reason))) {
      throw new Error('The recorded plan is fixed. Omit plan on later calls.');
    }
    const next = this.plan[this.cursor];
    if (next ? next.path !== path : !this.validationFailed || !this.plan.some(f=>f.path===path))
      throw new Error(this.incomplete() ?? 'The plan is complete. Report the review and validation outcomes.');
    return first;
  }

  reviewed(path:string, proposed:string, overlay:string|undefined) {
    if (overlay !== proposed) {
      this.stopped = 'Review declined all or part of '+path+'. Accepted hunks remain staged. Do not propose that change again.';
      return;
    }
    this.failures = 0;
    if (this.plan[this.cursor]?.path === path) this.cursor++;
  }

  recordFailure() {
    if (++this.failures >= 3 && !this.stopped) this.stopped = 'Sequential draft stopped after three proposals without progress.';
  }

  requestTests(tests:string[] | undefined) {
    if (tests === undefined || this.tests?.length === 0) return;
    this.tests = tests.length ? [...new Set([...(this.tests??[]), ...tests])] : [];
    this.validationPending = true;
  }

  get finalTests() {
    return this.cursor === this.plan.length && !this.stopped ? this.tests : undefined;
  }

  validation(result:string) {
    this.validationPending = false;
    const exitCode = /^Candidate (?:pytest|node:test) exited (\d+);/.exec(result)?.[1];
    if (exitCode === undefined) {
      this.stopped = 'Candidate validation did not return a pytest exit code. The tests will not be requested again.';
      return;
    }
    this.validationFailed = exitCode !== '0';
    if (this.validationFailed && ++this.repairs >= 3) this.stopped = 'Sequential draft stopped after three unsuccessful validations.';
  }

  incomplete(): string | undefined {
    if (this.stopped) return this.stopped;
    if (!this.plan.length) return 'The model did not stage a file plan.';
    if (this.plan[this.cursor]) return 'Next planned file: '+this.plan[this.cursor]!.path;
    if (this.validationFailed) return 'Repair one planned file using the validation diagnostics; the same checks will run again.';
    if (this.validationPending) return 'The planned files have been reviewed; candidate validation is still pending.';
    return undefined;
  }
}
