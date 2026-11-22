# How often does context include the files a change needs?

This backtest measures file coverage on historical Flask changes. Each query consists of the commit subject and body, limited to 600 characters. The selector receives only that query and source files from the preceding commit. A result counts as complete when the excerpts include every eligible file the change modified.

**On the independent 40-change sample, ForgeLens returned every target file for 16 changes. Whole-file BM25 did so for three.** Across all 40 queries, ForgeLens retrieved 61.7% of the target files on average, using 5,016 source tokens per request.

| Sample | Method | Complete changes | Mean share of target files found | Mean files returned | Mean source tokens |
| --- | --- | ---: | ---: | ---: | ---: |
| Independent, 2019–2020 | ForgeLens | 16/40 (40.0%) | 61.7% | 15.2 | 5,016 |
| Independent, 2019–2020 | Earlier four-window policy | 8/40 (20.0%) | 39.1% | 4.0 | 4,485 |
| Independent, 2019–2020 | Whole-file BM25 | 3/40 (7.5%) | 35.2% | 10.2 | 9,974 |
| Published, 2023–2026 | ForgeLens | 25/79 (31.6%) | 54.2% | 15.5 | 5,203 |
| Published, 2023–2026 | Earlier four-window policy | 11/79 (13.9%) | 33.3% | 4.0 | 4,212 |
| Published, 2023–2026 | Whole-file BM25 | 11/79 (13.9%) | 38.5% | 10.6 | 9,897 |

On the independent sample, only ForgeLens found every target in 14 cases, and only whole-file BM25 did so in one. The paired difference was +32.5 percentage points, with a 95% bootstrap interval from +17.5 to +50.0 points. On the published sample, the difference was +17.7 points, with an interval from +7.6 to +29.1 points. The broader packing rule was chosen after observing the earlier score on that published sample.

Two independent cases illustrate the tradeoff. ForgeLens included both the session implementation and request-context tests in a change that whole-file BM25 missed. Whole-file BM25 included all three documentation files in an error-handling change that ForgeLens missed. [Session change](https://github.com/pallets/flask/commit/0c0b31a789f8bfeadcbcf49d1fb38a00624b3065) · [Documentation change](https://github.com/pallets/flask/commit/59b0b85835fa925e67f9a3f5173f7d6b6e67a411)

## How to reproduce

From the ForgeLens repository, run the following with Node 22, Git and a full clone of Flask. The program reads Git objects directly, so the Flask checkout may stay on any branch.

```sh
npm ci
git clone https://github.com/pallets/flask.git ../flask-history
node --import tsx checks/flask-retrieval.ts ../flask-history
```

The replay took 127.03 seconds on Windows x64 with Node 22.18.0. Its output includes full commit and parent IDs, target paths, selected paths, hits and source-token counts for each method, plus a digest of the selector source. [Replay script](../checks/flask-retrieval.ts) · [Per-commit results](flask-retrieval-results.json)

## Samples and scoring

- **Published sample.** The 79 commit IDs come from Countersign's public test rows for Flask 3.1.3. ForgeLens initially returned up to four automatic excerpts. It found every edited file on 11/79 changes, tied with our whole-file BM25 baseline. We chose the broader packing rule after seeing that result. The revised score on those 79 is a retrospective measurement. [Flask 3.1.3](https://github.com/pallets/flask/tree/22d924701a6ae2e4cd01e9a15bbaf3946094af65) · [Original sample and MIT notice](../checks/flask-heldout-commits.txt) · [Countersign's evaluation plan](https://github.com/kinnuworks/countersign/blob/40ba3492ac818d5a728866476e12122cc8dcebd6/evidence/EVAL_PLAN.md)
- **Independent sample.** We fixed the broader rule before scoring 40 earlier changes. The runner takes single-parent commits reachable from Flask 2.0.0 with UTC committer dates in 2019–2020, sorts their full Git IDs, and takes the first 40 qualifying cases. Each subject has at least 20 characters and avoids release, merge, dependency-bump and pre-commit prefixes. Each change modifies two to eight eligible existing text files. The script checks that the samples are disjoint. [Pinned Flask 2.0.0 source](https://github.com/pallets/flask/tree/2f0c62f5e6e290843f03c1fa70817c7a3c7fd661)
- **Ground truth.** Targets are modified regular text files already present at the parent commit. Both methods use the same source, configuration, documentation, markup and script file extensions. The changelog remains searchable and is excluded from targets. New files, deleted files, symlinks, protected paths, binary files and oversized files are outside this evaluation. We derived all 275 targets in the published sample directly from Flask's Git objects, then checked that every record matched the published target paths. [Published comparison rows](https://github.com/kinnuworks/countersign/blob/40ba3492ac818d5a728866476e12122cc8dcebd6/evidence/results/replay.csv)
- **Methods.** ForgeLens uses the shipping selector, including lexical BM25, path and symbol matches, import neighbours, diversity across top-level directories and anchored excerpts. At the default 24,000-character and 10,000-token limits, an automatic query can return up to 16 windows. It budgets one window per 1,500 characters and 600 tokens, bounded between four and sixteen. Explicit mentions and the discovery tool have separate allocation rules. The comparison also scores the previous four-window policy on the same parent blobs.
- **Baseline.** Whole-file BM25 scores path and content using the same BM25 implementation. It adds complete files in rank order and skips any file too large for the remaining budget. Both methods have the same 10,000-token ceiling for source text, measured with the actual `o200k_base` tokenizer. Only ForgeLens additionally enforces its editor character cap. Tool schemas, metadata and model responses fall outside these counts.
- **Uncertainty.** Intervals for complete-coverage differences use 10,000 paired bootstrap samples with replacement and seed 7. A commit is the resampling unit. Related commits in the same project can be correlated. Commit messages can also name changed identifiers. File coverage alone does not establish that an excerpt contains enough code to implement the change or that a model would complete it.

Countersign reports 21/79 complete changes using its own estimated token counts and packing implementation. The shared commit list permits case-by-case inspection. A direct comparison of the two products would require running both through the same tokenizer and file-selection protocol. [Countersign's published evidence](https://github.com/kinnuworks/countersign/tree/40ba3492ac818d5a728866476e12122cc8dcebd6#evidence)
