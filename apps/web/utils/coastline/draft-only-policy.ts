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

const REGISTERED_ACTION_TYPES = new Set<string>([
  ActionType.ARCHIVE,
  ActionType.LABEL,
  ActionType.DRAFT_EMAIL,
  ActionType.DRAFT_MESSAGING_CHANNEL,
  ActionType.NOTIFY_MESSAGING_CHANNEL,
  ActionType.MARK_READ,
  ActionType.DIGEST,
  ActionType.MOVE_FOLDER,
]);

const REGISTERED_MUTATIONS = new Set([
  "ARCHIVE",
  "ARCHIVE_THREAD",
  "BULK_ARCHIVE",
  "CHANGE_KEEP_TO_DONE",
  "CLEAN_INBOX",
  "BLOCK_UNSUBSCRIBED_EMAIL",
  "DELETE_AI_DRAFT",
  "LABEL_MESSAGE",
  "MARK_NOT_COLD_EMAIL",
  "MARK_READ",
  "MARK_READ_THREAD",
  "MOVE_FOLDER",
  "MOVE_THREAD_TO_FOLDER",
  "REMOVE_COLD_EMAIL_LABEL",
  "UNARCHIVE_THREAD",
  "UNDO_CLEAN_INBOX",
  "UNSUBSCRIBE",
  "bulkArchive",
  "cleanInbox",
  "unsubscribeSender",
]);

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
    (!REGISTERED_MUTATIONS.has(mutation) || BLOCKED_MUTATIONS.has(mutation))
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
    !REGISTERED_ACTION_TYPES.has(actionType) ||
    (actionType === ActionType.DRAFT_EMAIL && !providerCapabilities.canDraftEmail)
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
