---
description: "Manual ChatGPT Pro bridge for CCG planning evidence"
argument-hint: "<task-or-plan> [--task <task-id>] [--followup <session-dir>]"
allowed-tools: [Read, Glob, Grep, Bash, Edit, Write]
---

# /ccg:gptpro-plan

$ARGUMENTS

Use this command when a CCG task needs a manual ChatGPT Pro planning second opinion.

## Contract

Codex/Claude remains the controller and final planner. GPT Pro is not a `codeagent-wrapper`
backend and must not be routed through `model-router.md` as an automated model. It is manual
planning evidence only.

Plan-only boundary:

- Do not execute implementation.
- Do not apply product code changes.
- Only create or update CCG plan artifacts and GPT Pro bridge artifacts.
- After the user saves GPT Pro output, synthesize Codex, Gemini, and GPT Pro planning findings,
  write or revise the plan, report the plan path, and stop.
- Execution requires a separate `/ccg:execute <plan>` or `/ccg:codex-exec <plan>` request.

Hard boundaries:

- Do not automate ChatGPT login, prompt submission, DOM reading, output extraction, cookies, or tokens.
- Do not paste the full generated prompt into the chat unless the user explicitly asks.
- Do not continue planning synthesis after creating the bridge until the user saves a non-empty response.
- Do not store full GPT Pro evidence in `task.json`; use task-local `evidence.json`.

## Required Inputs

1. Locate or create the active task under `.ccg/tasks/<task-id>/task.json`.
2. Resolve the planning subject from `$ARGUMENTS`, an existing plan file, or task context.
3. Validate required Gemini planning/gate evidence from `.ccg/tasks/<task-id>/evidence.json`.
   Legacy `task.json.gemini_evidence` or `task.json.gemini_gate` may be normalized for read
   compatibility, but do not expand large evidence arrays into `task.json`.

Required Gemini evidence:

```text
provider=gemini
role=gate
policy=required
available=true
artifactFile exists and is non-empty
artifactSha256 matches when present
```

If required Gemini evidence is missing or invalid, stop and explain the exact missing evidence.
Do not create a GPT Pro bridge session with invented Gemini findings.

## Bridge Creation

Create a concise prompt file with:

- task title, phase, gate, and next action;
- requirements, constraints, known code context, and draft plan if present;
- Gemini evidence summary and artifact path;
- explicit request for planning risks, alternatives, missing context, implementation sequence,
  test strategy, and blocking questions.

Then invoke the task-local bridge:

```bash
python ~/.claude/.ccg/engine/tools/gptpro/gptpro_bridge.py \
  --mode plan \
  --workdir "$WORKDIR" \
  --task-dir ".ccg/tasks/<task-id>" \
  --source-command "/ccg:gptpro-plan" \
  --prompt-file "<prompt-file>" \
  --slug "<task-id>-plan" \
  --gemini-policy required \
  --gemini-evidence-role gate \
  --gemini-response-file "<gemini-response-file>" \
  --gemini-summary-file "<gemini-summary-file>" \
  --detach-preview \
  --open-preview
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
  "nextAction": "Open the GPT Pro preview, manually submit the planning prompt, save the response, then continue."
}
```

Report only the preview URL and artifact paths, then stop the current turn.

Continue only after:

- `status.json` shows the current round response saved;
- `response.md` is non-empty;
- `response_sha256` is present for the saved round;
- `.ccg/tasks/<task-id>/evidence.json` contains the GPT Pro item.

## Round Budget

Default one manual GPT Pro question. A second round is only for blocker re-check or revised plan
comparison. If more is needed, split the task or return to native CCG planning.
