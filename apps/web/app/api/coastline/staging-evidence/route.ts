import { NextResponse } from "next/server";
import { env } from "@/env";
import { hasCronSecret } from "@/utils/cron";
import { createCoastlineCronAuthProbe } from "@/utils/coastline/cron-auth-probe";
import {
  assertFreshCoastlineStagingRunNonce,
  CoastlineStagingEvidenceError,
  createCoastlineRemoteStagingEvidence,
  readCoastlineStagingRuntimeBinding,
  type CoastlineStagingRuntimeBinding,
} from "@/utils/coastline/staging-evidence";
import { withError, type RequestWithLogger } from "@/utils/middleware";

type RuntimeEvidenceReader = () => Promise<CoastlineStagingRuntimeBinding>;

export function createStagingEvidenceHandler(
  readRuntimeEvidence: RuntimeEvidenceReader = readCoastlineStagingRuntimeBinding,
  now: () => Date = () => new Date(),
) {
  return withError(
    "coastline/staging-evidence",
    async (request: RequestWithLogger) => {
      if (!hasCronSecret(request)) {
        return new Response("Unauthorized", { status: 401 });
      }

      const observedAt = now();
      const runNonce = new URL(request.url).searchParams.get("run_nonce");
      try {
        assertFreshCoastlineStagingRunNonce(runNonce, observedAt);
        if (!env.CRON_SECRET) {
          throw new CoastlineStagingEvidenceError(
            "COASTLINE_STAGING_CRON_EVIDENCE_INVALID",
            503,
          );
        }

        const runtime = await readRuntimeEvidence();
        const cronEvidence = createCoastlineCronAuthProbe({
          runNonce,
          cronSecret: env.CRON_SECRET,
          observedAt,
        });
        return NextResponse.json(
          createCoastlineRemoteStagingEvidence({
            ...runtime,
            runNonce,
            cronEvidenceId: cronEvidence.evidenceId,
            observedAt,
          }),
        );
      } catch (error) {
        if (error instanceof CoastlineStagingEvidenceError) {
          return NextResponse.json(
            {
              error: "Remote staging evidence unavailable",
              errorCode: error.code,
            },
            { status: error.status },
          );
        }
        return NextResponse.json(
          {
            error: "Remote staging evidence unavailable",
            errorCode: "COASTLINE_STAGING_RUNTIME_UNAVAILABLE",
          },
          { status: 503 },
        );
      }
    },
  );
}

export const GET = createStagingEvidenceHandler();
