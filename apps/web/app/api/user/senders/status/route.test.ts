import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  coastlineMode: true,
  middlewareCalls: 0,
  setSenderStatusWithAutoArchive: vi.fn(),
}));

vi.mock("@/env", () => ({
  env: {
    get COASTLINE_DRAFT_PROPOSALS_ENABLED() {
      return mocks.coastlineMode;
    },
  },
}));

vi.mock("@/utils/middleware", () => ({
  withEmailProvider:
    (_scope: string, handler: (request: NextRequest) => Promise<Response>) =>
    (request: NextRequest) => {
      mocks.middlewareCalls++;
      Object.assign(request, {
        auth: { emailAccountId: "account-1" },
        emailProvider: { name: "microsoft" },
      });
      return handler(request);
    },
}));

vi.mock("@/utils/senders/unsubscribe", () => ({
  setSenderStatusWithAutoArchive: mocks.setSenderStatusWithAutoArchive,
}));

import { POST } from "./route";

function post(body: string) {
  return POST(
    new NextRequest("http://localhost/api/user/senders/status", {
      method: "POST",
      body,
    }),
    {} as never,
  );
}

describe("POST /api/user/senders/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.coastlineMode = true;
    mocks.middlewareCalls = 0;
  });

  it("rejects before provider middleware, body parsing, or sender mutation in Coastline mode", async () => {
    const response = await post("not-json");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: "COASTLINE_DRAFT_ONLY_ACTION_BLOCKED",
    });
    expect(mocks.middlewareCalls).toBe(0);
    expect(mocks.setSenderStatusWithAutoArchive).not.toHaveBeenCalled();
  });

  it("preserves sender-status behavior outside Coastline mode", async () => {
    mocks.coastlineMode = false;
    mocks.setSenderStatusWithAutoArchive.mockResolvedValue({
      sender: { email: "newsletter@example.com", status: null },
    });

    const response = await post(
      JSON.stringify({
        senderEmail: "newsletter@example.com",
        status: null,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.middlewareCalls).toBe(1);
    expect(mocks.setSenderStatusWithAutoArchive).toHaveBeenCalledOnce();
  });
});
