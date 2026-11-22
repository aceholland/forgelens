# Task B on public CPU runners

Each job loaded an open-weight model and TrueForge on the same standard GitHub Actions Linux runner. ForgeLens received one original, path-free request against the pinned Flask checkout. The diagnostic allowed bounded edits into the review store and counted an edit only when the store received it. An independent checker evaluates any retained patch. The harness gave the model zero operator answers.

| Model and mode | Weight file | Elapsed | Workspace tool calls | Staged files | Observed outcome |
| --- | ---: | ---: | ---: | ---: | --- |
| GPT-OSS 20B, discovery tools | 12.11 GB | 9m 10s | 13 | 0 | Found the implementation, tests and guide. The run ended with a server error after repeated searches and reads. [Run](https://github.com/aceholland/forgelens/actions/runs/44999850567) |
| GPT-OSS 20B, compact context | 12.11 GB | 15m 01s | 0 | 0 | Streamed 2,815 updates before the model-call deadline. [Run](https://github.com/aceholland/forgelens/actions/runs/45000895044) |
| Qwen3-Coder 30B A3B, compact context | 12.85 GB | 15m 01s | 0 | 0 | The model-call deadline expired before a streamed update arrived. [Run](https://github.com/aceholland/forgelens/actions/runs/45001057328) |
| GPT-OSS 20B, draft from context | 12.11 GB | 16m 50s | 3 | 0 | The model made three native multi-file edit requests. All reached the workspace tool, and none produced a staged patch. The model finished within its revised deadline. [Run](https://github.com/aceholland/forgelens/actions/runs/45002825312) |
| Qwen2.5-Coder 7B, draft from context | 4.68 GB | 7m 05s | 0 | 0 | The provider reported 849 output tokens. The model returned text and issued zero native edit calls. [Run](https://github.com/aceholland/forgelens/actions/runs/45003204334) |
| Qwen2.5-Coder 7B, native edit tool required on first request | 4.68 GB | 27m 29s | 0 | 0 | The adapter confirmed one request with the required tool. The provider reported 4,096 output tokens. TrueForge received text and zero tool-call deltas, then recorded a server error. [Run](https://github.com/aceholland/forgelens/actions/runs/45004450903) |

Elapsed time starts when the diagnostic starts and excludes installing dependencies and downloading weights. For runs with provider token counts, GPT-OSS averaged 1.86 output tokens per elapsed second with discovery tools and 3.10 with draft mode. The 7B model averaged 2.00 with default tool selection and 2.48 with the first edit tool required. These rates include time spent in tools and waiting for the model. The two timed-out runs reported stream updates without final token counts.

The machine-readable record includes source and weight hashes, trace counts, exact elapsed times, artifact checksums and links. [Run records](runs.json). The independently graded Flash Lite candidate has its own patch and reproduction commands. [Historical Flask candidate](../task-b-flash-lite/README.md).

## Repeat the CPU check

On a public fork, open **Actions → Task B live model → Run workflow** and choose the model. The 7B option also offers **Request first draft tool**. That option asks the local inference server to call the advertised edit tool on the first draft request. The model supplies the edits, and ForgeLens checks the proposed files and anchors. The job records whether the inference server received this request. Leave the option clear to measure the model’s default tool selection.

Download the job artifact after it finishes. A staged patch gets a separate report from the independent Flask checker. Runs that stage no patch still retain their timing and tool counters.
