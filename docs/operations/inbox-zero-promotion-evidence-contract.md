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
`integration`, `pester`, `check_server_actions`, `check_client_redirects`,
`check_test_fixtures`, `protected_environment`, `remote_staging`,
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
| `check_server_actions` | `pnpm.cmd --filter inbox-zero-ai run check-server-actions` | none |
| `check_client_redirects` | `pnpm.cmd --filter inbox-zero-ai run check-client-redirects` | none |
| `check_test_fixtures` | `pnpm.cmd --filter inbox-zero-ai run check-test-fixtures` | none |

Each result has `outcome: pass`. A failed command must be represented as failed
evidence; do not omit or relabel it. All seven local results must be present and
bound to the same current `commit_sha`; no subset is promotion evidence.

### Protected environment

`coastline_inbox_zero_protected_environment_receipt.v1` contains `commit_sha`,
the exact environment and branch rule, `protected_sha`, non-empty
`required_reviewers`, `prevent_self_review: true`, and exactly the configured
secret and variable names above. `configured_variable_names` must contain exactly
`COASTLINE_INBOX_ZERO_STAGING_BASE_URL`,
`COASTLINE_INBOX_ZERO_STAGING_MICROSOFT_EMULATOR_URL`, and
`COASTLINE_INBOX_ZERO_PROTECTED_SHA`. It contains no values.

### Remote staging and Microsoft canary

The remote verifier produces exact schema
`coastline_inbox_zero_staging_receipt.v2`. Promotion requires
`provenance: remote_https`, `is_loopback: false`, a fresh bounded and ordered
start/completion window, a valid run nonce, the current artifact SHA, opaque
remote worker and queue identities, the authenticated cron evidence ID, exact
healthy service states, all four named checks passing, and `outcome: pass`.
Loopback and local Docker receipts are marked `local_diagnostic`; the readiness
checker rejects them even if their diagnostic checks pass.

Promotion consumes an exact composite
`coastline_inbox_zero_promotion_canary_evidence.v1` bundle assembled and retained
outside Git from the protected runner and independent verifier outputs. Its
outer record binds `artifact_sha`, one `run_id`, one `run_nonce`, and a fresh,
ordered start/completion window. The exact nested records are:

- `runner_provenance`: current artifact SHA, matching run identity, executor
  registration ID and SHA-256, executor ID, and independent verifier ID.
- `dedicated_mailbox`: current artifact and run identity, bounded verification
  timestamp, hashed mailbox identity, matching connected account and identity
  evidence, `staging`, `dedicated_non_production_canary`, and explicit false
  values for shared and production mailbox flags.
- `canary`: the complete `inbox_zero_microsoft_canary_receipt.v1` property set,
  matching runner registration and mailbox identity evidence, exact delegated
  scope identity, verified Graph readback, `Mail.Send_absent`,
  `created_verified`, and numeric exact-one-draft evidence.
- `replay`: current artifact and matching run identity, bounded timestamp,
  `created_verified`, and the same idempotency key, draft ID, replay evidence,
  no-duplicate evidence, and numeric draft count as the canary.

Truncated raw canary receipts, stale timestamps, mismatched run IDs/nonces,
mismatched artifact identities, incomplete runner provenance, and unproved
dedicated mailbox status are blocked evidence. A three-field fixture can never
produce `ready`.

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
