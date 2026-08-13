import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  coastlineMode: true,
  middlewareCalls: 0,
  unsubscribeSenderAndMark: vi.fn(),
  coastlineEnv: { COASTLINE_DRAFT_PROPOSALS_ENABLED: true },
}));

vi.mock("@/env", () => ({
  env: mocks.coastlineEnv,
}));

vi.mock("@/utils/middleware", () => ({
  withEmailAccount:
    (_scope: string, handler: (request: NextRequest) => Promise<Response>) =>
    (request: NextRequest) => {
      mocks.middlewareCalls++;
      Object.assign(request, {
        auth: { emailAccountId: "account-1" },
        logger: {},
      });
      return handler(request);
    },
}));

vi.mock("@/utils/senders/unsubscribe", () => ({
  unsubscribeSenderAndMark: mocks.unsubscribeSenderAndMark,
}));

import { POST } from "./route";

function post(body: string) {
  return POST(
    new NextRequest("http://localhost/api/user/senders/unsubscribe", {
      method: "POST",
      body,
    }),
    {} as never,
  );
}

describe("POST /api/user/senders/unsubscribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.coastlineMode = true;
    mocks.coastlineEnv.COASTLINE_DRAFT_PROPOSALS_ENABLED = true;
    mocks.middlewareCalls = 0;
  });

  it("allows verified unsubscribe execution in Coastline mode", async () => {
    mocks.unsubscribeSenderAndMark.mockResolvedValue({
      sender: { email: "newsletter@example.com" },
      unsubscribe: { attempted: true, success: true },
    });
    const response = await post(
      JSON.stringify({
        senderEmail: "newsletter@example.com",
        unsubscribeLink: "https://example.com/unsubscribe",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.middlewareCalls).toBe(1);
    expect(mocks.unsubscribeSenderAndMark).toHaveBeenCalledOnce();
  });

  it("preserves unsubscribe behavior outside Coastline mode", async () => {
    mocks.coastlineMode = false;
    mocks.coastlineEnv.COASTLINE_DRAFT_PROPOSALS_ENABLED = false;
    mocks.unsubscribeSenderAndMark.mockResolvedValue({
      sender: { email: "newsletter@example.com" },
      unsubscribe: { attempted: true, success: true },
    });

    const response = await post(
      JSON.stringify({
        senderEmail: "newsletter@example.com",
        unsubscribeLink: "https://example.com/unsubscribe",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.middlewareCalls).toBe(1);
    expect(mocks.unsubscribeSenderAndMark).toHaveBeenCalledOnce();
  });
});
