---
title: Inbox Zero operational readiness
description: Evidence-bound promotion decision for Coastline's Microsoft draft-only pilot.
---

# Inbox Zero operational readiness

## Decision

**pilot-only**

The current branch has reviewed local hardening through implementation evidence
base `4de132fb062606e0d0f9eed230757873a3ac939a`, but no protected-environment
configuration receipt, remote staging receipt, dedicated-mailbox Graph canary,
rollback receipt, or approved pull-request receipt is present. Nothing in this
record authorizes a deployment, production mailbox, send action, delete action,
or promotion.

The readiness checker binds every evaluation to the full SHA passed as
`-ExpectedSha` and independently compares it with `git rev-parse HEAD`. This
avoids a self-referential document hash while ensuring the emitted machine
record names the exact current commit:

```powershell
pwsh -File scripts/Assert-CoastlineInboxZeroReadiness.ps1 `
  -ExpectedSha (git rev-parse HEAD)
```

With no out-of-repository receipt paths supplied, the expected result is
`pilot-only`. Missing evidence is not a passing result.

## Task 6 protected-staging boundary

The protected-staging preflight was run locally for the current branch. The
checkout and local Docker, PostgreSQL, and Redis checks passed, but the
operator environment did not contain the protected staging bindings. The
Microsoft canary therefore terminated with
`COASTLINE_CANARY_MISSING_PROTECTED_PREREQUISITE` before any executor,
verifier, deployment endpoint, Microsoft Graph resource, or mailbox request.
This is a blocked preflight result, not staging, canary, replay, rollback, or
promotion evidence. The sanitized blocked receipt remains outside the
repository.

## Current evidence matrix

| Evidence | Current result | Stable reason when absent | Limitation |
| --- | --- | --- | --- |
| Current SHA | pass at evaluation time | `CURRENT_SHA_MISMATCH` | The checker emits the exact final `HEAD`; the code evidence base above is the latest implementation commit before this documentation refresh. |
| Build | pending final-HEAD receipt | `LOCAL_BUILD_RESULT_MISSING` | A fresh `build:ci` result belongs in the out-of-repository local receipt. |
| Full unit suite | pending final-HEAD receipt | `LOCAL_FULL_TEST_RESULT_MISSING` | Exact counts must come from the final command output, never an older document. |
| Integration suite | pending final-HEAD receipt | `LOCAL_INTEGRATION_RESULT_MISSING` | Exact counts must come from the final command output, never an older document. |
| Pester suite | 32 focused readiness tests passed | `LOCAL_PESTER_RESULT_MISSING` | The focused result is not a full-suite promotion receipt; the final full-suite count remains pending. |
| Server-action check | pending current-SHA receipt | `LOCAL_CHECK_SERVER_ACTIONS_RESULT_MISSING` | Required as its own matrix row. |
| Client-redirect check | pending current-SHA receipt | `LOCAL_CHECK_CLIENT_REDIRECTS_RESULT_MISSING` | Required as its own matrix row. |
| Test-fixture check | pending current-SHA receipt | `LOCAL_CHECK_TEST_FIXTURES_RESULT_MISSING` | Required as its own matrix row. |
| Protected environment | missing | `PROTECTED_ENVIRONMENT_EVIDENCE_MISSING` | Workflow YAML cannot prove GitHub Environment reviewer or branch protection. |
| Remote staging receipt | missing | `REMOTE_STAGING_RECEIPT_MISSING` | No remote endpoint was contacted. A passing receipt must attest the current worker artifact and heartbeat. |
| Dedicated mailbox | missing | `DEDICATED_MAILBOX_EVIDENCE_MISSING` | No mailbox identity was supplied or contacted. |
| Graph canary receipt | missing | `GRAPH_CANARY_RECEIPT_MISSING` | Local mocks are not Graph read-after-write evidence. |
| Same-key replay | missing | `REPLAY_RESULT_MISSING` | No independent exact-one-draft receipt exists. |
| Rollback | missing | `ROLLBACK_RESULT_MISSING` | The staging flag was not changed and no deployment was rolled back. |
| PR review | missing | `PR_REVIEW_MISSING` | No branch was pushed and no pull request was opened or reviewed. |

The exact final-HEAD counts and all three named code-check results belong in the
sanitized local validation receipt
defined by
[`inbox-zero-promotion-evidence-contract.md`](inbox-zero-promotion-evidence-contract.md).
That receipt is tied to one full commit SHA and remains outside Git. The checker
copies those counts into the `full_test`, `integration`, and `pester` matrix rows;
it rejects missing, malformed, failed, or stale results instead of carrying
forward historical numbers.

## Protected promotion boundary

The only staging environment name is `coastline-inbox-zero-staging`. Promotion
requires the `refs/heads/main` deployment branch rule, exact
`COASTLINE_INBOX_ZERO_PROTECTED_SHA`, at least one configured required reviewer,
self-review prevention, the named secrets and variables in the evidence
contract, and an out-of-repository configuration receipt. The `if` guards and
ref-check script in the workflow complement GitHub Environment protection; they
do not establish or replace it.

## Data and system boundary

- Raw validation output, staging/canary/replay/rollback receipts, environment
  configuration snapshots, and PR review exports stay outside Git.
- Receipts must not contain credentials, OAuth material, mailbox addresses,
  message bodies, subjects, cookies, or raw source-system records.
- This Task 5 refresh contacted no remote endpoint, Microsoft Graph resource,
  mailbox, GitHub environment, deployment target, or production system.
- Tasks 1–4 remain draft-only, no-send, and no-delete. Their durable marker
  recovery, recipient-bucket validation, mutation/scope gates, and remote
  evidence endpoint are unchanged.
- Any supplied remote staging, canary, replay, and rollback receipt must use
  one current promotion nonce. Their fresh timestamps must be ordered from
  remote staging through canary/replay and then rollback. A legacy
  current-SHA-only rollback record is blocked evidence.

## Next safe action

Complete the exact local validation set and retain its sanitized current-SHA
receipt outside Git. Promotion still requires a separately authorized Task 6
run that first verifies the protected environment, then captures remote staging,
dedicated-mailbox canary, exact-one-draft replay, rollback, and reviewed-PR
evidence. Until every matrix row passes for the same SHA, retain `pilot-only` or
`blocked` with the checker's reason codes.
