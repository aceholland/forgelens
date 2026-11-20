# ForgeLens

A from-scratch VS Code extension for the TrueFoundry Forge-a-thon. TrueForge owns the agent loop; this extension handles context and safe editor review. **Development build, not yet a verified competition submission.** See [verification status](docs/STATUS.md).

## Windows checkpoint: 0.1.13

112 Windows tests, TypeScript checking and extension compilation passed. Updated dependencies report zero known vulnerabilities in npm audit. Authenticated MCP requests are limited to 2 MiB and 512 input elements before schema expansion. Exact model edits preserve LF/CRLF line endings; agent tools require exact replacements. Discovery retains the original task's source/test/documentation requirements, and focused recovery reads remain available after planning or rejected edits. Streamed chunks remain readable in the panel and OutputChannel.

Task A was exercised in the real Windows Extension Development Host on 0.1.13: two reviewed hunks were saved and `off`/`n` variants returned `False`. Guarded editor Undo followed by Save restored the clean pinned baseline. A real 0.1.13 backend check automatically switched from a genuinely unreachable primary to the configured free model, staged one scoped proposal without applying it, and left all 235 file hashes unchanged. A previous genuine four-file Task B candidate passed 59 CLI tests, help and masked JSON checks in a separate clone. The latest distinct three-file headless candidate failed its new test; the separate live editor B run remains under review. No official B or final C editor pass is claimed. See the [feature/evidence register](docs/FEATURES.txt) and current status for measured evidence.

## Requirements
- Node.js 22.14 or newer, npm, VS Code 1.96 or newer.
- A local TrueForge instance and an authorized model configured there. No model key is stored by this extension.
- Local trusted workspace. The first version proposes edits to existing files only.

## Clean-clone setup
```sh
git clone https://github.com/aceholland/forgelens.git
cd forgelens
npm ci
npm run check
npm test
npm run compile
HOST=127.0.0.1 NETWORK_POLICY_ENABLED=true OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' MODEL_HTTP_MAX_RETRIES=5 npx @truefoundry/trueforge@0.185.1 --port 8790
```
On Windows PowerShell use:
```powershell
$env:HOST = '127.0.0.1'
$env:NETWORK_POLICY_ENABLED = 'true'
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1"]'
$env:MODEL_HTTP_MAX_RETRIES = '5'
npx.cmd @truefoundry/trueforge@0.185.1 --port 8790
```

Rehearsal evidence uses TrueForge 0.185.1. The explicit loopback host exception lets this local server call the authenticated editor MCP bridge; the network guard remains enabled. Preserve any additional deliberate allow/block entries in an existing setup. Five native model-HTTP retries use TrueForge's bounded backoff for free-tier 429/503 responses; extension turn requests are not blindly replayed.

Open http://127.0.0.1:8790, configure a catalog provider or OpenAI-compatible endpoint in Settings → Models, and note its model ID. Use your own authorized credentials; free/local models are supported by the harness. Keep TrueForge on loopback because standalone mode has no authentication.

Open this project in VS Code and press F5 using `Run ForgeLens`. In the extension development window open your target repository. Set `forgelens.model` to the TrueForge model ID. Optionally set `forgelens.fallbackModel` to a second configured model. [The model example](agent/model.example.json) shows a cloud primary, a loopback Ollama fallback, and their VS Code settings. Fill real keys only in TrueForge. To switch models, set `forgelens.model` to the new configured TrueForge model ID; set or clear `forgelens.fallbackModel` separately.

Alternatively:
```sh
npm run package
code --install-extension forgelens-0.1.13.vsix
```
Then run **ForgeLens: Open Agent** from the command palette. Select text and press Ctrl+Alt+I (Cmd+Alt+I on Mac) for inline editing.

## Agent definition
`agent/forgelens.json` is the versioned agent manifest template. At runtime the extension supplies the selected model and an authenticated ephemeral loopback MCP connector name, then sends the inline manifest to `sessions.create({agent:{spec}})`. This loads the agent through the official SDK; no separate import is required. The shared runtime instructions in `src/instructions.ts` match this template; a regression test checks equality.

## Architecture and safety
- Official `@truefoundry/trueforge-sdk@0.185.0` creates sessions and streams turns. No provider API requests originate from the extension.
- Local authenticated Streamable HTTP MCP tools: `read_file`, `search_workspace`, `select_context`, `report_plan`, `propose_write` (legacy alias `propose_edit`), `run_command`.
- Deferred tool loading (`preload:false`) keeps unused tools out of initial context. Show actual discovery calls in the session before claiming this judging criterion.
- TrueForge approval prompts preview proposed edits. Allowing a proposal only stages it. Review each hunk, then explicitly apply accepted hunks through VS Code WorkspaceEdit. Changes enter the unsaved buffer, not disk; Save when ready. Reject leaves the original untouched. Guarded Undo Last restores an accepted edit only if it has not since changed.
- The per-client HTTP transport allows up to 15 minutes between streamed data chunks, while a separate 5-minute total-run deadline (`forgelens.runTimeoutMinutes`, configurable) aborts the run. Neither setting retries an ambiguous interrupted turn or changes process-wide network/TLS settings.
- Cancel aborts local work, requests server cancellation and discards pending proposals. No tools are available when inactive/cancelled.
- Commands require separate user approval and a narrow allowlist; no arbitrary shell. Workspace imports/tests may execute code, so use trusted repos only. Run custom commands manually.
- Retrieval uses deterministic lexical/path scoring, explicit `@file:path` / `@symbol:name` mentions and a content-character budget (default 24,000). Paths, line ranges and reasons appear in the panel. Automatic retrieval returns at most four snippets. Literal search includes up to three neighboring lines (two by default), with bounded output and exact line references. Snippets select high-relevance local line clusters rather than the first keyword occurrence, with explicit symbols acting as anchors. This is not an exact tokenizer budget. Metadata and prompt overhead are extra.
- Secret filenames, binary/oversized files, symlinks and paths outside the workspace are excluded. These filters do not detect every secret embedded in ordinary source files: inspect repositories before providing them to a model.

## Historical verification (0.1.6, 2026-11-18)
Fresh supporting validation: **67/67 tests**, TypeScript check, compilation and VSIX packaging passed. Genuine TrueForge headless Task C returned an error with zero proposals and a clean pinned Flask checkout; cancellation returned `cancelled` in 22 ms with the checkout unchanged. These are not on-screen UI demonstrations.

Bounded Task B runs on Qwen3 8B and Qwen3.5 4B did **not** complete. The latest 0.1.6/16K run stopped at approximately 16 minutes with nine tool calls and zero proposals. Retrieval changes have not demonstrated an end-to-end Task B improvement. See [current verification status](docs/STATUS.md).

An earlier isolated source copy's offline `npm ci` failed because `yazl@2.5.1` was absent from the local cache. A fresh online install in a new clone has now passed on 0.1.12. Full release editor UI verification remains pending.

## What I changed and why
- **Ranked discovery:** One tool finds likely implementation, test and documentation files. Showing paths and reasons tells the reviewer what informed the edit.
- **Bounded recovery:** Repeated unchanged reads return short locators. Individual tool responses are bounded, while targeted recovery reads remain available until the run deadline or TrueForge's 40-iteration limit.
- **Timeout and fallback:** A per-model timer stops a stalled generation. TrueForge can start the configured fallback only when the first turn has stopped and no edit has been staged.
- **Review before apply:** Proposals stay out of the working tree until the user applies accepted hunks and saves. Interrupted or empty runs report their outcome instead of claiming completion.

## Discovery, recovery and optional model fallback
The first agent step is `find_relevant_files`, which ranks up to five distinct files using keywords and matching code/documentation symbols. It returns line-ranged previews and reasons within the configured character budget. The agent can make focused reads, report its plan, and stage exact edits. Targeted reads remain available after planning or a rejected edit; there is no six-call hard gate. Fresh read/search responses use a soft allowance of at least 6,000 characters or the configured context budget, whichever is larger, with a 900-character recovery floor; discovery, metadata and prompt overhead are additional. This is not a cumulative token ceiling. Staging still requires approval and never writes disk. The editor shows live discovery separately from planned changes.

Configure both model entries in **TrueForge**, not inside the extension. See [the single model example](agent/model.example.json) for the loopback Ollama endpoint and cloud-provider placeholders. Choose an authorized fast model in TrueForge and copy its actual ID into VS Code User Settings. The fallback is configured by its TrueForge model ID as well. Don't put credentials in VS Code or commit them. The model deadline defaults to 120 seconds per model generation (`forgelens.modelCallTimeoutSeconds`); the separate total-run deadline defaults to five minutes. On a model timeout, automatic fallback requires confirmation that the prior TrueForge turn stopped and no edits were staged. An ambiguous network interruption does not trigger replay.

## Live Task B rehearsal from a Windows terminal

Run on the same machine as TrueForge and the allowed pinned Flask checkout. Select an authorized cloud provider already configured in TrueForge. Using a cloud model sends retrieved workspace code to that provider and may incur usage charges. The headless harness sends the official Task B text as exactly one user message. It stages validated proposals for evidence and never applies them to the Flask workspace.

```powershell
$env:TRUEFORGE_URL = 'http://127.0.0.1:8790'
$env:TRUEFORGE_MODEL = 'COPY_AUTHORIZED_CLOUD_MODEL_ID_FROM_TRUEFORGE'
$env:TRUEFORGE_FALLBACK_MODEL = 'COPY_OLLAMA_MODEL_ID_FROM_TRUEFORGE'
$env:FLASK_ROOT = 'C:\path\to\clean\flask-3.1.3'
$env:EVIDENCE_DIR = Join-Path $HOME 'forgelens-task-b-evidence'
$env:CONTEXT_BUDGET = '24000'
$env:DYNAMIC_SUB_AGENTS = 'false'
$env:MODEL_CALL_TIMEOUT_MS = '120000'
$env:RUN_TIMEOUT_MS = '300000'
node --import tsx test-local-b.ts
```

Verify the target commit is `22d924701a6ae2e4cd01e9a15bbaf3946094af65`; inspect and apply only genuine proposals in a disposable checkout before running tests. A fallback result is a local-model result, not a cloud pass.

## Known limitations
Historical live Task A passed iteratively; exact Task C passed in VS Code on 0.1.2. Task A passed again in the Windows Extension Development Host on 0.1.13, including saved verification and guarded Undo/Save. Final B/C editor outcomes and recording remain pending. No trust setting was changed. Official Task B has not passed. No completed submission video or submission-ready PDF exists.

0.1.4 reports empty provider output as failure; 0.1.5 handles supported operator questions; 0.1.6 bounds automatic retrieval to four windows and adds bounded neighboring search context. These repairs do not establish model task success. New file creation/deletion, ignore-file parsing and full token budgeting are not implemented. Unsaved accepted buffers must be saved before validation. Ephemeral connectors remain in TrueForge settings after runs. Fallback creates a separate session and is not guaranteed to reconstruct partial reasoning. Humans review/apply staged proposals only after a run ends.

## License and provenance
From scratch, no upstream editor fork. MIT license. Ordinary dependencies retain their licenses. TrueForge API researched against official commit `18b571810ffd2fef29fd79e3731b8fb4295f92cf`. Built with OpenAI coding assistance, disclose this in the submission. The source does not publish the extension to a marketplace, make a paid call by itself, or submit the contest entry.

## Local-model compatibility (recovery update)

Agent tools `propose_write` and its legacy alias `propose_edit` require an `edits` array of `{oldText,newText}`. Full-file `content` arguments are rejected. Exact edits must match once and may not overlap. They are expanded in memory and enter the same proposal preview, inline-scope check, per-hunk review, apply confirmation, and undo flow. They never write files by themselves.

Set `forgelens.preloadTools` to `true` for small local models that fail deferred-call schemas. The default remains `false` (TrueForge deferred discovery). Both modes retain tool approval requirements. Configure the model only in TrueForge; the extension never calls Ollama or a model provider directly.

Local CPU inference may require raising TrueForge's documented model HTTP header/body timeouts. A local provider also requires appropriate loopback access under TrueForge's network policy; do not disable the policy or TLS validation. A hostname exception may allow access to other services on that host and requires informed approval.

Unit tests and model connectivity are not the required live editor demonstration. See the [verification status](docs/STATUS.md) for failures and incomplete rubric items.
