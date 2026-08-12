import { createHash } from "node:crypto";
import type { EmailProvider } from "@/utils/email/types";
import type { InboxZeroDraftProposal } from "@/utils/coastline/draft-proposal";
import { convertEmailHtmlToText } from "@/utils/mail";
import { stripQuotedHtmlContent } from "@/utils/email/parse-message-reply";
import { stripQuotedContent } from "@/utils/email/strip-quoted-content";
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
  client,
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

  if (!reservation.draftId && reservation.terminalState === "reserved") {
    const claim = await prisma.coastlineDraftReservation.updateMany({
      where: {
        id: reservation.id,
        terminalState: "reserved",
        draftId: null,
        creationClaimId: null,
      },
      data: { creationClaimId: actionId },
    });
    if (claim.count === 1) {
      return {
        reservationId: reservation.id,
        draftId: null,
        state: "reserved",
      };
    }

    const providerRecovery = await recoverProviderDraft({
      reservationId: reservation.id,
      proposal,
      client,
    });
    if (providerRecovery) return providerRecovery;

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
    await markRecoveryRequired(
      reservation.id,
      "COASTLINE_DRAFT_RECOVERY_REQUIRED",
    );
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

async function recoverProviderDraft({
  reservationId,
  proposal,
  client,
}: {
  reservationId: string;
  proposal: InboxZeroDraftProposal;
  client: EmailProvider;
}): Promise<{
  reservationId: string;
  draftId: string | null;
  state: ReservationState;
} | null> {
  let drafts: Awaited<ReturnType<EmailProvider["getDrafts"]>>;
  try {
    drafts = await client.getDrafts({ maxResults: 100 });
  } catch {
    await markRecoveryRequired(
      reservationId,
      "COASTLINE_DRAFT_PROVIDER_RECONCILIATION_UNAVAILABLE",
    );
    return {
      reservationId,
      draftId: null,
      state: "recovery_required",
    };
  }

  const matches = drafts.filter((draft) =>
    matchesProposal({ draft, draftId: draft.id, proposal }),
  );
  if (matches.length > 1) {
    await markRecoveryRequired(
      reservationId,
      "COASTLINE_DRAFT_PROVIDER_RECONCILIATION_AMBIGUOUS",
    );
    return {
      reservationId,
      draftId: null,
      state: "recovery_required",
    };
  }
  if (matches.length === 0) return null;

  const draftId = matches[0]?.id;
  if (!draftId) return null;
  const persisted = await prisma.coastlineDraftReservation.updateMany({
    where: {
      id: reservationId,
      draftId: null,
      terminalState: "reserved",
    },
    data: {
      draftId,
      terminalState: "created_unverified",
      recoverableErrorCode: null,
    },
  });
  if (persisted.count !== 1) return null;
  return { reservationId, draftId, state: "created_unverified" };
}

export async function recordCoastlineDraftCreation({
  reservationId,
  draftId,
  creationClaimId,
}: {
  reservationId: string;
  draftId: string;
  creationClaimId: string;
}) {
  const result = await prisma.coastlineDraftReservation.updateMany({
    where: { id: reservationId, creationClaimId, draftId: null },
    data: {
      draftId,
      terminalState: "created_unverified",
      recoverableErrorCode: null,
    },
  });
  if (result.count !== 1) {
    throw Object.assign(
      new Error("Coastline draft creation claim could not be persisted"),
      { code: "COASTLINE_DRAFT_RECOVERY_REQUIRED" },
    );
  }
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
  if (!draft || !matchesProposal({ draft, draftId, proposal })) {
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
  await prisma.coastlineDraftReservation.updateMany({
    where: {
      id: reservationId,
      terminalState: { not: "created_verified" },
    },
    data: { terminalState: "recovery_required", recoverableErrorCode },
  });
}

function matchesProposal({
  draft,
  draftId,
  proposal,
}: {
  draft: Awaited<ReturnType<EmailProvider["getDraft"]>>;
  draftId: string;
  proposal: InboxZeroDraftProposal;
}) {
  if (!draft || draft.id !== draftId || draft.threadId !== proposal.thread_id) {
    return false;
  }
  const plainText =
    draft.bodyContentType === "html"
      ? draft.textPlain
        ? convertEmailHtmlToText({
            htmlText: stripQuotedHtmlContent(draft.textPlain),
            includeLinks: false,
          })
        : ""
      : draft.textPlain || "";
  if (
    draft.subject.trim() !== proposal.subject.trim() ||
    stripQuotedContent(plainText) !== proposal.body_text.trim()
  ) {
    return false;
  }
  return (
    recipientsMatch(draft.headers.to, proposal.to) &&
    recipientsMatch(draft.headers.cc, proposal.cc) &&
    recipientsMatch(draft.headers.bcc, proposal.bcc)
  );
}

function recipientsMatch(actual: string | undefined, expected: string[]) {
  return (
    normalizeRecipients(actual).join("\n") ===
    normalizeRecipients(expected.join(",")).join("\n")
  );
}

function normalizeRecipients(value: string | undefined) {
  return (value ?? "")
    .split(/[;,]/)
    .map((entry) => {
      const match = entry.match(/<([^>]+)>/);
      return (match?.[1] ?? entry).trim().toLowerCase();
    })
    .filter(Boolean)
    .sort();
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
