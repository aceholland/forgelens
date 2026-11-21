# ForgeLens

ForgeLens is a VS Code extension for reviewing AI-assisted changes in a local repository. Select a function to request a focused edit, or ask the agent panel for a change that spans source code, tests and documentation. TrueForge runs the agent. You choose which hunks to apply and when to save them.

[Install the v0.2.0 preview](https://github.com/aceholland/forgelens/releases/download/v0.2.0/forgelens-0.2.0.vsix) · [Watch the Round 1 demo (3:59)](https://drive.google.com/file/d/1XiT8MMKxJyZTAejPxJvrqI8tOzk0gSjs/view) · [Read the Round 1 write-up](docs/technical-writeup.pdf) · [Download the recorded v0.1.13 build](https://github.com/aceholland/forgelens/releases/download/v0.1.13/forgelens-0.1.13.vsix)

### What's new in the 22 November preview

This build follows the Round 1 recording. To try the new workflow, open a trusted local folder in **desktop VS Code 1.101 or newer** and run **ForgeLens: Open Agent**.

1. **Preview context before calling a model.** Type a task and choose **Preview context**. The panel shows each selected file, line range, selection reason and the excerpt budget used. Click a path to open those lines. This preview runs locally, including when no model is configured.
2. **Choose what the agent can see.** In Git repositories automatic discovery follows Git's standard ignore rules and includes tracked files. Add a root-level `.forgelensignore` to exclude files or folders even when tracked or explicitly requested. Use one literal workspace-relative path per line, such as `fixtures/private/`. Blank lines and `#` comments are accepted. Glob patterns and negation produce a configuration error.
3. **Choose hunks in any order.** When the run ends, open each diff from **Staged changes**, then accept or reject it. **Export accepted patch** saves exactly those hunks as a Git-compatible patch at the location you choose. You can share it or run `git apply --check` before applying any changes. **Review hunks** takes you through any outstanding decisions and asks before applying to the editor buffer.
4. **Verify saved changes in a real terminal.** Choose **Verify saved changes** for Git status, Git diff checks, or Flask CLI tests when `tests/test_cli.py` is present. The panel reports elapsed time and exit status. The VS Code task terminal shows the command and its actual output. Set `forgelens.pythonPath` in User Settings to use a particular Python environment. Save edits first.
5. **Stop from the keyboard.** Press **Escape** in the agent panel during a run. The output reports the local time to block editing and discard proposals. TrueForge cancellation runs separately.

For multi-file tasks, you can also enable `forgelens.contextScout` in Settings. The scout uses a separate, read-only TrueForge session to retrieve, read and search context. It passes bounded notes to the editing session, which must discover its own files and obtain edit approvals. The scout is off by default. Enabling it uses additional provider quota.

## Try it in VS Code

**1. Install the extension.** Download the VSIX above. In desktop VS Code, open the Command Palette, choose **Extensions: Install from VSIX…** and select the downloaded file. Open a local project folder you trust.

**2. Start TrueForge.** Install Node.js 22.14 or newer and npm on the machine running the extension. The commands below start the version used in the demo. The loopback exception lets TrueForge reach ForgeLens’s local editor tools.

**Windows PowerShell**

```powershell
$env:HOST = '127.0.0.1'
$env:NETWORK_POLICY_ENABLED = 'true'
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1"]'
$env:MODEL_HTTP_MAX_RETRIES = '5'
npx.cmd @truefoundry/trueforge@0.185.1 --port 8790
```

**macOS or Linux shell**

```sh
HOST=127.0.0.1 NETWORK_POLICY_ENABLED=true OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' \
  MODEL_HTTP_MAX_RETRIES=5 npx @truefoundry/trueforge@0.185.1 --port 8790
```

**3. Choose a model.** Open [local TrueForge](http://127.0.0.1:8790), add your provider in **Settings → Models**, and copy its model ID. Set `forgelens.model` to that ID in VS Code User Settings. Provider keys belong in TrueForge. If you have a second model, set `forgelens.fallbackModel` to its ID. An existing TrueForge server listening on IPv6 loopback needs `forgelens.baseUrl` set to `http://[::1]:8790`. [Example model configuration](agent/model.example.json)

**4. Make a first edit.** Select a function and press **Ctrl+Alt+I** (**Cmd+Alt+I** on macOS), or run **ForgeLens: Edit Selection**. For a multi-file task, run **ForgeLens: Open Agent**, describe the outcome and choose **Run agent**. The panel shows the files it chose and streams progress. After the run, choose **Review hunks**. Apply the hunks you accept, save, then run your tests.

## How a request reaches the editor

```mermaid
flowchart LR
    User["Developer in VS Code"] -->|Selection or agent request| Editor["ForgeLens extension"]
    Editor -->|Create session and send turn| Forge["Local TrueForge"]
    Forge <-->|Inference| Model["Configured model"]
    Forge -->|Discover and call tools| Tools["Authenticated local MCP tools"]
    Tools -->|Read, search and stage proposals| Workspace["Local workspace and review queue"]
    Forge -->|Stream events and request approval| Editor
```

TrueForge decides which tools to call. ForgeLens ranks paths and symbols, selects short excerpts, and displays the file, line range and reason for each choice. You can steer retrieval with `@file:src/example.py` or `@symbol:get_debug_flag`. The default excerpt budget is **24,000 characters**. Tool metadata, later reads and model output consume additional context.

The extension uses the official TrueForge SDK. At session creation it fills in the selected model and temporary MCP connector, then sends the agent specification to TrueForge. Tools load on demand by default. Set `forgelens.preloadTools` for a model that needs their schemas up front. [Versioned agent definition](agent/forgelens.json)

## What Accept, Apply and Save do

```mermaid
flowchart TD
    Request["Model proposes an exact edit"] --> Stage{"Allow staging?"}
    Stage -->|No| Drop["Discard proposal"]
    Stage -->|Yes| Review{"Review each hunk"}
    Review -->|Reject| Skip["Skip hunk"]
    Review -->|Accept| Apply["Apply accepted hunks"]
    Apply --> Buffer["Unsaved editor buffer"]
    Buffer -->|Save| Disk["File on disk"]
    Buffer -->|Guarded Undo| Restore["Restore prior text"]
```

ForgeLens checks that the expected text still matches before it applies or undoes a change. It preserves line endings and keeps inline edits within the selected scope. **Stop** cancels the active run and discards pending proposals. To reverse an applied edit, use **ForgeLens: Undo Last Accepted Change**, then save the restored text. Validation commands require a separate approval and read saved files.

## The three Flask tasks

The demo uses [Flask 3.1.3 at the required commit](https://github.com/pallets/flask/tree/22d924701a6ae2e4cd01e9a15bbaf3946094af65). The times below point to the evidence in the narrated recording.

| Task | What happened | Where to look |
| --- | --- | --- |
| **A · Inline edit** | Two reviewed hunks changed how Flask interprets its debug flag. The saved function returned `False` for `off` and `n`, including uppercase variants. Undo and Save restored the baseline. | Diff **0:17** · result **0:36** · Undo **0:40** |
| **B · Multi-file command** | The request named no files. The agent found the CLI, its tests and its documentation. Human review corrected the initial test and docs. A follow-up expanded case-insensitive masking. The final four-file change passed **59 CLI tests**, appeared in help and masked **12** test secrets while leaving an ordinary value visible. | Discovery **0:52** · diff **2:28** · final checks **3:07** · TrueForge session **3:15** |
| **C · Model failure** | An unreachable primary triggered the configured fallback. We rejected one hunk and applied the other to an unsaved buffer, then used Undo and Save. Git was clean and all **235** tracked-file hashes matched the starting state. | Failure and fallback **3:36** · review **3:40** · clean workspace **3:55** |

A separate cancellation at **2:39** preserved the earlier reviewed edits. The recording shows captured command output for verification. [Detailed run evidence](docs/STATUS.md) · [Feature and test register](docs/FEATURES.txt)

## Additional features and limits

| Feature | Behavior and verification |
| --- | --- |
| **Model fallback and deadlines** | A second configured model can take over after a confirmed failure with no staged edits. Task C shows the switch. Tests cover model timeouts, ambiguous interruptions and late events. |
| **Focused retrieval and recovery** | Ranked source, test and documentation snippets guide multi-file work. Tests cover explicit mentions, repeat reads and recovery when an edit’s anchor fails. |
| **Workspace protections** | The authenticated loopback bridge filters protected paths, symlinks, binary and oversized files. It limits requests to 2 MiB and 512 input elements. These checks cannot identify every secret embedded in ordinary source. |
| **Command review** | The agent can request approved validation commands, including pytest, Git status or diff, and Flask help. Workspace code can run during a test, so use a trusted folder. |
| **Optional diagnostics** | The Windows rehearsal can parse a proposed Python edit before staging. The optional Groq gateway passed offline forwarding, retry and streaming checks. Live Groq inference remains unverified. |

ForgeLens edits existing files in the first local workspace folder. File creation and deletion are outside the current feature set. Model quality and provider quotas affect whether a request finishes.

## Which VS Code setups were checked?

Use **current desktop VS Code with a local folder** to reproduce the demo. The 20 November Windows recording follows a model request through TrueForge to a reviewed edit. On 22 November 2026 we also checked the published v0.1.13 package in five real VS Code extension hosts. Each loaded the extension, registered all five commands and opened the ForgeLens panel. [Five desktop test results](https://github.com/aceholland/forgelens/actions/runs/44943796900)

| Editor and platform | What we verified |
| --- | --- |
| Windows desktop | Recorded Tasks A, B and C with local TrueForge. Separately installed the release VSIX and checked the panel on Stable 1.147.0 (x64). |
| macOS and Linux desktop | The packaged extension opened its panel on Stable 1.147.0, on Apple silicon and Linux x64. Full model runs were recorded on Windows only. |
| Linux Insiders | The panel and commands worked on 1.148.0-insider. |
| Older VS Code | The v0.1.13 panel opened on Linux 1.96.0. That editor embeds Node 20. The v0.2.0 preview raises the minimum to 1.101 because the TrueForge SDK specifies Node 22 or newer. |
| Browser, remote workspaces and forks | Browser-only editors such as `vscode.dev` cannot host this Node extension. Remote SSH, WSL, Dev Containers, Codespaces, Cursor and VSCodium have no verified full run. |

The recorded v0.1.13 release checkpoint passed **112 extension tests** on Windows. A subsequent 0.1.x check included a Python diagnostic and passed **113 tests**. The final Flask Task B checkout separately passed **59 CLI tests** again on 22 November. The 0.2.0 preview adds desktop checks for opening the panel, previewing context without a provider, and respecting project exclusions. [Round 1 feature evidence](docs/FEATURES.txt) · [Preview desktop test workflow](.github/workflows/desktop-preview.yml)

## Build from a clean clone

```sh
git clone --branch codex/postdeadline-20261122 https://github.com/aceholland/forgelens.git
cd forgelens
npm ci
npm run check
npm test
npm run compile
```

Open the cloned folder in desktop VS Code, select **Run ForgeLens** in Run and Debug, and press **F5**. In the Extension Development Host window, open the target project and configure the model as above. To build your own installable VSIX, run `npm run package`. The source test suite includes the optional diagnostic checks. [Windows reproduction guide](WINDOWS_RUNBOOK.md) · [v0.1.13 release and downloads](https://github.com/aceholland/forgelens/releases/tag/v0.1.13)

<details>
<summary>Optional local model helpers</summary>

For a loopback Ollama provider, start with the [model example](agent/model.example.json) and substitute an ID that exists in your TrueForge configuration. To try the optional Groq helper, run `node scripts/groq-demo-gateway.mjs --self-check` for its offline test. Start it without that flag to listen on `http://127.0.0.1:11435/openai/v1`. Point an OpenAI-compatible provider in TrueForge at that address with model ID `openai/gpt-oss-120b` and your own Groq key. A slow incoming upload can exceed the helper’s internal request timer.

For the headless Flask rehearsal, follow the [Windows runbook](WINDOWS_RUNBOOK.md). Set `FORGELENS_PYTHON` to the Python executable if you want syntax validation of proposed Python changes. The rehearsal stages edits for inspection. The desktop recording shows the actual review and save workflow.

</details>

## License and starting point

Team AceSentry built ForgeLens from scratch for the TrueFoundry Forge-a-thon. There is no upstream editor fork. The extension uses [TrueForge](https://github.com/truefoundry/trueforge) for its agent loop and the VS Code API for editor review. See the [MIT license](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
