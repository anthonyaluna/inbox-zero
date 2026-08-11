# Microsoft draft-only staging canary

This is a gated, real-Microsoft canary. It creates exactly one unsent draft
from one known message in one dedicated test mailbox. It is not an emulator
test and must never be pointed at the shared AP mailbox or an owner, resident,
tenant, vendor, or production-operations mailbox.

## Protected prerequisites

Set these values only in the protected staging deployment environment. Do not
put their values in Git, CI logs, receipts, shell history, or this runbook.

- `COASTLINE_STAGING_BASE_URL`: exact HTTPS staging origin.
- `COASTLINE_MICROSOFT_CANARY_EXECUTOR_PATH`: registered draft-only executor
  path below that origin; it must not name a send or other mailbox-mutation
  endpoint.
- `COASTLINE_MICROSOFT_CANARY_MAILBOX`: one dedicated test mailbox only.
- `COASTLINE_MICROSOFT_CANARY_ACCOUNT_ID`: the connected account ID for that
  mailbox.
- `COASTLINE_MICROSOFT_CANARY_THREAD_ID`: the known source-message thread ID.
- `COASTLINE_MICROSOFT_CANARY_SCOPE_IDENTITY`: approved delegated identity and
  scope fingerprint returned by the executor.
- `COASTLINE_MICROSOFT_CANARY_SCOPES`: consented scope names. It must not
  contain `Mail.Send`.
- `COASTLINE_MICROSOFT_CANARY_RECEIPT_DIR`: existing protected local directory
  outside the repository for sanitized receipts.
- `COASTLINE_DRAFT_PROPOSALS_ENABLED=true`.
- `NEXT_PUBLIC_EMAIL_SEND_ENABLED=false`.

The approved Microsoft app registration must be dedicated to staging, bind its
redirect URI to the exact staging hostname, have documented tenant/client ID
and secret expiry in the protected deployment system, and have no `Mail.Send`
permission. `Mail.ReadWrite` is permitted only when the connected provider
requires it to create and read a draft.

Before this run, the staging executor must be registered and independently
implemented to: invoke only the existing `DRAFT_EMAIL`/`outlook_draft_create`
path; use the known source message; create the one draft; read that exact draft
back through a separate Microsoft Graph request path; verify `isDraft=true`,
the Drafts folder, proposal subject, and fixed test recipient; replay the same
idempotency key; and report a deterministic existing-draft reconciliation or
duplicate-prevention result. The runner refuses any response that includes
message content, subjects, recipients, OAuth values, tokens, or cookies.

## Execute

First verify the connected identity in the protected staging console. The
returned mailbox identity must exactly equal
`COASTLINE_MICROSOFT_CANARY_MAILBOX`; the account and tenant must match the
approved app-registration record; and the scope list must exclude `Mail.Send`.
Stop if any comparison fails.

Run the existing staging preflight, then the canary from the staging operator
host. Replace placeholders only with records already approved in the protected
deployment system; do not paste those values into a ticket or terminal log.

```powershell
pwsh -File scripts/Invoke-CoastlineInboxZeroPreflight.ps1 -Mode Staging

pwsh -File scripts/Run-CoastlineInboxZeroMicrosoftCanary.ps1 `
  -BaseUrl <exact protected COASTLINE_STAGING_BASE_URL> `
  -SourceMessageId <known dedicated-test source message ID> `
  -TestRecipient <fixed dedicated-test recipient>
```

The runner posts only a draft-create request to the registered protected
executor. It never calls a Microsoft Graph send endpoint, `/api/messages/send`,
or any delete, archive, mark-read, move, unsubscribe, or rule endpoint. It
requires `Mail.Send` absence both from the protected scope list and from the
executor's receipt (`noSendCapability=Mail.Send_absent`).

## Receipt and terminal states

On success, the runner writes one JSON receipt only to
`COASTLINE_MICROSOFT_CANARY_RECEIPT_DIR` and prints that same sanitized receipt.
It contains account, thread, source-message, and draft IDs; Graph readback
status; scope identity; idempotency key; no-send capability; replay result; and
timestamp. It contains no mailbox body, subject, recipient name, OAuth value,
token, or cookie. Receipts remain private runtime evidence and are excluded
from Git.

`created_verified` is the only passing terminal state: Graph readback is
verified, `Mail.Send` is absent, and replay reports either
`existing_draft_reconciled` or `duplicate_prevented`. A second draft on replay,
missing readback, mismatched account/thread/source ID, unknown receipt field,
or any non-draft mutation is a failed canary. Do not promote from a failed or
unverified canary.

## Rollback

After archiving the sanitized receipt, set
`COASTLINE_DRAFT_PROPOSALS_ENABLED=false` in the protected staging environment
and restart the staging artifact. Rerun the staging preflight and confirm the
Coastline draft action is unavailable while `/api/health` remains healthy.
Leave the feature disabled until the receipt and rollback result have been
reviewed. Do not delete, archive, send, or otherwise mutate the canary draft as
part of rollback; the dedicated test mailbox retention process owns any later
cleanup.

If a protected prerequisite is absent, the runner exits nonzero with
`COASTLINE_CANARY_MISSING_PROTECTED_PREREQUISITE`. That failure is expected and
is not emulator or real-canary evidence.
