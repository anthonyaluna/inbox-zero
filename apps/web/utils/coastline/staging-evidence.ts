import "server-only";

import { randomBytes } from "node:crypto";
import { Queue } from "bullmq";
import IORedis from "ioredis";

const SCHEMA_VERSION =
  "coastline_inbox_zero_remote_staging_evidence.v1" as const;
const NONCE_MAX_AGE_MS = 5 * 60_000;
const NONCE_FUTURE_TOLERANCE_MS = 30_000;

export type CoastlineStagingRuntimeBinding = {
  deployedArtifactSha: string | undefined;
  protectedArtifactSha: string | undefined;
  queueIdentity: string;
  queueReachable: boolean;
  workerRegistrations: Array<{ name?: string }>;
};

export class CoastlineStagingEvidenceError extends Error {
  readonly code: string;
  readonly status: 400 | 503;

  constructor(code: string, status: 400 | 503) {
    super(code);
    this.name = "CoastlineStagingEvidenceError";
    this.code = code;
    this.status = status;
  }
}

export function createCoastlineStagingRunNonce(
  now = new Date(),
  entropy = randomBytes(10).toString("hex"),
) {
  if (!/^[a-f0-9]{20}$/.test(entropy)) {
    throw new Error(
      "Coastline staging nonce entropy must be 20 hex characters",
    );
  }

  return `${now.getTime().toString(16).padStart(12, "0")}${entropy}`;
}

export function assertFreshCoastlineStagingRunNonce(
  runNonce: string | null | undefined,
  now = new Date(),
): asserts runNonce is string {
  if (!runNonce || !/^[a-f0-9]{32}$/.test(runNonce)) {
    throw new CoastlineStagingEvidenceError(
      "COASTLINE_STAGING_NONCE_INVALID",
      400,
    );
  }

  const issuedAt = Number.parseInt(runNonce.slice(0, 12), 16);
  const ageMs = now.getTime() - issuedAt;
  if (
    !Number.isSafeInteger(issuedAt) ||
    ageMs > NONCE_MAX_AGE_MS ||
    ageMs < -NONCE_FUTURE_TOLERANCE_MS
  ) {
    throw new CoastlineStagingEvidenceError(
      "COASTLINE_STAGING_NONCE_STALE",
      400,
    );
  }
}

export function createCoastlineRemoteStagingEvidence({
  runNonce,
  cronEvidenceId,
  protectedArtifactSha,
  deployedArtifactSha,
  workerRegistrations,
  queueIdentity,
  queueReachable,
  observedAt = new Date(),
}: CoastlineStagingRuntimeBinding & {
  runNonce: string;
  cronEvidenceId: string;
  observedAt?: Date;
}) {
  assertFreshCoastlineStagingRunNonce(runNonce, observedAt);

  if (
    !protectedArtifactSha ||
    !deployedArtifactSha ||
    !/^[a-f0-9]{40}$/.test(protectedArtifactSha) ||
    deployedArtifactSha !== protectedArtifactSha
  ) {
    throw new CoastlineStagingEvidenceError(
      "COASTLINE_STAGING_ARTIFACT_MISMATCH",
      503,
    );
  }
  if (!/^[a-f0-9]{64}$/.test(cronEvidenceId)) {
    throw new CoastlineStagingEvidenceError(
      "COASTLINE_STAGING_CRON_EVIDENCE_INVALID",
      503,
    );
  }
  if (!queueReachable || !queueIdentity.trim()) {
    throw new CoastlineStagingEvidenceError(
      "COASTLINE_STAGING_QUEUE_UNREACHABLE",
      503,
    );
  }

  const workerIdentity = workerRegistrations
    .map((registration) => registration.name?.trim())
    .filter((name): name is string => Boolean(name))
    .sort()[0];
  if (!workerIdentity) {
    throw new CoastlineStagingEvidenceError(
      "COASTLINE_STAGING_WORKER_STOPPED",
      503,
    );
  }

  return {
    artifactSha: protectedArtifactSha,
    cronEvidenceId,
    observedAt: observedAt.toISOString(),
    queueIdentity,
    queueStatus: "reachable" as const,
    runNonce,
    schemaVersion: SCHEMA_VERSION,
    workerIdentity,
    workerStatus: "running" as const,
  };
}

export async function readCoastlineStagingRuntimeBinding(): Promise<CoastlineStagingRuntimeBinding> {
  const queueName = process.env.COASTLINE_STAGING_QUEUE_NAME;
  const redisUrl = process.env.REDIS_URL;
  if (!queueName || !redisUrl) {
    throw new CoastlineStagingEvidenceError(
      "COASTLINE_STAGING_QUEUE_UNREACHABLE",
      503,
    );
  }

  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(queueName, { connection });
  try {
    await queue.waitUntilReady();
    const queueReachable = true;
    const workerRegistrations = await queue.getWorkers();

    return {
      protectedArtifactSha: process.env.COASTLINE_STAGING_ARTIFACT_SHA,
      deployedArtifactSha: process.env.COASTLINE_DEPLOYED_ARTIFACT_SHA,
      queueIdentity: `bullmq:${queue.name}`,
      queueReachable,
      workerRegistrations,
    };
  } finally {
    await queue.close();
    if (connection.status !== "end") await connection.quit();
  }
}
