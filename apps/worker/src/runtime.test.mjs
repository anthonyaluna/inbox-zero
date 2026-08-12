import assert from "node:assert/strict";
import test from "node:test";
import {
  getWorkerConfig,
  publishWorkerRuntimeBinding,
  startWorkerRuntime,
  workerRuntimeBindingKey,
  workerRuntimeIdentity,
} from "./runtime.mjs";

test("worker publishes a worker-owned, opaque staging runtime binding", async () => {
  const writes = [];
  const connection = {
    async set(...args) {
      writes.push(args);
    },
  };
  const binding = await publishWorkerRuntimeBinding({
    connection,
    worker: {
      id: "random-worker-id",
      name: "automation-jobs",
      opts: { name: "coastline-staging-a" },
    },
    artifactSha: "a".repeat(40),
    now: new Date("2026-08-12T16:00:00.000Z"),
    attestationId: "b".repeat(64),
  });

  assert.deepEqual(binding, {
    schemaVersion: "coastline_inbox_zero_worker_runtime_binding.v1",
    attestationSource: "coastline_worker_runtime",
    attestationId: "b".repeat(64),
    identity: "bull:YXV0b21hdGlvbi1qb2Jz:w:coastline-staging-a",
    queueIdentity: "bullmq:automation-jobs",
    status: "running",
    artifactSha: "a".repeat(40),
    heartbeatAt: "2026-08-12T16:00:00.000Z",
  });
  assert.deepEqual(writes, [
    [
      workerRuntimeBindingKey("bull:YXV0b21hdGlvbi1qb2Jz:w:coastline-staging-a"),
      JSON.stringify(binding),
      "EX",
      120,
    ],
  ]);
});

test("worker refuses to publish an invalid artifact or non-BullMQ identity", async () => {
  await assert.rejects(
    publishWorkerRuntimeBinding({
      connection: { set: async () => undefined },
      worker: { id: "web-static", name: "automation-jobs", opts: { name: "invalid name" } },
      artifactSha: "not-a-sha",
    }),
    /worker runtime binding/i,
  );
});

test("worker runtime binding uses the deterministic BullMQ client name, not Worker.id", () => {
  assert.equal(
    workerRuntimeIdentity({
      id: "f6c1f12d-b698-4d4e-b59a-bcf26c6bb4f1",
      name: "automation-jobs",
      opts: { name: "coastline-staging-a" },
    }),
    "bull:YXV0b21hdGlvbi1qb2Jz:w:coastline-staging-a",
  );
});

test("worker runtime binding falls back to the protected staging artifact binding", () => {
  assert.equal(
    getWorkerConfig({
      REDIS_URL: "redis://example.test",
      INTERNAL_API_KEY: "test-key",
      INTERNAL_API_URL: "https://web.example.test",
      COASTLINE_STAGING_ARTIFACT_SHA: "a".repeat(40),
      COASTLINE_WORKER_RUNTIME_INSTANCE_ID: "coastline-staging-a",
    }).workerArtifactSha,
    "a".repeat(40),
  );
});

test("worker runtime binding publishes with the exact configured client identity", async () => {
  const writes = [];
  const runtime = await startWorkerRuntime({
    env: {
      REDIS_URL: "redis://example.test",
      INTERNAL_API_KEY: "test-key",
      INTERNAL_API_URL: "https://web.example.test",
      COASTLINE_STAGING_ARTIFACT_SHA: "a".repeat(40),
      COASTLINE_WORKER_RUNTIME_INSTANCE_ID: "coastline-staging-a",
      WORKER_QUEUES: "automation-jobs:1",
    },
    createConnection: () => ({
      set: async (...args) => writes.push(args),
      quit: async () => undefined,
    }),
    createWorker: (name, _processor, options) => ({
      id: "random-worker-id",
      name,
      opts: options,
      on: () => undefined,
      close: async () => undefined,
    }),
  });

  await runtime.publishRuntimeBindings();
  assert.equal(
    writes[0][0],
    workerRuntimeBindingKey("bull:YXV0b21hdGlvbi1qb2Jz:w:coastline-staging-a"),
  );
  await runtime.close();
});
