import { env } from "@/env";
import {
  assertCoastlineMutationAllowed,
  type CoastlineDraftOnlyPolicyError,
} from "@/utils/coastline/draft-only-policy";
import type { EmailProvider } from "@/utils/email/types";

const PROVIDER_MUTATION_OPERATIONS = new Set<string>([
  "archiveMessage",
  "archiveThread",
  "archiveThreadWithLabel",
  "blockUnsubscribedEmail",
  "bulkArchiveFromSenders",
  "bulkArchiveThreads",
  "bulkTrashFromSenders",
  "createAutoArchiveFilter",
  "createDraft",
  "createFilter",
  "createLabel",
  "deleteDraft",
  "deleteFilter",
  "deleteLabel",
  "forwardEmail",
  "getOrCreateFolderIdByName",
  "getOrCreateInboxZeroLabel",
  "labelMessage",
  "markRead",
  "markReadThread",
  "markSpam",
  "moveThreadToFolder",
  "removeThreadLabel",
  "removeThreadLabels",
  "replyToEmail",
  "sendDraft",
  "sendEmail",
  "sendEmailWithHtml",
  "starMessage",
  "trashThread",
  "unarchiveThread",
  "untrashThread",
  "unwatchEmails",
  "updateDraft",
  "watchEmails",
]);

export function withCoastlineProviderMutationGuard(
  emailProvider: EmailProvider,
  {
    coastlineDraftProposalsEnabled = env.COASTLINE_DRAFT_PROPOSALS_ENABLED,
    allowOwnedDraftCleanup = false,
  }: {
    coastlineDraftProposalsEnabled?: boolean;
    allowOwnedDraftCleanup?: boolean;
  } = {},
): EmailProvider {
  return new Proxy(emailProvider, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;

      return (...args: unknown[]) => {
        const operation = String(property);
        if (
          PROVIDER_MUTATION_OPERATIONS.has(operation) &&
          !isAllowedCoastlineDraftOperation({
            operation,
            provider: target.name,
            allowOwnedDraftCleanup,
          })
        ) {
          assertCoastlineMutationAllowed({
            surface: `email-provider/${target.name}`,
            mutation: toMutationCode(operation),
            coastlineDraftProposalsEnabled,
          });
        }

        return value.apply(target, args);
      };
    },
  }) as EmailProvider;
}

function isAllowedCoastlineDraftOperation({
  operation,
  provider,
  allowOwnedDraftCleanup,
}: {
  operation: string;
  provider: EmailProvider["name"];
  allowOwnedDraftCleanup: boolean;
}) {
  if (provider !== "microsoft") return false;
  if (operation === "deleteDraft") return allowOwnedDraftCleanup;
  return new Set([
    "archiveMessage",
    "archiveThread",
    "archiveThreadWithLabel",
    "blockUnsubscribedEmail",
    "bulkArchiveFromSenders",
    "bulkArchiveThreads",
    "draftEmail",
    "labelMessage",
    "markRead",
    "markReadThread",
    "moveThreadToFolder",
    "removeThreadLabel",
    "removeThreadLabels",
  ]).has(operation);
}

function toMutationCode(operation: string) {
  return operation.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

export type ProviderMutationGuardError = CoastlineDraftOnlyPolicyError;
