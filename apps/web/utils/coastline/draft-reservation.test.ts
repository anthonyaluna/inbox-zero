import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { EmailProvider } from "@/utils/email/types";
import prisma from "@/utils/prisma";
import {
  createInboxZeroDraftProposal,
  buildDraftIdempotencyKey,
} from "@/utils/coastline/draft-proposal";
import {
  reconcileCoastlineDraft,
  recordCoastlineDraftCreation,
  reserveOrReconcileCoastlineDraft,
} from "@/utils/coastline/draft-reservation";

vi.mock("@/utils/prisma", () => ({
  default: {
    coastlineDraftReservation: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

const proposal = createInboxZeroDraftProposal({
  provider: "microsoft",
  account_id: "account-1",
  thread_id: "thread-1",
  source_message_id: "message-1",
  to: ["recipient@example.com"],
  cc: [],
  bcc: [],
  subject: "Subject",
  body_text: "Body",
  confidence: "medium",
  model: "test",
  idempotency_key: buildDraftIdempotencyKey({
    accountId: "account-1",
    threadId: "thread-1",
    sourceMessageId: "message-1",
  }),
  generated_at: "2026-08-11T12:00:00.000Z",
});

describe("reserveOrReconcileCoastlineDraft", () => {
  const reservations = prisma.coastlineDraftReservation as unknown as {
    upsert: Mock;
    findUnique: Mock;
    update: Mock;
    updateMany: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    reservations.updateMany.mockResolvedValue({ count: 1 });
  });

  it("reuses one durable reservation for separate action rows", async () => {
    reservations.upsert
      .mockResolvedValueOnce({
        id: "reservation-1",
        proposalFingerprint: "fingerprint-1",
        executedActionId: "action-1",
        draftId: null,
        terminalState: "reserved",
      })
      .mockResolvedValueOnce({
        id: "reservation-1",
        proposalFingerprint: "fingerprint-1",
        executedActionId: "action-1",
        draftId: "draft-1",
        terminalState: "created_verified",
      });

    const first = await reserveOrReconcileCoastlineDraft({
      actionId: "action-1",
      proposal,
      proposalFingerprint: "fingerprint-1",
      client: {} as EmailProvider,
    });
    const second = await reserveOrReconcileCoastlineDraft({
      actionId: "action-2",
      proposal,
      proposalFingerprint: "fingerprint-1",
      client: {} as EmailProvider,
    });

    expect(first).toEqual({
      reservationId: "reservation-1",
      draftId: null,
      state: "reserved",
    });
    expect(second).toEqual({
      reservationId: "reservation-1",
      draftId: "draft-1",
      state: "created_verified",
    });
  });

  it("rejects a reused key when its proposal fingerprint differs", async () => {
    reservations.upsert.mockResolvedValue({
      id: "reservation-1",
      proposalFingerprint: "different-fingerprint",
      executedActionId: "action-1",
      draftId: null,
      terminalState: "reserved",
    });

    await expect(
      reserveOrReconcileCoastlineDraft({
        actionId: "action-1",
        proposal,
        proposalFingerprint: "fingerprint-1",
        client: {} as EmailProvider,
      }),
    ).rejects.toMatchObject({ code: "COASTLINE_DRAFT_IDEMPOTENCY_CONFLICT" });
  });

  it("waits for a concurrent creator to persist its draft ID", async () => {
    reservations.upsert.mockResolvedValue({
      id: "reservation-1",
      proposalFingerprint: "fingerprint-1",
      executedActionId: "action-1",
      draftId: null,
      terminalState: "reserved",
    });
    reservations.findUnique.mockResolvedValue({
      id: "reservation-1",
      draftId: "draft-1",
      terminalState: "created_unverified",
    });
    reservations.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      reserveOrReconcileCoastlineDraft({
        actionId: "action-2",
        proposal,
        proposalFingerprint: "fingerprint-1",
        client: {
          findCoastlineDraftsByMarker: vi.fn().mockResolvedValue([]),
        } as unknown as EmailProvider,
      }),
    ).resolves.toEqual({
      reservationId: "reservation-1",
      draftId: "draft-1",
      state: "created_unverified",
    });
  });

  it("persists recovery-required state when a creator claim remains ambiguous", async () => {
    reservations.upsert.mockResolvedValue({
      id: "reservation-1",
      proposalFingerprint: "fingerprint-1",
      executedActionId: "action-1",
      draftId: null,
      terminalState: "reserved",
    });
    reservations.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    reservations.findUnique.mockResolvedValue(null);

    await expect(
      reserveOrReconcileCoastlineDraft({
        actionId: "action-2",
        proposal,
        proposalFingerprint: "fingerprint-1",
        client: {
          findCoastlineDraftsByMarker: vi.fn().mockResolvedValue([]),
        } as unknown as EmailProvider,
      }),
    ).resolves.toMatchObject({ state: "recovery_required" });

    expect(reservations.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "reservation-1",
        terminalState: { not: "created_verified" },
      },
      data: {
        terminalState: "recovery_required",
        recoverableErrorCode: "COASTLINE_DRAFT_RECOVERY_REQUIRED",
      },
    });
  });

  it("requires full proposal readback before marking a draft verified", async () => {
    const client = {
      getDraft: vi.fn().mockResolvedValue({
        id: "draft-1",
        threadId: "thread-1",
        snippet: "",
        historyId: "",
        inline: [],
        subject: "Subject",
        headers: {
          from: "account@example.com",
          to: "other@example.com",
          subject: "Subject",
          date: "2026-08-11T12:00:00.000Z",
        },
        textPlain: "Body",
      }),
    } as unknown as EmailProvider;

    await expect(
      reconcileCoastlineDraft({
        reservationId: "reservation-1",
        draftId: "draft-1",
        proposal,
        client,
      }),
    ).rejects.toMatchObject({ code: "COASTLINE_DRAFT_READBACK_FAILED" });

    expect(reservations.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ terminalState: "created_verified" }),
      }),
    );
  });

  it("allows one provider create across two action IDs through the durable claim", async () => {
    const reservation = {
      id: "reservation-1",
      proposalFingerprint: "fingerprint-1",
      executedActionId: "action-1",
      creationClaimId: null as string | null,
      draftId: null as string | null,
      terminalState: "reserved",
    };
    reservations.upsert.mockImplementation(async () => reservation);
    reservations.updateMany.mockImplementation(async ({ where, data }) => {
      if (
        where.creationClaimId === null &&
        reservation.creationClaimId === null &&
        data.creationClaimId
      ) {
        reservation.creationClaimId = data.creationClaimId;
        return { count: 1 };
      }
      if (
        where.creationClaimId === reservation.creationClaimId &&
        where.draftId === null &&
        data.draftId
      ) {
        reservation.draftId = data.draftId;
        reservation.terminalState = data.terminalState;
        return { count: 1 };
      }
      return { count: 0 };
    });
    const client = {
      getDrafts: vi.fn().mockResolvedValue([]),
    } as unknown as EmailProvider;
    const draftEmail = vi.fn().mockResolvedValue({ draftId: "draft-1" });

    const creator = await reserveOrReconcileCoastlineDraft({
      actionId: "action-1",
      proposal,
      proposalFingerprint: "fingerprint-1",
      client,
    });
    const created = await draftEmail();
    await recordCoastlineDraftCreation({
      reservationId: creator.reservationId,
      draftId: created.draftId,
      creationClaimId: "action-1",
    });
    const replay = await reserveOrReconcileCoastlineDraft({
      actionId: "action-2",
      proposal,
      proposalFingerprint: "fingerprint-1",
      client,
    });

    expect(creator.state).toBe("reserved");
    expect(replay).toEqual({
      reservationId: "reservation-1",
      draftId: "draft-1",
      state: "created_unverified",
    });
    expect(draftEmail).toHaveBeenCalledTimes(1);
  });

  it("recovers one matching provider draft after a crash before draft ID persistence", async () => {
    const reservation = {
      id: "reservation-1",
      proposalFingerprint: "fingerprint-1",
      executedActionId: "action-1",
      creationClaimId: "action-1",
      draftId: null as string | null,
      terminalState: "reserved",
    };
    reservations.upsert.mockImplementation(async () => reservation);
    reservations.updateMany.mockImplementation(async ({ data }) => {
      if (data.draftId === "draft-1") {
        reservation.draftId = data.draftId;
        reservation.terminalState = data.terminalState;
        return { count: 1 };
      }
      return { count: 0 };
    });
    const client = {
      findCoastlineDraftsByMarker: vi.fn().mockResolvedValue([
        {
          id: "draft-1",
          threadId: "thread-1",
          subject: "Subject",
          headers: {
            from: "account@example.com",
            to: "recipient@example.com",
            cc: "",
            bcc: "",
            subject: "Subject",
            date: "2026-08-11T12:00:00.000Z",
          },
          textPlain:
            "Body\n\n---- Original Message ----\nFrom: sender@example.com",
          snippet: "",
          historyId: "",
          inline: [],
        },
      ]),
    } as unknown as EmailProvider;

    await expect(
      reserveOrReconcileCoastlineDraft({
        actionId: "action-2",
        proposal,
        proposalFingerprint: "fingerprint-1",
        client,
      }),
    ).resolves.toEqual({
      reservationId: "reservation-1",
      draftId: "draft-1",
      state: "created_unverified",
    });
    expect(client.findCoastlineDraftsByMarker).toHaveBeenCalledTimes(1);
  });
});
