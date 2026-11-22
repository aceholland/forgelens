---
name: forgelens-review-checklist
description: Interpret ForgeLens review counts and staged test status before a reviewer applies a change.
---

# Review a ForgeLens change summary

Run the bundled `review_counts.py` with Python 3 in the sandbox. Pass the review connector name supplied by ForgeLens as its single argument. Use the script's aggregate counts for the review. The workspace stays in the editor.

1. Report the number of accepted, pending and rejected changes. Keep pending and rejected changes out of the accepted total.
2. If any changes are pending, ask the reviewer to resolve them before applying the patch.
3. Read the `tests` field. For `not-run`, ask for a staged test run. For `stale`, ask for a rerun on this revision. For `failed`, ask the reviewer to inspect the failure. For `passed`, report that the staged tests passed on this revision.
4. Give the reviewer one concrete next action based on the counts and test evidence. Avoid claims about correctness or coverage that the summary cannot establish.
