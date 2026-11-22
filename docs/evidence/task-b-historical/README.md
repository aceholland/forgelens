# Historical Task B proposals from a single request

Eleven distinct ForgeLens sessions from 20 November 2026 staged changes after the original path-free Task B request, without a clarification or a follow-up. Nine ran through the headless Windows diagnostic and two ran in Windows VS Code. **None passed every grading check.** These sessions predate ForgeLens 0.3.0. The archive does not identify the exact ForgeLens commit used to generate each patch. [Results for all eleven sessions](results.json)

| Original model proposals | Independent result on Flask 3.1.3 |
| --- | --- |
| Seven headless proposals | Pytest could not collect the candidate tests. CLI and full-suite runs exited with code 4. |
| One headless proposal | The command masked all 16 synthetic keys. The full suite had 13 failures, 477 passes and one error. The CLI documentation was missing. |
| One headless proposal | All 59 CLI tests and all 491 Flask tests passed. The command masked all 16 keys and preserved ordinary values. The proposal omitted the CLI documentation and moved three existing route tests into a different test class, changing their pytest node IDs. |
| Two editor proposals | Each passed 58 CLI tests and failed its new test. In each full-suite run, 490 passed and one failed. One of these proposals also missed the mixed-case masking check. |

The two-file proposal that passed pytest came from Gemini 3.5 Flash Lite. Its patch retains the original implementation and test changes. The checked-in patch’s Git blob IDs match the archived proposal contents after conversion to Flask’s LF line endings. [Original partial patch](partial-candidate.patch) · [Grader output](partial-verification.json)

## How the sessions were identified

For each distinct archived proposal, we matched its session ID to the local TrueForge session and event records. Each of these eleven sessions contained one turn with one user message. Its UTF-8 bytes matched the original 296-byte task request. Each session had zero initial context messages, zero clarification requests and zero operator answers. The MCP tool-response records confirmed successful staging for every file. The two editor candidates were reconstructed from successful original calls before human edits. The grading used the original proposals in disposable checkouts at Flask commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. The results file records session IDs, timestamps, archive hashes, paths, grader checks and exit codes. [Grader source](../../../checks/run-task-b-verification.py)

The original narrated editor demonstration includes subsequent human review and a follow-up. A separate archived four-file headless proposal passed the full grader after one procedural operator answer. Its record gives the exact answer and independent grading results. [Four-file run](../task-b-flash-lite/README.md)

## Reproduce the two-file result

Use a local clone containing the pinned Flask commit and the Python dependencies listed in the environment record. From the ForgeLens repository, run the following command with a fresh output directory. [Test environment](../task-b-flash-lite/README.md#reproduce-the-independent-check)

```sh
python checks/run-task-b-verification.py ../flask ../historical-partial-grade --patch docs/evidence/task-b-historical/partial-candidate.patch
```

The expected exit code is 1. The JSON report flags the missing documentation and the change to existing test IDs. Its list of added nodes includes the three route tests now collected under `TestConfig`.
