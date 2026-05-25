---
description: "Execute a CCG plan with Codex orchestrating Gemini and Claude evidence"
argument-hint: "<plan-path-or-task>"
allowed-tools: [Read, Glob, Grep, Bash, Edit, Write, WebFetch]
---

# CCG Execute - Codex Orchestrator

The user invoked:

```text
/ccg:execute $ARGUMENTS
```

Use the installed CCG plugin skill `ccg:executor` and follow it exactly. Treat `$ARGUMENTS` as the plan path or task description.

This command is Codex-native:

- Planning may come from `/ccg:plan` or an existing CCG plan file.
- New `/ccg:plan` artifacts live under `.codex/ccg/plans/*.md`; legacy `.claude/plan/*.md` files may still be executed as compatibility inputs.
- Codex is the orchestrator and final code owner.
- Gemini and Claude are allowed external evidence helpers under the Codex-native CCG parity rules; Codex applies and verifies all changes.
- Use Claude through `~/.claude/bin/codeagent-wrapper[.exe] --backend claude` for M+ analysis, risky backend/architecture/security work, and required dual-model review evidence.
- Use Gemini for bounded code drafting, edge-case analysis, UI prototypes, or review; frontend/UI work remains Gemini-first.
- Any Gemini delegation must use the bundled browser preview helper automatically; do not ask the user to run `/ccg:gemini-preview` first and do not call the raw Gemini CLI directly.
- Do not edit the original Claude plugin files. Do not spend Claude quota on trivial low-risk work, but do not forbid Claude when the Codex-native parity rules require it.
