---
title: Inbox Zero promotion evidence contract
description: Machine-checkable evidence and protected-environment requirements for Coastline's Microsoft draft-only lane.
---

# Inbox Zero promotion evidence contract

`scripts/Assert-CoastlineInboxZeroReadiness.ps1` is the promotion freshness
checker. It accepts only sanitized JSON receipts stored outside the repository
and emits `coastline_inbox_zero_promotion_readiness.v1`, tied to the exact full
commit SHA supplied with `-ExpectedSha` and read back from the local checkout.

## Required matrix

The ordered `evidence_matrix` contains `current_sha`, `build`, `full_test`,
`integration`, `pester`, `protected_environment`, `remote_staging`,
`dedicated_mailbox`, `canary`, `replay`, `rollback`, and `pr_review`. Each row is
`pass`, `missing`, or `fail` and includes a stable `reason_code` when it is not a
pass. Exact full-suite and Pester counts are copied from the current-SHA local
receipt into the applicable row.

Terminal states are deterministic:

- `ready`: every row passes for the current SHA.
- `pilot-only`: no supplied evidence failed, but at least one row is missing.
- `blocked`: the SHA differs, or a supplied receipt is stale, failed, malformed,
  in-repository, or contradicts the contract.

Receipt omission never implies staging, Graph, replay, rollback, environment,
or review success. The checker does not call GitHub, a staging endpoint,
Microsoft Graph, or a mailbox.

## Protected GitHub environment

Configure this in GitHub before Task 6; workflow text alone is insufficient.

- Environment: `coastline-inbox-zero-staging`.
- Deployment branch rule: protected branch `refs/heads/main` only.
- Required SHA variable: `COASTLINE_INBOX_ZERO_PROTECTED_SHA`, equal to the
  intended 40-character artifact SHA.
- Required reviewers: at least one designated staging reviewer must be
  configured, and self-review must be prevented. Reviewer identities are
  recorded only in the protected-environment receipt. They are `Pending` until
  independently read back from GitHub Environment configuration.
- Required environment secrets:
  `COASTLINE_INBOX_ZERO_STAGING_DATABASE_URL`,
  `COASTLINE_INBOX_ZERO_STAGING_AUTH_SECRET`,
  `COASTLINE_INBOX_ZERO_STAGING_MICROSOFT_CLIENT_ID`,
  `COASTLINE_INBOX_ZERO_STAGING_MICROSOFT_CLIENT_SECRET`, and
  `COASTLINE_INBOX_ZERO_STAGING_CRON_SECRET`.
- Required environment variables:
  `COASTLINE_INBOX_ZERO_STAGING_BASE_URL`,
  `COASTLINE_INBOX_ZERO_STAGING_MICROSOFT_EMULATOR_URL`, and
  `COASTLINE_INBOX_ZERO_PROTECTED_SHA`.

Do not record secret values. The workflow's `refs/heads/main` and exact-SHA
guards complement the GitHub Environment's deployment branch, reviewer,
self-review, secret, and variable protections. A passing workflow guard is not
environment-protection evidence.

## Input receipts

All paths supplied to the checker must resolve outside the repository.

### Local validation

`coastline_inbox_zero_local_validation_receipt.v1` contains `commit_sha` and a
`results` object. The required command strings and pass fields are exact:

| Key | Command | Required counts |
| --- | --- | --- |
| `build` | `pnpm.cmd --filter inbox-zero-ai run build:ci` | none |
| `full_test` | `pnpm.cmd --filter inbox-zero-ai test -- --run` | passed/skipped files and tests |
| `integration` | `pnpm.cmd --filter inbox-zero-ai test-integration` | passed files and tests |
| `pester` | `Invoke-Pester -Script scripts/tests -PassThru` | passed tests |

Each result has `outcome: pass`. A failed command must be represented as failed
evidence; do not omit or relabel it. The separate server-action,
client-redirect, and fixture checks remain mandatory validation commands and
must be reported alongside the receipt even though they are not promotion
matrix count rows.

### Protected environment

`coastline_inbox_zero_protected_environment_receipt.v1` contains `commit_sha`,
the exact environment and branch rule, `protected_sha`, non-empty
`required_reviewers`, `prevent_self_review: true`, and exactly the configured
secret names above. It contains no values.

### Remote staging and Microsoft canary

The remote verifier produces `coastline_inbox_zero_staging_receipt.v2`. It must
have `outcome: pass` and `artifact_sha` equal to the current SHA. A loopback or
local Docker receipt is diagnostic only and must not be supplied as remote
staging evidence.

The protected canary runner produces
`inbox_zero_microsoft_canary_receipt.v1`. It must show independent Graph readback
`verified`, terminal state `created_verified`, `Mail.Send_absent`, a reconciled
or duplicate-prevented replay, and numeric `idempotencyDraftCount: 1`. This
schema is accepted as dedicated-mailbox evidence only because the runner fails
before execution unless its protected dedicated-mailbox prerequisites pass.

### Rollback and pull-request review

`coastline_inbox_zero_rollback_receipt.v1` is current-SHA evidence with
`outcome: pass`, `draft_action_unavailable: true`,
`existing_draft_untouched: true`, and `no_mailbox_delete: true`.

`coastline_inbox_zero_pr_review_receipt.v1` is current-SHA evidence with
`base_branch: main`, `review_state: approved`, and at least one approving
reviewer. A local review note or unreviewed pull request does not satisfy it.

## Invocation

The local validation-only invocation intentionally remains `pilot-only` when
remote and protected evidence paths are absent:

```powershell
pwsh -File scripts/Assert-CoastlineInboxZeroReadiness.ps1 `
  -ExpectedSha (git rev-parse HEAD) `
  -LocalEvidencePath C:\protected-receipts\local-validation.json `
  -OutputPath C:\protected-receipts\promotion-readiness.json
```

Task 6 may additionally supply
`-ProtectedEnvironmentEvidencePath`, `-RemoteStagingReceiptPath`,
`-CanaryReceiptPath`, `-RollbackReceiptPath`, and `-PrReviewEvidencePath` only
after those independently verified files exist. Never put receipt or output
paths under the repository, and never include credentials or mailbox content.
