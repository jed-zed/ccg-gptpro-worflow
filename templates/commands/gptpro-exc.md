---
description: "Manual ChatGPT Pro execution-companion bridge"
argument-hint: "<task-or-plan> [--task <task-id>] [--followup <session-dir>]"
allowed-tools: [Read, Glob, Grep, Bash, Edit, Write]
---

# /ccg:gptpro-exc

$ARGUMENTS

Use this command when a CCG task needs one manual GPT Pro implementation second opinion after the
ordinary `/ccg:execute` semantics have completed preflight and routing evidence, but before real
code landing begins.

## Contract

Run ordinary `/ccg:execute` first through the preflight, plan load, model routing, prototype, or
analysis-evidence phase. Preserve the current CCG orchestrator semantics and the normal execution
routing for this installation, including Codex, Claude, Gemini, or any configured helper that
ordinary execute would use. GPT Pro is fourth evidence: it is appended as a manual second opinion
after ordinary routing evidence exists and before the ordinary execute owner applies final code.

GPT Pro provides manual helper evidence only. It must not write files, own delivery, replace routed
models, or decide that missing Codex, Claude, or Gemini evidence exists.

Gemini behavior still follows ordinary `/ccg:execute` routing:

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
3. Run ordinary `/ccg:execute` preflight and model routing up to the point where implementation
   advice can still change the path safely. Write a concise routing evidence file, for example
   `.ccg/tasks/<task-id>/evidence/routing.md`, plus a routing summary file. The routing evidence
   must identify the current orchestrator, the routed model evidence that actually exists, the
   ordinary execute conclusion so far, and any skipped/failed model steps.
4. Decide whether ordinary routing produced Gemini frontend/full-stack evidence:
   - backend/tooling-only: use `--gemini-policy optional --gemini-evidence-role frontend-prototype`
     without forcing a Gemini run;
   - frontend/full-stack: pass the real Gemini response and summary files when ordinary execute
     produced them.

## Bridge Creation

Create a concise prompt file with:

- task title, phase, gate, and next action;
- implementation objective and relevant plan/diff/file excerpts;
- Base CCG Routing Evidence summary and artifact path;
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
  --routing-evidence-file "<routing-evidence-file>" \
  --routing-summary-file "<routing-summary-file>" \
  --require-routing-evidence \
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
