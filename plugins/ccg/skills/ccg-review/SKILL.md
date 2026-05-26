---
name: review
description: Review a CCG implementation with Codex-led judgment and Gemini plus Claude evidence. Use when the user invokes /ccg:review or asks for CCG review of a diff/plan.
---

# CCG Review

Load and follow `skills/ccg-executor/SKILL.md`.

Review the current diff or the implementation associated with the supplied plan/task. Codex performs the primary review under the Codex-native CCG parity rules. Gemini and Claude provide bounded second-pass review evidence for non-trivial, risky, or explicitly requested CCG reviews; Codex must verify findings before reporting them.

Every Gemini call in the CCG workflow must use the bundled preview helper. Do not call the raw `gemini`, `gemini.cmd`, or `gemini.exe` CLI directly. `/ccg:gemini-preview` is only a manual smoke-test/debug entry; `/ccg:review` must open the same browser preview automatically whenever it asks Gemini for a second-pass review.

When using Gemini, call the bundled preview helper with `--prompt-template review`. The template already carries the original CCG-style read-only and prioritized review protocol; put only the concrete diff, plan, and review focus in the task prompt.

When using Claude, call `~/.claude/bin/codeagent-wrapper[.exe] --backend claude` with the Claude reviewer role and a read-only prompt containing the concrete diff, plan, and review focus. If required Gemini or Claude review evidence is missing, say so explicitly; do not present a single-model review as dual-model review.
