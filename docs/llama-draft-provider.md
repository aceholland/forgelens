# Draft from context with a local llama.cpp model

Some local models answer an edit request in prose. If you want the model’s first action in **Draft from context** to be a reviewable proposal, run the optional provider adapter on the same machine as TrueForge and llama.cpp. It uses the model’s native tool selection. The model generates every path and replacement, TrueForge dispatches the call, and ForgeLens shows the proposed changes for review.

Use a locally installed llama.cpp server, a tool-capable GGUF model and Node.js 22.14 or newer. In one terminal, start the model. Replace `your-model.gguf` with its local path.

```sh
llama-server -m your-model.gguf --alias local-draft --host 127.0.0.1 --port 18931 --jinja
```

From a ForgeLens source checkout, start the adapter in a second terminal. The first port accepts TrueForge requests and the second points to llama.cpp.

```sh
node scripts/llama-draft-adapter.mjs 18932 18931
```

Configure a custom OpenAI-compatible provider in TrueForge with base URL `http://127.0.0.1:18932/v1` and model ID `local-draft`. If the provider form asks for a key, use a local placeholder. Select that model in ForgeLens, then choose **Draft from context**. Keep both terminals running during the session. The adapter binds to IPv4 loopback and addresses only the specified loopback model port.

### When the adapter requests a tool call

Selecting this provider opts into a first-inference rule. It recognizes the trusted ForgeLens draft instruction, user input without any assistant or tool history, and the existing `propose_changes` function schema. The only other advertised function it accepts for this rule is TrueForge’s `get_current_datetime`. If tool choice is absent or `auto`, the adapter sends the original proposal schema alone and requests `tool_choice: "required"`. The b12613 server reads tool choice as a string. With one function available, that function is the required choice. [llama.cpp b12613 request parser](https://github.com/ggml-org/llama.cpp/blob/b12613/tools/server/server-common.cpp#L1396-L1400)

Ordinary Agent requests, later inferences, and calls with an explicit `none`, `required` or named selection retain their original payloads. The adapter passes the model’s response stream and HTTP errors through to TrueForge. Disconnecting a client closes the upstream inference connection. Its process log contains a request number and whether the rule applied. Source text, credentials and model output stay out of that log. A model can still generate edits that fail review or tests. [Adapter](../scripts/llama-draft-adapter.mjs) · [HTTP and cancellation tests](../test/llama-draft-adapter.test.ts)

### Generate the first proposal as structured JSON

For a local model that supports llama.cpp’s JSON Schema output, start this adapter on the same two ports in the second terminal. Use one adapter per listening port.

```sh
node scripts/llama-schema-draft.mjs 18932 18931
```

On the first **Draft from context** generation, llama.cpp receives the original messages and the edit tool’s schema. The model writes the file paths, reasons and edits. The adapter passes its generated JSON to TrueForge as the proposal arguments. A completed proposal produces a SHA-256 receipt. Later generations receive the real review decisions and pytest output. This setup uses local CPU inference and needs no model API account. [Schema adapter](../scripts/llama-schema-draft.mjs)

For a smaller model, enable **ForgeLens › Sequential Draft** before choosing **Draft from context**. The first model call plans the files and proposes a change to the first one. After each approval the model moves to the next planned file in the same turn. Tests run on the assembled changes. A bad anchor in a later file leaves earlier accepted edits available for review. If the model stops with unfinished files, the panel reports the incomplete draft. [Review and validation checks](../test/sequential-draft.test.ts)

To repeat a recorded editor benchmark on a public fork, open **Actions → Task B live model → Run workflow** and choose a model ending in `-desktop`. The standard Linux runner downloads checked model weights, installs the extension in desktop VS Code, submits the request once and retains the screen capture, saved patch and test receipts. The job checks that the saved files match the model’s reviewed edits. [Workflow](../.github/workflows/task-b-model.yml) · [Desktop setup and grader](../checks/run-task-b-desktop-ci.sh)
