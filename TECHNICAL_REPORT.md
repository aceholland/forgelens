# Historical ForgeLens 0.1.9: Task B evaluation checkpoint

This is the earlier release's historical report. See [the 0.1.11 Windows checkpoint](docs/STATUS.md) for the newly measured Windows results and outstanding official evaluation work.

**Status: the local IPv6/MCP integration passed. The official Gemini Task B run is not verified.** This package contains a focused ForgeLens source patch and a Windows runbook. It does not contain generated Flask changes, a claimed pass, or a demo recording.

## What worked

- **Windows, as reported by Ayush:** TrueForge was listening at `http://[::1]:8790`; the narrow outbound allowlist permitted the localhost ForgeLens MCP endpoint; MCP registered via Streamable HTTP; `google-gemini/gemini-3-1-flash-lite` answered a simple chat. This establishes a reported chat connection, not a verified tool-using run.
- **Independently verified in Linux:** A fresh actual TrueForge **0.185.1** process accepted the ForgeLens registration on IPv6 loopback; TrueForge then listed all eight tools from the authenticated IPv4 loopback MCP bridge. Network policy remained enabled with only `127.0.0.1` allowlisted in this isolated check. An unauthenticated MCP request returned HTTP **401**. There was no model call, command execution, or workspace write in this preflight. Registration finished at **101 ms** and the complete local preflight took **203 ms** in this one check; neither number is Task B runtime.
- **Flask baseline:** Clean, detached Flask **3.1.3**, commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. `python -m pytest tests/test_cli.py -q`: **58 passed in 0.13 s**. With a temporary app selected, `flask --help` listed `routes`, `run`, and `shell`, with no `config`. Baseline `flask config` exited **2**, `No such command 'config'`. The new masking verifier correctly refused that baseline. No Flask changes were applied.

## What failed and why

1. **Reported Windows failure:** `google-gemini/gemini-3-5-flash` returned `Headers Timeout Error`. The exact cause (for example, provider, its network route, or local TrueForge) cannot be determined without that run's TrueForge trace. A successful simple response from Flash Lite does not prove that the official Task B prompt works. No claim that the source patch fixes this provider timeout.
2. **Reproduced API-registration transport mismatch:** 0.1.9 registered MCP through the SDK's default process HTTP fetch, while agent turns used a dedicated transport. In this environment, the default fetch failed against IPv6 loopback even though the endpoint returned 200 and the dedicated transport connected. This is a verified issue here, not a claim that it caused the reported Windows timeout.
3. **Diagnostic evidence gap:** The old harness excluded repeat attempts from its count, printed raw event data, and could exit during registration without a final evidence summary. A `done` event did not prove that Task B produced the three required changes.

## Changes made

- Registration now uses the same class of per-client transport as the turn for **literal IPv4 and IPv6 loopback**. Loopback registration rejects redirects rather than sending the registration body elsewhere. The registration timeout stays at 15 seconds; no global proxy, TLS, allowlist, or remote-host behavior was changed.
- The harness separately records actual MCP initialization and authenticated MCP call attempts, including repeat, invalid, and gate-rejected attempts. It records safe discovered/planned paths, proposed paths, requested and observed model IDs, status/recovery categories and available model usage without printing raw prompt replies, arguments, provider error bodies, or raw configuration. The metadata report is written even if registration fails. A provider that emits no usable usage records is reported as `null`, not zero.
- The official Task B prompt matches the original exactly, and the harness does not alter the Flask checkout or execute agent-requested validation commands. Diagnostic proposal validation merely stages candidates. The VS Code extension still requires a user to review hunks, apply accepted changes, then save them. No security restrictions were removed.

## Actual Task B benchmark

| Measure | Current result |
|---|---|
| Intended model | `google-gemini/gemini-3-1-flash-lite`; selected in the supplied commands, reported working for simple Windows chat |
| Model actually observed on an official Task B run with this build | Not measured |
| Task B elapsed time and total calls | Not measured |
| MCP initialization | Local preflight: TrueForge registration and eight listed tools verified. Windows Task B initialization: not measured |
| Files discovered / proposed | Not measured for this run |
| Token usage / agent completion / recovery | Not measured for this run |
| Post-review tests / help / masked JSON | Not run; there were no human-approved Task B hunks to apply |
| ForgeLens source checks | 96 passed, 0 failed, 0 skipped. Typecheck and extension compile exited 0. |

## Remaining blocker and exact next steps

Only the cloud execution environment was connected, not Windows. Its TrueForge instance did not have the requested Windows Gemini configuration. No other model was substituted and no live Gemini result was inferred.

1. Extract the accompanying evaluation ZIP into Downloads. Open `WINDOWS_RUNBOOK.md` in its `ForgeLens-public` folder and follow the PowerShell setup. It uses the existing TrueForge API at `http://[::1]:8790`, the exact Flash Lite model ID, and an isolated pinned Flask worktree.
2. Use the one-shot harness if diagnosing transport. For the **official run**, use the VS Code ForgeLens Agent panel and send only the unchanged prompt. Keep the actual TrueForge session and the panel reasons for file selection. Compare total trace calls (including TrueForge built-ins) separately from the harness's MCP bridge count.
3. Inspect proposals for implementation, tests and documentation. Approve desired hunks explicitly, save the buffers, and run `pytest tests/test_cli.py -q` and the supplied sample-app verifier. The verifier prints `flask --help` and only a safe subset of `flask config` after it has verified the output. Do not record or share actual secrets.
4. If the run errors, share the sanitized `result.json` and the relevant redacted TrueForge session statuses. Report separately whether registration and initialization completed, whether any model output/tool calls arrived, and whether fallback occurred. No need to move API keys or open Windows TrueForge to the network.
