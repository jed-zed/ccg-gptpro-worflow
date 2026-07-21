---
name: grok-verify
description: Verify plan, diff, dependency, and test assumptions against current source-backed Grok evidence. Use for /ccg:grok-verify.
---

# CCG Grok Verify

Load `skills/ccg-grok-intel/SKILL.md`, then run its shared
`scripts/grok-intelligence/command.mjs verify` entry.

- Put task text in a file and pass `--task-file`.
- Bind the exact plan with `--plan`, applied diff with `--diff`, and every dependency/lock input with
  repeated `--dependency`. The runtime records their SHA-256 digests.
- Support `--force-refresh` and `--export`.
- Print requirement/status, search counts, bindings, evidence/manifest paths and hashes.
- Preserve exit 2, exit 3, and exit 4. Never replace official ACP evidence with a Grok Search MCP.
