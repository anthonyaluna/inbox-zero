import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CoastlineStagingEvidenceError,
  createCoastlineStagingRunNonce,
} from "@/utils/coastline/staging-evidence";

const envMock = vi.hoisted(() => ({ CRON_SECRET: "cron-secret" }));

vi.mock("@/env", () => ({ env: envMock }));
vi.mock("@/utils/middleware", async () => {
  const { createWithErrorTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithErrorTestMiddleware();
});

import { createStagingEvidenceHandler } from "./route";

const NOW = new Date("2026-08-12T16:00:00.000Z");
const RUN_NONCE = createCoastlineStagingRunNonce(NOW, "a".repeat(20));

describe("GET /api/coastline/staging-evidence", () => {
  beforeEach(() => {
    envMock.CRON_SECRET = "cron-secret";
  });

  it("rejects an unauthenticated request before reading runtime bindings", async () => {
    const readRuntimeEvidence = vi.fn();
    const response = await createStagingEvidenceHandler(readRuntimeEvidence)(
      request(RUN_NONCE),
    );

    expect(response.status).toBe(401);
    expect(readRuntimeEvidence).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "not-a-nonce",
  ])("rejects a missing or malformed nonce with 400", async (nonce) => {
    const readRuntimeEvidence = vi.fn();
    const response = await createStagingEvidenceHandler(readRuntimeEvidence)(
      request(nonce, true),
    );

    expect(response.status).toBe(400);
    expect(readRuntimeEvidence).not.toHaveBeenCalled();
  });

  it("rejects a stale nonce with 400", async () => {
    const readRuntimeEvidence = vi.fn();
    const staleNonce = createCoastlineStagingRunNonce(
      new Date(Date.now() - 10 * 60_000),
      "c".repeat(20),
    );
    const response = await createStagingEvidenceHandler(readRuntimeEvidence)(
      request(staleNonce, true),
    );

    expect(response.status).toBe(400);
    expect(readRuntimeEvidence).not.toHaveBeenCalled();
  });

  it("serves the exact mocked remote runtime binding without secrets", async () => {
    const readRuntimeEvidence = vi.fn().mockResolvedValue({
      protectedArtifactSha: "1".repeat(40),
      deployedArtifactSha: "1".repeat(40),
      workerRegistrations: [runningWorker()],
      queueIdentity: "bullmq:automation-jobs",
      queueReachable: true,
    });
    const response = await createStagingEvidenceHandler(
      readRuntimeEvidence,
      () => NOW,
    )(request(RUN_NONCE, true));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([
      "artifactSha",
      "cronEvidenceId",
      "observedAt",
      "queueIdentity",
      "queueStatus",
      "runNonce",
      "schemaVersion",
      "workerArtifactSha",
      "workerHeartbeatAt",
      "workerIdentity",
      "workerStatus",
    ]);
    expect(body).toMatchObject({
      artifactSha: "1".repeat(40),
      queueIdentity: "bullmq:automation-jobs",
      queueStatus: "reachable",
      runNonce: RUN_NONCE,
      workerIdentity: "bull:YXV0b21hdGlvbi1qb2Jz:w:worker-1",
      workerArtifactSha: "1".repeat(40),
      workerHeartbeatAt: NOW.toISOString(),
      workerStatus: "running",
    });
    expect(JSON.stringify(body)).not.toContain("cron-secret");
    expect(JSON.stringify(body)).not.toContain("redis://");
  });

  it.each([
    ["artifact mismatch", { deployedArtifactSha: "2".repeat(40) }],
    ["worker stopped", { workerRegistrations: [] }],
    ["queue unreachable", { queueReachable: false }],
  ])("rejects %s runtime evidence", async (_name, overrides) => {
    const readRuntimeEvidence = vi.fn().mockResolvedValue({
      protectedArtifactSha: "1".repeat(40),
      deployedArtifactSha: "1".repeat(40),
      workerRegistrations: [runningWorker()],
      queueIdentity: "bullmq:automation-jobs",
      queueReachable: true,
      ...overrides,
    });
    const response = await createStagingEvidenceHandler(
      readRuntimeEvidence,
      () => NOW,
    )(request(RUN_NONCE, true));

    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("redis://");
  });

  it("returns deterministic queue-unreachable evidence when runtime discovery times out", async () => {
    const readRuntimeEvidence = vi
      .fn()
      .mockRejectedValue(
        new CoastlineStagingEvidenceError(
          "COASTLINE_STAGING_QUEUE_UNREACHABLE",
          503,
        ),
      );
    const response = await createStagingEvidenceHandler(
      readRuntimeEvidence,
      () => NOW,
    )(request(RUN_NONCE, true));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Remote staging evidence unavailable",
      errorCode: "COASTLINE_STAGING_QUEUE_UNREACHABLE",
    });
  });
});

function request(runNonce?: string, authenticated = false) {
  const url = new URL("http://localhost/api/coastline/staging-evidence");
  if (runNonce) url.searchParams.set("run_nonce", runNonce);
  return new Request(url, {
    headers: authenticated
      ? { authorization: "Bearer cron-secret" }
      : undefined,
  });
}

function runningWorker() {
  return {
    identity: "bull:YXV0b21hdGlvbi1qb2Jz:w:worker-1",
    queueIdentity: "bullmq:automation-jobs",
    status: "running" as const,
    artifactSha: "1".repeat(40),
    heartbeatAt: NOW.toISOString(),
  };
}
