# Live hunk review in Windows VS Code

On November 22, 2026, ForgeLens 0.3.0 completed a review run in Windows VS Code 1.147.0 against a local TrueForge server. A deterministic model issued a fixed sequence of tool calls so the check could compare its next input with the user's exact decisions. This supplemental recording covers the editor workflow. The competition submission has its own Task B evidence.

## Follow the review

1. Open ForgeLens in a trusted local workspace, configure your TrueForge model, and run a task. When a proposal arrives, **Allow staging** opens its live review.
2. Choose **Accept** or **Reject** over each hunk in the proposed diff. The panel also offers individual and bulk decisions. If your editor hides diff CodeLens, choose **Open editor hunk controls** in the panel or use the panel buttons.
3. The running agent receives the hunk decisions. Its next file read includes the accepted changes. Use **Review hunks** after the run to apply them. An existing file changes in the editor buffer. Creating a file has its own confirmation and writes it to disk.

## What the check verified

The test workspace contained a three-line text file. The model proposed uppercasing the first and third lines. The native CodeLens commands accepted the first change and rejected the second. The tool response delivered both decisions to the model with the following character offsets in the original text. The end offsets are exclusive.

| Hunk | Human decision | Start | End |
| --- | --- | ---: | ---: |
| `hunk-1` | Accepted | 0 | 4 |
| `hunk-2` | Rejected | 14 | 20 |

The model's subsequent `read_file` returned this staged content.

```text
ONE
unchanged
three
```

The model also proposed `docs/new.txt`. The driver accepted the new file's hunk, waited for the run to finish, and checked the live workspace at each step.

| Step | Observed result |
| --- | --- |
| Run completed | The original disk file retained its initial bytes. The proposed new file was absent. |
| **Apply accepted** | The existing editor buffer contained the accepted first line and the original third line. VS Code marked the buffer unsaved. |
| **Create file** | The new disk file contained the exact reviewed text. |
| **Undo creation**, then **Undo last** | The new file was removed and the existing buffer returned to its original contents. |

The walkthrough uses the recorded VS Code workbench and voices the steps in English. The feedback screen displays values recorded at the model's HTTP endpoint. The release also provides an English subtitle file.

## Compact multi-file review and a failing test

A second Windows run enabled `forgelens.compactRequests` in the same editor version. The task asked to double a number, update its regression test, and document the behavior. The model endpoint recorded static system instructions, a user-role message containing the local excerpts labeled as untrusted workspace data, and a separate user-role task message. The deterministic model issued one `propose_changes` call for the implementation, test, and documentation.

The native review accepted three changes and rejected an unrelated change to a module tag. Before each test run, the native **Run candidate tests** dialog listed the three staged paths and the configured Python executable with these arguments.

```text
-m pytest -q -p no:cacheprovider -- tests/test_doubles.py
```

The local model endpoint recorded four requests in the same TrueForge turn.

| Request | Evidence received or action taken |
| --- | --- |
| 1 | Proposed exact edits to `src/doubles.py`, `tests/test_doubles.py`, and `docs/doubles.md` with candidate tests requested. |
| 2 | Received the implementation hunk accepted at offsets `[15, 28)`, the tag hunk rejected at `[30, 45)`, and the test failure `assert 3 == 4`. Pytest exited 1 with one failed test. The model requested the staged implementation. |
| 3 | Read `return n + 1` and the original `TAG = "stable"`. Proposed replacing the computation with `return n * 2` and requested another test run. |
| 4 | Received the accepted repair and the second pytest result. Pytest exited 0 with one passing test against the three staged files. |

The editor driver compared the original file hashes at the consent and hunk-decision steps and again at completion. All three disk files retained their original contents. The workspace contained no generated files outside Git's metadata, and no source buffer had unsaved changes. The candidate files stayed available for final user review.

## Draft from context in the editor

The Windows VS Code 1.147.0 driver clicked **Draft from context** with ordinary compact requests and tool preloading disabled, and the optional scout enabled in settings. The deterministic provider captured three requests from the same TrueForge turn. Each offered the ForgeLens `propose_changes` tool and TrueForge’s built-in clock. The retrieved excerpts arrived in a labeled user-role message separate from the task.

The fixture deliberately supplied an incorrect anchor for `src/doubles.py`. ForgeLens returned a short excerpt from that file and staged zero edits. The fixture then proposed corrected edits to the implementation, its test and its documentation. The editor accepted all three requested changes and rejected an unrelated tag modification. After the driver clicked **Run candidate tests**, pytest exited 0 with one passing test in the staged copy. The provider received both the hunk decisions and the pytest result. The three source-file hashes still matched their originals and the editor buffers were clean.

## Deferred review blocks candidate execution

A third Windows run used `forgelens.liveReview: false`. TrueForge returned a structured denial for a batch with an invalid workspace path, and the model retried with three valid files in the same turn. All proposed hunks were still pending when it requested pytest, first inside the batch and then through `validate_candidate`. The editor declined both requests and returned instructions to finish review. The exact-command execution dialog never opened. A marker in the disposable test module confirmed that pytest never collected it. File hashes and editor buffers remained unchanged.
