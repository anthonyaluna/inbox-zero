import { randomUUID } from "node:crypto";
import type {
  CoastlineCalendarInvitationProposal,
  CoastlineCalendarInvitationReservationStore,
} from "@/utils/coastline/calendar-invitation";
import prisma from "@/utils/prisma";

const CALENDAR_CREATION_LEASE_MS = 5 * 60 * 1000;

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
  const now = new Date();
  const creationClaimId = randomUUID();
  const creationClaimExpiresAt = new Date(
    now.getTime() + CALENDAR_CREATION_LEASE_MS,
  );
  const reservation =
    await prisma.coastlineCalendarInvitationReservation.upsert({
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

  const claim = await prisma.coastlineCalendarInvitationReservation.updateMany({
    where: {
      id: reservation.id,
      terminalState: "reserved",
      providerEventId: null,
      OR: [{ creationClaimId: null }, { creationClaimExpiresAt: { lt: now } }],
    },
    data: { creationClaimId, creationClaimExpiresAt },
  });
  if (claim.count === 1) {
    return {
      reservationId: reservation.id,
      state: "create" as const,
      creationClaimId,
    };
  }

  if (
    reservation.creationClaimExpiresAt &&
    reservation.creationClaimExpiresAt <= now
  ) {
    await prisma.coastlineCalendarInvitationReservation.updateMany({
      where: {
        id: reservation.id,
        terminalState: "reserved",
        creationClaimId: reservation.creationClaimId,
        creationClaimExpiresAt: { lte: now },
      },
      data: {
        terminalState: "recovery_required",
        recoverableErrorCode: "COASTLINE_CALENDAR_CREATION_LEASE_EXPIRED",
        creationClaimId: null,
        creationClaimExpiresAt: null,
      },
    });
    throw Object.assign(
      new Error(
        "Calendar invitation creation lease expired and requires recovery",
      ),
      { code: "COASTLINE_CALENDAR_RECOVERY_REQUIRED" },
    );
  }

  throw Object.assign(
    new Error("Calendar invitation creation is already in progress"),
    { code: "COASTLINE_CALENDAR_RESERVATION_IN_PROGRESS" },
  );
}

export async function completeCoastlineCalendarInvitation({
  reservationId,
  creationClaimId,
  eventId,
  providerCalendarId,
  providerConnectionId,
  terminalState,
}: {
  reservationId: string;
  creationClaimId: string;
  eventId: string;
  providerCalendarId: string;
  providerConnectionId: string;
  terminalState: "created_verified";
}) {
  const completed =
    await prisma.coastlineCalendarInvitationReservation.updateMany({
      where: {
        id: reservationId,
        terminalState: "reserved",
        creationClaimId,
      },
      data: {
        providerEventId: eventId,
        providerCalendarId,
        providerConnectionId,
        terminalState,
        recoverableErrorCode: null,
        creationClaimId: null,
        creationClaimExpiresAt: null,
      },
    });
  if (completed.count !== 1) {
    throw Object.assign(
      new Error("Calendar invitation creation claim could not be persisted"),
      { code: "COASTLINE_CALENDAR_RECOVERY_REQUIRED" },
    );
  }
}

export async function failCoastlineCalendarInvitation({
  reservationId,
  creationClaimId,
  recoverableErrorCode,
}: {
  reservationId: string;
  creationClaimId?: string;
  recoverableErrorCode: "COASTLINE_CALENDAR_READBACK_FAILED";
}) {
  if (!creationClaimId) {
    await prisma.coastlineCalendarInvitationReservation.update({
      where: { id: reservationId },
      data: {
        terminalState: "recovery_required",
        recoverableErrorCode,
      },
    });
    return;
  }

  await prisma.coastlineCalendarInvitationReservation.updateMany({
    where: {
      id: reservationId,
      terminalState: "reserved",
      creationClaimId,
    },
    data: {
      terminalState: "recovery_required",
      recoverableErrorCode,
      creationClaimId: null,
      creationClaimExpiresAt: null,
    },
  });
}
