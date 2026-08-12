import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { EmailProvider } from "@/utils/email/types";
import prisma from "@/utils/prisma";
import {
  createInboxZeroDraftProposal,
  buildDraftIdempotencyKey,
} from "@/utils/coastline/draft-proposal";
import { reserveOrReconcileCoastlineDraft } from "@/utils/coastline/draft-reservation";

vi.mock("@/utils/prisma", () => ({
  default: {
    coastlineDraftReservation: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
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
  };

  beforeEach(() => vi.clearAllMocks());

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

    await expect(
      reserveOrReconcileCoastlineDraft({
        actionId: "action-2",
        proposal,
        proposalFingerprint: "fingerprint-1",
        client: {} as EmailProvider,
      }),
    ).resolves.toEqual({
      reservationId: "reservation-1",
      draftId: "draft-1",
      state: "created_unverified",
    });
  });
});
