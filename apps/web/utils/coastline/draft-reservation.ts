import { createHash } from "node:crypto";
import type { EmailProvider } from "@/utils/email/types";
import type { InboxZeroDraftProposal } from "@/utils/coastline/draft-proposal";
import prisma from "@/utils/prisma";

type ReservationState =
  | "reserved"
  | "created_unverified"
  | "created_verified"
  | "recovery_required";

type ReservationInput = {
  actionId: string;
  proposal: InboxZeroDraftProposal;
  proposalFingerprint?: string;
  client: EmailProvider;
};

export async function reserveOrReconcileCoastlineDraft({
  actionId,
  proposal,
  proposalFingerprint = fingerprintProposal(proposal),
}: ReservationInput): Promise<{
  reservationId: string;
  draftId: string | null;
  state: ReservationState;
}> {
  const reservation = await prisma.coastlineDraftReservation.upsert({
    where: {
      accountId_idempotencyKey: {
        accountId: proposal.account_id,
        idempotencyKey: proposal.idempotency_key,
      },
    },
    create: {
      accountId: proposal.account_id,
      idempotencyKey: proposal.idempotency_key,
      threadId: proposal.thread_id,
      sourceMessageId: proposal.source_message_id,
      proposalFingerprint,
      executedActionId: actionId,
      terminalState: "reserved",
    },
    update: {},
  });

  if (reservation.proposalFingerprint !== proposalFingerprint) {
    throw Object.assign(
      new Error("Coastline draft idempotency key has a different proposal"),
      { code: "COASTLINE_DRAFT_IDEMPOTENCY_CONFLICT" },
    );
  }

  if (!reservation.draftId && reservation.executedActionId !== actionId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const recovered = await prisma.coastlineDraftReservation.findUnique({
        where: { id: reservation.id },
      });
      if (recovered?.draftId) {
        return {
          reservationId: recovered.id,
          draftId: recovered.draftId,
          state: recovered.terminalState as ReservationState,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return {
      reservationId: reservation.id,
      draftId: null,
      state: "recovery_required",
    };
  }

  return {
    reservationId: reservation.id,
    draftId: reservation.draftId,
    state: reservation.terminalState as ReservationState,
  };
}

export async function recordCoastlineDraftCreation({
  reservationId,
  draftId,
}: {
  reservationId: string;
  draftId: string;
}) {
  await prisma.coastlineDraftReservation.update({
    where: { id: reservationId },
    data: {
      draftId,
      terminalState: "created_unverified",
      recoverableErrorCode: null,
    },
  });
}

export async function reconcileCoastlineDraft({
  reservationId,
  draftId,
  proposal,
  client,
}: {
  reservationId: string;
  draftId: string;
  proposal: InboxZeroDraftProposal;
  client: EmailProvider;
}): Promise<{ draftId: string; terminalState: "created_verified" }> {
  const draft = await client.getDraft(draftId);
  if (!draft || draft.id !== draftId || draft.threadId !== proposal.thread_id) {
    await markRecoveryRequired(
      reservationId,
      "COASTLINE_DRAFT_READBACK_FAILED",
    );
    throw Object.assign(
      new Error("Coastline draft independent readback did not match"),
      {
        code: "COASTLINE_DRAFT_READBACK_FAILED",
      },
    );
  }

  await prisma.coastlineDraftReservation.update({
    where: { id: reservationId },
    data: {
      terminalState: "created_verified",
      recoverableErrorCode: null,
    },
  });
  return { draftId, terminalState: "created_verified" };
}

export async function markRecoveryRequired(
  reservationId: string,
  recoverableErrorCode: string,
) {
  await prisma.coastlineDraftReservation.update({
    where: { id: reservationId },
    data: { terminalState: "recovery_required", recoverableErrorCode },
  });
}

export function fingerprintProposal(proposal: InboxZeroDraftProposal) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        accountId: proposal.account_id,
        threadId: proposal.thread_id,
        sourceMessageId: proposal.source_message_id,
        to: proposal.to,
        cc: proposal.cc,
        bcc: proposal.bcc,
        subject: proposal.subject,
        bodyText: proposal.body_text,
      }),
    )
    .digest("hex");
}
