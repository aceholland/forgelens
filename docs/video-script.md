# ForgeLens 0.5.0 demo narration

[Watch the narrated video](https://github.com/aceholland/forgelens/releases/download/v0.5.0/ForgeLens-0.5.0-demo.mp4) · [Download the English captions](https://github.com/aceholland/forgelens/releases/download/v0.5.0/ForgeLens-0.5.0-demo.en.srt)

## Task A · Inline edit

**00:00.000** In Windows VS Code, we select Flask’s debug flag function. The inline instruction asks for two more false spellings and documentation of every false value.

**00:12.042** The free hosted model receives the instruction once through TrueForge. This continuous capture follows it through to the first visible diff.

**00:21.625** The first diff covers empty and unset values. The operator approves it without giving the model any corrections.

**00:29.958** With the variable set to off, the terminal prints False. All 35 helper tests and all 490 Flask tests pass.

**00:40.083** Undo restores the original file. Git reports a clean checkout.

## Task B · Multi-file agent

**00:45.417** For Task B, the editor starts with an empty review queue and the complete original request.

**00:52.458** Task B gives one instruction and names no files. We ask for a Flask command that prints configuration as JSON and masks sensitive values. Watch the editor move from discovery to the first review.

**01:07.167** The model changed 3 files, including the command, a regression test and the CLI guide. The operator reviews the hunks before applying them.

**01:17.958** The native TrueForge session records one original turn with a free hosted model. The operator supplied no hints or code corrections.

**01:27.625** The integrated terminal runs the Flask CLI test file. All 64 tests pass.

**01:34.750** The command appears in Flask help. Keys containing secret, password, token or key display three asterisks. An ordinary configuration value stays readable.

**01:47.083** The complete Flask suite passes all 496 tests on the saved change.

**01:53.833** The new command is documented alongside the other built-in Flask commands.

## Task C · Failure recovery

**01:59.333** We repeat the inline instruction with an unreachable primary endpoint. The same editor stays responsive while ForgeLens tries its configured fallbacks.

**02:11.333** The panel reports connection failures and an invalid credential. It then switches to the free local model.

**02:18.958** The editor stays responsive. Git is clean, and all 235 tracked files still match their original contents.

## Five new editor features

**02:28.667** Five new tools are available in the editor. Check My Setup confirms that the local service lists the selected model. You can also choose to send a short test message.

**02:40.875** In this separate review fixture, the same Python tests run twice. The saved baseline and the accepted changes both pass in their own temporary copies.

**02:52.250** Here a TypeScript test imports JavaScript. One test starts failing, one was already broken, and another now passes. These results appear before saving.

**03:04.458** After restarting the editor, Resume restores the saved review and its earlier hunk decisions.

**03:11.583** An overlapping workspace edit opens a three-way comparison. The editor shows the original, current and proposed versions together.

**03:21.333** Edit the result to keep the local comment and the accepted calculation. Staging it sends the merge through review.

**03:29.208** The final buffer shows the merged text. ForgeLens leaves the save decision with the developer.

## Source and technical write-up

**03:36.250** The release README links the installer, the technical write-up and the verification records. The write-up explains the editor design and maps the judging criteria to this recording.
