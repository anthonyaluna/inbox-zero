import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildCalendarInvitationIdempotencyKey,
  createCoastlineCalendarInvitationProposal,
  executeCoastlineCalendarInvitation,
} from "@/utils/coastline/calendar-invitation";

const proposalInput = {
  accountId: "account-1",
  threadId: "thread-1",
  sourceMessageId: "message-1",
  title: "Freeman security review",
  startAt: "2026-08-13T17:00:00.000Z",
  endAt: "2026-08-13T17:30:00.000Z",
  timezone: "America/Los_Angeles",
  location: "1400 Freeman Ave",
  attendees: [
    { email: "bond@example.com", name: "Bond Nichols" },
    { email: "ops@example.com", name: "Operations" },
  ],
  schedulingStatus: "clear" as const,
};

describe("Coastline calendar invitations", () => {
  it("creates one exact attendee event and records sanitized provider readback", async () => {
    const proposal = createCoastlineCalendarInvitationProposal(proposalInput);
    const reservation = {
      reserve: vi.fn().mockResolvedValue({
        reservationId: "reservation-1",
        state: "create",
      }),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const provider = {
      createAttendeeEvent: vi.fn().mockResolvedValue({
        eventId: "event-1",
        providerCalendarId: "calendar-1",
        providerConnectionId: "connection-1",
      }),
      readEvent: vi.fn().mockResolvedValue({
        id: "event-1",
        title: proposal.title,
        startAt: proposal.startAt,
        endAt: proposal.endAt,
        timezone: proposal.timezone,
        location: proposal.location,
        attendees: proposal.attendees,
      }),
    };

    const result = await executeCoastlineCalendarInvitation({
      proposal,
      provider,
      reservations: reservation,
    });

    expect(provider.createAttendeeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        attendees: proposal.attendees,
        endAt: proposal.endAt,
        location: proposal.location,
        startAt: proposal.startAt,
        timezone: "America/Los_Angeles",
      }),
    );
    expect(provider.readEvent).toHaveBeenCalledWith({
      eventId: "event-1",
      providerCalendarId: "calendar-1",
      providerConnectionId: "connection-1",
    });
    expect(result.receipt).toMatchObject({
      terminalState: "created_verified",
      eventId: "event-1",
      attendeeCount: 2,
      timezone: "America/Los_Angeles",
      durationMinutes: 30,
      attendeeSetSha256: createHash("sha256")
        .update("bond@example.com\nops@example.com")
        .digest("hex"),
    });
    expect(JSON.stringify(result.receipt)).not.toContain("bond@example.com");
    expect(reservation.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "event-1",
        terminalState: "created_verified",
      }),
    );
  });

  it("never creates an event for ambiguous scheduling or unavailable calendar mutations", async () => {
    const reservations = {
      reserve: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const provider = {
      createAttendeeEvent: vi.fn(),
      readEvent: vi.fn(),
    };

    await expect(
      executeCoastlineCalendarInvitation({
        proposal: {
          ...createCoastlineCalendarInvitationProposal(proposalInput),
          schedulingStatus: "ambiguous",
        },
        provider,
        reservations,
      }),
    ).rejects.toMatchObject({ code: "COASTLINE_CALENDAR_SCHEDULING_UNCLEAR" });

    expect(reservations.reserve).not.toHaveBeenCalled();
    expect(provider.createAttendeeEvent).not.toHaveBeenCalled();
    expect(provider).not.toHaveProperty("cancelEvent");
    expect(provider).not.toHaveProperty("respondToInvitation");
  });

  it("fails closed when Graph readback changes an attendee or location", async () => {
    const proposal = createCoastlineCalendarInvitationProposal(proposalInput);
    const reservations = {
      reserve: vi.fn().mockResolvedValue({
        reservationId: "reservation-1",
        state: "create",
      }),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const provider = {
      createAttendeeEvent: vi.fn().mockResolvedValue({
        eventId: "event-1",
        providerCalendarId: "calendar-1",
        providerConnectionId: "connection-1",
      }),
      readEvent: vi.fn().mockResolvedValue({
        id: "event-1",
        title: proposal.title,
        startAt: proposal.startAt,
        endAt: proposal.endAt,
        timezone: proposal.timezone,
        location: "Other location",
        attendees: proposal.attendees.slice(0, 1),
      }),
    };

    await expect(
      executeCoastlineCalendarInvitation({
        proposal,
        provider,
        reservations,
      }),
    ).rejects.toMatchObject({ code: "COASTLINE_CALENDAR_READBACK_FAILED" });

    expect(reservations.complete).not.toHaveBeenCalled();
    expect(reservations.fail).toHaveBeenCalledWith({
      reservationId: "reservation-1",
      recoverableErrorCode: "COASTLINE_CALENDAR_READBACK_FAILED",
    });
  });

  it("replays a verified reservation without creating a duplicate event", async () => {
    const proposal = createCoastlineCalendarInvitationProposal(proposalInput);
    const reservations = {
      reserve: vi.fn().mockResolvedValue({
        reservationId: "reservation-1",
        state: "existing",
        eventId: "event-1",
        providerCalendarId: "calendar-1",
        providerConnectionId: "connection-1",
      }),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const provider = {
      createAttendeeEvent: vi.fn(),
      readEvent: vi.fn().mockResolvedValue({
        id: "event-1",
        title: proposal.title,
        startAt: proposal.startAt,
        endAt: proposal.endAt,
        timezone: proposal.timezone,
        location: proposal.location,
        attendees: proposal.attendees,
      }),
    };

    const replay = await executeCoastlineCalendarInvitation({
      proposal,
      provider,
      reservations,
    });

    expect(provider.createAttendeeEvent).not.toHaveBeenCalled();
    expect(replay.receipt).toMatchObject({
      eventId: "event-1",
      terminalState: "created_verified",
    });
  });

  it("binds the event idempotency key to its source request", () => {
    expect(
      buildCalendarInvitationIdempotencyKey({
        accountId: "account-1",
        threadId: "thread-1",
        sourceMessageId: "message-1",
      }),
    ).toBe("inbox-zero/calendar/account-1/thread-1/message-1");
  });
});
