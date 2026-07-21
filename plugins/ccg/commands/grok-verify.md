---
description: "Verify plan, diff, and dependencies against current Grok evidence"
argument-hint: "<task> [--plan <file>] [--diff <file>] [--dependency <file>] [--force-refresh] [--export <dir>]"
allowed-tools: [Read, Glob, Grep, Bash, Write]
---

# /ccg:grok-verify

$ARGUMENTS

Use the installed `ccg:grok-verify` skill. Bind the exact plan digest, diff digest, and dependency
digests. Print requirement/status/search counts plus evidence/manifest paths and hashes. Propagate
exit 2, exit 3, and exit 4 exactly.
