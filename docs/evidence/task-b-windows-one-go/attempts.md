# Windows Task B attempts on 22 November 2026

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

These runs led to stricter edit schemas, a real file-ending excerpt for each draft target where the budget permits, and a setting to run the full agent without clarification questions. After a failed staged test, Draft can also show the model the actual reviewed source around an edit or traceback. The recording driver now verifies each saved file byte for byte before grading it. Each change applies to ordinary project files.
