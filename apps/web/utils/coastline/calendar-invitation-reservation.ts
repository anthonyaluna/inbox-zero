import type {
  CoastlineCalendarInvitationProposal,
  CoastlineCalendarInvitationReservationStore,
} from "@/utils/coastline/calendar-invitation";
import prisma from "@/utils/prisma";

export const coastlineCalendarInvitationReservations: CoastlineCalendarInvitationReservationStore =
  {
    reserve: reserveCoastlineCalendarInvitation,
    complete: completeCoastlineCalendarInvitation,
    fail: failCoastlineCalendarInvitation,
  };

export async function reserveCoastlineCalendarInvitation({
  proposal,
  proposalFingerprint,
}: {
  proposal: CoastlineCalendarInvitationProposal;
  proposalFingerprint: string;
}) {
  const reservation = await prisma.coastlineCalendarInvitationReservation.upsert({
    where: {
      accountId_idempotencyKey: {
        accountId: proposal.accountId,
        idempotencyKey: proposal.idempotencyKey,
      },
    },
    create: {
      accountId: proposal.accountId,
      idempotencyKey: proposal.idempotencyKey,
      threadId: proposal.threadId,
      sourceMessageId: proposal.sourceMessageId,
      proposalFingerprint,
    },
    update: {},
  });
  if (reservation.proposalFingerprint !== proposalFingerprint) {
    throw Object.assign(
      new Error("Calendar invitation idempotency key has a different proposal"),
      { code: "COASTLINE_CALENDAR_IDEMPOTENCY_CONFLICT" },
    );
  }
  if (
    reservation.terminalState === "created_verified" &&
    reservation.providerEventId &&
    reservation.providerCalendarId &&
    reservation.providerConnectionId
  ) {
    return {
      reservationId: reservation.id,
      state: "existing" as const,
      eventId: reservation.providerEventId,
      providerCalendarId: reservation.providerCalendarId,
      providerConnectionId: reservation.providerConnectionId,
    };
  }
  if (reservation.terminalState !== "reserved") {
    throw Object.assign(
      new Error("Calendar invitation reservation requires recovery"),
      { code: "COASTLINE_CALENDAR_RECOVERY_REQUIRED" },
    );
  }
  return { reservationId: reservation.id, state: "create" as const };
}

export async function completeCoastlineCalendarInvitation({
  reservationId,
  eventId,
  providerCalendarId,
  providerConnectionId,
  terminalState,
}: {
  reservationId: string;
  eventId: string;
  providerCalendarId: string;
  providerConnectionId: string;
  terminalState: "created_verified";
}) {
  await prisma.coastlineCalendarInvitationReservation.update({
    where: { id: reservationId },
    data: {
      providerEventId: eventId,
      providerCalendarId,
      providerConnectionId,
      terminalState,
      recoverableErrorCode: null,
    },
  });
}

export async function failCoastlineCalendarInvitation({
  reservationId,
  recoverableErrorCode,
}: {
  reservationId: string;
  recoverableErrorCode: "COASTLINE_CALENDAR_READBACK_FAILED";
}) {
  await prisma.coastlineCalendarInvitationReservation.update({
    where: { id: reservationId },
    data: {
      terminalState: "recovery_required",
      recoverableErrorCode,
    },
  });
}
