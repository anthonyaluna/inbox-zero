import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { ActionType, ExecutedRuleStatus } from "@/generated/prisma/enums";
import { executeAct } from "@/utils/ai/choose-rule/execute";
import { runActionFunction } from "@/utils/ai/actions";
import prisma from "@/utils/prisma";
import type { EmailProvider } from "@/utils/email/types";
import type { ParsedMessage } from "@/utils/types";
import { createTestLogger } from "@/__tests__/helpers";
import { updateExecutedActionWithDraftId } from "@/utils/ai/choose-rule/draft-management";
import {
  buildDraftIdempotencyKey,
  createInboxZeroDraftProposal,
} from "@/utils/coastline/draft-proposal";
import { createSameDayResponseCase } from "@/utils/coastline/same-day-response-case";
import type { SameDayResponseCaseV1 } from "@/utils/coastline/same-day-response-case";
import type { SameDayResponseCaseStore } from "@/utils/coastline/same-day-response-case-store";

const { envMock } = vi.hoisted(() => ({
  envMock: {
    WHITELIST_FROM: undefined as string | undefined,
  },
}));

const { mockDispatchCalendarForMessage } = vi.hoisted(() => ({
  mockDispatchCalendarForMessage: vi.fn(),
}));

vi.mock("@/env", () => ({
  env: envMock,
}));

vi.mock("@/utils/ai/actions", () => ({
  runActionFunction: vi.fn(),
}));

vi.mock("@/utils/ai/choose-rule/draft-management", () => ({
  updateExecutedActionWithDraftId: vi.fn(),
}));

vi.mock("@/utils/coastline/calendar-context-dispatch", () => ({
  dispatchCalendarForMessage: mockDispatchCalendarForMessage,
}));

vi.mock("@/utils/prisma", () => ({
  default: {
    executedAction: {
      update: vi.fn(),
    },
    executedRule: {
      update: vi.fn(),
    },
  },
}));

describe("executeAct", () => {
  const logger = createTestLogger();
  const mockClient = {} as EmailProvider;
  const emailAccount = {
    email: "recipient@example.com",
    id: "email-account-1",
    userId: "user-1",
  };
  const message: ParsedMessage = {
    id: "message-id-1",
    threadId: "thread-id-1",
    snippet: "",
    historyId: "history-id-1",
    inline: [],
    headers: {
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Subject",
      date: "Mon, 1 Jan 2026 12:00:00 +0000",
      "message-id": "<message-id-1>",
    },
    subject: "Subject",
    date: "2026-01-01T12:00:00.000Z",
    internalDate: "1700000000000",
  };

  const baseExecutedRule = {
    id: "executed-rule-1",
    ruleId: "rule-1",
    threadId: "thread-id-1",
    messageId: "message-id-1",
    emailAccountId: "email-account-1",
    automated: true,
    reason: "Rule matched",
    createdAt: new Date("2026-01-01T12:00:00.000Z"),
    updatedAt: new Date("2026-01-01T12:00:00.000Z"),
    status: ExecutedRuleStatus.APPLYING,
  };

  const mockRunActionFunction = runActionFunction as Mock;
  const mockUpdateExecutedActionWithDraftId =
    updateExecutedActionWithDraftId as Mock;
  const mockExecutedActionUpdate = prisma.executedAction.update as Mock;
  const mockExecutedRuleUpdate = prisma.executedRule.update as Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    envMock.WHITELIST_FROM = undefined;
    mockDispatchCalendarForMessage.mockResolvedValue({
      status: "not_scheduling",
      reason: "no_scheduling_intent",
    });
    mockExecutedActionUpdate.mockResolvedValue({});
    mockExecutedRuleUpdate.mockResolvedValue({});
  });

  it("keeps labels but skips archive for protected company senders", async () => {
    envMock.WHITELIST_FROM = "onboarding@getinboxzero.com";
    mockRunActionFunction.mockResolvedValueOnce({ success: true });

    const executedRule = {
      ...baseExecutedRule,
      actionItems: [
        { id: "action-1", type: ActionType.LABEL, label: "Marketing" },
        { id: "action-2", type: ActionType.ARCHIVE },
      ],
    } as any;

    const result = await executeAct({
      client: mockClient,
      executedRule,
      message: {
        ...message,
        headers: {
          ...message.headers,
          from: "Inbox Zero <onboarding@getinboxzero.com>",
        },
      },
      emailAccount,
      logger,
    });

    expect(result).toBe(ExecutedRuleStatus.APPLIED);
    expect(mockRunActionFunction).toHaveBeenCalledTimes(1);
    expect(mockRunActionFunction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({
          id: "action-1",
          type: ActionType.LABEL,
        }),
      }),
    );
    expect(mockExecutedActionUpdate).toHaveBeenNthCalledWith(1, {
      where: { id: "action-1" },
      data: {
        executionStatus: "SUCCEEDED",
        executedAt: expect.any(Date),
        executionError: Prisma.DbNull,
      },
    });
    expect(mockExecutedActionUpdate).toHaveBeenNthCalledWith(2, {
      where: { id: "action-2" },
      data: {
        executionStatus: "SKIPPED",
        executedAt: expect.any(Date),
        executionError: Prisma.DbNull,
      },
    });
    expect(mockExecutedRuleUpdate).toHaveBeenCalledWith({
      where: { id: "executed-rule-1" },
      data: { status: ExecutedRuleStatus.APPLIED },
    });
  });

  it("dispatches a clear calendar proposal once before mailbox actions", async () => {
    mockDispatchCalendarForMessage.mockResolvedValue({
      status: "dispatched",
      eventId: "event-1",
    });
    const microsoftClient = { name: "microsoft" } as EmailProvider;
    mockRunActionFunction.mockResolvedValueOnce({ success: true });

    await executeAct({
      client: microsoftClient,
      executedRule: {
        ...baseExecutedRule,
        actionItems: [{ id: "action-1", type: ActionType.LABEL }],
      } as any,
      message,
      emailAccount,
      logger,
    });

    expect(mockDispatchCalendarForMessage).toHaveBeenCalledWith({
      clientName: "microsoft",
      message,
      account: emailAccount,
      logger: expect.anything(),
    });
    expect(mockRunActionFunction).toHaveBeenCalledTimes(1);
  });

  it("dispatches a clear calendar proposal even when no mailbox rule action matched", async () => {
    mockDispatchCalendarForMessage.mockResolvedValue({
      status: "dispatched",
      eventId: "event-1",
    });

    await executeAct({
      client: { name: "microsoft" } as EmailProvider,
      executedRule: {
        ...baseExecutedRule,
        actionItems: [],
      } as any,
      message,
      emailAccount,
      logger,
    });

    expect(mockDispatchCalendarForMessage).toHaveBeenCalledWith({
      clientName: "microsoft",
      message,
      account: emailAccount,
      logger: expect.anything(),
    });
    expect(mockRunActionFunction).not.toHaveBeenCalled();
  });

  it("does not emit a calendar event for ambiguous scheduling", async () => {
    mockDispatchCalendarForMessage.mockResolvedValue({
      status: "ambiguous",
      reason: "exact_date_missing",
    });

    await executeAct({
      client: { name: "microsoft" } as EmailProvider,
      executedRule: {
        ...baseExecutedRule,
        actionItems: [],
      } as any,
      message,
      emailAccount,
      logger,
    });

    expect(mockDispatchCalendarForMessage).toHaveBeenCalledTimes(1);
    expect(mockRunActionFunction).not.toHaveBeenCalled();
  });

  it("records actions skipped by the executor without failing the rule", async () => {
    mockRunActionFunction.mockResolvedValueOnce({
      skipped: true,
      reason: "NO_NEW_FORWARD_RECIPIENTS",
    });

    const executedRule = {
      ...baseExecutedRule,
      actionItems: [{ id: "action-1", type: ActionType.FORWARD }],
    } as any;

    const result = await executeAct({
      client: mockClient,
      executedRule,
      message,
      emailAccount,
      logger,
    });

    expect(result).toBe(ExecutedRuleStatus.APPLIED);
    expect(mockExecutedActionUpdate).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: {
        executionStatus: "SKIPPED",
        executedAt: expect.any(Date),
        executionError: Prisma.DbNull,
      },
    });
    expect(mockExecutedRuleUpdate).toHaveBeenCalledWith({
      where: { id: "executed-rule-1" },
      data: { status: ExecutedRuleStatus.APPLIED },
    });
  });

  it("marks executed rule as ERROR when notify sender reports a failure", async () => {
    mockRunActionFunction.mockResolvedValueOnce({
      success: false,
      errorCode: "RESEND_NOT_CONFIGURED",
    });

    const executedRule = {
      ...baseExecutedRule,
      actionItems: [{ id: "action-1", type: ActionType.NOTIFY_SENDER }],
    } as any;

    const result = await executeAct({
      client: mockClient,
      executedRule,
      message,
      emailAccount,
      logger,
    });

    expect(result).toBe(ExecutedRuleStatus.ERROR);
    expect(mockExecutedRuleUpdate).toHaveBeenCalledTimes(1);
    expect(mockExecutedRuleUpdate).toHaveBeenCalledWith({
      where: { id: "executed-rule-1" },
      data: {
        status: ExecutedRuleStatus.ERROR,
        reason:
          "Rule matched\nAction failures: NOTIFY_SENDER:RESEND_NOT_CONFIGURED",
      },
    });
    expect(mockExecutedActionUpdate).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: {
        executionStatus: "FAILED",
        executedAt: expect.any(Date),
        executionError: {
          code: "RESEND_NOT_CONFIGURED",
          message: "Action reported failure",
          stack: null,
          statusCode: null,
          requestId: null,
        },
      },
    });
  });

  it("keeps the rule APPLIED when an action skips itself on purpose", async () => {
    mockRunActionFunction.mockResolvedValueOnce({ skipped: true });

    const executedRule = {
      ...baseExecutedRule,
      actionItems: [{ id: "action-1", type: ActionType.NOTIFY_SENDER }],
    } as any;

    const result = await executeAct({
      client: mockClient,
      executedRule,
      message,
      emailAccount,
      logger,
    });

    expect(result).toBe(ExecutedRuleStatus.APPLIED);
    expect(mockExecutedActionUpdate).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: {
        executionStatus: "SKIPPED",
        executedAt: expect.any(Date),
        executionError: Prisma.DbNull,
      },
    });
  });

  it("continues later messaging notifications after one delivery failure", async () => {
    mockRunActionFunction
      .mockResolvedValueOnce({
        success: false,
        errorCode: "MESSAGING_DELIVERY_FAILED",
      })
      .mockResolvedValueOnce({ success: true });

    const executedRule = {
      ...baseExecutedRule,
      actionItems: [
        {
          id: "telegram-action",
          type: ActionType.NOTIFY_MESSAGING_CHANNEL,
          messagingChannelId: "telegram-channel",
        },
        {
          id: "slack-action",
          type: ActionType.NOTIFY_MESSAGING_CHANNEL,
          messagingChannelId: "slack-channel",
        },
      ],
    } as any;

    const result = await executeAct({
      client: mockClient,
      executedRule,
      message,
      emailAccount,
      logger,
    });

    expect(result).toBe(ExecutedRuleStatus.ERROR);
    expect(mockRunActionFunction).toHaveBeenCalledTimes(2);
    expect(mockRunActionFunction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: expect.objectContaining({ id: "telegram-action" }),
      }),
    );
    expect(mockRunActionFunction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: expect.objectContaining({ id: "slack-action" }),
      }),
    );
    expect(mockExecutedRuleUpdate).toHaveBeenCalledTimes(1);
    expect(mockExecutedRuleUpdate).toHaveBeenCalledWith({
      where: { id: "executed-rule-1" },
      data: {
        status: ExecutedRuleStatus.ERROR,
        reason:
          "Rule matched\nAction failures: NOTIFY_MESSAGING_CHANNEL:MESSAGING_DELIVERY_FAILED",
      },
    });
  });

  it("marks executed rule as APPLIED when actions succeed", async () => {
    mockRunActionFunction.mockResolvedValueOnce({ success: true });

    const executedRule = {
      ...baseExecutedRule,
      actionItems: [{ id: "action-1", type: ActionType.NOTIFY_SENDER }],
    } as any;

    const result = await executeAct({
      client: mockClient,
      executedRule,
      message,
      emailAccount,
      logger,
    });

    expect(result).toBe(ExecutedRuleStatus.APPLIED);
    expect(mockExecutedRuleUpdate).toHaveBeenCalledTimes(1);
    expect(mockExecutedRuleUpdate).toHaveBeenCalledWith({
      where: { id: "executed-rule-1" },
      data: { status: ExecutedRuleStatus.APPLIED },
    });
  });

  it("accepts a Coastline action only after a persisted verified receipt", async () => {
    mockRunActionFunction.mockResolvedValueOnce({
      draftId: "draft-123",
      draftProposal: createInboxZeroDraftProposal({
        provider: "microsoft",
        account_id: "email-account-1",
        thread_id: "thread-id-1",
        source_message_id: "message-id-1",
        to: ["recipient@example.com"],
        cc: [],
        bcc: [],
        subject: "Subject excluded from receipt",
        body_text: "Body excluded from receipt",
        confidence: "medium",
        model: "test-model",
        idempotency_key: buildDraftIdempotencyKey({
          accountId: "email-account-1",
          threadId: "thread-id-1",
          sourceMessageId: "message-id-1",
        }),
        generated_at: "2026-08-11T12:00:00.000Z",
      }),
      draftReceipt: {
        schemaVersion: "inbox_zero_draft_receipt.v1",
        provider: "microsoft",
        accountId: "email-account-1",
        threadId: "thread-id-1",
        sourceMessageId: "message-id-1",
        idempotencyKey:
          "inbox-zero/draft/email-account-1/thread-id-1/message-id-1",
        draftId: "draft-123",
        generatedAt: "2026-08-11T12:00:00.000Z",
        readBackAt: "2026-08-11T12:00:01.000Z",
        terminalState: "created_verified",
      },
    });

    const executedRule = {
      ...baseExecutedRule,
      actionItems: [{ id: "action-1", type: ActionType.DRAFT_EMAIL }],
    } as any;

    await executeAct({
      client: mockClient,
      executedRule,
      message,
      emailAccount,
      logger,
    });

    expect(mockUpdateExecutedActionWithDraftId).not.toHaveBeenCalled();
    expect(mockExecutedActionUpdate).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: expect.objectContaining({ executionStatus: "SUCCEEDED" }),
    });
  });

  it("moves the response case to drafted after verified draft readback", async () => {
    mockRunActionFunction.mockResolvedValueOnce({
      draftId: "draft-123",
      draftProposal: createInboxZeroDraftProposal({
        provider: "microsoft",
        account_id: "email-account-1",
        thread_id: "thread-id-1",
        source_message_id: "message-id-1",
        to: ["recipient@example.com"],
        cc: [],
        bcc: [],
        subject: "Subject excluded from receipt",
        body_text: "Body excluded from receipt",
        confidence: "medium",
        model: "test-model",
        idempotency_key: buildDraftIdempotencyKey({
          accountId: "email-account-1",
          threadId: "thread-id-1",
          sourceMessageId: "message-id-1",
        }),
        generated_at: "2026-08-11T12:00:00.000Z",
      }),
      draftReceipt: {
        schemaVersion: "inbox_zero_draft_receipt.v1",
        provider: "microsoft",
        accountId: "email-account-1",
        threadId: "thread-id-1",
        sourceMessageId: "message-id-1",
        idempotencyKey:
          "inbox-zero/draft/email-account-1/thread-id-1/message-id-1",
        draftId: "draft-123",
        generatedAt: "2026-08-11T12:00:00.000Z",
        readBackAt: "2026-08-11T12:00:01.000Z",
        terminalState: "created_verified",
      },
    });
    const rows = new Map<string, SameDayResponseCaseV1>();
    const initialCase = createSameDayResponseCase({
      accountId: "email-account-1",
      sourceMessageId: "message-id-1",
      sourceThreadId: "thread-id-1",
      sender: "sender@example.com",
      recipients: { to: ["recipient@example.com"], cc: [], bcc: [] },
      matterType: "inbound_message",
      audience: "other",
      receivedAt: "2026-08-11T12:00:00.000Z",
      accountableOwner: "Coastline Equity",
      nextAction: "Draft a response",
    });
    rows.set(initialCase.matterId, initialCase);
    const sameDayResponseCaseStore: SameDayResponseCaseStore = {
      async upsert(responseCase) {
        rows.set(responseCase.matterId, responseCase);
        return responseCase;
      },
      async findUnique({ matterId }) {
        return rows.get(matterId) ?? null;
      },
    };

    await executeAct({
      client: mockClient,
      executedRule: {
        ...baseExecutedRule,
        actionItems: [{ id: "action-1", type: ActionType.DRAFT_EMAIL }],
      } as any,
      message,
      emailAccount,
      logger,
      sameDayResponseCaseStore,
    });

    expect(rows.get(initialCase.matterId)).toMatchObject({
      state: "drafted",
      draftId: "draft-123",
    });
  });

  it("marks the action failed when Coastline readback is not verified", async () => {
    mockRunActionFunction.mockResolvedValueOnce({
      draftId: "draft-123",
      draftProposal: createInboxZeroDraftProposal({
        provider: "microsoft",
        account_id: "email-account-1",
        thread_id: "thread-id-1",
        source_message_id: "message-id-1",
        to: ["recipient@example.com"],
        cc: [],
        bcc: [],
        subject: "Subject excluded from receipt",
        body_text: "Body excluded from receipt",
        confidence: "medium",
        model: "test-model",
        idempotency_key: buildDraftIdempotencyKey({
          accountId: "email-account-1",
          threadId: "thread-id-1",
          sourceMessageId: "message-id-1",
        }),
        generated_at: "2026-08-11T12:00:00.000Z",
      }),
      draftReceipt: {
        schemaVersion: "inbox_zero_draft_receipt.v1",
        provider: "microsoft",
        accountId: "email-account-1",
        threadId: "thread-id-1",
        sourceMessageId: "message-id-1",
        idempotencyKey:
          "inbox-zero/draft/email-account-1/thread-id-1/message-id-1",
        draftId: "draft-123",
        generatedAt: "2026-08-11T12:00:00.000Z",
        readBackAt: null,
        terminalState: "created_unverified",
      },
    });

    const executedRule = {
      ...baseExecutedRule,
      actionItems: [{ id: "action-1", type: ActionType.DRAFT_EMAIL }],
    } as any;

    await expect(
      executeAct({
        client: mockClient,
        executedRule,
        message,
        emailAccount,
        logger,
      }),
    ).rejects.toMatchObject({
      code: "COASTLINE_DRAFT_VERIFICATION_REQUIRED",
    });

    expect(mockExecutedActionUpdate).toHaveBeenCalledTimes(1);
    expect(mockExecutedActionUpdate).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: {
        executionStatus: "FAILED",
        executedAt: expect.any(Date),
        executionError: {
          code: "COASTLINE_DRAFT_VERIFICATION_REQUIRED",
          message: "Coastline draft did not return a verified receipt",
          stack: expect.stringContaining(
            "Coastline draft did not return a verified receipt",
          ),
          statusCode: null,
          requestId: null,
        },
      },
    });
    expect(mockExecutedRuleUpdate).toHaveBeenCalledWith({
      where: { id: "executed-rule-1" },
      data: { status: ExecutedRuleStatus.ERROR },
    });
  });

  it("rejects a Coastline receipt when its proposal does not match the executing message", async () => {
    mockRunActionFunction.mockResolvedValueOnce({
      draftId: "draft-123",
      draftProposal: createInboxZeroDraftProposal({
        provider: "microsoft",
        account_id: "email-account-1",
        thread_id: "different-thread",
        source_message_id: "message-id-1",
        to: ["recipient@example.com"],
        cc: [],
        bcc: [],
        subject: "Subject",
        body_text: "Body",
        confidence: "medium",
        model: "test-model",
        idempotency_key: buildDraftIdempotencyKey({
          accountId: "email-account-1",
          threadId: "different-thread",
          sourceMessageId: "message-id-1",
        }),
        generated_at: "2026-08-11T12:00:00.000Z",
      }),
      draftReceipt: {
        schemaVersion: "inbox_zero_draft_receipt.v1",
        provider: "microsoft",
        accountId: "email-account-1",
        threadId: "different-thread",
        sourceMessageId: "message-id-1",
        idempotencyKey:
          "inbox-zero/draft/email-account-1/different-thread/message-id-1",
        draftId: "draft-123",
        generatedAt: "2026-08-11T12:00:00.000Z",
        readBackAt: "2026-08-11T12:00:01.000Z",
        terminalState: "created_verified",
      },
    });

    await expect(
      executeAct({
        client: mockClient,
        executedRule: {
          ...baseExecutedRule,
          actionItems: [{ id: "action-1", type: ActionType.DRAFT_EMAIL }],
        } as any,
        message,
        emailAccount,
        logger,
      }),
    ).rejects.toMatchObject({
      code: "COASTLINE_DRAFT_PROPOSAL_CONTEXT_MISMATCH",
    });
  });

  it("does not report APPLIED when persisting the final status fails", async () => {
    mockRunActionFunction.mockResolvedValueOnce({ success: true });
    mockExecutedRuleUpdate.mockRejectedValueOnce(new Error("db unavailable"));

    const executedRule = {
      ...baseExecutedRule,
      actionItems: [{ id: "action-1", type: ActionType.NOTIFY_SENDER }],
    } as any;

    await expect(
      executeAct({
        client: mockClient,
        executedRule,
        message,
        emailAccount,
        logger,
      }),
    ).rejects.toThrow("db unavailable");

    expect(mockExecutedRuleUpdate).toHaveBeenCalledWith({
      where: { id: "executed-rule-1" },
      data: { status: ExecutedRuleStatus.APPLIED },
    });
  });

  it("keeps throwing for unexpected action exceptions", async () => {
    const graphError = Object.assign(new Error("Graph move failed"), {
      code: "ErrorMoveCopyFailed",
      statusCode: 503,
      requestId: "graph-request-123",
    });
    mockRunActionFunction.mockRejectedValueOnce(graphError);

    const executedRule = {
      ...baseExecutedRule,
      actionItems: [{ id: "action-1", type: ActionType.LABEL }],
    } as any;

    await expect(
      executeAct({
        client: mockClient,
        executedRule,
        message,
        emailAccount,
        logger,
      }),
    ).rejects.toThrow("Graph move failed");

    expect(mockExecutedRuleUpdate).toHaveBeenCalledTimes(1);
    expect(mockExecutedRuleUpdate).toHaveBeenCalledWith({
      where: { id: "executed-rule-1" },
      data: { status: ExecutedRuleStatus.ERROR },
    });
    expect(mockExecutedActionUpdate).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: {
        executionStatus: "FAILED",
        executedAt: expect.any(Date),
        executionError: {
          code: "ErrorMoveCopyFailed",
          message: "Graph move failed",
          stack: expect.stringContaining("Graph move failed"),
          statusCode: 503,
          requestId: "graph-request-123",
        },
      },
    });
  });
});
