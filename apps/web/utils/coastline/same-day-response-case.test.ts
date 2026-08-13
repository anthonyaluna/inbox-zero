import { describe, expect, it } from "vitest";
import {
  calculateSameDayResponseDeadline,
  createSameDayResponseCase,
  transitionSameDayResponseCase,
} from "@/utils/coastline/same-day-response-case";

describe("Same-Day Response case lifecycle", () => {
  it("sets a same-business-day deadline during Coastline business hours", () => {
    const deadline = calculateSameDayResponseDeadline(
      "2026-08-14T23:00:00.000Z",
      {
        timezone: "America/Los_Angeles",
        holidays: [],
      },
    );

    expect(deadline).toBe("2026-08-15T00:00:00.000Z");
  });

  it("moves after-cutoff and holiday messages to the next business day", () => {
    const deadline = calculateSameDayResponseDeadline(
      "2026-08-15T01:00:00.000Z",
      {
        timezone: "America/Los_Angeles",
        holidays: ["2026-08-17"],
      },
    );

    expect(deadline).toBe("2026-08-19T00:00:00.000Z");
  });

  it("creates a stable case and advances only through declared states", () => {
    const responseCase = createSameDayResponseCase({
      accountId: "account-1",
      sourceMessageId: "message-1",
      sourceThreadId: "thread-1",
      sender: "Bond Nichols <bond@example.com>",
      recipients: { to: ["anthony@example.com"], cc: [], bcc: [] },
      matterType: "property_operations",
      audience: "client",
      receivedAt: "2026-08-14T23:00:00.000Z",
      accountableOwner: "Coastline Equity",
      nextAction: "Draft a verified response",
      holidays: [],
    });

    expect(responseCase.schemaVersion).toBe("same_day_response_case.v1");
    expect(responseCase.matterId).toBe(
      "same-day-response/account-1/thread-1/message-1",
    );
    expect(responseCase.state).toBe("response_due");

    const drafted = transitionSameDayResponseCase(responseCase, "drafted", {
      draftId: "draft-1",
      nextAction: "Reconcile the draft readback",
    });

    expect(drafted.state).toBe("drafted");
    expect(drafted.draftId).toBe("draft-1");

    expect(() =>
      transitionSameDayResponseCase(drafted, "verified_closed"),
    ).toThrow("Invalid Same-Day Response transition");
  });

  it("keeps sensitive matters draftable and marks the Anthony hold", () => {
    const responseCase = createSameDayResponseCase({
      accountId: "account-1",
      sourceMessageId: "message-2",
      sourceThreadId: "thread-2",
      sender: "Client <client@example.com>",
      recipients: { to: ["anthony@example.com"], cc: [], bcc: [] },
      matterType: "legal",
      audience: "client",
      receivedAt: "2026-08-14T23:00:00.000Z",
      accountableOwner: "Coastline Equity",
      nextAction: "Draft verified status and hold for Anthony",
      holidays: [],
      escalation: "[Escalate: Hold for Anthony]",
    });

    expect(responseCase.state).toBe("response_due");
    expect(responseCase.escalation).toBe("[Escalate: Hold for Anthony]");
  });
});
