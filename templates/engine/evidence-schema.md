# CCG Task Evidence Schema

Task evidence is stored outside `task.json` so workflow hooks can keep `task.json` small and stable.

Canonical path:

```text
.ccg/tasks/<task-id>/evidence.json
```

## Shape

```json
{
  "schemaVersion": 1,
  "items": [
    {
      "id": "gemini-gate-round-1",
      "provider": "gemini",
      "role": "gate",
      "policy": "required",
      "available": true,
      "artifactFile": "evidence/gemini-gate.md",
      "artifactSha256": "<sha256>",
      "artifactChars": 1200,
      "summary": "Short human-readable summary.",
      "sessionId": null,
      "round": 1,
      "createdAt": "2026-05-21T00:00:00.000Z"
    }
  ]
}
```

## Providers And Roles

Recommended providers:

- `gemini` for automated Gemini helper evidence.
- `gptpro` for user-mediated ChatGPT Pro evidence.
- `codex` for local synthesis or verification artifacts when useful.

Recommended roles:

- `gate` for required pre-GPT-Pro Gemini evidence.
- `review` for review findings.
- `plan` for planning evidence.
- `execution-companion` for legacy GPT Pro execution evidence; new items should add
  `displayRole: "execution-route-review"`, `semanticRole: "route-review"`, and
  `implementationOwner: false`.
- `frontend-prototype` for optional frontend/UI helper evidence.

## Artifact Rules

- Prefer paths relative to the task directory.
- `.ccg/...` paths are resolved from the project root.
- Absolute paths are accepted for legacy compatibility but should not be written by new commands.
- Required evidence must point to a non-empty artifact.
- When `artifactSha256` is present, consumers must verify it against the exact artifact bytes.

## Legacy Compatibility

Readers may normalize `task.json.gemini_evidence` or `task.json.gemini_gate` into this shape.
Writers must not append large evidence payloads to `task.json`.
