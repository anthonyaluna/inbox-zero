import { NextResponse } from "next/server";
import { withEmailProvider } from "@/utils/middleware";
import { createPrismaSameDayResponseCaseStore } from "@/utils/coastline/same-day-response-case-store";
import { getSameDayResponseMetrics } from "@/utils/coastline/same-day-response-dashboard";

export const GET = withEmailProvider(
  "same-day-response-metrics",
  async (request) => {
    const result = await getSameDayResponseMetrics({
      store: createPrismaSameDayResponseCaseStore(),
      accountId: request.auth.emailAccountId,
    });

    return NextResponse.json(result);
  },
);
