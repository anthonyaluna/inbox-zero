import { describe, expect, it } from "vitest";
import {
  assertDraftOnlyProposal,
  buildDraftIdempotencyKey,
  createInboxZeroDraftProposal,
  parseInboxZeroDraftProposal,
  toCoastlineOutlookDraftRequest,
} from "./draft-proposal";

const baseInput = {
  provider: "microsoft" as const,
  account_id: "account-123",
  thread_id: "thread-456",
  source_message_id: "message-789",
  to: ["bond@example.com"],
  cc: [],
  bcc: [],
  subject: "Security update",
  body_text: "I am looking into this and will follow up.",
  confidence: "medium" as const,
  model: "local-eval-model",
  idempotency_key: buildDraftIdempotencyKey({
    accountId: "account-123",
    threadId: "thread-456",
    sourceMessageId: "message-789",
  }),
  generated_at: "2026-08-11T12:00:00.000Z",
};

describe("Inbox Zero draft proposal contract", () => {
  it("creates a versioned Microsoft draft-only proposal", () => {
    const proposal = createInboxZeroDraftProposal(baseInput);

    expect(proposal.schema_version).toBe("inbox_zero_draft_proposal.v1");
    expect(proposal.source).toBe("inbox_zero");
    expect(proposal.action).toBe("draft_only");
  });

  it("maps only to the existing Outlook draft action", () => {
    const request = toCoastlineOutlookDraftRequest(
      createInboxZeroDraftProposal(baseInput),
    );

    expect(request.action).toBe("outlook_draft_create");
    expect(request.draftOnly).toBe(true);
    expect(request.externalMessage).toBe(false);
    expect(request.idempotencyKey).toContain("inbox-zero/draft");
  });

  it("rejects send, archive, and unknown fields at the boundary", () => {
    expect(() =>
      parseInboxZeroDraftProposal({ ...baseInput, action: "send" }),
    ).toThrow();
    expect(() =>
      parseInboxZeroDraftProposal({ ...baseInput, archive: true }),
    ).toThrow();
  });

  it("requires the idempotency key to match the source IDs", () => {
    const proposal = createInboxZeroDraftProposal(baseInput);
    expect(() =>
      parseInboxZeroDraftProposal({ ...proposal, idempotency_key: "wrong" }),
    ).toThrow(/idempotency_key/);
  });

  it("produces a stable key for the same source message", () => {
    const first = buildDraftIdempotencyKey({
      accountId: "a",
      threadId: "t",
      sourceMessageId: "m",
    });
    const second = buildDraftIdempotencyKey({
      accountId: "a",
      threadId: "t",
      sourceMessageId: "m",
    });

    expect(first).toBe(second);
  });

  it("supports an assertion guard for adapter callers", () => {
    const proposal = createInboxZeroDraftProposal(baseInput);
    expect(() => assertDraftOnlyProposal(proposal)).not.toThrow();
  });
});
