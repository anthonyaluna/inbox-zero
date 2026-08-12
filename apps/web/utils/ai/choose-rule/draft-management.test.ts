import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import {
  handlePreviousDraftDeletion,
  extractDraftPlainText,
  stripQuotedContent,
  isDraftUnmodified,
  createOrReconcileCoastlineDraft,
  updateExecutedActionWithDraftId,
} from "@/utils/ai/choose-rule/draft-management";
import { stripQuotedHtmlContent } from "@/utils/email/parse-message-reply";
import prisma from "@/utils/prisma";
import { ActionType, DraftEmailStatus } from "@/generated/prisma/enums";
import type { ParsedMessage } from "@/utils/types";
import type { EmailProvider } from "@/utils/email/types";
import { createTestLogger } from "@/__tests__/helpers";
import {
  buildDraftIdempotencyKey,
  createInboxZeroDraftProposal,
  createInboxZeroDraftReceipt,
} from "@/utils/coastline/draft-proposal";
import {
  reconcileCoastlineDraft,
  recordCoastlineDraftCreation,
  reserveOrReconcileCoastlineDraft,
} from "@/utils/coastline/draft-reservation";

vi.mock("@/utils/prisma", () => ({
  default: {
    executedAction: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/utils/coastline/draft-reservation", () => ({
  reserveOrReconcileCoastlineDraft: vi.fn(),
  recordCoastlineDraftCreation: vi.fn(),
  reconcileCoastlineDraft: vi.fn(),
  markRecoveryRequired: vi.fn(),
}));

const previousDraftAction = {
  id: "action-111",
  draftId: "draft-222",
  content: "Hello, this is a test draft",
};

const executedRule = {
  id: "rule-123",
  threadId: "thread-456",
  emailAccountId: "account-789",
};

describe("handlePreviousDraftDeletion", () => {
  const mockGetDraft = vi.fn();
  const mockDeleteDraft = vi.fn();
  const mockClient = {
    getDraft: mockGetDraft,
    deleteDraft: mockDeleteDraft,
  } as unknown as EmailProvider;
  const logger = createTestLogger();

  const mockFindFirst = prisma.executedAction.findFirst as Mock;
  const mockUpdate = prisma.executedAction.update as Mock;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should delete unmodified draft and update draft status", async () => {
    mockFindFirst.mockResolvedValue(previousDraftAction);
    mockGetDraft.mockResolvedValue(
      createParsedMessage({
        textPlain:
          "Hello, this is a test draft\n\nOn Monday wrote:\n> Previous message",
        snippet: "Hello, this is a test draft",
      }),
    );

    const result = await handlePreviousDraftDeletion({
      client: mockClient,
      executedRule,
      logger,
    });

    expect(mockFindFirst).toHaveBeenCalledWith({
      where: {
        executedRule: {
          threadId: "thread-456",
          emailAccountId: "account-789",
        },
        type: ActionType.DRAFT_EMAIL,
        draftId: { not: null },
        executedRuleId: { not: "rule-123" },
        draftSendLog: null,
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        draftId: true,
        content: true,
      },
    });

    expect(mockGetDraft).toHaveBeenCalledWith("draft-222");
    expectDraftCleanedUp({
      mockDeleteDraft,
      mockUpdate,
    });
    expect(result).toEqual({ shouldCreateDraft: true });
  });

  it("should not delete modified draft", async () => {
    mockFindFirst.mockResolvedValue(previousDraftAction);
    mockGetDraft.mockResolvedValue(
      createParsedMessage({
        textPlain:
          "Hello, this is a MODIFIED draft\n\nOn Monday wrote:\n> Previous message",
        snippet: "Hello, this is a MODIFIED draft",
      }),
    );

    const result = await handlePreviousDraftDeletion({
      client: mockClient,
      executedRule,
      logger,
    });

    expect(mockDeleteDraft).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({
      shouldCreateDraft: false,
      existingDraftId: "draft-222",
      reason: "modified",
    });
  });

  it("should not delete draft when original content is missing", async () => {
    mockFindFirst.mockResolvedValue({
      ...previousDraftAction,
      content: null,
    });
    mockGetDraft.mockResolvedValue(
      createParsedMessage({
        textPlain: "Potentially user modified draft",
        snippet: "Potentially user modified draft",
      }),
    );

    const result = await handlePreviousDraftDeletion({
      client: mockClient,
      executedRule,
      logger,
    });

    expect(mockGetDraft).toHaveBeenCalledWith("draft-222");
    expect(mockDeleteDraft).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({
      shouldCreateDraft: false,
      existingDraftId: "draft-222",
      reason: "missing_original_content",
    });
  });

  it("should handle no previous draft found", async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await handlePreviousDraftDeletion({
      client: mockClient,
      executedRule,
      logger,
    });

    expect(mockGetDraft).not.toHaveBeenCalled();
    expect(mockDeleteDraft).not.toHaveBeenCalled();
    expect(result).toEqual({ shouldCreateDraft: true });
  });

  it("should handle draft not found in Gmail", async () => {
    mockFindFirst.mockResolvedValue(previousDraftAction);
    mockGetDraft.mockResolvedValue(null);

    const result = await handlePreviousDraftDeletion({
      client: mockClient,
      executedRule,
      logger,
    });

    expect(mockDeleteDraft).not.toHaveBeenCalled();
    expect(result).toEqual({ shouldCreateDraft: true });
  });

  it("should handle errors gracefully", async () => {
    mockFindFirst.mockRejectedValue(new Error("Database error"));

    await expect(
      handlePreviousDraftDeletion({
        client: mockClient,
        executedRule,
        logger,
      }),
    ).resolves.not.toThrow();
  });

  it("should handle draft with no textPlain content", async () => {
    mockFindFirst.mockResolvedValue(previousDraftAction);
    mockGetDraft.mockResolvedValue(
      createParsedMessage({
        textPlain: undefined,
        textHtml: "<p>HTML content</p>",
        snippet: "HTML content",
      }),
    );

    const result = await handlePreviousDraftDeletion({
      client: mockClient,
      executedRule,
      logger,
    });

    expect(mockDeleteDraft).not.toHaveBeenCalled();
    expect(result).toEqual({
      shouldCreateDraft: false,
      existingDraftId: "draft-222",
      reason: "modified",
    });
  });

  it("should skip creating a replacement draft when previous draft content is unavailable", async () => {
    mockFindFirst.mockResolvedValue(previousDraftAction);
    mockGetDraft.mockResolvedValue(
      createParsedMessage({
        textPlain: undefined,
        textHtml: undefined,
        snippet: "",
      }),
    );

    const result = await handlePreviousDraftDeletion({
      client: mockClient,
      executedRule,
      logger,
    });

    expect(mockDeleteDraft).not.toHaveBeenCalled();
    expect(result).toEqual({
      shouldCreateDraft: false,
      existingDraftId: "draft-222",
      reason: "missing_content",
    });
  });

  it("should handle Outlook HTML draft with signature link", async () => {
    mockFindFirst.mockResolvedValue({
      ...previousDraftAction,
      content:
        'Hello, this is a test draft\n\nDrafted by <a href="http://localhost:3000/?ref=ABC">Inbox Zero</a>.',
    });
    mockGetDraft.mockResolvedValue(
      createParsedMessage({
        textPlain:
          '<html><head>\r\n<meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body><div dir="ltr">Hello, this is a test draft<br><br>Drafted by <a href="http://localhost:3000/?ref=ABC">Inbox Zero</a>.</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Tue, 11 Nov 2025 at 2:18, John wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex; border-left:1px solid rgb(204,204,204); padding-left:1ex"><div dir="ltr">Previous message content</div></blockquote></div></body></html>',
        bodyContentType: "html",
        snippet: "Hello",
      }),
    );

    await handlePreviousDraftDeletion({
      client: mockClient,
      executedRule,
      logger,
    });

    expectDraftCleanedUp({
      mockDeleteDraft,
      mockUpdate,
    });
  });

  it("should not delete when draft has extra user content", async () => {
    mockFindFirst.mockResolvedValue({
      ...previousDraftAction,
      content: "Original AI draft",
    });
    mockGetDraft.mockResolvedValue(
      createParsedMessage({
        textPlain:
          "Original AI draft\n\nUser added this extra paragraph.\n\nOn Monday wrote:\n> Quote",
      }),
    );

    await handlePreviousDraftDeletion({
      client: mockClient,
      executedRule,
      logger,
    });

    expect(mockDeleteDraft).not.toHaveBeenCalled();
  });
});

describe("updateExecutedActionWithDraftId", () => {
  const logger = createTestLogger();
  const mockFindUnique = prisma.executedAction.findUnique as Mock;
  const mockUpdate = prisma.executedAction.update as Mock;
  const mockUpdateMany = prisma.executedAction.updateMany as Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUnique.mockResolvedValue({
      draftContextMetadata: {
        replyMemories: { count: 2, ids: ["memory-1", "memory-2"] },
        retainedContext: { preserve: true },
      },
      updatedAt: new Date("2026-08-11T12:00:00.000Z"),
    });
    mockUpdate.mockResolvedValue({});
    mockUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("merges a Coastline receipt without overwriting existing metadata", async () => {
    const receipt = createInboxZeroDraftReceipt({
      proposal: createInboxZeroDraftProposal({
        provider: "microsoft",
        account_id: "account-123",
        thread_id: "thread-456",
        source_message_id: "message-789",
        to: ["recipient@example.com"],
        cc: [],
        bcc: [],
        subject: "Subject excluded from receipt",
        body_text: "Body excluded from receipt",
        confidence: "medium",
        model: "test-model",
        idempotency_key: buildDraftIdempotencyKey({
          accountId: "account-123",
          threadId: "thread-456",
          sourceMessageId: "message-789",
        }),
        generated_at: "2026-08-11T12:00:00.000Z",
      }),
      draftId: "draft-123",
    });

    await updateExecutedActionWithDraftId({
      actionId: "action-123",
      draftId: "draft-123",
      receipt,
      logger,
    });

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: "action-123" },
      select: { draftContextMetadata: true, updatedAt: true },
    });
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "action-123",
        updatedAt: new Date("2026-08-11T12:00:00.000Z"),
      },
      data: {
        draftId: "draft-123",
        draftStatus: DraftEmailStatus.PENDING,
        updatedAt: expect.any(Date),
        draftContextMetadata: {
          replyMemories: { count: 2, ids: ["memory-1", "memory-2"] },
          retainedContext: { preserve: true },
          coastlineDraft: receipt,
        },
      },
    });
  });

  it("retries a receipt merge against the latest metadata after a concurrent update", async () => {
    const firstUpdatedAt = new Date("2026-08-11T12:00:00.000Z");
    const secondUpdatedAt = new Date("2026-08-11T12:00:01.000Z");
    const receipt = createInboxZeroDraftReceipt({
      proposal: createInboxZeroDraftProposal({
        provider: "microsoft",
        account_id: "account-123",
        thread_id: "thread-456",
        source_message_id: "message-789",
        to: ["recipient@example.com"],
        cc: [],
        bcc: [],
        subject: "Subject excluded from receipt",
        body_text: "Body excluded from receipt",
        confidence: "medium",
        model: "test-model",
        idempotency_key: buildDraftIdempotencyKey({
          accountId: "account-123",
          threadId: "thread-456",
          sourceMessageId: "message-789",
        }),
        generated_at: "2026-08-11T12:00:00.000Z",
      }),
      draftId: "draft-123",
    });
    mockFindUnique
      .mockResolvedValueOnce({
        draftContextMetadata: { retainedContext: { preserve: true } },
        updatedAt: firstUpdatedAt,
      })
      .mockResolvedValueOnce({
        draftContextMetadata: {
          retainedContext: { preserve: true },
          concurrentContext: { preserve: true },
        },
        updatedAt: secondUpdatedAt,
      });
    mockUpdateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await updateExecutedActionWithDraftId({
      actionId: "action-123",
      draftId: "draft-123",
      receipt,
      logger,
    });

    expect(mockUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "action-123", updatedAt: firstUpdatedAt },
      data: expect.objectContaining({
        draftContextMetadata: {
          retainedContext: { preserve: true },
          coastlineDraft: receipt,
        },
      }),
    });
    expect(mockUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "action-123", updatedAt: secondUpdatedAt },
      data: expect.objectContaining({
        draftContextMetadata: {
          retainedContext: { preserve: true },
          concurrentContext: { preserve: true },
          coastlineDraft: receipt,
        },
      }),
    });
  });

  it("surfaces receipt persistence failures with a deterministic error code", async () => {
    const receipt = createInboxZeroDraftReceipt({
      proposal: createInboxZeroDraftProposal({
        provider: "microsoft",
        account_id: "account-123",
        thread_id: "thread-456",
        source_message_id: "message-789",
        to: ["recipient@example.com"],
        cc: [],
        bcc: [],
        subject: "Subject excluded from receipt",
        body_text: "Body excluded from receipt",
        confidence: "medium",
        model: "test-model",
        idempotency_key: buildDraftIdempotencyKey({
          accountId: "account-123",
          threadId: "thread-456",
          sourceMessageId: "message-789",
        }),
        generated_at: "2026-08-11T12:00:00.000Z",
      }),
      draftId: "draft-123",
    });
    mockFindUnique.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      updateExecutedActionWithDraftId({
        actionId: "action-123",
        draftId: "draft-123",
        receipt,
        logger,
      }),
    ).rejects.toMatchObject({
      code: "COASTLINE_DRAFT_RECEIPT_PERSISTENCE_FAILED",
    });
  });

  it("records a stable execution error when the receipt reaches failed", async () => {
    const receipt = {
      ...createInboxZeroDraftReceipt({
        proposal: createInboxZeroDraftProposal({
          provider: "microsoft",
          account_id: "account-123",
          thread_id: "thread-456",
          source_message_id: "message-789",
          to: ["recipient@example.com"],
          cc: [],
          bcc: [],
          subject: "Subject excluded from receipt",
          body_text: "Body excluded from receipt",
          confidence: "medium",
          model: "test-model",
          idempotency_key: buildDraftIdempotencyKey({
            accountId: "account-123",
            threadId: "thread-456",
            sourceMessageId: "message-789",
          }),
          generated_at: "2026-08-11T12:00:00.000Z",
        }),
        draftId: "draft-123",
      }),
      terminalState: "failed" as const,
    };

    await updateExecutedActionWithDraftId({
      actionId: "action-123",
      draftId: "draft-123",
      receipt,
      logger,
    });

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "action-123",
        updatedAt: new Date("2026-08-11T12:00:00.000Z"),
      },
      data: expect.objectContaining({
        executionError: {
          code: "COASTLINE_DRAFT_RECEIPT_FAILED",
          message: "Coastline draft receipt recorded a failed state",
          stack: null,
          statusCode: null,
          requestId: null,
        },
      }),
    });
  });
});

describe("createOrReconcileCoastlineDraft", () => {
  const logger = createTestLogger();
  const mockFindUnique = prisma.executedAction.findUnique as Mock;
  const mockUpdateMany = prisma.executedAction.updateMany as Mock;
  const mockReserve = reserveOrReconcileCoastlineDraft as Mock;
  const mockRecordCreation = recordCoastlineDraftCreation as Mock;
  const mockReconcile = reconcileCoastlineDraft as Mock;
  const proposal = createInboxZeroDraftProposal({
    provider: "microsoft",
    account_id: "account-123",
    thread_id: "thread-456",
    source_message_id: "message-789",
    to: ["recipient@example.com"],
    cc: [],
    bcc: [],
    subject: "Property documents",
    body_text: "I will send the lease packet this afternoon.",
    confidence: "medium",
    model: "test-model",
    idempotency_key: buildDraftIdempotencyKey({
      accountId: "account-123",
      threadId: "thread-456",
      sourceMessageId: "message-789",
    }),
    generated_at: "2026-08-11T12:00:00.000Z",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockRecordCreation.mockResolvedValue(undefined);
    mockReconcile.mockResolvedValue({
      draftId: "draft-123",
      terminalState: "created_verified",
    });
  });

  it("reserves the idempotency key before creating and persists verified readback", async () => {
    mockReserve.mockResolvedValueOnce({
      reservationId: "reservation-1",
      draftId: null,
      state: "reserved",
    });
    mockFindUnique
      .mockResolvedValueOnce({
        draftId: null,
        draftContextMetadata: {},
        updatedAt: new Date("2026-08-11T12:00:00.000Z"),
      })
      .mockResolvedValueOnce({
        draftContextMetadata: {
          coastlineDraftReservation: expect.any(Object),
        },
        updatedAt: new Date("2026-08-11T12:00:01.000Z"),
      })
      .mockResolvedValueOnce({
        draftId: "draft-123",
        draftContextMetadata: {
          coastlineDraft: {
            ...createInboxZeroDraftReceipt({
              proposal,
              draftId: "draft-123",
            }),
            readBackAt: "2026-08-11T12:00:03.000Z",
            terminalState: "created_verified",
          },
        },
      });
    const createDraft = vi.fn().mockResolvedValue({ draftId: "draft-123" });
    const getDraft = vi.fn().mockResolvedValue(
      createParsedMessage({
        id: "draft-123",
        threadId: "thread-456",
        subject: "Property documents",
        headers: {
          from: "account@example.com",
          to: "recipient@example.com",
          subject: "Property documents",
          date: "2026-08-11T12:00:00.000Z",
        },
        textPlain: "I will send the lease packet this afternoon.",
      }),
    );

    const result = await createOrReconcileCoastlineDraft({
      actionId: "action-123",
      proposal,
      client: { getDraft } as unknown as EmailProvider,
      createDraft,
      logger,
    });

    expect(mockReserve.mock.invocationCallOrder[0]).toBeLessThan(
      createDraft.mock.invocationCallOrder[0],
    );
    expect(getDraft).toHaveBeenCalledWith("draft-123");
    expect(result.receipt).toMatchObject({
      draftId: "draft-123",
      terminalState: "created_verified",
      readBackAt: expect.any(String),
    });
  });

  it("reconciles a persisted unverified draft without creating another provider draft", async () => {
    mockReserve.mockResolvedValueOnce({
      reservationId: "reservation-1",
      draftId: "draft-123",
      state: "created_unverified",
    });
    const unverifiedReceipt = createInboxZeroDraftReceipt({
      proposal,
      draftId: "draft-123",
    });
    mockFindUnique
      .mockResolvedValueOnce({
        draftId: "draft-123",
        draftContextMetadata: {
          coastlineDraftReservation: {
            schemaVersion: "inbox_zero_draft_reservation.v1",
            idempotencyKey: proposal.idempotency_key,
            accountId: proposal.account_id,
            threadId: proposal.thread_id,
            sourceMessageId: proposal.source_message_id,
            reservedAt: proposal.generated_at,
          },
          coastlineDraft: unverifiedReceipt,
        },
        updatedAt: new Date("2026-08-11T12:00:00.000Z"),
      })
      .mockResolvedValueOnce({
        draftId: "draft-123",
        draftContextMetadata: {
          coastlineDraft: {
            ...unverifiedReceipt,
            readBackAt: "2026-08-11T12:00:02.000Z",
            terminalState: "created_verified",
          },
        },
      });
    const createDraft = vi.fn();
    const getDraft = vi.fn().mockResolvedValue(
      createParsedMessage({
        id: "draft-123",
        threadId: "thread-456",
        subject: "Property documents",
        headers: {
          from: "account@example.com",
          to: "recipient@example.com",
          subject: "Property documents",
          date: "2026-08-11T12:00:00.000Z",
        },
        textPlain: "I will send the lease packet this afternoon.",
      }),
    );

    const result = await createOrReconcileCoastlineDraft({
      actionId: "action-123",
      proposal,
      client: { getDraft } as unknown as EmailProvider,
      createDraft,
      logger,
    });

    expect(createDraft).not.toHaveBeenCalled();
    expect(result.receipt.terminalState).toBe("created_verified");
  });

  it("fails closed on an unresolved reservation instead of creating a duplicate", async () => {
    mockReserve.mockResolvedValueOnce({
      reservationId: "reservation-1",
      draftId: null,
      state: "recovery_required",
    });
    mockFindUnique.mockResolvedValueOnce({
      draftId: null,
      draftContextMetadata: {
        coastlineDraftReservation: {
          schemaVersion: "inbox_zero_draft_reservation.v1",
          idempotencyKey: proposal.idempotency_key,
          accountId: proposal.account_id,
          threadId: proposal.thread_id,
          sourceMessageId: proposal.source_message_id,
          reservedAt: proposal.generated_at,
        },
      },
      updatedAt: new Date("2026-08-11T12:00:00.000Z"),
    });
    const createDraft = vi.fn();

    await expect(
      createOrReconcileCoastlineDraft({
        actionId: "action-123",
        proposal,
        client: { getDraft: vi.fn() } as unknown as EmailProvider,
        createDraft,
        logger,
      }),
    ).rejects.toMatchObject({
      code: "COASTLINE_DRAFT_RECOVERY_REQUIRED",
    });
    expect(createDraft).not.toHaveBeenCalled();
  });
});

describe("extractDraftPlainText", () => {
  it.each([
    {
      name: "Gmail message without bodyContentType",
      message: createParsedMessage({
        textPlain: "Plain text content",
        textHtml: "<p>HTML content</p>",
      }),
      expected: "Plain text content",
    },
    {
      name: "message with text bodyContentType",
      message: createParsedMessage({
        textPlain: "Plain text content",
        bodyContentType: "text",
      }),
      expected: "Plain text content",
    },
    {
      name: "HTML message without textPlain",
      message: createParsedMessage({
        textPlain: undefined,
        bodyContentType: "html",
      }),
      expected: "",
    },
    {
      name: "empty textPlain",
      message: createParsedMessage({
        textPlain: "",
      }),
      expected: "",
    },
  ])("should return expected text for $name", ({ message, expected }) => {
    expect(extractDraftPlainText(message)).toBe(expected);
  });

  it("should convert HTML to plain text when bodyContentType is html", () => {
    const result = extractDraftPlainText(
      createParsedMessage({
        textPlain:
          '<p>HTML content with <a href="http://example.com">link</a></p>',
        bodyContentType: "html",
      }),
    );

    expect(result).toContain("HTML content");
    expect(result).toContain("link");
    expect(result).not.toContain("<p>");
    expect(result).not.toContain("<a href");
  });

  it("should handle Outlook HTML with complex formatting", () => {
    const result = extractDraftPlainText(
      createParsedMessage({
        textPlain:
          '<html><body><div><strong>Bold</strong> and <em>italic</em> and <a href="http://example.com">link</a></div></body></html>',
        bodyContentType: "html",
      }),
    );

    expect(result).toContain("Bold");
    expect(result).toContain("italic");
    expect(result).toContain("link");
    expect(result).not.toContain("<strong>");
    expect(result).not.toContain("http://example.com");
  });
});

describe("stripQuotedContent", () => {
  it.each([
    {
      name: "On ... wrote:",
      text: "My reply\n\nOn Monday, John wrote:\n> Quoted content",
      expected: "My reply",
    },
    {
      name: "Original Message",
      text: "My reply\n\n---- Original Message ----\nFrom: test@example.com",
      expected: "My reply",
    },
    {
      name: "> quote",
      text: "My reply\n\n> On Monday:\n> Quoted content",
      expected: "My reply",
    },
    {
      name: "From:",
      text: "My reply\n\nFrom: sender@example.com\nQuoted content",
      expected: "My reply",
    },
    {
      name: "no quote patterns",
      text: "  Just a simple reply  ",
      expected: "Just a simple reply",
    },
    {
      name: "empty string",
      text: "",
      expected: "",
    },
    {
      name: "first matching pattern only",
      text: "My reply\n\nOn Monday wrote:\n> Quote 1\n\nFrom: test@example.com\n> Quote 2",
      expected: "My reply",
    },
    {
      name: "newlines without quotes",
      text: "Line 1\nLine 2\nLine 3",
      expected: "Line 1\nLine 2\nLine 3",
    },
    {
      name: "single-newline quote-like text",
      text: "My reply\nOn Monday wrote: something",
      expected: "My reply\nOn Monday wrote: something",
    },
    {
      name: "multiple consecutive newlines",
      text: "My reply\n\n\n\nOn Monday wrote:\n> Quote",
      expected: "My reply",
    },
  ])("should handle $name", ({ text, expected }) => {
    expect(stripQuotedContent(text)).toBe(expected);
  });
});

describe("stripQuotedHtmlContent", () => {
  it("removes Gmail quote containers without reading localized header text", () => {
    const html = `<div dir="ltr">My reply</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">Le lun. 27 avr. 2026, Sender a écrit:<br></div><blockquote class="gmail_quote"><div>Quoted content</div></blockquote></div>`;

    const result = stripQuotedHtmlContent(html);

    expect(result).toContain("My reply");
    expect(result).not.toContain("Le lun.");
    expect(result).not.toContain("Quoted content");
  });
});

describe("isDraftUnmodified", () => {
  const logger = createTestLogger();

  it.each([
    {
      name: "content matches exactly",
      originalContent: "Hello, this is a test",
      currentDraft: createParsedMessage({
        textPlain: withQuotedReply("Hello, this is a test"),
      }),
      expected: true,
    },
    {
      name: "content is modified",
      originalContent: "Hello, this is a test",
      currentDraft: createParsedMessage({
        textPlain: withQuotedReply("Hello, this is MODIFIED"),
      }),
      expected: false,
    },
    {
      name: "whitespace differs",
      originalContent: "  Hello, this is a test  ",
      currentDraft: createParsedMessage({
        textPlain: withQuotedReply("Hello, this is a test"),
      }),
      expected: true,
    },
    {
      name: "original content is empty",
      originalContent: "",
      currentDraft: createParsedMessage({
        textPlain: "Some content",
      }),
      expected: false,
    },
    {
      name: "different quote pattern is present",
      originalContent: "My response",
      currentDraft: createParsedMessage({
        textPlain: "My response\n\n---- Original Message ----\nFrom: test",
      }),
      expected: true,
    },
    {
      name: "special characters are present",
      originalContent: "Reply with émojis 🎉 and spëcial çhars!",
      currentDraft: createParsedMessage({
        textPlain: withQuotedReply("Reply with émojis 🎉 and spëcial çhars!"),
      }),
      expected: true,
    },
    {
      name: "content has multiple paragraph breaks",
      originalContent: "Paragraph 1\n\nParagraph 2\n\nParagraph 3",
      currentDraft: createParsedMessage({
        textPlain: withQuotedReply("Paragraph 1\n\nParagraph 2\n\nParagraph 3"),
      }),
      expected: true,
    },
    {
      name: "user added content before quote",
      originalContent: "Original text",
      currentDraft: createParsedMessage({
        textPlain: withQuotedReply("Original text\n\nUser added this"),
      }),
      expected: false,
    },
    {
      name: "draft has no quoted content",
      originalContent: "Just a reply",
      currentDraft: createParsedMessage({
        textPlain: "Just a reply",
      }),
      expected: true,
    },
    {
      name: "case differs",
      originalContent: "Hello World",
      currentDraft: createParsedMessage({
        textPlain: withQuotedReply("hello world"),
      }),
      expected: false,
    },
    {
      name: "reply is only whitespace",
      originalContent: "   ",
      currentDraft: createParsedMessage({
        textPlain: withQuotedReply("   "),
      }),
      expected: true,
    },
  ])("should return $expected when $name", ({
    originalContent,
    currentDraft,
    expected,
  }) => {
    const result = isDraftUnmodified({
      originalContent,
      currentDraft,
      logger,
    });

    expect(result).toBe(expected);
  });

  it("should handle HTML content with links (Outlook case)", () => {
    const result = isDraftUnmodified({
      originalContent:
        'My reply\n\nDrafted by <a href="http://localhost:3000/?ref=ABC">Inbox Zero</a>.',
      currentDraft: createParsedMessage({
        textPlain:
          '<html><head>\r\n<meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body><div dir="ltr">My reply<br><br>Drafted by <a href="http://localhost:3000/?ref=ABC">Inbox Zero</a>.</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Tue, 11 Nov 2025 at 2:18, John wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex; border-left:1px solid rgb(204,204,204); padding-left:1ex"><div dir="ltr">Quote content</div></blockquote></div></body></html>',
        bodyContentType: "html",
      }),
      logger,
    });

    expect(result).toBe(true);
  });

  it("should compare Gmail drafts using structural HTML when available", () => {
    const result = isDraftUnmodified({
      originalContent:
        'My reply\n\nDrafted by <a href="http://localhost:3000/?ref=ABC">Inbox Zero</a>.',
      currentDraft: createParsedMessage({
        textPlain:
          "My reply\n\nDrafted by Inbox Zero [http://localhost:3000/?ref=ABC].\n\nLe lun. 27 avr. 2026, Sender a écrit:\nQuoted content",
        textHtml:
          '<div dir="ltr">My reply<br><br>Drafted by <a href="http://localhost:3000/?ref=ABC">Inbox Zero</a>.</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">Le lun. 27 avr. 2026, Sender a écrit:<br></div><blockquote class="gmail_quote"><div>Quoted content</div></blockquote></div>',
      }),
      logger,
    });

    expect(result).toBe(true);
  });
});

function createParsedMessage(
  overrides: Partial<ParsedMessage> = {},
): ParsedMessage {
  return {
    id: "msg-123",
    threadId: "thread-456",
    textPlain: "Plain text content",
    textHtml: undefined,
    subject: "subject",
    date: "2024-01-01T12:00:00.000Z",
    snippet: "snippet",
    historyId: "12345",
    internalDate: "1234567890",
    headers: {
      from: "test@example.com",
      to: "recipient@example.com",
      subject: "Test Subject",
      date: "Mon, 1 Jan 2024 12:00:00 +0000",
    },
    labelIds: [],
    inline: [],
    ...overrides,
  };
}

function withQuotedReply(reply: string): string {
  return `${reply}\n\nOn Monday wrote:\n> Quote`;
}

function expectDraftCleanedUp({
  mockDeleteDraft,
  mockUpdate,
}: {
  mockDeleteDraft: Mock;
  mockUpdate: Mock;
}) {
  expect(mockDeleteDraft).toHaveBeenCalledWith("draft-222");
  expect(mockUpdate).toHaveBeenCalledWith({
    where: { id: "action-111" },
    data: {
      draftStatus: DraftEmailStatus.CLEANED_UP_UNUSED,
    },
  });
}
