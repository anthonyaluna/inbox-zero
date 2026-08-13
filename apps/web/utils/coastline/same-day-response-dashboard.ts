import {
  listSameDayResponseCases,
  type SameDayResponseCaseStore,
} from "@/utils/coastline/same-day-response-case-store";
import {
  summarizeSameDayResponseCases,
  type SameDayResponseMetrics,
} from "@/utils/coastline/same-day-response-metrics";

export const SAME_DAY_RESPONSE_METRICS_SCHEMA =
  "same_day_response_metrics.v1" as const;

export type SameDayResponseMetricsResponse = {
  schemaVersion: typeof SAME_DAY_RESPONSE_METRICS_SCHEMA;
  generatedAt: string;
  metrics: SameDayResponseMetrics;
};

export async function getSameDayResponseMetrics({
  store,
  accountId,
  now = new Date().toISOString(),
}: {
  store: SameDayResponseCaseStore;
  accountId: string;
  now?: string;
}): Promise<SameDayResponseMetricsResponse> {
  const responseCases = await listSameDayResponseCases(store, { accountId });
  return {
    schemaVersion: SAME_DAY_RESPONSE_METRICS_SCHEMA,
    generatedAt: now,
    metrics: summarizeSameDayResponseCases(responseCases, { now }),
  };
}
