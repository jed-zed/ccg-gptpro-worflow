---
name: gptpro-review
description: Create a manual ChatGPT Pro review second-opinion bridge. Use when the user invokes /ccg:gptpro-review.
---

# CCG GPT Pro Review

This is ordinary CCG review plus GPT Pro manual evidence.

Load and follow `skills/ccg-gptpro-bridge/SKILL.md`.

## Behavior

- Gather review input: plan, diff, touched files, test summary, or user-provided target.
- Run ordinary `/ccg:review` semantics first. Preserve the current CCG orchestrator and cross-review
  model routing for this installation; do not drop Codex from Claude-led review or drop Claude from
  Codex-led review when ordinary review would include that evidence.
- Before GPT Pro, write Base CCG Routing Evidence that records the current orchestrator, actual
  routed model evidence, ordinary review conclusion, and skipped/failed model steps.
- Run Gemini according to ordinary review rules before GPT Pro using the bundled Gemini preview
  helper with `--prompt-template review`.
- Follow the Gemini Gate Before GPT Pro from `skills/ccg-gptpro-bridge/SKILL.md`: require a real `CCG_GEMINI_RESPONSE_FILE`, read a non-empty Gemini response from it, stop and do not create a GPT Pro bridge session if it is missing or empty, and do not invent Gemini findings.
- Include the ordinary review conclusion, Base CCG Routing Evidence, the Gemini response file path,
  and a concise Gemini findings summary in the GPT Pro prompt.
- Build a single-round review prompt by default.
- Expected manual questions: 1.
- Maximum manual questions: 2.
- Round 2 only after Codex fixes blocker findings.
- Use `scripts/gptpro_bridge.py --mode review --detach-preview --open-preview --gemini-response-file <CCG_GEMINI_RESPONSE_FILE> --gemini-summary-file <summary-file> --routing-evidence-file <routing-evidence-file> --routing-summary-file <routing-summary-file> --require-routing-evidence`.
- After response is saved, classify:
  - blocking findings
  - non-blocking findings
  - possible false positives
  - Codex actions
- Report in Chinese and synthesize ordinary review evidence, Gemini gate evidence, and GPT Pro
  findings.
- The current CCG orchestrator remains final owner.
- Do not automate ChatGPT web login.
- Do not read ChatGPT web DOM.
- Do not extract ChatGPT Output programmatically.

## Manual Handoff Barrier

- After creating the bridge artifacts, show only handoff metadata.
- Do not paste the full generated prompt into chat.
- Show the preview URL, session directory, prompt file path, response file path, and status file path.
- Tell the user to open the preview page and use the preview page Copy Prompt button, then manually submit the prompt to ChatGPT Pro and manually save the response.
- End the current assistant turn after the handoff. Do not continue the review analysis in the same turn.
- Continue only after `status.json` shows `response_saved=true` and `response.md is non-empty`.
