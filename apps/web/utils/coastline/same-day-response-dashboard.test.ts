import { describe, expect, it } from "vitest";
import { createSameDayResponseCase } from "@/utils/coastline/same-day-response-case";
import { getSameDayResponseMetrics } from "@/utils/coastline/same-day-response-dashboard";
import type { SameDayResponseCaseV1 } from "@/utils/coastline/same-day-response-case";
import type { SameDayResponseCaseStore } from "@/utils/coastline/same-day-response-case-store";

function makeStore(
  responseCases: SameDayResponseCaseV1[],
): SameDayResponseCaseStore {
  return {
    async upsert(responseCase) {
      responseCases.push(responseCase);
      return responseCase;
    },
    async findUnique({ matterId }) {
      return (
        responseCases.find(
          (responseCase) => responseCase.matterId === matterId,
        ) ?? null
      );
    },
    async findMany() {
      return responseCases;
    },
  };
}

describe("Same-Day Response dashboard metrics", () => {
  it("returns a versioned account-scoped metrics response", async () => {
    const responseCase = createSameDayResponseCase({
      accountId: "account-1",
      sourceMessageId: "message-1",
      sourceThreadId: "thread-1",
      sender: "client@example.com",
      recipients: { to: ["anthony@example.com"], cc: [], bcc: [] },
      matterType: "inbound_message",
      audience: "client",
      receivedAt: "2026-08-13T15:00:00.000Z",
      accountableOwner: "Coastline Equity",
      nextAction: "Draft a response",
      timezone: "America/Los_Angeles",
    });

    const result = await getSameDayResponseMetrics({
      store: makeStore([responseCase]),
      accountId: "account-1",
      now: "2026-08-13T16:00:00.000Z",
    });

    expect(result.schemaVersion).toBe("same_day_response_metrics.v1");
    expect(result.generatedAt).toBe("2026-08-13T16:00:00.000Z");
    expect(result.metrics.total).toBe(1);
    expect(result.metrics.responseDue).toBe(1);
  });

  it("returns an empty dashboard when the store cannot list cases", async () => {
    const result = await getSameDayResponseMetrics({
      store: {
        async upsert(responseCase) {
          return responseCase;
        },
        async findUnique() {
          return null;
        },
      },
      accountId: "account-1",
      now: "2026-08-13T16:00:00.000Z",
    });

    expect(result.metrics.total).toBe(0);
    expect(result.metrics.sameDayComplianceRate).toBe(0);
  });
});
