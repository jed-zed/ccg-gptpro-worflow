---
name: go
description: Smart CCG entrypoint and router. Use when the user invokes /ccg:go or asks CCG to choose the right workflow automatically.
---

# CCG Go

Use `commands/go.md` as the authoritative routing contract for `/ccg:go`.

## Behavior

- Inspect the user's natural-language request, current project context, and git status before choosing a workflow.
- Route explicit GPT Pro intents to `/ccg:gptpro-plan`, `/ccg:gptpro-review`, or `/ccg:gptpro-exc`.
- If the user says `gptpro` without a precise subcommand, choose:
  - planning/design intent -> `/ccg:gptpro-plan`;
  - review/audit/diff intent -> `/ccg:gptpro-review`;
  - implement/fix/build intent -> `/ccg:gptpro-exc`;
  - unclear intent -> `/ccg:gptpro-plan`, because it is planning-only and does not edit product code.
- For normal development, follow the complexity/risk/domain strategy matrix in `commands/go.md`.
- Codex remains the controller and final executor.

Do not bypass the GPT Pro manual handoff barrier. GPT Pro is manual evidence, not an automated model backend.
GPT Pro routes inherit the matching ordinary command first: plan -> ordinary `/ccg:plan`, review ->
ordinary `/ccg:review`, exc -> ordinary `/ccg:execute` preflight/routing evidence before manual GPT
Pro second opinion. Do not replace routed Codex, Claude, Gemini, or helper evidence.
