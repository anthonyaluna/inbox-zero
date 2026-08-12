import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import prisma from "@/utils/prisma";
import {
  completeCoastlineCalendarInvitation,
  reserveCoastlineCalendarInvitation,
} from "@/utils/coastline/calendar-invitation-reservation";
import { createCoastlineCalendarInvitationProposal } from "@/utils/coastline/calendar-invitation";

vi.mock("@/utils/prisma", () => ({
  default: {
    coastlineCalendarInvitationReservation: {
      upsert: vi.fn(),
      update: vi.fn(),
    },
  },
}));

const proposal = createCoastlineCalendarInvitationProposal({
  accountId: "account-1",
  threadId: "thread-1",
  sourceMessageId: "message-1",
  title: "Meeting",
  startAt: "2026-08-13T17:00:00.000Z",
  endAt: "2026-08-13T17:30:00.000Z",
  timezone: "America/Los_Angeles",
  location: "Office",
  attendees: [{ email: "guest@example.com" }],
  schedulingStatus: "clear",
});

describe("Coastline calendar invitation reservation", () => {
  const reservations = prisma.coastlineCalendarInvitationReservation as unknown as {
    upsert: Mock;
    update: Mock;
  };

  beforeEach(() => vi.clearAllMocks());

  it("returns a verified existing event for the same source-bound key", async () => {
    reservations.upsert.mockResolvedValue({
      id: "reservation-1",
      proposalFingerprint: "fingerprint-1",
      providerEventId: "event-1",
      providerCalendarId: "calendar-1",
      providerConnectionId: "connection-1",
      terminalState: "created_verified",
    });

    await expect(
      reserveCoastlineCalendarInvitation({
        proposal,
        proposalFingerprint: "fingerprint-1",
      }),
    ).resolves.toEqual({
      reservationId: "reservation-1",
      state: "existing",
      eventId: "event-1",
      providerCalendarId: "calendar-1",
      providerConnectionId: "connection-1",
    });
  });

  it("persists a verified provider event only after readback", async () => {
    reservations.update.mockResolvedValue({});

    await completeCoastlineCalendarInvitation({
      reservationId: "reservation-1",
      eventId: "event-1",
      providerCalendarId: "calendar-1",
      providerConnectionId: "connection-1",
      terminalState: "created_verified",
    });

    expect(reservations.update).toHaveBeenCalledWith({
      where: { id: "reservation-1" },
      data: {
        providerEventId: "event-1",
        providerCalendarId: "calendar-1",
        providerConnectionId: "connection-1",
        terminalState: "created_verified",
        recoverableErrorCode: null,
      },
    });
  });
});
