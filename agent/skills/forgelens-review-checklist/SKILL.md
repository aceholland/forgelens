---
name: forgelens-review-checklist
description: Interpret ForgeLens review counts and staged test status before a reviewer applies a change.
---

# Review a ForgeLens change summary

Use the aggregate counts supplied by ForgeLens. The workspace stays in the editor.

1. Report the number of accepted, pending and rejected changes. Keep pending and rejected changes out of the accepted total.
2. If any changes are pending, ask the reviewer to resolve them before applying the patch.
3. Report only the test evidence supplied. Missing test results mean the patch is unverified. A result from an earlier revision requires a fresh run. A failing current result requires inspection before applying.
4. Give the reviewer one concrete next action based on the counts and test evidence. Avoid claims about correctness or coverage that the summary cannot establish.
