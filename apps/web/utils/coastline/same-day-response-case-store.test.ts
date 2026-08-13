import { describe, expect, it } from "vitest";
import {
  createSameDayResponseCase,
  transitionSameDayResponseCase,
} from "@/utils/coastline/same-day-response-case";
import {
  ensureSameDayResponseCaseForMessage,
  markSameDayResponseCaseAwaitingAction,
  markSameDayResponseCaseCompleted,
  markSameDayResponseCaseDrafted,
  markSameDayResponseCaseResponded,
  markSameDayResponseCaseUpdateDue,
  markSameDayResponseCaseVerifiedClosed,
  persistSameDayResponseCase,
  readSameDayResponseCase,
  type SameDayResponseCaseStore,
} from "@/utils/coastline/same-day-response-case-store";

function makeCase() {
  return createSameDayResponseCase({
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
  });
}

describe("Same-Day Response case persistence contract", () => {
  it("upserts a case and reads back the latest lifecycle state", async () => {
    const rows = new Map<string, ReturnType<typeof makeCase>>();
    const store: SameDayResponseCaseStore = {
      async upsert(responseCase) {
        rows.set(responseCase.matterId, responseCase);
        return responseCase;
      },
      async findUnique({ matterId }) {
        return rows.get(matterId) ?? null;
      },
    };

    const created = await persistSameDayResponseCase(store, makeCase());
    const drafted = transitionSameDayResponseCase(created, "drafted", {
      draftId: "draft-1",
    });
    await persistSameDayResponseCase(store, drafted);

    await expect(
      readSameDayResponseCase(store, {
        accountId: "account-1",
        matterId: drafted.matterId,
      }),
    ).resolves.toMatchObject({
      state: "drafted",
      draftId: "draft-1",
    });
  });

  it("creates one inbound case, skips automated mail, and marks the draft state", async () => {
    const rows = new Map<string, ReturnType<typeof makeCase>>();
    const store: SameDayResponseCaseStore = {
      async upsert(responseCase) {
        rows.set(responseCase.matterId, responseCase);
        return responseCase;
      },
      async findUnique({ matterId }) {
        return rows.get(matterId) ?? null;
      },
    };
    const message = {
      id: "message-2",
      threadId: "thread-2",
      date: "2026-08-14T23:00:00.000Z",
      internalDate: "2026-08-14T23:00:00.000Z",
      historyId: "history-2",
      snippet: "Can we review this?",
      subject: "Review",
      inline: [],
      headers: {
        from: "Bond Nichols <bond@example.com>",
        to: "anthony@example.com",
        cc: "",
        bcc: "",
        date: "2026-08-14T23:00:00.000Z",
        subject: "Review",
      },
    };

    const created = await ensureSameDayResponseCaseForMessage({
      store,
      accountId: "account-1",
      accountEmail: "anthony@example.com",
      message,
    });
    expect(created?.state).toBe("response_due");

    const drafted = await markSameDayResponseCaseDrafted({
      store,
      accountId: "account-1",
      sourceThreadId: "thread-2",
      sourceMessageId: "message-2",
      draftId: "draft-2",
    });
    expect(drafted).toMatchObject({ state: "drafted", draftId: "draft-2" });

    const automated = await ensureSameDayResponseCaseForMessage({
      store,
      accountId: "account-1",
      accountEmail: "anthony@example.com",
      message: {
        ...message,
        id: "message-3",
        headers: {
          ...message.headers,
          "list-unsubscribe": "https://example.com/unsubscribe",
        },
      },
    });
    expect(automated).toBeNull();
  });

  it("runs the response matter through response, update, completion, and verified closure", async () => {
    const rows = new Map<string, ReturnType<typeof makeCase>>();
    const store: SameDayResponseCaseStore = {
      async upsert(responseCase) {
        rows.set(responseCase.matterId, responseCase);
        return responseCase;
      },
      async findUnique({ matterId }) {
        return rows.get(matterId) ?? null;
      },
    };

    await persistSameDayResponseCase(store, makeCase());
    await markSameDayResponseCaseDrafted({
      store,
      accountId: "account-1",
      sourceThreadId: "thread-1",
      sourceMessageId: "message-1",
      draftId: "draft-1",
    });
    const responded = await markSameDayResponseCaseResponded({
      store,
      accountId: "account-1",
      sourceThreadId: "thread-1",
      sourceMessageId: "message-1",
      responseMessageId: "response-1",
      respondedAt: "2026-08-14T23:30:00.000Z",
      nextAction: "Wait for Bond to confirm the access window",
    });
    expect(responded).toMatchObject({
      state: "responded",
      responseMessageId: "response-1",
      respondedAt: "2026-08-14T23:30:00.000Z",
    });

    const awaiting = await markSameDayResponseCaseAwaitingAction({
      store,
      accountId: "account-1",
      sourceThreadId: "thread-1",
      sourceMessageId: "message-1",
      nextAction: "Wait for Bond to confirm the access window",
      nextUpdateAt: "2026-08-15T00:00:00.000Z",
    });
    expect(awaiting.state).toBe("awaiting_action");

    const updateDue = await markSameDayResponseCaseUpdateDue({
      store,
      accountId: "account-1",
      sourceThreadId: "thread-1",
      sourceMessageId: "message-1",
      nextAction: "Send the promised status update",
      at: "2026-08-16T00:00:00.000Z",
    });
    expect(updateDue.state).toBe("update_due");

    const completed = await markSameDayResponseCaseCompleted({
      store,
      accountId: "account-1",
      sourceThreadId: "thread-1",
      sourceMessageId: "message-1",
      terminalEvidence: {
        sourceSystem: "outlook",
        sourceId: "response-1",
      },
    });
    expect(completed.state).toBe("completed");

    const closed = await markSameDayResponseCaseVerifiedClosed({
      store,
      accountId: "account-1",
      sourceThreadId: "thread-1",
      sourceMessageId: "message-1",
    });
    expect(closed).toMatchObject({
      state: "verified_closed",
      terminalEvidence: {
        sourceSystem: "outlook",
        sourceId: "response-1",
      },
    });
  });

  it("does not close a matter without independent terminal evidence", async () => {
    const rows = new Map<string, ReturnType<typeof makeCase>>();
    const store: SameDayResponseCaseStore = {
      async upsert(responseCase) {
        rows.set(responseCase.matterId, responseCase);
        return responseCase;
      },
      async findUnique({ matterId }) {
        return rows.get(matterId) ?? null;
      },
    };

    const responseCase = await persistSameDayResponseCase(store, makeCase());
    const drafted = await persistSameDayResponseCase(
      store,
      transitionSameDayResponseCase(responseCase, "drafted", {
        draftId: "draft-1",
      }),
    );
    const responded = await persistSameDayResponseCase(
      store,
      transitionSameDayResponseCase(drafted, "responded", {
        responseMessageId: "response-1",
      }),
    );

    await expect(
      markSameDayResponseCaseVerifiedClosed({
        store,
        accountId: "account-1",
        sourceThreadId: "thread-1",
        sourceMessageId: "message-1",
      }),
    ).rejects.toThrow(/completed|terminal evidence/);
    expect(responded.state).toBe("responded");
  });
});
