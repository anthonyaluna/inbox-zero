import { ActionType } from "@/generated/prisma/enums";

export const COASTLINE_DRAFT_ONLY_POLICY_CODE =
  "COASTLINE_DRAFT_ONLY_ACTION_BLOCKED" as const;

export const COASTLINE_REGISTERED_CAPABILITIES = [
  "draft_reply",
  "follow_up_draft",
  "meeting_recap_draft",
  "calendar_event",
  "archive",
  "unsubscribe_https",
  "cold_email_classification",
  "stale_ai_draft_cleanup",
  "attachment_filing",
  "teams_assistant",
  "analytics",
] as const;
type CoastlineCapability = (typeof COASTLINE_REGISTERED_CAPABILITIES)[number];

export function isCoastlineCapabilityRegistered(
  capability: CoastlineCapability | undefined,
) {
  return (
    capability !== undefined &&
    COASTLINE_REGISTERED_CAPABILITIES.includes(capability)
  );
}

export class CoastlineDraftOnlyPolicyError extends Error {
  readonly code = COASTLINE_DRAFT_ONLY_POLICY_CODE;
  readonly actionType: string;
  readonly surface?: string;

  constructor(actionType: string, surface?: string) {
    super(`Coastline production policy blocked ${actionType}`);
    this.name = "CoastlineDraftOnlyPolicyError";
    this.actionType = actionType;
    this.surface = surface;
  }
}

const ACTION_CAPABILITIES: Partial<Record<string, CoastlineCapability>> = {
  [ActionType.ARCHIVE]: "archive",
  [ActionType.LABEL]: "cold_email_classification",
  [ActionType.DRAFT_EMAIL]: "draft_reply",
  [ActionType.DRAFT_MESSAGING_CHANNEL]: "teams_assistant",
  [ActionType.NOTIFY_MESSAGING_CHANNEL]: "teams_assistant",
  [ActionType.MARK_READ]: "cold_email_classification",
  [ActionType.DIGEST]: "analytics",
  [ActionType.MOVE_FOLDER]: "archive",
};

const MUTATION_CAPABILITIES: Record<string, CoastlineCapability> = {
  CREATE_DRAFT: "meeting_recap_draft",
  ARCHIVE: "archive",
  ARCHIVE_THREAD: "archive",
  BULK_ARCHIVE: "archive",
  CHANGE_KEEP_TO_DONE: "archive",
  CLEAN_INBOX: "archive",
  BLOCK_UNSUBSCRIBED_EMAIL: "unsubscribe_https",
  DELETE_AI_DRAFT: "stale_ai_draft_cleanup",
  LABEL_MESSAGE: "cold_email_classification",
  MARK_NOT_COLD_EMAIL: "cold_email_classification",
  MARK_READ: "cold_email_classification",
  MARK_READ_THREAD: "cold_email_classification",
  MOVE_FOLDER: "archive",
  MOVE_THREAD_TO_FOLDER: "archive",
  REMOVE_COLD_EMAIL_LABEL: "cold_email_classification",
  UNARCHIVE_THREAD: "archive",
  UNDO_CLEAN_INBOX: "archive",
  UNSUBSCRIBE: "unsubscribe_https",
  bulkArchive: "archive",
  cleanInbox: "archive",
  unsubscribeSender: "unsubscribe_https",
};

const BLOCKED_MUTATIONS = new Set([
  "DELETE_DRAFT",
  "FORWARD",
  "FORWARD_EMAIL",
  "REPLY",
  "REPLY_TO_EMAIL",
  "SEND_DRAFT",
  "SEND_EMAIL",
  "SEND_EMAIL_WITH_HTML",
  "TRASH_THREAD",
  "forwardEmail",
  "replyToEmail",
  "sendEmail",
  "trashThread",
]);

export function assertCoastlineMutationAllowed({
  surface,
  mutation,
  coastlineDraftProposalsEnabled,
}: {
  surface: string;
  mutation: string;
  coastlineDraftProposalsEnabled: boolean;
}): void {
  if (
    coastlineDraftProposalsEnabled &&
    (!isCoastlineCapabilityRegistered(MUTATION_CAPABILITIES[mutation]) ||
      BLOCKED_MUTATIONS.has(mutation))
  ) {
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
    !isCoastlineCapabilityRegistered(ACTION_CAPABILITIES[actionType]) ||
    (actionType === ActionType.DRAFT_EMAIL &&
      !providerCapabilities.canDraftEmail)
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
