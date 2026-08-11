# Inbox Zero Coastline Operationalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the Inbox Zero fork from a local Windows pilot to a proof-backed staging deployment and then a controlled Coastline Microsoft draft-only production lane.

**Architecture:** Keep Inbox Zero as the application runtime and Microsoft provider of record. Extend the existing `DRAFT_EMAIL` execution path with a sanitized Coastline proposal/receipt stored through `ExecutedAction.draftContextMetadata`, and use the existing `draftId`/`draftStatus` fields for terminal draft state. Deploy the web app with its existing Postgres, Redis, worker, cron, health, and CI paths; do not create a second mail executor or a parallel queue.

**Tech Stack:** Next.js 16, TypeScript, Prisma/Postgres, Redis/BullMQ or the configured queue backend, Microsoft Graph, Vitest, Playwright, Docker Compose/self-hosting assets, GitHub Actions.

## Global Constraints

- Microsoft scope is draft-only: read mailbox context and create drafts; do not send, delete, archive, mark read, move, unsubscribe, create rules, or modify the shared AP mailbox.
- The Microsoft app registration must exclude `Mail.Send`; use the least-privilege read/write scope required for draft creation and document the exact consented identity.
- No real mailbox canary runs until target mailbox, credential source, rollback path, idempotency key, and independent Graph read-after-write proof are recorded.
- No secrets, OAuth tokens, cookies, mailbox bodies, raw exports, or local emulator state may enter Git.
- Use a new `codex/...` branch from commit `142411092`; do not modify the dirty canonical Coastline checkout or push/merge without explicit approval.
- On Windows, use `pnpm.cmd`; keep local emulator shims and `.env.local` local-only.
- Build and test commands must be repeatable without production credentials; live canary commands must be explicit and separately gated.

## Definition of Done

The lane is operational only when all of these are true:

1. The web build, Prisma migration check, focused adapter tests, full web unit/integration suite, and permitted end-to-end suite pass, with every remaining failure classified in the handoff.
2. A staging deployment starts from a clean artifact, applies migrations once, serves `/api/health`, and has working Postgres, Redis, worker, cron, and Microsoft OAuth callback paths.
3. A real Microsoft draft-only canary creates one draft from a known source message, independently reads that draft back through Graph, records the sanitized receipt, and proves no send call occurred.
4. Replaying the same idempotency key returns or reconciles the existing draft instead of creating a second draft; a failed readback remains non-terminal and is recoverable.
5. Logs and health checks expose only IDs, state, and error codes; no message body or credential is logged.
6. Rollback is exercised in staging by disabling the Coastline flag and reverting the application artifact without deleting mailbox data.
7. The branch has a reviewed PR, deployment receipt, canary receipt, and a clear production boundary. “Operational” is not claimed from a local HTTP 200 alone.

---

### Task 1: Create the operationalization branch and baseline evidence

**Files:**
- Create: `docs/superpowers/plans/2026-08-11-inbox-zero-operationalization.md` (this plan)
- Review: `AGENTS.md`, `README.md`, `docs/hosting/production-operations.mdx`, `docs/hosting/self-hosting.mdx`, `docs/hosting/microsoft-oauth.mdx`, `.github/workflows/build-check.yml`, `.github/workflows/test.yml`, `.github/workflows/e2e-flows.yml`
- Output: local `exports/inbox-zero-operational-baseline.md` (ignored; do not commit)

**Interfaces:**
- Consumes: current fork commit `142411092` and existing hosting/CI contracts.
- Produces: a reproducible baseline with branch, commit, runtime services, test commands, and open blockers.

- [ ] **Step 1: Create the isolated implementation branch.**

```powershell
git switch -c codex/inbox-zero-operationalization
git status --short --branch
```

Expected: the branch starts at `142411092`; the worktree has no tracked changes before implementation.

- [ ] **Step 2: Run the reuse-before-build inventory against the requested operationalization.**

```powershell
python -m coastline_agentic_os reuse-before-build inventory `
  --request "Inbox Zero Microsoft draft-only staging and production operationalization" `
  --output C:\CoastlineAgenticOS\local-only\inbox-zero-reuse-inventory.csv `
  --brief-output C:\CoastlineAgenticOS\local-only\inbox-zero-reuse-brief.md
```

Expected: the inventory identifies existing Inbox Zero provider, receipt, health, hosting, CI, and Coastline adapter rails before new code is added.

- [ ] **Step 3: Capture the baseline without mailbox access.**

```powershell
pnpm.cmd --filter inbox-zero-ai run build:ci
pnpm.cmd --filter inbox-zero-ai exec vitest run utils/coastline/draft-proposal.test.ts utils/ai/actions.test.ts
git diff --check
git status --short --branch
```

Record the exact outputs, current local services, and known TypeScript/Biome warnings in `C:\CoastlineAgenticOS\local-only\inbox-zero-operational-baseline.md`.

- [ ] **Step 4: Commit only the baseline documentation if it contains no private runtime data.**

```powershell
git add docs/superpowers/plans/2026-08-11-inbox-zero-operationalization.md
git commit -m "docs: plan Inbox Zero operationalization"
```

Expected: no `.env.local`, emulator fixture, logs, or source-system data is staged.

### Task 2: Persist a sanitized proposal and terminal receipt

**Files:**
- Modify: `apps/web/utils/ai/reply/draft-context-metadata.ts`
- Modify: `apps/web/utils/ai/choose-rule/draft-management.ts`
- Modify: `apps/web/utils/ai/choose-rule/execute.ts`
- Modify: `apps/web/utils/ai/choose-rule/run-rules.ts`
- Modify: `apps/web/utils/coastline/draft-proposal.ts`
- Test: `apps/web/utils/coastline/draft-proposal.test.ts`
- Test: `apps/web/utils/ai/choose-rule/execute.test.ts` or the closest existing executor test file

**Interfaces:**
- Consumes: `InboxZeroDraftProposal`, `ExecutedAction.draftContextMetadata`, `draftId`, and `draftStatus`.
- Produces: a `coastlineDraft` metadata object containing only schema version, provider, account ID, thread ID, source message ID, idempotency key, target draft ID, generated/read-back timestamps, and terminal state.

- [ ] **Step 1: Define the sanitized metadata schema before changing persistence.**

Add an optional `coastlineDraft` object to `draftContextMetadataSchema` with these exact fields:

```ts
coastlineDraft: z.object({
  schemaVersion: z.literal("inbox_zero_draft_receipt.v1"),
  provider: z.literal("microsoft"),
  accountId: z.string().min(1),
  threadId: z.string().min(1),
  sourceMessageId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  draftId: z.string().min(1),
  generatedAt: z.string().datetime(),
  readBackAt: z.string().datetime().nullable(),
  terminalState: z.enum(["created_verified", "created_unverified", "failed"]),
}).optional()
```

Do not add subject, body, recipient names, OAuth values, or mailbox content to this persisted object.

- [ ] **Step 2: Add a pure receipt builder and parser.**

Export `createInboxZeroDraftReceipt(input)` and `parseInboxZeroDraftReceipt(input)` from `apps/web/utils/coastline/draft-proposal.ts`. The builder must require the validated proposal plus `draftId`, set `readBackAt` to `null` before verification, and never accept a body field.

- [ ] **Step 3: Extend the existing executed-action update path.**

Change `updateExecutedActionWithDraftId` to accept an optional parsed receipt and merge it into existing `draftContextMetadata` without overwriting unrelated draft metadata. Set `draftStatus` to `PENDING` for `created_unverified` and to the existing verified pending state for `created_verified`; keep failures in `executionError` with a stable error code.

- [ ] **Step 4: Persist the receipt only after the draft ID exists.**

In `execute.ts`, validate the proposal, create the provider draft, build the sanitized receipt, and persist it together with `draftId`. On a successful independent readback, update only `readBackAt` and `terminalState`; do not persist the message body.

- [ ] **Step 5: Add tests for persistence, merge behavior, and body exclusion.**

Test that an existing `draftContextMetadata` object survives the merge, that the receipt parser rejects missing IDs or an unexpected provider, and that serialized receipt data contains none of `subject`, `body`, `body_text`, or recipient names.

- [ ] **Step 6: Run the narrow tests and commit.**

```powershell
pnpm.cmd --filter inbox-zero-ai exec vitest run `
  utils/coastline/draft-proposal.test.ts `
  utils/ai/choose-rule/execute.test.ts
git diff --check
git add apps/web/utils/ai/reply/draft-context-metadata.ts `
  apps/web/utils/ai/choose-rule/draft-management.ts `
  apps/web/utils/ai/choose-rule/execute.ts `
  apps/web/utils/ai/choose-rule/run-rules.ts `
  apps/web/utils/coastline/draft-proposal.ts `
  apps/web/utils/coastline/draft-proposal.test.ts
git commit -m "feat: persist Coastline draft receipts"
```

### Task 3: Make Microsoft draft-only behavior fail closed

**Files:**
- Modify: `apps/web/utils/ai/actions.ts`
- Modify: `apps/web/utils/ai/actions.test.ts`
- Review: Microsoft provider implementation and `apps/web/__tests__/e2e/drafting/microsoft-drafting.test.ts`
- Create: `apps/web/utils/coastline/draft-only-policy.ts`
- Test: `apps/web/utils/coastline/draft-only-policy.test.ts`

**Interfaces:**
- Consumes: action type, provider name, `COASTLINE_DRAFT_PROPOSALS_ENABLED`, and Microsoft provider capabilities.
- Produces: `assertCoastlineDraftOnlyAction(input)` that allows only Microsoft `DRAFT_EMAIL` and rejects send, delete, archive, mark-read, move, unsubscribe, rule creation, and non-Microsoft providers when the Coastline flag is enabled.

- [ ] **Step 1: Write policy tests for every prohibited action.**

Cover `SEND_EMAIL`, `REPLY`, `FORWARD`, `ARCHIVE`, `MARK_READ`, `MOVE_FOLDER`, unsubscribe, rule creation, and a Gmail provider. Assert the error contains a stable policy code and the action type, without including message content.

- [ ] **Step 2: Implement the policy as a pure function.**

Keep the policy independent from Prisma, Graph, and Next.js env loading so it can run in unit tests and deployment preflight.

- [ ] **Step 3: Call the policy before any provider mutation.**

Invoke it at the start of the Coastline-enabled action path, before attachments are fetched or `client.draftEmail` is called. Preserve normal Inbox Zero behavior when the Coastline flag is false.

- [ ] **Step 4: Add a negative integration test.**

Run a local Microsoft emulator action with a prohibited action type and assert zero Graph mutation requests were made. Keep the existing positive draft read-after-write fixture.

- [ ] **Step 5: Run and commit the policy hardening.**

```powershell
pnpm.cmd --filter inbox-zero-ai exec vitest run `
  utils/coastline/draft-only-policy.test.ts `
  utils/ai/actions.test.ts `
  utils/coastline/draft-proposal.integration.test.ts
git diff --check
git add apps/web/utils/ai/actions.ts apps/web/utils/ai/actions.test.ts `
  apps/web/utils/coastline/draft-only-policy.ts `
  apps/web/utils/coastline/draft-only-policy.test.ts
git commit -m "feat: enforce Coastline Microsoft draft-only policy"
```

### Task 4: Build a reproducible staging deployment

**Files:**
- Modify: `apps/web/.env.example`
- Modify: `docs/hosting/coastline-draft-only-pilot.mdx`
- Modify: `docs/hosting/production-operations.mdx`
- Review or modify: `docker-compose.yml`, `docker-compose.dev.yml`, `.github/workflows/build-check.yml`, `.github/workflows/test.yml`, `.github/workflows/build_and_publish_docker.yml`
- Create: `scripts/Invoke-CoastlineInboxZeroPreflight.ps1`
- Create: `scripts/Verify-CoastlineInboxZeroStaging.ps1`
- Test: `scripts/tests/CoastlineInboxZeroPreflight.Tests.ps1`

**Interfaces:**
- Consumes: environment variables documented in `docs/hosting/environment-variables.mdx`, the Docker services, and the existing `/api/health` endpoint.
- Produces: a fail-closed staging preflight and a sanitized staging verification receipt.

- [ ] **Step 1: Document the exact staging environment contract.**

Require `DATABASE_URL`, `AUTH_SECRET`, Microsoft client ID/secret, redirect URL, `MICROSOFT_BASE_URL` only for emulators, queue configuration, `CRON_SECRET`, and the Coastline flag. Explicitly set `COASTLINE_DRAFT_PROPOSALS_ENABLED=true` only in staging and keep all send-capable actions disabled by policy.

- [ ] **Step 2: Implement the PowerShell preflight.**

The script must verify clean artifact version, Node 24, pnpm 11, Docker, database reachability, Redis reachability, required non-secret variable presence, Microsoft provider URL, and a disabled `Mail.Send` capability marker. It must print names and hashes only, never values.

- [ ] **Step 3: Implement staging verification.**

The verification script must call `/api/health`, confirm the web response, check the worker/queue process, check the cron authentication path, and emit a JSON receipt with timestamps, commit SHA, service states, and pass/fail codes.

- [ ] **Step 4: Add CI gates.**

Require the web build, focused tests, full test command, preflight script, and `git diff --check` before a staging artifact can be published. Do not put credentials in workflow files; use protected environment secrets.

- [ ] **Step 5: Test the scripts locally and commit.**

```powershell
pwsh -File scripts/Invoke-CoastlineInboxZeroPreflight.ps1 -Mode Local
pwsh -File scripts/Verify-CoastlineInboxZeroStaging.ps1 -BaseUrl http://localhost:3000
pnpm.cmd --filter inbox-zero-ai run build:ci
git diff --check
git add apps/web/.env.example docs/hosting/coastline-draft-only-pilot.mdx `
  docs/hosting/production-operations.mdx scripts/Invoke-CoastlineInboxZeroPreflight.ps1 `
  scripts/Verify-CoastlineInboxZeroStaging.ps1 scripts/tests/CoastlineInboxZeroPreflight.Tests.ps1 `
  .github/workflows/build-check.yml .github/workflows/test.yml
git commit -m "ops: add Coastline Inbox Zero staging preflight"
```

### Task 5: Run the real Microsoft draft-only canary

**Files:**
- Create: `docs/operations/inbox-zero-microsoft-staging-canary.md`
- Create: `scripts/Run-CoastlineInboxZeroMicrosoftCanary.ps1`
- Test: `apps/web/utils/coastline/draft-proposal.microsoft-canary.test.ts` (mocked contract path only)
- Review: `docs/hosting/microsoft-oauth.mdx`, `apps/web/utils/outlook`, `apps/web/utils/ai/actions.ts`

**Interfaces:**
- Consumes: staging URL, approved Microsoft app registration, one dedicated test mailbox, one known source message ID, and the receipt schema from Task 2.
- Produces: a sanitized canary receipt containing account/thread/source/draft IDs, Graph readback status, scope identity, idempotency key, and no message content.

- [ ] **Step 1: Register the Microsoft application for staging.**

Use a dedicated Coastline staging app registration with redirect URI bound to the staging hostname, `Mail.ReadWrite` only if required by the provider, and no `Mail.Send`. Record tenant, client ID, consented scopes, mailbox UPN, and secret expiry in the protected deployment system, not Git.

- [ ] **Step 2: Connect only the dedicated test mailbox.**

Complete OAuth, verify the returned account identity and tenant, and refuse to continue if the mailbox is shared AP, owner, resident, tenant, or production operations mail.

- [ ] **Step 3: Execute one known-message draft.**

Invoke the registered `DRAFT_EMAIL` action with the source message ID and a fixed test recipient. Capture the returned draft ID and idempotency key. Do not invoke `/api/messages/send` or any provider send method.

- [ ] **Step 4: Read the draft back independently through Graph.**

Fetch the exact draft ID using a separate Graph client/request path. Assert `isDraft=true`, target folder is Drafts, subject and recipient match the proposal, and the source/thread IDs in the sanitized receipt match the canary input. Store only the sanitized receipt.

- [ ] **Step 5: Replay the same action.**

Repeat the same idempotency key and verify the system reconciles the existing draft or records a deterministic duplicate-prevention result. Any second draft is a failed canary and blocks promotion.

- [ ] **Step 6: Exercise rollback.**

Set `COASTLINE_DRAFT_PROPOSALS_ENABLED=false` in staging, restart the artifact, rerun the preflight, and confirm the Coastline action path is unavailable while the existing application health endpoint remains healthy. Re-enable only after the canary receipt is archived.

- [ ] **Step 7: Commit the runbook and attach the sanitized receipt outside Git.**

The runbook must state the exact commands, identity verification, terminal proof, rollback result, and the fact that no send call occurred. Do not commit the receipt if it contains source-system identifiers that Coastline policy classifies as private runtime data.

### Task 6: Complete full validation and promotion review

**Files:**
- Modify: `docs/hosting/coastline-draft-only-pilot.mdx`
- Create: `docs/operations/inbox-zero-operational-readiness.md`
- Review: all files changed by Tasks 1–5 and the CI artifacts

**Interfaces:**
- Consumes: build output, test output, staging verification receipt, Microsoft canary receipt, rollback result, and PR review.
- Produces: an explicit `ready`, `blocked`, or `pilot-only` readiness decision with evidence and next action.

- [ ] **Step 1: Run the repository validation set.**

```powershell
pnpm.cmd --filter inbox-zero-ai run build:ci
pnpm.cmd --filter inbox-zero-ai test -- --run
pnpm.cmd --filter inbox-zero-ai test-integration
pnpm.cmd --filter inbox-zero-ai test-e2e:flows
pnpm.cmd --filter inbox-zero-ai run check-server-actions
pnpm.cmd --filter inbox-zero-ai run check-client-redirects
pnpm.cmd --filter inbox-zero-ai run check-test-fixtures
git diff --check
git status --short --branch
```

If a command cannot run in the staging environment, record the exact reason and keep readiness at `pilot-only` until the missing evidence is supplied.

- [ ] **Step 2: Run the Coastline repository validation.**

```powershell
python -m coastline_agentic_os validate
```

This validates the Coastline control surface; it does not substitute for the Microsoft canary or Inbox Zero deployment proof.

- [ ] **Step 3: Complete the readiness document.**

Use these terminal states only:

```text
ready      = staging and canary proof complete, rollback exercised, PR approved
pilot-only = local or emulator proof complete but real staging/canary proof absent
blocked    = required prerequisite failed and autonomous recovery is exhausted
```

List branch, commit, environment, exact tests, receipts, excluded files, production systems touched, and the next safe action.

- [ ] **Step 4: Open the PR without merging or pushing production.**

```powershell
git status --short --branch
git log --oneline --decorate -8
```

Push and open the PR only after explicit approval. The PR description must include the readiness state, no-send proof, rollback result, and known limitations.

## Self-Review Checklist

- [ ] Every task names exact files, interfaces, tests, and a commit boundary.
- [ ] The plan reuses existing Inbox Zero provider, Prisma fields, health endpoint, hosting docs, and CI workflows.
- [ ] No step grants authority to send, move, delete, or alter a production mailbox.
- [ ] No step stores message bodies, credentials, cookies, or raw source records.
- [ ] Build success is separated from live deployment and Graph read-after-write proof.
- [ ] The plan identifies the current warning in `apps/web/utils/recall/client.ts` as a deployment-hardening item rather than ignoring it.
- [ ] The final readiness document can honestly remain `pilot-only` if staging or canary evidence is missing.
