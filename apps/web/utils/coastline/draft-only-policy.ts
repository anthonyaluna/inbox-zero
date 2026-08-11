import { ActionType } from "@/generated/prisma/enums";

export const COASTLINE_DRAFT_ONLY_POLICY_CODE =
  "COASTLINE_DRAFT_ONLY_ACTION_BLOCKED" as const;

export class CoastlineDraftOnlyPolicyError extends Error {
  readonly code = COASTLINE_DRAFT_ONLY_POLICY_CODE;
  readonly actionType: string;

  constructor(actionType: string) {
    super(`Coastline draft-only policy blocked ${actionType}`);
    this.name = "CoastlineDraftOnlyPolicyError";
    this.actionType = actionType;
  }
}

export function assertCoastlineDraftOnlyAction({
  actionType,
  providerName,
  coastlineDraftProposalsEnabled,
  providerCapabilities,
}: {
  actionType: string;
  providerName: string;
  coastlineDraftProposalsEnabled: boolean;
  providerCapabilities: { canDraftEmail: boolean };
}) {
  if (!coastlineDraftProposalsEnabled) return;

  if (
    providerName !== "microsoft" ||
    actionType !== ActionType.DRAFT_EMAIL ||
    !providerCapabilities.canDraftEmail
  ) {
    throw new CoastlineDraftOnlyPolicyError(actionType);
  }
}

export function assertCoastlineServerActionAllowed({
  actionName,
  coastlineDraftProposalsEnabled,
}: {
  actionName: string;
  coastlineDraftProposalsEnabled: boolean;
}) {
  if (coastlineDraftProposalsEnabled) {
    throw new CoastlineDraftOnlyPolicyError(actionName);
  }
}
