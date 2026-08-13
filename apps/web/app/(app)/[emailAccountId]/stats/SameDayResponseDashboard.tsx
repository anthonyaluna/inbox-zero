"use client";

import { AlertTriangle, CheckCircle2, Clock3, ListChecks } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingContent } from "@/components/LoadingContent";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrgSWR } from "@/hooks/useOrgSWR";
import type { SameDayResponseMetricsResponse } from "@/utils/coastline/same-day-response-dashboard";

export function SameDayResponseDashboard({
  refreshInterval,
}: {
  refreshInterval: number;
}) {
  const { data, error, isLoading } = useOrgSWR<SameDayResponseMetricsResponse>(
    "/api/user/same-day-response",
    { refreshInterval },
  );

  return (
    <LoadingContent
      loading={isLoading}
      error={error}
      loadingComponent={<Skeleton className="h-36 rounded" />}
    >
      {data && (
        <div className="space-y-3">
          <div>
            <h2 className="font-semibold text-lg">Same-Day Response</h2>
            <p className="text-muted-foreground text-sm">
              Ownership and follow-through, not same-day resolution.
            </p>
          </div>
          <div className="grid gap-2 sm:gap-4 grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="Compliance"
              value={`${Math.round(data.metrics.sameDayComplianceRate * 100)}%`}
              icon={<CheckCircle2 className="h-4 w-4" />}
            />
            <MetricCard
              label="Due now"
              value={data.metrics.responseDue + data.metrics.updatesDue}
              icon={<Clock3 className="h-4 w-4" />}
            />
            <MetricCard
              label="Awaiting action"
              value={data.metrics.awaitingAction}
              icon={<ListChecks className="h-4 w-4" />}
            />
            <MetricCard
              label="Overdue"
              value={
                data.metrics.overdueResponses + data.metrics.overdueCommitments
              }
              icon={<AlertTriangle className="h-4 w-4" />}
            />
          </div>
        </div>
      )}
    </LoadingContent>
  );
}

function MetricCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number | string;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
        <span className="text-muted-foreground">{icon}</span>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}
