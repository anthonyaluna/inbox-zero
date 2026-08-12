import { createHmac } from "node:crypto";

export function createCoastlineCronAuthProbe({
  runNonce,
  cronSecret,
  observedAt = new Date(),
}: {
  runNonce: string;
  cronSecret: string;
  observedAt?: Date;
}) {
  if (!/^[a-f0-9]{32}$/.test(runNonce)) {
    throw new Error("Invalid Coastline cron probe nonce");
  }
  if (!cronSecret) throw new Error("Cron secret is unavailable");

  return {
    authenticated: true as const,
    runNonce,
    evidenceId: createHmac("sha256", cronSecret)
      .update(`coastline-cron-probe:${runNonce}`)
      .digest("hex"),
    observedAt: observedAt.toISOString(),
  };
}
