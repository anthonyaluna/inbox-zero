import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { EmailProvider } from "@/utils/email/types";
import type { ParsedMessage } from "@/utils/types";
import prisma from "@/utils/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import { createOrReconcileCoastlineDraft } from "@/utils/ai/choose-rule/draft-management";
import {
  createInboxZeroDraftProposal,
  buildDraftIdempotencyKey,
} from "@/utils/coastline/draft-proposal";
import {
  reconcileCoastlineDraft,
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
    executedAction: {
      findUnique: vi.fn(),
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

  it("recovers one marker-backed provider draft across two action rows without creating twice", async () => {
    const reservation = {
      id: "reservation-1",
      proposalFingerprint: "",
      executedActionId: "action-1",
      creationClaimId: null as string | null,
      draftId: null as string | null,
      terminalState: "reserved",
      recoverableErrorCode: null as string | null,
    };
    reservations.upsert.mockImplementation(async ({ create }) => {
      if (!reservation.proposalFingerprint) {
        reservation.proposalFingerprint = create.proposalFingerprint;
      }
      return { ...reservation };
    });
    reservations.findUnique.mockImplementation(async () => ({
      ...reservation,
    }));
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
        where.draftId === null &&
        reservation.draftId === null &&
        data.draftId
      ) {
        reservation.draftId = data.draftId;
        reservation.terminalState = data.terminalState;
        reservation.recoverableErrorCode = data.recoverableErrorCode;
        return { count: 1 };
      }
      return { count: 0 };
    });
    reservations.update.mockImplementation(async ({ data }) => {
      reservation.terminalState = data.terminalState;
      reservation.recoverableErrorCode = data.recoverableErrorCode;
      return { ...reservation };
    });

    const actionRows = new Map(
      ["action-1", "action-2"].map((id) => [
        id,
        {
          id,
          draftId: null as string | null,
          draftContextMetadata: {} as Record<string, unknown>,
          updatedAt: new Date("2026-08-11T12:00:00.000Z"),
        },
      ]),
    );
    const executedActions = prisma.executedAction as unknown as {
      findUnique: Mock;
      updateMany: Mock;
    };
    executedActions.findUnique.mockImplementation(async ({ where }) => {
      const row = actionRows.get(where.id);
      return row ? { ...row } : null;
    });
    executedActions.updateMany.mockImplementation(async ({ where, data }) => {
      const row = actionRows.get(where.id);
      if (!row || row.updatedAt.getTime() !== where.updatedAt.getTime()) {
        return { count: 0 };
      }
      Object.assign(row, data);
      return { count: 1 };
    });

    const providerDraft: ParsedMessage = {
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
      textPlain: "Body\n\n---- Original Message ----\nFrom: sender@example.com",
      snippet: "",
      historyId: "",
      inline: [],
      internalDate: "",
      labelIds: [],
    };
    const providerDraftsByMarker = new Map<string, ParsedMessage>();
    const findCoastlineDraftsByMarker = vi.fn(async (marker: string) => {
      const draft = providerDraftsByMarker.get(marker);
      return draft ? [draft] : [];
    });
    const getDraft = vi.fn(async (draftId: string) =>
      draftId === providerDraft.id ? providerDraft : null,
    );
    const client = {
      findCoastlineDraftsByMarker,
      getDraft,
    } as unknown as EmailProvider;
    const createDraft = vi.fn(async (marker?: string) => {
      providerDraftsByMarker.set(marker ?? "missing-marker", providerDraft);
      throw new Error("simulated provider response loss");
    });

    await expect(
      createOrReconcileCoastlineDraft({
        actionId: "action-1",
        proposal,
        client,
        createDraft,
        logger: createTestLogger(),
      }),
    ).rejects.toThrow("simulated provider response loss");

    const replay = await createOrReconcileCoastlineDraft({
      actionId: "action-2",
      proposal,
      client,
      createDraft,
      logger: createTestLogger(),
    });

    expect(replay).toMatchObject({
      draftId: "draft-1",
      receipt: {
        draftId: "draft-1",
        terminalState: "created_verified",
        readBackAt: expect.any(String),
      },
    });
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(findCoastlineDraftsByMarker).toHaveBeenCalledTimes(1);
    expect(getDraft).toHaveBeenCalledTimes(2);
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
