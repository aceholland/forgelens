# ForgeLens Windows handoff: diagnostic, then genuine editor demo

The source checks and real Task A were executed on Windows. Task B still requires a successful reviewed editor run and post-save validation. The diagnostic never applies proposals and does not replace the required VS Code demonstration. Preserve the existing worktree and Python environment; align pytest to the pinned Flask lockfile's `9.0.2` if a newer pytest cannot collect its tests.

If restarting TrueForge for this authenticated loopback bridge, retain the outbound guard and explicitly permit the bridge's exact IPv4 loopback host in that server process:

```powershell
$env:HOST = '::1'
$env:NETWORK_POLICY_ENABLED = 'true'
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1"]'
npx.cmd @truefoundry/trueforge@0.185.1 --port 8790
```

This resolves the reproduced HTTP 400 `Outbound URL blocked for host "127.0.0.1"`. Preserve additional deliberate allow/block entries rather than replacing them. Do not restart a working server merely to run these commands.

## 1. New source and clean isolated Flask worktree

Download the new ZIP attachment from this chat and extract it in Downloads. Use its `ForgeLens-public` folder, not the previous 0.1.9 extraction. Adjust `$Source` only if Windows extracted it elsewhere. Keep the existing TrueForge process and its security settings unchanged.

```powershell
$Source = 'C:\Users\User\Downloads\ForgeLens-0.1.9-Windows-evaluation\ForgeLens-public'
if (-not (Test-Path (Join-Path $Source 'diagnostics\metadata.ts'))) { throw 'Open the new Windows evaluation ZIP, then set $Source to the actual extracted ForgeLens-public path.' }
$OriginalFlask = 'C:\Users\User\flask'
$Stamp = Get-Date -Format yyyyMMdd-HHmmss
$Work = Join-Path $HOME ('forgelens-demo-' + $Stamp)
$Flask = Join-Path $Work 'flask'
$Venv = Join-Path $Work 'venv'
$Evidence = Join-Path $Work 'evidence'
New-Item -ItemType Directory -Path $Work,$Evidence | Out-Null

git -C $OriginalFlask cat-file -e '22d924701a6ae2e4cd01e9a15bbaf3946094af65^{commit}'
if ($LASTEXITCODE -ne 0) { throw 'Pinned Flask commit missing. Stop and report this; do not reset the existing checkout.' }
git -C $OriginalFlask worktree add --detach $Flask 22d924701a6ae2e4cd01e9a15bbaf3946094af65
if ($LASTEXITCODE -ne 0) { throw 'Worktree creation failed' }
git -C $Flask rev-parse HEAD
git -C $Flask status --short
py -m venv $Venv
$Python = Join-Path $Venv 'Scripts\python.exe'
& $Python -m pip install -e $Flask pytest python-dotenv asgiref greenlet
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed' }
& $Python -c 'import flask; print(flask.__file__)'
```

The HEAD must be the pinned commit and initial status empty. Flask import must resolve inside `$Flask`. This does not modify the original checkout's source files. A worktree shares Git metadata but has independent files. Do not run `git reset --hard` or `git clean` on the original checkout.

## 2. Preflight the existing local TrueForge and source

Your reported TrueForge API uses IPv6 loopback. Its API address and the extension's ephemeral MCP address are separate connections.

```powershell
$env:TRUEFORGE_URL = 'http://[::1]:8790'
$env:TRUEFORGE_MODEL = 'google-gemini/gemini-3-1-flash-lite'
Test-NetConnection -ComputerName '::1' -Port 8790
(Invoke-WebRequest -Uri $env:TRUEFORGE_URL -UseBasicParsing).StatusCode
Set-Location $Source
node --version
npm.cmd --version
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
npm.cmd run check
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
npm.cmd test
if ($LASTEXITCODE -ne 0) { throw 'Supporting tests failed' }
npm.cmd run compile
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
```

Open `http://[::1]:8790` in the browser and verify the configured model ID is exactly `google-gemini/gemini-3-1-flash-lite`. Do not paste provider keys into chat, extension settings or recordings. Keep the existing policy enabled. **Do not** expose TrueForge on `0.0.0.0`, change global TLS validation, or change the MCP bridge from authenticated loopback. If MCP is blocked, preserve the exact error for diagnosis instead of disabling policy.

## 3. One bounded diagnostic, no application of files

```powershell
$env:FLASK_ROOT = $Flask
$env:EVIDENCE_DIR = $Evidence
$env:CONTEXT_BUDGET = '24000'
$env:DYNAMIC_SUB_AGENTS = 'false'
$env:RUN_TIMEOUT_MS = '300000'
$env:MODEL_CALL_TIMEOUT_MS = '120000'
Remove-Item Env:TRUEFORGE_FALLBACK_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:REASONING_EFFORT -ErrorAction SilentlyContinue
node --import tsx .\test-local-b.ts 2>&1 | Tee-Object -FilePath (Join-Path $Evidence 'console.log')
$DiagnosticExit = $LASTEXITCODE
'Diagnostic exit code: ' + $DiagnosticExit
git -C $Flask status --short
Get-ChildItem $Evidence
```

Inspect the new summary (safe metadata rather than source payloads):

```powershell
Get-Content (Join-Path $Evidence 'result.json')
```

It reports `phase`, `status`, `elapsedMs`, real MCP initialization, tool-call attempts (including repeats/gate failures/invalid arguments), `observedModels`, `fallbackTransitions`, `modelTimeouts`, `tokenUsage`, `proposalCount`/`paths`, and `targetFilesApplied:false`. `tokenUsage:null` means unreported, not zero. `events.json` is metadata-only in the new harness. `proposals.json` contains actual staged source and must remain private unless separately reviewed for publication. A final error or missing required proposals remains a failure even if usage or tool calls are present.

No fallback model is invented. If you have a second model configured and explicitly want this run to use it, set `TRUEFORGE_FALLBACK_MODEL` to its exact ID before running. Watch the TrueForge session and diagnostic output. Preserve the session ID, final result, plan, proposal paths, usage and event trace. A timeout/error is not a pass. If the agent asks a question, read it and answer deliberately; do not insert a generic automatic answer. Do not copy `proposals.json` over Flask files.

Raw traces may contain source, local paths and provider error details. Inspect before sharing or recording; never publish raw trace logs blindly. Usage is provider-reported token usage, not proof of billing or a measured financial cost.

## 4. Official VS Code run through F5

The diagnostic does not satisfy the required editor proof. Use a clean worktree for the real run. If the diagnostic left it clean, this same worktree is suitable.

Open `$Source` in VS Code. The source package may omit the hidden launch file. If F5 has no `Run ForgeLens` configuration, create **only** `$Source\.vscode\launch.json` with:

```json
{"version":"0.2.0","configurations":[{"name":"Run ForgeLens","type":"extensionHost","request":"launch","args":["--extensionDevelopmentPath=${workspaceFolder}"],"outFiles":["${workspaceFolder}/dist/**/*.js"]}]}
```

Press F5 → `Run ForgeLens`. In the new **Extension Development Host**, open the isolated `$Flask` folder. Review the known official checkout before trusting it. In that development window's **User Settings JSON**, merge these keys (do not replace unrelated settings):

```json
{
  "forgelens.baseUrl": "http://[::1]:8790",
  "forgelens.model": "google-gemini/gemini-3-1-flash-lite",
  "forgelens.fallbackModel": "",
  "forgelens.preloadTools": true,
  "forgelens.contextBudget": 4000,
  "forgelens.runTimeoutMinutes": 5,
  "forgelens.modelCallTimeoutSeconds": 120
}
```

Environment variables used by the diagnostic are not extension settings. In particular `DYNAMIC_SUB_AGENTS=false` is diagnostic-only unless the current extension explicitly supplies an equivalent setting. Do not claim identical configurations without checking the actual session definition.

### A (for the eventual full recording; skip if you are evaluating B now)

Select all of `get_debug_flag`, including its docstring, in `src/flask/helpers.py`. Run **ForgeLens: Edit Selection** and give:

> Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.

Allow staging when appropriate. Wait until the run ends, then **ForgeLens: Review Pending Hunks** → inspect every hunk → Accept/Reject → **Apply accepted** → **File → Save All**. Accepted editor buffers are initially unsaved.

In PowerShell at the isolated Flask directory:

```powershell
Set-Location $Flask
$env:FLASK_DEBUG = 'off'
& $Python -c 'from flask.helpers import get_debug_flag; print(get_debug_flag())'
Remove-Item Env:FLASK_DEBUG
```

Show `False`. Before running B, use **Undo** on the applied A edit in the editor, **Save All**, and check `git -C $Flask status --short` is empty. If it is not clean, create a fresh detached worktree and point a new virtual environment to it as in step 1. Do not reset the original checkout.

### B

Before starting B or sharing the recording, confirm that the isolated checkout is at the required commit and `git -C $Flask status --short` is empty. Do not paste any prebuilt changes or include file paths in the prompt.

Run **ForgeLens: Open Agent**. Enter only the following task, with no filenames, attached context or added hints:

> Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.

Show the actual discovered plan, the corresponding TrueForge session's turns/tool calls, and at least three meaningful B proposal files covering implementation, tests and documentation. Do not count A's pre-existing file change toward B's three-file requirement. Review, explicitly apply and Save All as above. No manual application of diagnostic proposals.

```powershell
Set-Location $Flask
& $Python -m pytest tests/test_cli.py -q
if ($LASTEXITCODE -ne 0) { throw 'Task B test failure; do not claim a pass' }
$env:FLASK_SKIP_DOTENV = '1'
git diff --stat
```

The bundled `verify_config.py` runs `python -m flask --help` and `python -m flask config` with its temporary sample app selected, so it avoids the irrelevant “Could not locate a Flask application” help notice. Run:

```powershell
& $Python (Join-Path $Source 'verify_config.py') $Flask
```

It creates a synthetic app outside Flask, disables dotenv loading and verifies all four matching categories (`DEMO_SECRET_VALUE`, `DB_PASSWORD`, `AUTH_TOKEN`, `API_KEY`) become `***`, while `PUBLIC_LABEL` stays visible. It prints only the verified synthetic subset and help. It never applies proposals. A valid smoke check still needs actual agent provenance, meaningful test/docs review and the CLI test pass.

### C (after B, for the full recording)

Save a before-state screenshot of `git status --short` and `git diff --stat`. Configure a deliberately unreachable **model endpoint in TrueForge** with no fallback for this test; do not change the extension's API URL instead. Repeat exact A. Show a clear error and responsive editor, then unchanged Git status/diff. Restore the intended working model afterward. For stronger integrity, compare file hashes before/after using the supplied earlier snapshot verifier; Git status alone does not detect further changes to already-modified files.

## 5. Recording and evidence

Record actual editor behavior in A → B → C order, each with on-screen verification, and show the B TrueForge session. Maximum 4 minutes. Keep the instruction-to-diff interval continuous. The brief's permission to cut waiting time does not justify hiding that interval or a failed run. Rehearse timing before final capture.

Keep private evidence: versions, pinned commit, initial state, diagnostic summary/session ID, genuine editor B proposal paths, acceptance and saved diff, pytest output, synthetic masking output, A False check, C before/after state and final video duration. Capture provider-reported usage from the actual session/trace; do not invent cost. Submission/publication remains a separate approved step.
