# Mode: Review Second Opinion

Review the plan, diff, changed files, or verification summary below.

The input should include the ordinary CCG review route, the current orchestrator's review
conclusion, and any routed helper findings. Compare the Base CCG Routing Evidence with the
review scope, call out disagreements, and help the current orchestrator decide what is actually
blocking.

Do not assume missing Codex, Claude, Gemini, or other model evidence exists. GPT Pro is fourth
evidence and must not replace routed models.

## Expected Output

| Severity | File/Area | Finding | Rationale | Suggested Fix |
| --- | --- | --- | --- | --- |

Then provide:

- Must-fix before merge
- Should-fix later
- Test gaps
- Possible false positives
- Confidence and assumptions

Do not invent files. Do not assume hidden state.
