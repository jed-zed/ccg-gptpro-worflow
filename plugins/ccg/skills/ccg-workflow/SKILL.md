---
name: workflow
description: Explain or enter the Codex-native CCG workflow. Use when the user invokes /ccg:workflow.
---

# CCG Workflow

Load `skills/ccg-executor/SKILL.md` for the full rule.

Explain in Chinese:

- Original CCG: Claude Code orchestrates Codex + Gemini.
- Codex CCG: Codex creates plans, orchestrates execution, and applies final code; Gemini and Claude assist as bounded read-only evidence helpers. M+ complexity and risky review paths use Gemini + Claude, matching the Codex-native parity rules from `fengshao1227/ccg-workflow`.
- Gemini browser preview is automatic whenever the workflow calls Gemini. `/ccg:gemini-preview` is only a manual smoke-test/debug entry for that same helper. Claude evidence uses `~/.claude/bin/codeagent-wrapper[.exe] --backend claude`.

If the user supplies a plan path or task, route it to `/ccg:execute`.
