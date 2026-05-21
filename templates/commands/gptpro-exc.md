---
description: "Manual ChatGPT Pro execution-companion bridge"
argument-hint: "<task-or-plan> [--task <task-id>] [--followup <session-dir>]"
allowed-tools: [Read, Glob, Grep, Bash, Edit, Write]
---

# /ccg:gptpro-exc

$ARGUMENTS

Use this command when Codex/Claude is implementing and wants one manual GPT Pro second opinion for
implementation sketches, patch ideas, edge cases, or test ideas.

## Contract

Codex/Claude remains the controller, final implementer, reviewer, and verifier. GPT Pro provides
manual helper evidence only. GPT Pro must not write files or own delivery.

Gemini behavior is mode-aware:

- Backend-only execution-companion sessions should not run Gemini by default.
- Frontend/full-stack sessions may run Gemini first for frontend prototype or frontend-review evidence.
- If Gemini evidence is included, it must come from a real, non-empty response file with a concise
  summary. Do not invent Gemini findings.

Hard boundaries:

- Do not automate ChatGPT login, prompt submission, DOM reading, output extraction, cookies, or tokens.
- Do not paste the full generated prompt into the chat unless the user explicitly asks.
- Do not continue implementation based on GPT Pro until the user saves a non-empty response.
- Do not store full GPT Pro evidence in `task.json`; use task-local `evidence.json`.

## Required Inputs

1. Locate the active task under `.ccg/tasks/<task-id>/task.json`.
2. Resolve execution scope from `$ARGUMENTS`, the active plan, changed files, or task context.
3. Decide whether Gemini frontend/full-stack evidence is useful:
   - backend/tooling-only: use `--gemini-policy optional --gemini-evidence-role frontend-prototype`
     without forcing a Gemini run;
   - frontend/full-stack: run Gemini preview first when useful and pass its response and summary files.

## Bridge Creation

Create a concise prompt file with:

- task title, phase, gate, and next action;
- implementation objective and relevant plan/diff/file excerpts;
- Gemini frontend/full-stack evidence when available;
- explicit request for implementation sketch, pseudo patch or unified diff if possible, tests to add,
  edge cases, risks, and verification commands.

For backend/tooling-only execution companion:

```bash
python ~/.claude/.ccg/engine/tools/gptpro/gptpro_bridge.py \
  --mode exc \
  --workdir "$WORKDIR" \
  --task-dir ".ccg/tasks/<task-id>" \
  --source-command "/ccg:gptpro-exc" \
  --prompt-file "<prompt-file>" \
  --slug "<task-id>-exc" \
  --gemini-policy optional \
  --gemini-evidence-role frontend-prototype \
  --detach-preview \
  --open-preview
```

For frontend/full-stack execution companion with Gemini evidence, also pass:

```bash
  --gemini-response-file "<gemini-response-file>" \
  --gemini-summary-file "<gemini-summary-file>"
```

Expected artifacts:

```text
.ccg/tasks/<task-id>/gptpro/<session-id>/status.json
.ccg/tasks/<task-id>/gptpro/<session-id>/round-1/prompt.md
.ccg/tasks/<task-id>/gptpro/<session-id>/round-1/response.md
.ccg/tasks/<task-id>/evidence.json
```

## Manual Wait State

After bridge creation, update the active task:

```json
{
  "status": "in_progress",
  "gate": "manual_gptpro_waiting",
  "nextAction": "Open the GPT Pro preview, manually submit the execution-companion prompt, save the response, then continue."
}
```

Report only the preview URL and artifact paths, then stop the current turn.

Continue only after:

- `status.json` shows the current round response saved;
- `response.md` is non-empty;
- `response_sha256` is present for the saved round;
- `.ccg/tasks/<task-id>/evidence.json` contains the GPT Pro item.

## Round Budget

Default one manual GPT Pro question. A second round should normally become `/ccg:gptpro-review`
after Codex applies changes. Use round 2 only for blocker re-check, applied diff review, or another
high-risk follow-up.
