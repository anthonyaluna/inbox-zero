import { describe, expect, it, vi } from "vitest";
import { dispatchCalendarForMessage } from "@/utils/coastline/calendar-context-dispatch";

describe("dispatchCalendarForMessage", () => {
  it("emits one CREATE_CALENDAR_EVENT from a clear bounded scheduling context", async () => {
    const proposal = {
      accountId: "account-1",
      threadId: "thread-1",
      sourceMessageId: "message-1",
      idempotencyKey: "inbox-zero/calendar/account-1/thread-1/message-1",
    };
    const dispatch = vi.fn().mockResolvedValue({
      action: "CREATE_CALENDAR_EVENT",
      receipt: { eventId: "event-1" },
    });

    const result = await dispatchCalendarForMessage({
      clientName: "microsoft",
      message: { id: "message-1" } as never,
      account: {
        id: "account-1",
        email: "anthony@example.com",
        timezone: "America/Los_Angeles",
      },
      logger: {} as never,
      classify: () => ({ status: "clear", proposal }),
      dispatch,
    });

    expect(result).toEqual({ status: "dispatched", eventId: "event-1" });
    expect(dispatch).toHaveBeenCalledWith({ proposal, logger: expect.anything() });
  });

  it("does not emit a calendar event for ambiguous scheduling", async () => {
    const dispatch = vi.fn();

    const result = await dispatchCalendarForMessage({
      clientName: "microsoft",
      message: { id: "message-1" } as never,
      account: { id: "account-1", email: "anthony@example.com" },
      logger: {} as never,
      classify: () => ({ status: "ambiguous", reason: "exact_date_missing" }),
      dispatch,
    });

    expect(result).toEqual({ status: "ambiguous", reason: "exact_date_missing" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not emit a calendar event for conflicting scheduling facts", async () => {
    const dispatch = vi.fn();

    const result = await dispatchCalendarForMessage({
      clientName: "microsoft",
      message: { id: "message-1" } as never,
      account: { id: "account-1", email: "anthony@example.com" },
      logger: {} as never,
      classify: () => ({
        status: "conflicting",
        reason: "multiple_or_uncertain_options",
      }),
      dispatch,
    });

    expect(result).toEqual({
      status: "conflicting",
      reason: "multiple_or_uncertain_options",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not classify or dispatch from non-Microsoft mailboxes", async () => {
    const classify = vi.fn();
    const dispatch = vi.fn();

    const result = await dispatchCalendarForMessage({
      clientName: "google",
      message: { id: "message-1" } as never,
      account: { id: "account-1", email: "anthony@example.com" },
      logger: {} as never,
      classify,
      dispatch,
    });

    expect(result).toEqual({ status: "not_microsoft" });
    expect(classify).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
