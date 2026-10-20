# Bounded MCPX production contract

This contract applies to the opt-in budget helper in this source distribution.
It never changes MCPX installation, authentication, tunnels, ACLs or server roles.
See the repository README for setup and the explicit summary route.

Completed replies can be reextracted with the installed sidebar `reextract` command.
It reads the original exact conversation, verifies the original prompt and transcript
baseline, and writes a new sibling reextraction directory. Original state, reply,
manifest, event, timestamps and failure results remain unchanged. Budget `record
--reextraction-file` validates this derived receipt and preserves the original import.

For an explicitly user-confirmed pending execute, `record --mcpx-confirmation-dir`
validates the already completed confirmation RootWait artifacts, original request
marker, browser/profile/conversation, exact argv and original absolute deadline.
Only the original and confirmation intervals supply evidence; the gap is excluded,
and unregistered gap effects or a new intent fail closed. Confirmation cannot edit
or broaden scope. A waiting_confirmation event proves no execution and never counts
as success; a later matching succeeded event with the expected cwd and numeric exit
code zero is still mandatory. Prior blocked results are retained in resultHistory.

## Scoped code production default

For new task scope files, omitted permissionMode now means read-write-execute. The
read-only statements above describe only explicit legacy read-only tasks and capability
checks; they are not the new-task default. An authorized task supplies
`authorizationConfirmed: true`, one exact relative
`taskDirectory`, exact `writePaths`, and `allowedExecutions` containing argv arrays with
`shell: false` in its controller-owned MCPX scope JSON. Set `permissionMode: read-only` only for an explicitly requested read-only task.
This is an actual scope-contract default, not a per-request prompt override. Owner/editor role and all required tool capabilities
must be proved in the successful existing-tool receipt. Inputs and writes must stay under
the specified task directory; this option never alters server authentication or ACLs.

The first mode-capability round remains a read-only entrypoint check. Its registry key
is separate from the original contract. The later production round may read inputs,
write one exact file per edit, and run only the exact configured argv; no extensions,
browser/desktop, move_out, credential or tunnel tools are allowed. Codex retains independent
code/test review and final acceptance. The generated prompt does not contain the original
read-only prohibition in that explicit production round.

Normal import additionally requires correlated successful file.changed + edit receipts
for every exact output, and successful execute receipts with the exact command display,
workspace directory and numeric exit code zero. Capability-only imports and all original
read-only contracts keep rejecting non-read tools. Server owner capability does not authorize arbitrary destructive actions; authorized
paths and exact execution scope remain mandatory. New/written files are not required to
have existed before generation; immutable input revisions still must match after the run.
