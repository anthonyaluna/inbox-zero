import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createCoastlineStagingRunNonce } from "@/utils/coastline/staging-evidence";

const { envMock, captureExceptionMock } = vi.hoisted(() => ({
  envMock: {
    COASTLINE_DRAFT_PROPOSALS_ENABLED: true as boolean | undefined,
    CRON_SECRET: "cron-secret",
    QSTASH_TOKEN: undefined as string | undefined,
  },
  captureExceptionMock: vi.fn(),
}));

vi.mock("@/env", () => ({ env: envMock }));
vi.mock("@/utils/error", () => ({ captureException: captureExceptionMock }));
vi.mock("@/utils/prisma");
vi.mock("@/utils/middleware", async () => {
  const { createWithErrorTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithErrorTestMiddleware();
});

import { GET } from "./route";

describe("scheduled actions Coastline cron probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.CRON_SECRET = "cron-secret";
    envMock.COASTLINE_DRAFT_PROPOSALS_ENABLED = true;
  });

  it("rejects an unauthenticated probe without executing scheduled actions", async () => {
    const response = await GET(request(false));

    expect(response.status).toBe(401);
    expect(captureExceptionMock).toHaveBeenCalledOnce();
  });

  it("returns authenticated evidence bound to the caller nonce", async () => {
    const runNonce = createCoastlineStagingRunNonce();
    const response = await GET(request(true, runNonce));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      authenticated: true,
      runNonce,
      evidenceId: expect.stringMatching(/^[a-f0-9]{64}$/),
      observedAt: expect.any(String),
    });
  });

  it.each([
    false,
    undefined,
  ])("fails closed without processing when the Coastline flag is %s", async (coastlineEnabled) => {
    envMock.COASTLINE_DRAFT_PROPOSALS_ENABLED = coastlineEnabled;

    const response = await GET(request(true));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Coastline cron probe unavailable",
    });
    expect(prisma.scheduledAction.findMany).not.toHaveBeenCalled();
  });
});

function request(authenticated: boolean, runNonce = "a".repeat(32)) {
  return new NextRequest(
    `http://localhost/api/cron/scheduled-actions?coastline_probe=${runNonce}`,
    {
      headers: authenticated
        ? { authorization: "Bearer cron-secret" }
        : undefined,
    },
  );
}
