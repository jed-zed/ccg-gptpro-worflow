---
description: "Review a CCG implementation with Codex plus Gemini and Claude evidence"
argument-hint: "[diff-or-plan-path]"
allowed-tools: [Read, Glob, Grep, Bash, Edit, Write, WebFetch]
---

# CCG Review

The user invoked:

```text
/ccg:review $ARGUMENTS
```

Use the installed CCG plugin skill `ccg:executor`.

Review the current diff or the implementation associated with `$ARGUMENTS`. Codex performs the primary review, then preserves the Codex-native CCG parity rules by collecting Gemini + Claude review evidence for non-trivial, risky, or explicitly requested CCG reviews. Codex verifies findings before reporting them.

If Gemini is used, invoke the bundled browser preview helper automatically. Do not ask the user to run `/ccg:gemini-preview` first and do not call the raw Gemini CLI directly.

When Claude review evidence is required, invoke `~/.claude/bin/codeagent-wrapper[.exe] --backend claude` with a read-only reviewer prompt. If Claude fails or returns empty output, report the missing review evidence instead of claiming dual-model review happened.
