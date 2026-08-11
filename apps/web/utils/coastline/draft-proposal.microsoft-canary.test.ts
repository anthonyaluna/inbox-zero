import { describe, expect, it } from "vitest";
import {
  parseInboxZeroMicrosoftCanaryReceipt,
  type InboxZeroMicrosoftCanaryReceipt,
} from "./draft-proposal";

const mockedVerifiedReceipt: InboxZeroMicrosoftCanaryReceipt = {
  schemaVersion: "inbox_zero_microsoft_canary_receipt.v1",
  provider: "microsoft",
  action: "draft_only",
  accountId: "dedicated-canary-account",
  threadId: "canary-thread",
  sourceMessageId: "known-source-message",
  draftId: "created-draft",
  idempotencyKey:
    "inbox-zero/draft/dedicated-canary-account/canary-thread/known-source-message",
  graphReadbackStatus: "verified",
  scopeIdentity: "delegated:Mail.ReadWrite,User.Read",
  noSendCapability: "Mail.Send_absent",
  idempotencyReplay: "existing_draft_reconciled",
  terminalState: "created_verified",
  generatedAt: "2026-08-11T12:00:00.000Z",
  executorRegistrationId: "coastline-microsoft-draft-canary-v1",
  executorProvenanceSha256:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  connectedIdentityEvidenceId: "identity-evidence-001",
  grantedScopesEvidenceId: "scope-evidence-001",
  noSendEvidenceId: "no-send-evidence-001",
  graphReadbackEvidenceId: "graph-readback-evidence-001",
  replayGraphReadbackEvidenceId: "replay-graph-readback-evidence-001",
  noDuplicateEvidenceId: "no-duplicate-evidence-001",
  idempotencyDraftCount: 1,
};

describe("Microsoft draft-only canary receipt contract", () => {
  it("accepts the mocked sanitized result after Graph draft readback and replay", () => {
    expect(parseInboxZeroMicrosoftCanaryReceipt(mockedVerifiedReceipt)).toEqual(
      mockedVerifiedReceipt,
    );
  });

  it("rejects message content and OAuth values from persisted canary output", () => {
    for (const prohibitedField of [
      "body",
      "bodyText",
      "subject",
      "to",
      "accessToken",
      "refreshToken",
      "cookie",
    ]) {
      expect(() =>
        parseInboxZeroMicrosoftCanaryReceipt({
          ...mockedVerifiedReceipt,
          [prohibitedField]: "must-not-persist",
        }),
      ).toThrow();
    }
  });

  it("rejects a receipt that cannot prove Mail.Send absence or replay safety", () => {
    expect(() =>
      parseInboxZeroMicrosoftCanaryReceipt({
        ...mockedVerifiedReceipt,
        noSendCapability: "Mail.Send_present",
      }),
    ).toThrow();
    expect(() =>
      parseInboxZeroMicrosoftCanaryReceipt({
        ...mockedVerifiedReceipt,
        idempotencyReplay: "second_draft_created",
      }),
    ).toThrow();
  });

  it("rejects content-like, credential-like, oversized, and malformed receipt values", () => {
    for (const invalidValue of [
      "Subject: private message",
      "Bearer secret-token",
      "recipient@example.com",
      "x".repeat(513),
    ]) {
      expect(() =>
        parseInboxZeroMicrosoftCanaryReceipt({
          ...mockedVerifiedReceipt,
          draftId: invalidValue,
        }),
      ).toThrow();
    }
    expect(() =>
      parseInboxZeroMicrosoftCanaryReceipt({
        ...mockedVerifiedReceipt,
        generatedAt: "not-a-timestamp",
      }),
    ).toThrow();
  });

  it("requires the independently attested idempotency draft count to be exactly one", () => {
    expect(() =>
      parseInboxZeroMicrosoftCanaryReceipt({
        ...mockedVerifiedReceipt,
        idempotencyDraftCount: 2,
      }),
    ).toThrow();
    expect(() => {
      const { idempotencyDraftCount, ...missing } = mockedVerifiedReceipt;
      parseInboxZeroMicrosoftCanaryReceipt(missing);
    }).toThrow();
    expect(() =>
      parseInboxZeroMicrosoftCanaryReceipt({
        ...mockedVerifiedReceipt,
        noDuplicateEvidenceId: "recipient@example.com",
      }),
    ).toThrow();
  });
});
