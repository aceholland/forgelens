# Replaying the archived Flask patch before apply

ForgeLens 0.3.0 staged the archived four-file Task B patch through its authenticated local MCP endpoint on a fresh checkout of Flask 3.1.3. The driver invoked `propose_changes`, accepted all five hunks through the production review classes and requested pytest on the temporary candidate. The run used CPython 3.12.14 with the Flask test dependencies and preserved the original hash of every tracked file. The historical model generated the patch on 20 November. This replay used automated review decisions and made zero model calls. [Model run and original patch](README.md) · [Machine-readable replay](staged-replay.json)

| Staged copy | Check | Result |
| --- | --- | --- |
| Unchanged Flask, default fixture rules | Full suite | 489 passed, 1 failed |
| Archived Task B changes, default fixture rules | Full suite | 490 passed, 1 failed |
| Archived Task B changes, default fixture rules | New CLI configuration test | 1 passed |
| Archived Task B changes, explicit public fixture pin | CLI suite | 59 passed |
| Archived Task B changes, explicit public fixture pin | Full suite | 491 passed |

Both default failures were `tests/test_cli.py::test_load_dotenv`. This upstream test checks how values in two files interact. The default copy contained `tests/test_apps/.flaskenv` and excluded the protected `tests/test_apps/.env`. Pinning the public synthetic fixture by its Git blob ID supplied the intended data. The full-suite pytest run then took 13.43 seconds. The original checkout was clean at the end and all 235 tracked-file hashes matched the initial snapshot. [Upstream fixture at the pinned Flask commit](https://github.com/pallets/flask/blob/22d924701a6ae2e4cd01e9a15bbaf3946094af65/tests/test_apps/.env)

## Run the same check

Use the Python virtual environment and Flask clone from the original reproduction instructions. From the ForgeLens checkout, run the command below. The last argument is optional and writes a JSON report. The driver creates its own temporary clone and removes it when finished. [Environment and dependency versions](README.md#reproduce-the-independent-check) · [Replay driver](../../../checks/replay-reviewed-task-b.ts)

```sh
node --import tsx checks/replay-reviewed-task-b.ts ../flask-task-b /absolute/path/to/venv/bin/python replay.json
```

On Windows, supply the absolute path to `Scripts/python.exe` in the virtual environment.

## Enable a public fixture for an editor test run

The setting starts empty. For this exact upstream release, open **Preferences: Open User Settings (JSON)** and add the entry below. Only user settings can supply these pins. Confirm the listed test command, staged files, fixture paths and Git blob IDs in **Run candidate tests**. Choose public, synthetic test data you have verified. [Fixture data used by this replay](public-fixture-pins.json)

```json
{
  "forgelens.candidateTestFixtures": {
    "tests/test_apps/.env": "0890b615f109a3685a820c8948d74f4fab6c96c0"
  }
}
```

For each approved test, ForgeLens verifies the regular Git blob at that path in the current HEAD, checks its ID and writes the committed bytes into the temporary copy. The working-tree fixture stays outside the copy and discovery. A mismatched ID, an explicit `.forgelensignore` exclusion, an unsafe destination or a size-limit violation stops the run. The limits are eight fixtures, 64 KiB each and 256 KiB total. [Implementation](../../../src/candidateFixtures.ts) · [Isolation checks](../../../test/candidate-fixtures.test.ts)
