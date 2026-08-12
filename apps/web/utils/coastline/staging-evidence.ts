import "server-only";

import { randomBytes } from "node:crypto";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "@/env";

const SCHEMA_VERSION =
  "coastline_inbox_zero_remote_staging_evidence.v1" as const;
const NONCE_MAX_AGE_MS = 5 * 60_000;
const NONCE_FUTURE_TOLERANCE_MS = 30_000;
const DEFAULT_RUNTIME_TIMEOUT_MS = 5000;

type CoastlineWorkerRegistration = {
  identity: string;
  queueIdentity: string;
  status: "running" | "stopped";
};

type CoastlineQueueRuntime = {
  queueName: string;
  waitUntilReady: () => Promise<unknown>;
  getWorkers: () => Promise<Array<{ name?: string }>>;
  close: () => Promise<void>;
};

export type CoastlineStagingRuntimeBinding = {
  deployedArtifactSha: string | undefined;
  protectedArtifactSha: string | undefined;
  queueIdentity: string;
  queueReachable: boolean;
  workerRegistrations: CoastlineWorkerRegistration[];
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
    .filter(
      (registration) =>
        registration.queueIdentity === queueIdentity &&
        registration.status === "running" &&
        isQueueWorkerIdentity(registration.identity, queueIdentity),
    )
    .map((registration) => registration.identity)
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

function isQueueWorkerIdentity(identity: string, queueIdentity: string) {
  const queueName = queueIdentity.startsWith("bullmq:")
    ? queueIdentity.slice("bullmq:".length)
    : "";
  const prefix = `bull:${Buffer.from(queueName).toString("base64")}:w:`;
  return (
    Boolean(queueName) &&
    identity.startsWith(prefix) &&
    identity.length > prefix.length
  );
}

export async function readCoastlineStagingRuntimeBinding({
  queueName = env.COASTLINE_STAGING_QUEUE_NAME,
  protectedArtifactSha = env.COASTLINE_STAGING_ARTIFACT_SHA,
  deployedArtifactSha = env.COASTLINE_DEPLOYED_ARTIFACT_SHA,
  timeoutMs = DEFAULT_RUNTIME_TIMEOUT_MS,
  createQueueRuntime = createBullMqRuntime,
}: {
  queueName?: string;
  protectedArtifactSha?: string;
  deployedArtifactSha?: string;
  timeoutMs?: number;
  createQueueRuntime?: (queueName: string) => CoastlineQueueRuntime;
} = {}): Promise<CoastlineStagingRuntimeBinding> {
  if (!queueName) {
    throw new CoastlineStagingEvidenceError(
      "COASTLINE_STAGING_QUEUE_UNREACHABLE",
      503,
    );
  }

  const queue = createQueueRuntime(queueName);
  try {
    const workerClients = await withRuntimeTimeout(async () => {
      await queue.waitUntilReady();
      return queue.getWorkers();
    }, timeoutMs);
    const queueIdentity = `bullmq:${queue.queueName}`;
    const expectedClientPrefix = `bull:${Buffer.from(queue.queueName).toString("base64")}:w:`;
    const workerRegistrations = workerClients
      .map((registration) => registration.name?.trim())
      .filter(
        (identity): identity is string =>
          typeof identity === "string" &&
          identity.startsWith(expectedClientPrefix) &&
          identity.length > expectedClientPrefix.length,
      )
      .map((identity) => ({
        identity,
        queueIdentity,
        status: "running" as const,
      }));

    return {
      protectedArtifactSha,
      deployedArtifactSha,
      queueIdentity,
      queueReachable: true,
      workerRegistrations,
    };
  } catch {
    throw new CoastlineStagingEvidenceError(
      "COASTLINE_STAGING_QUEUE_UNREACHABLE",
      503,
    );
  } finally {
    await queue.close();
  }
}

function createBullMqRuntime(queueName: string): CoastlineQueueRuntime {
  if (!env.REDIS_URL) {
    throw new CoastlineStagingEvidenceError(
      "COASTLINE_STAGING_QUEUE_UNREACHABLE",
      503,
    );
  }

  const connection = new IORedis(env.REDIS_URL, {
    connectTimeout: DEFAULT_RUNTIME_TIMEOUT_MS,
    commandTimeout: DEFAULT_RUNTIME_TIMEOUT_MS,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  const queue = new Queue(queueName, { connection });

  return {
    queueName: queue.name,
    waitUntilReady: () => queue.waitUntilReady(),
    getWorkers: () => queue.getWorkers(),
    close: async () => {
      await queue.close();
      if (connection.status !== "end") connection.disconnect();
    },
  };
}

async function withRuntimeTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Coastline staging runtime timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
