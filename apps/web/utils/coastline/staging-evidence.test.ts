import { describe, expect, it } from "vitest";
import {
  createCoastlineRemoteStagingEvidence,
  createCoastlineStagingRunNonce,
  readCoastlineStagingRuntimeBinding,
} from "@/utils/coastline/staging-evidence";

const NOW = new Date("2026-08-12T16:00:00.000Z");
const PROTECTED_SHA = "1".repeat(40);

describe("createCoastlineRemoteStagingEvidence", () => {
  it("returns the exact nonce-bound remote evidence property set", () => {
    const runNonce = createCoastlineStagingRunNonce(NOW, "a".repeat(20));

    const evidence = createCoastlineRemoteStagingEvidence({
      runNonce,
      cronEvidenceId: "b".repeat(64),
      protectedArtifactSha: PROTECTED_SHA,
      deployedArtifactSha: PROTECTED_SHA,
      workerRegistrations: [runningWorker()],
      queueIdentity: "bullmq:automation-jobs",
      queueReachable: true,
      observedAt: NOW,
    });

    expect(Object.keys(evidence).sort()).toEqual([
      "artifactSha",
      "cronEvidenceId",
      "observedAt",
      "queueIdentity",
      "queueStatus",
      "runNonce",
      "schemaVersion",
      "workerIdentity",
      "workerStatus",
    ]);
    expect(evidence).toEqual({
      artifactSha: PROTECTED_SHA,
      cronEvidenceId: "b".repeat(64),
      observedAt: "2026-08-12T16:00:00.000Z",
      queueIdentity: "bullmq:automation-jobs",
      queueStatus: "reachable",
      runNonce,
      schemaVersion: "coastline_inbox_zero_remote_staging_evidence.v1",
      workerIdentity: "bull:YXV0b21hdGlvbi1qb2Jz:w:worker-1",
      workerStatus: "running",
    });
  });

  it("rejects a stale nonce", () => {
    const staleNonce = createCoastlineStagingRunNonce(
      new Date("2026-08-12T15:50:00.000Z"),
      "a".repeat(20),
    );

    expect(() =>
      createValidEvidence({ runNonce: staleNonce, observedAt: NOW }),
    ).toThrowError(
      expect.objectContaining({ code: "COASTLINE_STAGING_NONCE_STALE" }),
    );
  });

  it("rejects a deployed artifact that does not match the protected SHA", () => {
    expect(() =>
      createValidEvidence({ deployedArtifactSha: "2".repeat(40) }),
    ).toThrowError(
      expect.objectContaining({ code: "COASTLINE_STAGING_ARTIFACT_MISMATCH" }),
    );
  });

  it("rejects a runtime without a registered running worker", () => {
    expect(() => createValidEvidence({ workerRegistrations: [] })).toThrowError(
      expect.objectContaining({ code: "COASTLINE_STAGING_WORKER_STOPPED" }),
    );
  });

  it("rejects a nonblank synthetic worker that is not bound to this queue", () => {
    expect(() =>
      createValidEvidence({
        workerRegistrations: [
          {
            identity: "GCP does not support client list",
            queueIdentity: "bullmq:automation-jobs",
            status: "running",
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "COASTLINE_STAGING_WORKER_STOPPED" }),
    );
  });

  it("rejects a stopped queue-specific worker", () => {
    expect(() =>
      createValidEvidence({
        workerRegistrations: [{ ...runningWorker(), status: "stopped" }],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "COASTLINE_STAGING_WORKER_STOPPED" }),
    );
  });

  it("accepts the unnamed identity emitted by the deployed BullMQ worker", () => {
    const unnamedWorker = {
      identity: "bull:YXV0b21hdGlvbi1qb2Jz",
      queueIdentity: "bullmq:automation-jobs",
      status: "running" as const,
    };

    expect(
      createValidEvidence({ workerRegistrations: [unnamedWorker] }),
    ).toMatchObject({
      workerIdentity: unnamedWorker.identity,
      workerStatus: "running",
    });
  });

  it("rejects an unreachable deployed queue", () => {
    expect(() => createValidEvidence({ queueReachable: false })).toThrowError(
      expect.objectContaining({ code: "COASTLINE_STAGING_QUEUE_UNREACHABLE" }),
    );
  });

  it("fails queue discovery with a deterministic error when readiness times out", async () => {
    const never = new Promise<void>(() => undefined);

    await expect(
      readCoastlineStagingRuntimeBinding({
        queueName: "automation-jobs",
        protectedArtifactSha: PROTECTED_SHA,
        deployedArtifactSha: PROTECTED_SHA,
        timeoutMs: 5,
        createQueueRuntime: () => ({
          queueName: "automation-jobs",
          waitUntilReady: () => never,
          getWorkers: async () => [],
          close: async () => undefined,
        }),
      }),
    ).rejects.toMatchObject({
      code: "COASTLINE_STAGING_QUEUE_UNREACHABLE",
      status: 503,
    });
  });

  it("derives a running identity only from a real queue-specific registration", async () => {
    const runtime = await readCoastlineStagingRuntimeBinding({
      queueName: "automation-jobs",
      protectedArtifactSha: PROTECTED_SHA,
      deployedArtifactSha: PROTECTED_SHA,
      createQueueRuntime: () => ({
        queueName: "automation-jobs",
        waitUntilReady: async () => undefined,
        getWorkers: async () => [
          { name: "GCP does not support client list" },
          { name: "bull:b3RoZXItcXVldWU=:w:worker-x" },
          { name: "bull:YXV0b21hdGlvbi1qb2Jz:w:worker-1" },
        ],
        close: async () => undefined,
      }),
    });

    expect(runtime.workerRegistrations).toEqual([runningWorker()]);
  });

  it("discovers the unnamed identity emitted by the deployed BullMQ worker", async () => {
    const runtime = await readCoastlineStagingRuntimeBinding({
      queueName: "automation-jobs",
      protectedArtifactSha: PROTECTED_SHA,
      deployedArtifactSha: PROTECTED_SHA,
      createQueueRuntime: () => ({
        queueName: "automation-jobs",
        waitUntilReady: async () => undefined,
        getWorkers: async () => [
          { name: "GCP does not support client list" },
          { name: "bull:b3RoZXItcXVldWU=" },
          { name: "bull:YXV0b21hdGlvbi1qb2Jz" },
        ],
        close: async () => undefined,
      }),
    });

    expect(runtime.workerRegistrations).toEqual([
      {
        identity: "bull:YXV0b21hdGlvbi1qb2Jz",
        queueIdentity: "bullmq:automation-jobs",
        status: "running",
      },
    ]);
  });
});

function createValidEvidence(
  overrides: Partial<
    Parameters<typeof createCoastlineRemoteStagingEvidence>[0]
  > = {},
) {
  return createCoastlineRemoteStagingEvidence({
    runNonce: createCoastlineStagingRunNonce(NOW, "a".repeat(20)),
    cronEvidenceId: "b".repeat(64),
    protectedArtifactSha: PROTECTED_SHA,
    deployedArtifactSha: PROTECTED_SHA,
    workerRegistrations: [runningWorker()],
    queueIdentity: "bullmq:automation-jobs",
    queueReachable: true,
    observedAt: NOW,
    ...overrides,
  });
}

function runningWorker() {
  return {
    identity: "bull:YXV0b21hdGlvbi1qb2Jz:w:worker-1",
    queueIdentity: "bullmq:automation-jobs",
    status: "running" as const,
  };
}
