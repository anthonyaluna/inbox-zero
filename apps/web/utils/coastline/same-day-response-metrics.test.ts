import { describe, expect, it } from "vitest";
import { createSameDayResponseCase } from "@/utils/coastline/same-day-response-case";
import { summarizeSameDayResponseCases } from "@/utils/coastline/same-day-response-metrics";

describe("Same-Day Response metrics", () => {
  it("counts due, drafted, awaiting, and verified cases without treating drafts as responses", () => {
    const due = createSameDayResponseCase({
      accountId: "account-1",
      sourceMessageId: "message-1",
      sourceThreadId: "thread-1",
      sender: "sender@example.com",
      recipients: { to: ["anthony@example.com"], cc: [], bcc: [] },
      matterType: "inbound_message",
      audience: "other",
      receivedAt: "2026-08-14T23:00:00.000Z",
      accountableOwner: "Coastline Equity",
      nextAction: "Draft a response",
    });
    const drafted = {
      ...due,
      matterId: "drafted",
      state: "drafted" as const,
      draftId: "draft-1",
    };
    const awaiting = {
      ...due,
      matterId: "awaiting",
      state: "awaiting_action" as const,
      nextUpdateAt: "2026-08-15T00:00:00.000Z",
    };
    const closed = {
      ...due,
      matterId: "closed",
      state: "verified_closed" as const,
      terminalEvidence: { readback: "verified" },
    };

    expect(
      summarizeSameDayResponseCases([due, drafted, awaiting, closed], {
        now: "2026-08-15T00:30:00.000Z",
      }),
    ).toEqual({
      total: 4,
      responseDue: 1,
      drafted: 1,
      awaitingAction: 1,
      updatesDue: 1,
      overdueCommitments: 0,
      overdueResponses: 2,
      timelineChanges: 0,
      escalationMarkers: 0,
      unsupportedFactBlocks: 0,
      verifiedClosed: 1,
      sameDayComplianceRate: 0,
    });
  });
});
