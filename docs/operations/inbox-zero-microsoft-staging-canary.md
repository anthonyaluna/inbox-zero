# Microsoft draft-only staging canary

This is a gated, real-Microsoft canary. It creates exactly one unsent draft
from one known message in one dedicated test mailbox. It is not an emulator
test and must never be pointed at the shared AP mailbox or an owner, resident,
tenant, vendor, or production-operations mailbox.

## Protected prerequisites

Set these values only in the protected staging deployment environment. Do not
put their values in Git, CI logs, receipts, shell history, or this runbook.

- `COASTLINE_STAGING_BASE_URL`: exact HTTPS staging origin.
- `COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_PATH`: protected,
  out-of-repository registration record for the one authenticated executor.
- `COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_SHA256`: protected hash of
  that exact registration record; it is the executor provenance binding.
- `COASTLINE_MICROSOFT_CANARY_EXECUTOR_AUTH_TOKEN`: protected bearer credential
  for the registered executor and its independent verifier. The runner never
  prints or persists it.
- `COASTLINE_MICROSOFT_CANARY_MAILBOX`: one dedicated test mailbox only.
- `COASTLINE_MICROSOFT_CANARY_ACCOUNT_ID`: the connected account ID for that
  mailbox.
- `COASTLINE_MICROSOFT_CANARY_THREAD_ID`: the known source-message thread ID.
- `COASTLINE_MICROSOFT_CANARY_SOURCE_MESSAGE_ID`: the exact known source
  message ID. The command argument must match it byte-for-byte.
- `COASTLINE_MICROSOFT_CANARY_TEST_RECIPIENT`: the exact dedicated test
  recipient. The command argument must match it byte-for-byte.
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

The registration record is an allowlist, not an arbitrary path: it must hash to
the protected value, identify the executor, require bearer authentication, and
allow only the fixed
`/api/coastline/microsoft-draft-canary/v1` draft-only endpoint. It must name a
separate HTTPS verifier identity on a different authority. The runner refuses
blacklist-only executor selection, unknown fields, mutable route substitutions,
or an executor with unverified provenance.

Before this run, the staging executor must invoke only the existing
`DRAFT_EMAIL`/`outlook_draft_create` path; use the protected known source
message; create the one draft; and replay the exact same request with the same
idempotency key. The runner validates the initial executor draft ID as a bounded
opaque value before it is ever sent to the verifier. Both the initial and replay
Graph-readback evidence must bind to that exact created draft ID; the replay
must return the same draft ID and never a second draft. The
independent verifier must return distinct, authenticated Microsoft Graph
evidence for the connected account/mailbox hash, granted scope identity,
absence of `Mail.Send`, and the exact draft Graph readback. The draft readback
must verify `isDraft=true`, the Drafts folder, proposal subject, and fixed test
recipient. The runner binds every evidence ID to its receipt and refuses any
response that includes message content, subjects, recipients, OAuth values,
tokens, cookies, content-like strings, credentials, invalid timestamps, or
oversized values.

## Execute

First verify the connected identity through the independently registered
verifier. The returned mailbox hash must bind to the exact protected
`COASTLINE_MICROSOFT_CANARY_MAILBOX`; the account, source message, thread, and
recipient hash must match their exact protected values; and the scope evidence
must exclude `Mail.Send`. The runner performs these comparisons before posting
the draft request. Stop if any comparison fails.

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
verified, `Mail.Send` is absent, both Graph readbacks bind to the created draft,
and replay reports either
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
