# CCG Unified Role Routing

CCG has four formal top-level routing roles:

- `frontend`
- `backend`
- `search`
- `product-manager`

| Role | Used by |
| --- | --- |
| `frontend` | Frontend analysis, planning, implementation drafts, and review |
| `backend` | Backend analysis, planning, implementation drafts, and review |
| `search` | External lookup planning, evidence gathering, analysis, and review |
| `product-manager` | Read-only intake, milestone, and final product review evidence |

`analysis`, `planning`, and `review` are workflow phases inside these roles.
They are not independently configurable provider roles.

Inspect or change exactly one role:

```text
ccg routing get frontend --json
ccg routing get backend --json
ccg routing get search --json
ccg routing get product-manager --json
ccg routing set <role> <provider>
```

The registered providers are `codex`, `gemini`, `claude`, `antigravity`,
`grok`, and `pi`. Registration does not imply that every role can use every
provider:

| Role | Allowed providers |
| --- | --- |
| `frontend` | `codex`, `gemini`, `antigravity`, `grok`, `pi` |
| `backend` | `codex`, `gemini`, `antigravity`, `grok`, `pi` |
| `search` | `codex`, `grok` |
| `product-manager` | `codex`, `gemini`, `claude` |

Use `ccg wrapper --backend <provider> ...` for managed Antigravity, Grok, or
Pi delegation. The launcher keeps the wrapper Web UI enabled unless `--lite`
is explicit. Direct Codex and Gemini wrapper invocations are also accepted but
do not change role routing; ordinary Claude is always rejected. Claude remains
restricted to the read-only product-manager contract. Codex remains the
orchestrator, sole real-workspace writer, final verifier, and delivery owner
regardless of the selected role provider.

The product-manager Provider selection exists only at
`routing.product-manager`. `[product_manager]` stores behavior parameters such
as enablement, contract version, retry, timeout, and output limits. Harness,
projects, and Trellis tasks may restrict allowed Providers but must not select
one or introduce fallback.

Routing changes never install, authenticate, invoke, or grant permissions to a
Provider. Product-manager calls remain read-only and require explicit per-call
authorization.
