import type { SameDayResponseCaseV1 } from "@/utils/coastline/same-day-response-case";

export type SameDayResponseMetrics = {
  total: number;
  responseDue: number;
  drafted: number;
  awaitingAction: number;
  updatesDue: number;
  overdueCommitments: number;
  overdueResponses: number;
  timelineChanges: number;
  escalationMarkers: number;
  unsupportedFactBlocks: number;
  verifiedClosed: number;
  sameDayComplianceRate: number;
};

export function summarizeSameDayResponseCases(
  responseCases: readonly SameDayResponseCaseV1[],
  { now = new Date().toISOString() }: { now?: string } = {},
): SameDayResponseMetrics {
  const nowDate = new Date(now);
  const responseDue = responseCases.filter(
    (responseCase) => responseCase.state === "response_due",
  ).length;
  const drafted = responseCases.filter(
    (responseCase) => responseCase.state === "drafted",
  ).length;
  const awaitingAction = responseCases.filter(
    (responseCase) => responseCase.state === "awaiting_action",
  ).length;
  const updatesDue = responseCases.filter(
    (responseCase) =>
      responseCase.nextUpdateAt !== null &&
      new Date(responseCase.nextUpdateAt) <= nowDate &&
      ["awaiting_action", "update_due"].includes(responseCase.state),
  ).length;
  const overdueCommitments = responseCases.reduce(
    (count, responseCase) =>
      count +
      responseCase.commitments.filter(
        (commitment) =>
          commitment.status === "open" &&
          commitment.dueAt !== null &&
          new Date(commitment.dueAt) <= nowDate,
      ).length,
    0,
  );
  const overdueResponses = responseCases.filter(
    (responseCase) =>
      ["response_due", "drafted"].includes(responseCase.state) &&
      new Date(responseCase.responseDeadlineAt) <= nowDate,
  ).length;
  const timelineChanges = responseCases.reduce(
    (count, responseCase) =>
      count +
      responseCase.commitments.filter(
        (commitment) => commitment.status === "superseded",
      ).length,
    0,
  );
  const escalationMarkers = responseCases.filter((responseCase) =>
    Boolean(responseCase.escalation),
  ).length;
  const unsupportedFactBlocks = responseCases.filter(
    (responseCase) => responseCase.conflictStatus === "missing_facts",
  ).length;
  const verifiedClosed = responseCases.filter(
    (responseCase) => responseCase.state === "verified_closed",
  ).length;
  const respondedWithinWindow = responseCases.filter(
    (responseCase) =>
      responseCase.respondedAt !== null &&
      new Date(responseCase.respondedAt) <=
        new Date(responseCase.responseDeadlineAt),
  ).length;

  return {
    total: responseCases.length,
    responseDue,
    drafted,
    awaitingAction,
    updatesDue,
    overdueCommitments,
    overdueResponses,
    timelineChanges,
    escalationMarkers,
    unsupportedFactBlocks,
    verifiedClosed,
    sameDayComplianceRate:
      responseCases.length === 0
        ? 0
        : respondedWithinWindow / responseCases.length,
  };
}
