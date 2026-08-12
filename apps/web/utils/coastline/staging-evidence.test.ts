import { describe, expect, it } from "vitest";
import {
  createCoastlineRemoteStagingEvidence,
  createCoastlineStagingRunNonce,
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
      workerRegistrations: [{ name: "bull:automation-jobs:w:worker-1" }],
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
      workerIdentity: "bull:automation-jobs:w:worker-1",
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

  it("rejects an unreachable deployed queue", () => {
    expect(() => createValidEvidence({ queueReachable: false })).toThrowError(
      expect.objectContaining({ code: "COASTLINE_STAGING_QUEUE_UNREACHABLE" }),
    );
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
    workerRegistrations: [{ name: "bull:automation-jobs:w:worker-1" }],
    queueIdentity: "bullmq:automation-jobs",
    queueReachable: true,
    observedAt: NOW,
    ...overrides,
  });
}
