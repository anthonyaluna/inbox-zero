# Inbox Zero Coastline Promotion Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining review findings and produce independently verifiable staging, canary, rollback, and readiness evidence for the Coastline Microsoft draft-only lane.

**Architecture:** Keep the existing Inbox Zero execution path, Prisma/Postgres, Microsoft provider, safe-action middleware, cron route, and staging verifier. Add one durable Coastline idempotency ledger keyed by account plus idempotency key, one exact recipient-bucket comparator, one shared mutation gate for server actions and direct routes, and one remotely served staging-evidence contract. Promotion remains fail-closed until protected GitHub environment configuration, remote staging proof, a dedicated Microsoft test mailbox canary, same-key replay, rollback, and reviewed PR evidence all exist.

**Tech Stack:** Next.js 16, TypeScript, Prisma/Postgres, Microsoft Graph provider, PowerShell, GitHub Actions, Vitest, integration tests, Pester, Docker/self-hosting runtime.

## Owner, rail, and source map

- Owner/rail: Inbox Zero runtime hardening; Aiden Rivera owns cross-functional routing and promotion preflight.
- Source of truth: the Inbox Zero branch, Prisma schema, Microsoft provider implementation, protected GitHub environment, remote staging deployment, and sanitized receipts outside Git.
- Review inputs: `docs/operations/inbox-zero-operational-readiness.md`, `.superpowers/sdd/2026-08-11-inbox-zero-operationalization/final-fix-report.md`, and the scoped review package for `d999fb4a2..02a1c6f30`.
- Existing rails to reuse: `ExecutedAction`, `draftContextMetadata`, `safe-action.ts`, `/api/cron/scheduled-actions`, `Verify-CoastlineInboxZeroStaging.ps1`, the current canary runner, and existing CI workflows.

## Global constraints

- Microsoft remains draft-only: no send, delete, archive, mark-read, move, unsubscribe, rule creation, rule update, rule deletion, or shared AP mailbox mutation.
- No message bodies, OAuth tokens, cookies, mailbox addresses, raw source records, runtime logs, or receipts enter Git.
- A same-key replay must reconcile one existing draft or fail closed; it must never create a second provider draft.
- A `created_verified` terminal state requires exact provider readback and independent database readback.
- Scope validation requires the exact allowlist `openid profile email User.Read offline_access Mail.ReadWrite`; any missing or additional scope, including `Mail.Send`, fails closed.
- Staging evidence must come from the deployed remote artifact, not local Docker, local Git state, or a local checkout SHA.
- Real mailbox execution requires a dedicated non-production test mailbox, protected executor identity, rollback path, and explicit staging authorization. No production mailbox is in scope.
- Keep work on `codex/inbox-zero-operationalization`; do not push, merge, deploy, or contact Microsoft Graph until the task's stated gate is satisfied.

## Definition of done

The lane is promotion-ready only when all of the following have evidence:

1. Two independent action rows using one account and one idempotency key reconcile to one durable reservation and one provider draft.
2. A crash or persistence failure after provider creation is recoverable by a later run using the durable reservation and provider draft ID.
3. To, CC, and BCC are compared as separate normalized buckets; cross-bucket matches do not verify.
4. Direct unsubscribe and mobile rule routes reject under Coastline mode before provider or database mutation, with route-level tests.
5. The connected canary identity proves the exact scope set, not only absence of `Mail.Send`.
6. The deployed `/api/coastline/staging-evidence` endpoint returns nonce-bound remote artifact, worker, queue, and cron evidence and is consumed by the verifier.
7. Readiness documentation identifies the current commit and current validation results.
8. A protected staging deployment produces a passing receipt, a dedicated-mailbox draft-only canary produces a sanitized receipt, same-key replay produces no second draft, and rollback is exercised without deleting mailbox data.
9. Full local validation, scoped review, and PR review are complete. Until then, the terminal state is `pilot-only` or `blocked`, never `ready`.

---

### Task 1: Make idempotency global across action rows and crash-recoverable

**Files:**
- Modify: `apps/web/prisma/schema.prisma` near `model ExecutedAction`
- Create: `apps/web/prisma/migrations/<timestamp>_add_coastline_draft_reservations/migration.sql`
- Modify: `apps/web/utils/ai/choose-rule/draft-management.ts`
- Modify: `apps/web/utils/ai/choose-rule/execute.ts`
- Test: `apps/web/utils/ai/choose-rule/draft-management.test.ts`
- Test: `apps/web/utils/ai/choose-rule/execute.test.ts`
- Create: `apps/web/utils/coastline/draft-reservation.ts`
- Test: `apps/web/utils/coastline/draft-reservation.test.ts`

**Interfaces:**
- Consumes: `InboxZeroDraftProposal`, `ExecutedAction`, the current provider `getDraft`/`draftEmail` methods, and the existing receipt parser.
- Produces: `reserveOrReconcileCoastlineDraft(input): Promise<{ reservationId: string; draftId: string | null; state: "reserved" | "created_unverified" | "created_verified" | "recovery_required" }>` and `reconcileCoastlineDraft(input): Promise<{ draftId: string; terminalState: "created_verified" }>`.

- [ ] **Step 1: Write failing cross-action tests.**

Add tests that create two distinct action IDs with the same `accountId` and `idempotency_key`, then assert the second call returns the first reservation and never calls `draftEmail`. Add a crash test where the provider returns a draft ID but the action-row update fails; the next action row must find the durable reservation, read the draft back, and finish verification without creating another draft. Add a conflict test for the same key with a different proposal fingerprint.

- [ ] **Step 2: Add the durable reservation model and unique index.**

Create a Prisma model with `id`, timestamps, `accountId`, `idempotencyKey`, proposal identity fields (`threadId`, `sourceMessageId`), a proposal fingerprint, `executedActionId`, nullable `draftId`, terminal state, and recoverable error code. Add a unique constraint on `[accountId, idempotencyKey]` and indexes for `draftId` and terminal state. The model must contain no subject, body, recipients, or token values.

- [ ] **Step 3: Implement atomic reserve-or-reconcile.**

Use `upsert` or a transaction with the unique constraint so a new action row cannot create a second reservation. Reject a fingerprint mismatch with `COASTLINE_DRAFT_IDEMPOTENCY_CONFLICT`. When a reservation has a draft ID but is not verified, call the independent provider readback path and persist `created_verified`; when it has no draft ID, allow exactly one creator to proceed and make all concurrent callers wait/reconcile rather than create.

- [ ] **Step 4: Link the action row without making it the source of truth.**

Keep `draftId`, `draftStatus`, and sanitized `draftContextMetadata` for compatibility and audit display, but read the durable reservation first. Persist the action-row link after provider creation and preserve `COASTLINE_DRAFT_RECOVERY_REQUIRED` when the reservation is ambiguous.

- [ ] **Step 5: Run migration and focused tests.**

```powershell
pnpm.cmd --filter inbox-zero-ai exec prisma validate --schema apps/web/prisma/schema.prisma
pnpm.cmd --filter inbox-zero-ai exec vitest run utils/coastline/draft-reservation.test.ts utils/ai/choose-rule/draft-management.test.ts utils/ai/choose-rule/execute.test.ts
git diff --check
```

Expected: all new reservation, crash-recovery, conflict, and existing receipt tests pass; no mailbox or provider endpoint is contacted.

- [ ] **Step 6: Commit the durable idempotency rail.**

```powershell
git add apps/web/prisma/schema.prisma apps/web/prisma/migrations apps/web/utils/coastline/draft-reservation.ts apps/web/utils/coastline/draft-reservation.test.ts apps/web/utils/ai/choose-rule/draft-management.ts apps/web/utils/ai/choose-rule/draft-management.test.ts apps/web/utils/ai/choose-rule/execute.ts apps/web/utils/ai/choose-rule/execute.test.ts
git commit -m "fix: make Coastline draft idempotency global"
```

### Task 2: Enforce exact To, CC, and BCC readback

**Files:**
- Modify: `apps/web/utils/ai/choose-rule/draft-management.ts`
- Test: `apps/web/utils/ai/choose-rule/draft-management.test.ts`
- Modify: `apps/web/utils/coastline/draft-proposal.ts` only if the proposal bucket types need a named export
- Test: `apps/web/utils/coastline/draft-proposal.test.ts`

**Interfaces:**
- Consumes: provider draft headers and proposal `to`, `cc`, and `bcc` arrays.
- Produces: `normalizeRecipientBuckets(input): { to: string[]; cc: string[]; bcc: string[] }` and an assertion that compares each bucket independently after case/whitespace normalization.

- [ ] **Step 1: Add failing bucket-isolation tests.**

Test exact same-bucket success, a To-versus-BCC mismatch failure, a CC-versus-To mismatch failure, duplicate address normalization, and empty optional CC/BCC buckets. Assert failures use a stable readback error and do not serialize recipient values into logs or receipts.

- [ ] **Step 2: Implement bucket-preserving normalization.**

Normalize each bucket independently, sort only within that bucket, and compare `{to, cc, bcc}` as a structured value. Never flatten the buckets into one list.

- [ ] **Step 3: Run focused readback tests and commit.**

```powershell
pnpm.cmd --filter inbox-zero-ai exec vitest run utils/ai/choose-rule/draft-management.test.ts utils/coastline/draft-proposal.test.ts
git diff --check
git add apps/web/utils/ai/choose-rule/draft-management.ts apps/web/utils/ai/choose-rule/draft-management.test.ts apps/web/utils/coastline/draft-proposal.ts apps/web/utils/coastline/draft-proposal.test.ts
git commit -m "fix: preserve recipient classes in draft readback"
```

### Task 3: Close direct mutation routes and require the exact Microsoft scope set

**Files:**
- Modify: `apps/web/utils/coastline/draft-only-policy.ts`
- Modify: `apps/web/utils/actions/safe-action.ts`
- Modify: `apps/web/utils/actions/unsubscriber.ts`
- Modify: `apps/web/app/api/mobile/rules/route.ts`
- Modify: `apps/web/utils/outlook/scopes.ts`
- Modify: `scripts/Run-CoastlineInboxZeroMicrosoftCanary.ps1`
- Modify: `scripts/Invoke-CoastlineInboxZeroPreflight.ps1`
- Test: `apps/web/utils/coastline/draft-only-policy.test.ts`
- Test: `apps/web/utils/actions/assistant-chat.server-action-boundary.test.ts` or the closest route-boundary test
- Create: `apps/web/app/api/mobile/rules/route.test.ts`
- Test: `apps/web/utils/outlook/client.test.ts`
- Test: `scripts/tests/CoastlineInboxZeroPreflight.Tests.ps1`
- Test: `scripts/tests/Run-CoastlineInboxZeroMicrosoftCanary.Tests.ps1`

**Interfaces:**
- Consumes: `COASTLINE_DRAFT_PROPOSALS_ENABLED`, route metadata, and the connected scope identity.
- Produces: `assertCoastlineMutationAllowed({ surface, mutation }): void` plus `parseExactMicrosoftScopes(value): string[]` that accepts exactly `openid profile email User.Read offline_access Mail.ReadWrite` and rejects missing, extra, duplicate, or `Mail.Send` entries.

- [ ] **Step 1: Add failing route-level mutation tests.**

With Coastline mode enabled, call the unsubscribe action and `POST /api/mobile/rules` using mocked auth/provider/database layers. Assert a stable policy error before `createEmailProvider`, `unsubscribeSenderAndMark`, `setSenderStatusWithAutoArchive`, `aiPromptToRules`, or `createRuleAction` runs. Add a normal-mode test proving existing Inbox Zero behavior remains available when the flag is false.

- [ ] **Step 2: Centralize the mutation decision.**

Route every direct mutation surface through the same pure policy used by safe actions. The route guard must run before parsing AI prompts or constructing a provider. Keep the conservative pilot behavior that blocks all server actions unless a reviewed allowlist is explicitly introduced.

- [ ] **Step 3: Add exact scope parsing and connected-identity checks.**

Use one sorted exact set in TypeScript, PowerShell preflight, and canary runner. Reject duplicate scopes, unknown scopes, missing required scopes, and any `Mail.Send`. The canary must validate the independent verifier's returned scope set against the exact expected set, not only blacklist `Mail.Send`.

- [ ] **Step 4: Run focused route and scope tests and commit.**

```powershell
pnpm.cmd --filter inbox-zero-ai exec vitest run utils/coastline/draft-only-policy.test.ts utils/outlook/client.test.ts app/api/mobile/rules/route.test.ts utils/actions/assistant-chat.server-action-boundary.test.ts
Invoke-Pester -Script scripts/tests/CoastlineInboxZeroPreflight.Tests.ps1,scripts/tests/Run-CoastlineInboxZeroMicrosoftCanary.Tests.ps1 -PassThru
git diff --check
git add apps/web/utils/coastline/draft-only-policy.ts apps/web/utils/actions/safe-action.ts apps/web/utils/actions/unsubscriber.ts apps/web/app/api/mobile/rules/route.ts apps/web/app/api/mobile/rules/route.test.ts apps/web/utils/outlook/scopes.ts apps/web/utils/outlook/client.test.ts scripts/Run-CoastlineInboxZeroMicrosoftCanary.ps1 scripts/Invoke-CoastlineInboxZeroPreflight.ps1 scripts/tests/CoastlineInboxZeroPreflight.Tests.ps1 scripts/tests/Run-CoastlineInboxZeroMicrosoftCanary.Tests.ps1 apps/web/utils/coastline/draft-only-policy.test.ts apps/web/utils/actions/assistant-chat.server-action-boundary.test.ts
git commit -m "fix: close Coastline mutation and scope gates"
```

### Task 4: Serve remote staging evidence from the deployed artifact

**Files:**
- Create: `apps/web/app/api/coastline/staging-evidence/route.ts`
- Create: `apps/web/app/api/coastline/staging-evidence/route.test.ts`
- Create: `apps/web/utils/coastline/staging-evidence.ts`
- Create: `apps/web/utils/coastline/staging-evidence.test.ts`
- Modify: `scripts/Verify-CoastlineInboxZeroStaging.ps1`
- Modify: `scripts/tests/CoastlineInboxZeroPreflight.Tests.ps1`
- Modify: `docs/hosting/coastline-draft-only-pilot.mdx`
- Modify: `docs/hosting/production-operations.mdx`
- Modify: `.github/workflows/coastline-staging-preflight.yml`

**Interfaces:**
- Consumes: authenticated `CRON_SECRET`, `run_nonce`, deployed artifact SHA, remote worker registration, queue health, and the cron evidence ID generated by the deployed route.
- Produces: `coastline_inbox_zero_remote_staging_evidence.v1` with exactly `artifactSha`, `cronEvidenceId`, `observedAt`, `queueIdentity`, `queueStatus`, `runNonce`, `schemaVersion`, `workerIdentity`, and `workerStatus`.

- [ ] **Step 1: Write the endpoint contract tests.**

Test unauthenticated `401`, missing or malformed nonce `400`, stale nonce rejection, exact property set, artifact SHA mismatch rejection, worker not running rejection, queue not reachable rejection, and successful evidence from mocked remote runtime bindings. Assert no secrets or queue connection strings appear in the response.

- [ ] **Step 2: Implement remote-only runtime evidence.**

Read the artifact SHA from the deployment's protected immutable variable, worker identity from the running worker registration, and queue identity/status from the deployed queue client. Do not use `git`, local Docker, `docker compose`, or a caller-supplied SHA. Bind the response to the nonce and the authenticated cron evidence ID.

- [ ] **Step 3: Make the verifier require the endpoint.**

Keep loopback and exact protected-origin checks, but remove any implication that local service state is staging evidence. Require the endpoint response to match the protected SHA and current nonce, and emit a failed receipt when the endpoint is absent or externally mismatched.

- [ ] **Step 4: Document deployment bindings without committing secrets.**

Document the protected variables and environment contract, including the GitHub environment name, immutable artifact SHA, worker identity source, queue identity source, cron credential, and endpoint route. State that a local or emulator pass is not a staging pass.

- [ ] **Step 5: Run endpoint, verifier, and build checks and commit.**

```powershell
pnpm.cmd --filter inbox-zero-ai exec vitest run app/api/coastline/staging-evidence/route.test.ts utils/coastline/staging-evidence.test.ts app/api/cron/scheduled-actions/route.test.ts
Invoke-Pester -Script scripts/tests/CoastlineInboxZeroPreflight.Tests.ps1 -PassThru
pnpm.cmd --filter inbox-zero-ai run build:ci
git diff --check
git add apps/web/app/api/coastline/staging-evidence apps/web/utils/coastline/staging-evidence.ts apps/web/utils/coastline/staging-evidence.test.ts scripts/Verify-CoastlineInboxZeroStaging.ps1 scripts/tests/CoastlineInboxZeroPreflight.Tests.ps1 docs/hosting/coastline-draft-only-pilot.mdx docs/hosting/production-operations.mdx .github/workflows/coastline-staging-preflight.yml
git commit -m "ops: expose remote Inbox Zero staging evidence"
```

### Task 5: Refresh readiness evidence and promotion controls

**Files:**
- Modify: `docs/operations/inbox-zero-operational-readiness.md`
- Modify: `docs/hosting/coastline-draft-only-pilot.mdx`
- Modify: `.github/workflows/coastline-staging-preflight.yml`
- Modify: `.github/workflows/test.yml`
- Create: `docs/operations/inbox-zero-promotion-evidence-contract.md`
- Create: `scripts/Assert-CoastlineInboxZeroReadiness.ps1`
- Test: `scripts/tests/CoastlineInboxZeroReadiness.Tests.ps1`

**Interfaces:**
- Consumes: current commit SHA, exact validation commands, sanitized local receipts, protected GitHub environment configuration, and remote staging/canary receipts.
- Produces: a readiness record with one of `ready`, `pilot-only`, or `blocked`, plus a machine-checkable evidence matrix tied to the current commit.

- [ ] **Step 1: Add failing readiness freshness tests.**

Assert that the readiness document names the current commit, records the exact post-fix suite counts, does not claim a staging or Graph canary pass without receipt files, and stays `pilot-only` when the remote endpoint, protected environment, or dedicated mailbox evidence is absent.

- [ ] **Step 2: Implement the evidence matrix and freshness checker.**

Require current SHA, build result, full-test result, integration result, Pester result, remote staging receipt, canary receipt, replay result, rollback result, and PR review state. A missing item must produce `pilot-only` or `blocked` with a stable reason code.

- [ ] **Step 3: Document GitHub protected-environment requirements.**

Record the exact environment name `coastline-inbox-zero-staging`, protected branch rule, `COASTLINE_INBOX_ZERO_PROTECTED_SHA`, required reviewers, secret names, and the fact that workflow guards complement rather than replace environment protection. Do not store values.

- [ ] **Step 4: Run readiness and repository validation and commit.**

```powershell
pwsh -File scripts/Assert-CoastlineInboxZeroReadiness.ps1 -ExpectedSha (git rev-parse HEAD)
pnpm.cmd --filter inbox-zero-ai run build:ci
pnpm.cmd --filter inbox-zero-ai test -- --run
pnpm.cmd --filter inbox-zero-ai test-integration
pnpm.cmd --filter inbox-zero-ai run check-server-actions
pnpm.cmd --filter inbox-zero-ai run check-client-redirects
pnpm.cmd --filter inbox-zero-ai run check-test-fixtures
Invoke-Pester -Script scripts/tests -PassThru
git diff --check
```

- [ ] **Step 5: Commit the evidence refresh.**

```powershell
git add docs/operations/inbox-zero-operational-readiness.md docs/hosting/coastline-draft-only-pilot.mdx docs/operations/inbox-zero-promotion-evidence-contract.md scripts/Assert-CoastlineInboxZeroReadiness.ps1 scripts/tests/CoastlineInboxZeroReadiness.Tests.ps1 .github/workflows/coastline-staging-preflight.yml .github/workflows/test.yml
git commit -m "docs: bind Inbox Zero readiness to current evidence"
```

### Task 6: Execute protected staging, canary, replay, and rollback

**Files:**
- Modify: `docs/operations/inbox-zero-microsoft-staging-canary.md`
- Modify: `docs/operations/inbox-zero-operational-readiness.md`
- Create outside Git: sanitized staging receipt, canary receipt, replay receipt, rollback receipt
- Review: `scripts/Invoke-CoastlineInboxZeroPreflight.ps1`, `scripts/Verify-CoastlineInboxZeroStaging.ps1`, `scripts/Run-CoastlineInboxZeroMicrosoftCanary.ps1`

**Interfaces:**
- Consumes: protected GitHub environment, exact approved SHA, remote staging endpoint, dedicated test mailbox, protected executor registration, and approved cron credential.
- Produces: four sanitized receipts outside Git and a readiness decision tied to the deployed SHA.

- [ ] **Step 1: Verify protected deployment prerequisites before any mailbox action.**

Confirm the GitHub environment restricts deployment to `main`, `COASTLINE_INBOX_ZERO_PROTECTED_SHA` equals the intended 40-character commit, the remote base URL is exact, the remote evidence endpoint is deployed, worker and queue identities are present, and the dedicated mailbox is not a shared AP, owner, resident, tenant, or production operations mailbox. If any check fails, stop with `blocked` and do not contact Graph.

- [ ] **Step 2: Deploy the exact approved artifact and capture remote staging evidence.**

Run the protected workflow at the approved SHA. Execute the preflight and verifier against the exact staging origin. Retain the receipt outside Git and verify the artifact SHA, worker identity, queue identity, authenticated cron evidence, nonce, and timestamps.

- [ ] **Step 3: Run one dedicated-mailbox draft canary.**

Use one known source message and fixed test recipient. Confirm the connected account, tenant, mailbox hash, exact scope set, executor registration, and no-send evidence before invoking `DRAFT_EMAIL`. Independently read the returned draft through Graph, verify draft/thread identity, exact subject/body, and separate To/CC/BCC buckets, then retain only the sanitized receipt.

- [ ] **Step 4: Replay the same idempotency key and reconcile.**

Run the same proposal again from a distinct action row. Assert the durable reservation returns the original draft ID, Graph reports exactly one matching draft, and no second draft was created. A duplicate, reservation conflict, or failed independent readback is a failed canary.

- [ ] **Step 5: Exercise rollback without mailbox deletion.**

Disable the Coastline flag, restart or roll back the staging artifact, rerun health and verifier checks, and confirm the draft-only action is unavailable while the existing draft remains untouched. Re-enable only after the rollback receipt is complete.

- [ ] **Step 6: Update readiness and stop at the evidence boundary.**

Set `ready` only if all receipts, same-key replay, rollback, protected environment, and PR review are present. Otherwise write `pilot-only` or `blocked` with exact missing reason codes. Do not label the lane production-ready from a local HTTP 200 or mocked canary.

### Task 7: Final review and handoff

**Files:**
- Review: all files changed by Tasks 1–6
- Modify: `docs/operations/inbox-zero-operational-readiness.md`
- Create outside Git: final sanitized review packet

- [ ] **Step 1: Run the complete local validation set on the exact commit.**

```powershell
pnpm.cmd --filter inbox-zero-ai run build:ci
pnpm.cmd --filter inbox-zero-ai test -- --run
pnpm.cmd --filter inbox-zero-ai test-integration
pnpm.cmd --filter inbox-zero-ai run check-server-actions
pnpm.cmd --filter inbox-zero-ai run check-client-redirects
pnpm.cmd --filter inbox-zero-ai run check-test-fixtures
Invoke-Pester -Script scripts/tests -PassThru
python -m coastline_agentic_os validate
git diff --check
git status --short --branch
```

Classify the Coastline parent-repository validation separately if it reports unrelated control-surface errors; it does not substitute for Inbox Zero staging or Graph evidence.

- [ ] **Step 2: Run a fresh scoped whole-branch review.**

Review the final commit range for global idempotency, recipient-bucket integrity, every mutation surface, exact scopes, remote receipt binding, readiness freshness, secret hygiene, and no production claims. A `ready` label is invalid without the external receipts.

- [ ] **Step 3: Produce the handoff packet.**

Include branch, exact commit, files changed, validation commands, receipt locations outside Git, protected environment state, production systems touched (`none` unless the explicitly authorized staging canary ran), open limitations, rollback result, and the next safe action. Do not include credentials, mailbox content, or raw source records.

- [ ] **Step 4: Keep integration decisions explicit.**

Do not push, open a PR, merge, or promote without explicit authorization after the review packet is complete. If the user chooses to keep the branch local, preserve the worktree and report the exact branch and path.

## Self-review checklist

- [ ] Each final reviewer finding maps to a task: global idempotency (Task 1), recipient buckets (Task 2), mutation/scope gate (Task 3), remote evidence endpoint (Task 4), stale readiness and protected environment (Task 5), real staging/canary/rollback (Task 6), final proof (Task 7).
- [ ] The plan reuses existing provider, Prisma compatibility fields, safe-action rail, cron route, verifier, canary runner, and CI workflows.
- [ ] No task authorizes send, delete, archive, mark-read, move, unsubscribe, rule mutation, payment, legal action, or production mailbox access.
- [ ] Every external action has a prerequisite check, exact identity, idempotency key, independent readback, receipt, and rollback/correction path.
- [ ] Missing remote or mailbox evidence keeps the terminal state `pilot-only` or `blocked`.
- [ ] No placeholder wording, unbound owner, or untested interface remains.
