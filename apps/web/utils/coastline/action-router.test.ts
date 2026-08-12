import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import {
  COASTLINE_REGISTERED_ACTIONS,
  createCalendarEventAction,
  runCoastlineAction,
} from "@/utils/coastline/action-router";
import { createAndVerifyMicrosoftCalendarInvitation } from "@/utils/coastline/calendar-invitation-microsoft";

vi.mock("@/utils/coastline/calendar-invitation-microsoft", () => ({
  createAndVerifyMicrosoftCalendarInvitation: vi.fn(),
}));

const actionInput = {
  accountId: "account-1",
  threadId: "thread-1",
  sourceMessageId: "message-1",
  title: "Freeman security review",
  startAt: "2026-08-13T17:00:00.000Z",
  endAt: "2026-08-13T17:30:00.000Z",
  timezone: "America/Los_Angeles",
  location: "1400 Freeman Ave",
  attendees: [{ email: "bond@example.com", name: "Bond Nichols" }],
  schedulingStatus: "clear" as const,
  destinationCalendarId: "calendar-1",
};

describe("Coastline action router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers only the bounded calendar event action, creates it, and returns a validated receipt", async () => {
    const action = createCalendarEventAction(actionInput);
    const receipt = {
      schemaVersion: "inbox_zero_calendar_invitation_receipt.v1" as const,
      provider: "microsoft" as const,
      accountId: "account-1",
      threadId: "thread-1",
      sourceMessageId: "message-1",
      idempotencyKey: "inbox-zero/calendar/account-1/thread-1/message-1",
      eventId: "event-1",
      providerCalendarId: "calendar-1",
      providerConnectionId: "connection-1",
      titleSha256: "a".repeat(64),
      attendeeSetSha256: "b".repeat(64),
      attendeeCount: 1,
      locationSha256: "c".repeat(64),
      timezone: "America/Los_Angeles",
      durationMinutes: 30,
      readBackAt: "2026-08-12T12:00:00.000Z",
      terminalState: "created_verified" as const,
    };
    vi.mocked(createAndVerifyMicrosoftCalendarInvitation).mockResolvedValue({
      receipt,
    });

    const result = await runCoastlineAction({
      action,
      logger: createTestLogger(),
    });

    expect(COASTLINE_REGISTERED_ACTIONS).toEqual(["CREATE_CALENDAR_EVENT"]);
    expect(COASTLINE_REGISTERED_ACTIONS).not.toContain("SEND_EMAIL");
    expect(createAndVerifyMicrosoftCalendarInvitation).toHaveBeenCalledWith({
      proposal: action.proposal,
      destinationCalendarId: "calendar-1",
      logger: expect.anything(),
    });
    expect(result).toEqual({
      action: "CREATE_CALENDAR_EVENT",
      proposal: action.proposal,
      receipt,
    });
  });

  it("rejects unclear scheduling before calendar provider invocation", async () => {
    const action = createCalendarEventAction({
      ...actionInput,
      schedulingStatus: "ambiguous",
    });

    await expect(
      runCoastlineAction({ action, logger: createTestLogger() }),
    ).rejects.toMatchObject({ code: "COASTLINE_CALENDAR_SCHEDULING_UNCLEAR" });

    expect(createAndVerifyMicrosoftCalendarInvitation).not.toHaveBeenCalled();
  });

  it("does not report success when the calendar receipt fails validation", async () => {
    vi.mocked(createAndVerifyMicrosoftCalendarInvitation).mockResolvedValue({
      receipt: { terminalState: "created_verified" } as never,
    });

    await expect(
      runCoastlineAction({
        action: createCalendarEventAction(actionInput),
        logger: createTestLogger(),
      }),
    ).rejects.toThrow();
  });
});
