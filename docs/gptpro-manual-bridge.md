# GPT Pro Manual Bridge

The GPT Pro bridge adds a user-mediated ChatGPT Pro review layer to CCG without automating the
ChatGPT website. Codex/Claude remains the controller, Gemini remains automated helper evidence,
and GPT Pro is stored as manual task-local evidence.

## Layout

Runtime source is packaged under:

```text
templates/engine/tools/gptpro/
```

Installed location:

```text
~/.claude/.ccg/engine/tools/gptpro/
```

Task artifacts are written under:

```text
.ccg/tasks/<task-id>/gptpro/<session-id>/
  status.json
  round-1/
    prompt.md
    response.md
```

Canonical evidence is:

```text
.ccg/tasks/<task-id>/evidence.json
```

## Review MVP

`/ccg:gptpro-review` is the first supported command.

It requires valid Gemini gate evidence before creating the GPT Pro prompt. The command then starts
the local preview page, sets `task.json.gate` to `manual_gptpro_waiting`, and stops. The user copies
the prompt to ChatGPT Pro manually and saves the response in the preview page.

After the response is saved, the bridge:

- rejects empty responses;
- writes the exact response bytes to `response.md`;
- records character count and SHA-256 in `status.json`;
- appends a GPT Pro item to `evidence.json`.

## Boundaries

- No ChatGPT login automation.
- No DOM scraping.
- No automatic prompt submission.
- No automatic output extraction.
- No browser cookies, sessions, or account tokens are stored.
- GPT Pro is not a `codeagent-wrapper` backend and must not be added to normal model routing.

## Evidence Contract

See `templates/engine/evidence-schema.md` for the canonical evidence shape.

For review mode, required Gemini evidence is:

```text
provider=gemini
role=gate
policy=required
available=true
artifactFile exists and is non-empty
```

For GPT Pro responses, the bridge writes:

```text
provider=gptpro
role=review
policy=manual
available=true
artifactFile=gptpro/<session-id>/round-1/response.md
artifactSha256=<sha256>
```

## Packaging Check

`package.json.files` already includes `templates/engine/`, so `templates/engine/tools/gptpro/**`
is included by the existing package allowlist. Release validation should still inspect `npm pack`
output before publishing.
