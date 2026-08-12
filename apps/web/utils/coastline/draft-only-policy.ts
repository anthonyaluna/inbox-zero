import { ActionType } from "@/generated/prisma/enums";

export const COASTLINE_DRAFT_ONLY_POLICY_CODE =
  "COASTLINE_DRAFT_ONLY_ACTION_BLOCKED" as const;

export class CoastlineDraftOnlyPolicyError extends Error {
  readonly code = COASTLINE_DRAFT_ONLY_POLICY_CODE;
  readonly actionType: string;
  readonly surface?: string;

  constructor(actionType: string, surface?: string) {
    super(`Coastline draft-only policy blocked ${actionType}`);
    this.name = "CoastlineDraftOnlyPolicyError";
    this.actionType = actionType;
    this.surface = surface;
  }
}

export function assertCoastlineMutationAllowed({
  surface,
  mutation,
  coastlineDraftProposalsEnabled,
}: {
  surface: string;
  mutation: string;
  coastlineDraftProposalsEnabled: boolean;
}): void {
  if (coastlineDraftProposalsEnabled) {
    throw new CoastlineDraftOnlyPolicyError(mutation, surface);
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
  assertCoastlineMutationAllowed({
    surface: "server-action",
    mutation: actionName,
    coastlineDraftProposalsEnabled,
  });
}
