# Windows Task B attempts on 22 November 2026

The final Baidu ERNIE 5.5 Flash Preview take completed the original request in one native turn. All 59 CLI tests, all 491 Flask tests and the 16 secret-masking cases passed. [Recorded run, patch and verification](../task-b-editor-one-go/README.md)

Each submitted trial started in a separate Windows VS Code profile and a fresh checkout of the same Flask revision. The driver entered the original request once. It could approve review and test dialogs. A clarification ended a trial without an answer. The independent grader also checks mixed-case keys, ordinary values, the documentation and whether the new tests fail against unchanged Flask. [Desktop driver](../../../checks/task-b-desktop-run.cjs) · [Independent checks](../../../checks/run-task-b-verification.py)

| Free model and mode | What happened |
| --- | --- |
| OVHcloud DeepSeek V4.1 Flash, Draft | The first inference request received HTTP 429 with a long quota hold. No files reached review. |
| Kilo Flint, Draft, 6,000-token output limit | The model sent two proposals with unknown edit fields. Neither passed validation. A subsequent generation reached its output limit. |
| Kilo Flint, Run agent, questions enabled | The model asked where the implementation and tests should live. The run stopped without an answer. |
| Kilo Flint, Draft, strict edit schema, 24,576-token limit | Three proposals named the source, tests and docs. The model tried to append to documentation whose end was outside the selected excerpts. The editor rejected the batches. The final generation reached its output limit. |
| Kilo Baidu ERNIE 5.5 Flash Preview, Draft | Six hunks across three files passed staged review. The CLI suite passed 60 tests. The next model call received HTTP 429. The accepted three-file candidate independently passed 492 Flask tests and failed mixed-case masking. The desktop driver also captured only two of the three files on disk when it graded this attempt. |
| Kilo Flint, Run agent, questions disabled | The agent used discovery tools without asking a question. No edit reached review. The native turn ended with an error, and the editor closed when Windows entered standby. |
| Kilo NVIDIA Nemotron 3 Ultra, Draft | The model inserted a new function inside an existing command. Pytest exposed four regressions. The agent attempted repairs in the original turn, but the last staged CLI checks still had four failures. The editor closed at the same standby event. |
| Kilo NVIDIA Nemotron 3.5 Super VL, compact Run agent | The agent used 21 reads and nine searches, then sent the file list as a quoted string in two proposals. Neither reached hunk review. The provider eventually returned HTTP 429. |
| Google Gemma 4 31B, Draft | The provider returned HTTP 503 and the automatic retry timed out before a model edit arrived. |
| Google Gemma 4 26B A4B and Kilo NVIDIA Nemotron 3 Ultra, medium effort | These ran in separate Windows profiles. Neither produced a saved candidate before the machine entered standby. |
| Local Qwen3.5-4B, structured Draft | On the laptop CPU, the model generated 4,230 tokens before reaching the 30-minute generation limit. It had not sent a complete proposal, so no files reached review. |
| Google Gemma 4 31B, longer provider timeout | The model produced and revised all three files. The saved command passed help, all 16 masks, ordinary values, Flask defaults and docs checks. Its new test expected a key containing `KEY` to remain visible. That assertion failed in both the CLI suite (58 passed, one failed) and the full suite (490 passed, one failed). The next model call reached the provider’s 16,000-input-tokens-per-minute free limit. |
| Google Gemma 4, paced Draft | A 31B take was interrupted by Windows standby before review. Later 31B and 26B takes returned provider high-demand errors before staging a file. |
| Kilo Baidu ERNIE 5.5 Flash Preview, paced Draft | After the gateway’s quota window reopened, one request led to one three-file proposal. All six hunks were accepted, the reviewed bytes matched the saved files and the native turn finished. Two early HTTP 429 responses were retried automatically. The provider reported $0 for the two completed generations. [Full result](../task-b-editor-one-go/README.md) |

These runs led to stricter edit schemas, a real file-ending excerpt for each draft target where the budget permits, and a setting to run the full agent without clarification questions. After a failed staged test, Draft can also show the model the actual reviewed source around an edit or traceback. The recording driver now verifies each saved file byte for byte before grading it. Each change applies to ordinary project files.

## Installed VS Code on the public Linux runner

The local Qwen2.5-Coder-14B model proposed three files. The accepted implementation produced a Python syntax error. Ornith 1.5 9B proposed one implementation file and inserted a new declaration between two statements inside an existing method. Both editor subscriptions ended before returning a terminal event. These runs motivated checking the original turn after a lost subscription and giving smaller models a one-file-per-call review option. [Qwen recording job](https://github.com/aceholland/forgelens/actions/runs/45018220809) · [Ornith recording job](https://github.com/aceholland/forgelens/actions/runs/45018279145)
