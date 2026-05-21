---
description: "Manual ChatGPT Pro bridge for CCG review evidence"
argument-hint: "[plan-or-diff] [--task <task-id>] [--followup <session-dir>]"
allowed-tools: [Read, Glob, Grep, Bash, Edit, Write]
---

# /ccg:gptpro-review

$ARGUMENTS

Use this command when a CCG task needs a manual ChatGPT Pro review as fourth-model evidence.

## Contract

Codex/Claude remains the controller and final reviewer. GPT Pro is not a `codeagent-wrapper`
backend and must not be routed through `model-router.md` as an automated model. It is manual
evidence only.

Hard boundaries:

- Do not automate ChatGPT login, prompt submission, DOM reading, output extraction, cookies, or tokens.
- Do not paste the full generated prompt into the chat unless the user explicitly asks.
- Do not continue analysis after creating the bridge until the user saves a non-empty response.
- Do not store full GPT Pro evidence in `task.json`; use task-local `evidence.json`.

## Required Inputs

1. Locate the active task under `.ccg/tasks/<task-id>/task.json`.
2. Resolve review scope from `$ARGUMENTS`, `git diff HEAD`, the active plan, or changed files.
3. Validate required Gemini review/gate evidence from `.ccg/tasks/<task-id>/evidence.json`.
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
- review scope and relevant diff/file excerpts;
- Gemini evidence summary and artifact path;
- explicit request for blocking findings, non-blocking findings, test gaps, false positives, and suggested fixes.

Then invoke the task-local bridge:

```bash
python ~/.claude/.ccg/engine/tools/gptpro/gptpro_bridge.py \
  --mode review \
  --workdir "$WORKDIR" \
  --task-dir ".ccg/tasks/<task-id>" \
  --source-command "/ccg:gptpro-review" \
  --prompt-file "<prompt-file>" \
  --slug "<task-id>-review" \
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
  "nextAction": "Open the GPT Pro preview, manually submit the prompt, save the response, then continue."
}
```

Report only the preview URL and artifact paths, then stop the current turn.

Continue only after:

- `status.json` shows the current round response saved;
- `response.md` is non-empty;
- `response_sha256` is present for the saved round;
- `.ccg/tasks/<task-id>/evidence.json` contains the GPT Pro item.

## Round Budget

Default one manual GPT Pro question. A second round is only for blocker re-check after fixes,
revised plan comparison, applied diff review, or another high-risk follow-up. If more is needed,
split the task or return to native CCG planning/review.
