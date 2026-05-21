---
name: gptpro-exc
description: Create a manual ChatGPT Pro execution-companion bridge. Use when the user invokes /ccg:gptpro-exc.
---

# CCG GPT Pro Execution Companion

Load and follow `skills/ccg-gptpro-bridge/SKILL.md`.

This is ordinary CCG execute semantics plus GPT Pro manual evidence. The current CCG orchestrator
controls implementation and final decision after ordinary execute routing; GPT Pro provides one
manual second opinion before real code landing.

## Behavior

- Treat input as an implementation request whose ordinary `/ccg:execute` preflight and routing must
  happen before the GPT Pro handoff.
- Preserve the current CCG orchestrator and ordinary execution routing for this installation; do
  not drop Codex from Claude-led execution or drop Claude from Codex-led execution when ordinary
  execute would include that evidence.
- Before GPT Pro, write Base CCG Routing Evidence that records the current orchestrator, actual
  routed model evidence, ordinary execute conclusion so far, and skipped/failed model steps.
- For backend-only tasks, follow ordinary execute routing and do not run Gemini by default.
- For frontend or full-stack tasks, pass real Gemini frontend evidence when ordinary execute
  produced it through the bundled Gemini preview helper.
- Include the ordinary implementation context, Base CCG Routing Evidence, target files, constraints,
  existing patterns, and any available `Gemini Frontend Prototype Evidence` in the GPT Pro prompt.
- If Gemini frontend evidence is provided, it must come from a real, non-empty response file with a concise summary; do not invent Gemini findings.
- Gemini is not a gate for `/ccg:gptpro-exc`, is not a general execution participant beyond ordinary
  execute routing, and must not apply workspace changes.
- GPT Pro is a manual second opinion only; it does not write workspace files.
- Expected manual questions: 1.
- Maximum manual questions: 2.
- Round 2 should be converted into `/ccg:gptpro-review` whenever possible; use Gemini `--prompt-template review` and `--gemini-evidence-role frontend-review` for frontend review evidence over the applied diff.
- Use `scripts/gptpro_bridge.py --mode exc --detach-preview --open-preview --gemini-policy optional --gemini-evidence-role frontend-prototype --routing-evidence-file <routing-evidence-file> --routing-summary-file <routing-summary-file> --require-routing-evidence`.
- When frontend/full-stack Gemini output is available, add `--gemini-response-file <CCG_GEMINI_RESPONSE_FILE> --gemini-summary-file <summary-file>`.
- GPT Pro output is a sketch, pseudo patch, test idea list, or edge-case review.
- Report in Chinese and synthesize ordinary execute evidence, Gemini frontend evidence when present,
  and GPT Pro manual second opinion. If Gemini frontend evidence was not used, say so from routing
  evidence rather than inventing a Gemini result.
- The current CCG orchestrator remains final owner.
- Do not automate ChatGPT web login.
- Do not read ChatGPT web DOM.
- Do not extract ChatGPT Output programmatically.

## Manual Handoff Barrier

- After creating the bridge artifacts, show only handoff metadata.
- Do not paste the full generated prompt into chat.
- Show the preview URL, session directory, prompt file path, response file path, and status file path.
- Tell the user to open the preview page and use the preview page Copy Prompt button, then manually submit the prompt to ChatGPT Pro and manually save the response.
- End the current assistant turn after the handoff. Do not continue the execution-companion analysis in the same turn.
- Continue only after `status.json` shows `response_saved=true` and `response.md is non-empty`.
