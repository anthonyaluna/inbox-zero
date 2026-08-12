import prisma from "@/utils/prisma";
import { ActionType, DraftEmailStatus } from "@/generated/prisma/enums";
import type { ExecutedRule } from "@/generated/prisma/client";
import type { Logger } from "@/utils/logger";
import type { EmailProvider } from "@/utils/email/types";
import { convertEmailHtmlToText } from "@/utils/mail";
import type { ParsedMessage } from "@/utils/types";
import { stripQuotedHtmlContent } from "@/utils/email/parse-message-reply";
import {
  createInboxZeroDraftReceipt,
  parseInboxZeroDraftReceipt,
  type InboxZeroDraftProposal,
  type InboxZeroDraftReceipt,
} from "@/utils/coastline/draft-proposal";
import {
  markRecoveryRequired,
  recordCoastlineDraftCreation,
  reconcileCoastlineDraft,
  reserveOrReconcileCoastlineDraft,
} from "@/utils/coastline/draft-reservation";

const MAX_RECEIPT_PERSISTENCE_ATTEMPTS = 3;
const RECEIPT_PERSISTENCE_ERROR_CODE =
  "COASTLINE_DRAFT_RECEIPT_PERSISTENCE_FAILED";
const DRAFT_RECOVERY_ERROR_CODE = "COASTLINE_DRAFT_RECOVERY_REQUIRED";
const DRAFT_READBACK_ERROR_CODE = "COASTLINE_DRAFT_READBACK_FAILED";

export type PreviousDraftHandlingResult =
  | {
      shouldCreateDraft: true;
    }
  | {
      shouldCreateDraft: false;
      existingDraftId: string;
      reason: "modified" | "missing_original_content" | "missing_content";
    };

/**
 * Handles finding and potentially deleting a previous AI-generated draft for a thread.
 * Returns whether the caller should create a replacement draft.
 */
export async function handlePreviousDraftDeletion({
  client,
  executedRule,
  logger,
}: {
  client: EmailProvider;
  executedRule: Pick<ExecutedRule, "id" | "threadId" | "emailAccountId">;
  logger: Logger;
}): Promise<PreviousDraftHandlingResult> {
  try {
    // Find the most recent previous executed action of type DRAFT_EMAIL for this thread
    const previousDraftAction = await prisma.executedAction.findFirst({
      where: {
        executedRule: {
          threadId: executedRule.threadId,
          emailAccountId: executedRule.emailAccountId,
        },
        type: ActionType.DRAFT_EMAIL,
        draftId: { not: null }, // Ensure it has a draftId
        executedRuleId: { not: executedRule.id }, // Explicitly exclude current executedRule from the current rule execution
        draftSendLog: null, // Only consider drafts not logged as sent
      },
      orderBy: {
        createdAt: "desc", // Get the most recent one
      },
      select: {
        id: true,
        draftId: true,
        content: true,
      },
    });

    if (!previousDraftAction?.draftId) {
      logger.info("No previous draft found for this thread to delete");
      return { shouldCreateDraft: true };
    }

    logger.info("Found previous draft", {
      previousDraftId: previousDraftAction.draftId,
    });

    const currentDraftDetails = await client.getDraft(
      previousDraftAction.draftId,
    );

    if (!currentDraftDetails) {
      logger.warn("Previous draft not found, continuing draft creation.", {
        previousDraftId: previousDraftAction.draftId,
      });
      return { shouldCreateDraft: true };
    }

    if (!currentDraftDetails.textPlain && !currentDraftDetails.textHtml) {
      logger.warn(
        "Previous draft content is unavailable, skipping replacement draft creation.",
        { previousDraftId: previousDraftAction.draftId },
      );
      return {
        shouldCreateDraft: false,
        existingDraftId: previousDraftAction.draftId,
        reason: "missing_content",
      };
    }

    if (previousDraftAction.content === null) {
      logger.info(
        "Previous draft content missing, skipping replacement draft creation.",
      );
      return {
        shouldCreateDraft: false,
        existingDraftId: previousDraftAction.draftId,
        reason: "missing_original_content",
      };
    }

    if (
      isDraftUnmodified({
        originalContent: previousDraftAction.content,
        currentDraft: currentDraftDetails,
        logger,
      })
    ) {
      logger.info("Draft content matches, deleting draft.");

      await Promise.all([
        client.deleteDraft(previousDraftAction.draftId),
        prisma.executedAction.update({
          where: { id: previousDraftAction.id },
          data: {
            draftStatus: DraftEmailStatus.CLEANED_UP_UNUSED,
          },
        }),
      ]);

      logger.info("Deleted draft and updated action status.");
      return { shouldCreateDraft: true };
    } else {
      logger.info(
        "Draft content modified by user, skipping replacement draft creation.",
      );
      return {
        shouldCreateDraft: false,
        existingDraftId: previousDraftAction.draftId,
        reason: "modified",
      };
    }
  } catch (error) {
    logger.error("Error finding or deleting previous draft", {
      error: (error as Error)?.message || error,
    });
    return { shouldCreateDraft: true };
  }
}

/**
 * Updates the ExecutedAction record with the Gmail draft ID.
 */
export async function updateExecutedActionWithDraftId({
  actionId,
  draftId,
  receipt,
  logger,
}: {
  actionId: string;
  draftId: string;
  receipt?: InboxZeroDraftReceipt;
  logger: Logger;
}) {
  try {
    if (receipt) {
      await persistDraftReceipt({ actionId, draftId, receipt });
    } else {
      await prisma.executedAction.update({
        where: { id: actionId },
        data: { draftId, draftStatus: DraftEmailStatus.PENDING },
      });
    }
    logger.info("Updated executed action with draft ID", { actionId, draftId });
  } catch (error) {
    logger.error("Failed to update executed action with draft ID", {
      actionId,
      draftId,
      error,
    });
    throw createReceiptPersistenceError(error);
  }
}

export async function createOrReconcileCoastlineDraft({
  actionId,
  proposal,
  client,
  createDraft,
  logger,
}: {
  actionId: string;
  proposal: InboxZeroDraftProposal;
  client: EmailProvider;
  createDraft: () => Promise<{ draftId: string }>;
  logger: Logger;
}): Promise<{ draftId: string; receipt: InboxZeroDraftReceipt }> {
  const reservation = await reserveOrReconcileCoastlineDraft({
    actionId,
    proposal,
    client,
  });
  if (reservation.state === "recovery_required") {
    throw createDraftRecoveryError(
      "Draft idempotency reservation is awaiting recovery by its creator",
    );
  }
  let draftId = reservation.draftId;

  if (!draftId) {
    const createdDraft = await createDraft();
    draftId = createdDraft.draftId;
    try {
      await recordCoastlineDraftCreation({
        reservationId: reservation.reservationId,
        draftId,
      });
    } catch (error) {
      throw createDraftRecoveryError(
        error instanceof Error
          ? error.message
          : "Created Coastline draft could not be reserved for recovery",
      );
    }
    const unverifiedReceipt = createInboxZeroDraftReceipt({
      proposal,
      draftId,
    });
    try {
      await updateExecutedActionWithDraftId({
        actionId,
        draftId,
        receipt: unverifiedReceipt,
        logger,
      });
    } catch (error) {
      await persistRecoveryReceiptBestEffort({
        actionId,
        draftId,
        receipt: { ...unverifiedReceipt, terminalState: "failed" },
        logger,
      });
      throw error;
    }
  }

  try {
    await assertExactDraftReadback({ client, draftId, proposal });
    await reconcileCoastlineDraft({
      reservationId: reservation.reservationId,
      draftId,
      proposal,
      client,
    });
  } catch (error) {
    await markRecoveryRequired(
      reservation.reservationId,
      DRAFT_READBACK_ERROR_CODE,
    );
    const failedReceipt = {
      ...createInboxZeroDraftReceipt({ proposal, draftId }),
      terminalState: "failed" as const,
    };
    await persistRecoveryReceiptBestEffort({
      actionId,
      draftId,
      receipt: failedReceipt,
      logger,
    });
    throw Object.assign(
      new Error("Coastline draft independent readback did not match"),
      { code: DRAFT_READBACK_ERROR_CODE, cause: error },
    );
  }

  const receipt = createInboxZeroDraftReceipt({
    proposal,
    draftId,
    readBackAt: new Date(),
  });
  await updateExecutedActionWithDraftId({
    actionId,
    draftId,
    receipt,
    logger,
  });
  await assertPersistedVerifiedReceipt({ actionId, receipt });

  return { draftId, receipt };
}

async function assertExactDraftReadback({
  client,
  draftId,
  proposal,
}: {
  client: EmailProvider;
  draftId: string;
  proposal: InboxZeroDraftProposal;
}) {
  const draft = await client.getDraft(draftId);
  if (!draft || draft.id !== draftId || draft.threadId !== proposal.thread_id) {
    throw new Error("Draft identity did not match the reserved proposal");
  }
  if (
    draft.subject.trim() !== proposal.subject.trim() ||
    stripQuotedContent(extractDraftPlainText(draft)) !==
      proposal.body_text.trim()
  ) {
    throw new Error("Draft content did not match the reserved proposal");
  }

  const actualRecipients = normalizeRecipients([
    draft.headers.to,
    draft.headers.cc,
    draft.headers.bcc,
  ]);
  const expectedRecipients = normalizeRecipients([
    ...proposal.to,
    ...proposal.cc,
    ...proposal.bcc,
  ]);
  if (actualRecipients.join("\n") !== expectedRecipients.join("\n")) {
    throw new Error("Draft recipients did not match the reserved proposal");
  }
}

async function assertPersistedVerifiedReceipt({
  actionId,
  receipt,
}: {
  actionId: string;
  receipt: InboxZeroDraftReceipt;
}) {
  const action = await prisma.executedAction.findUnique({
    where: { id: actionId },
    select: { draftId: true, draftContextMetadata: true },
  });
  const persisted = parseReceipt(
    toMetadataObject(action?.draftContextMetadata).coastlineDraft,
  );
  if (
    action?.draftId !== receipt.draftId ||
    !persisted ||
    persisted.terminalState !== "created_verified" ||
    persisted.idempotencyKey !== receipt.idempotencyKey ||
    persisted.draftId !== receipt.draftId ||
    !persisted.readBackAt
  ) {
    throw createReceiptPersistenceError(
      new Error("Persisted Coastline draft receipt readback did not match"),
    );
  }
}

async function persistRecoveryReceiptBestEffort({
  actionId,
  draftId,
  receipt,
  logger,
}: {
  actionId: string;
  draftId: string;
  receipt: InboxZeroDraftReceipt;
  logger: Logger;
}) {
  try {
    await updateExecutedActionWithDraftId({
      actionId,
      draftId,
      receipt,
      logger,
    });
  } catch (error) {
    logger.error("Failed to persist Coastline draft recovery state", {
      actionId,
      draftId,
      error,
    });
  }
}

function parseReceipt(value: unknown): InboxZeroDraftReceipt | null {
  const result = (() => {
    try {
      return parseInboxZeroDraftReceipt(value);
    } catch {
      return null;
    }
  })();
  return result;
}

function createDraftRecoveryError(message: string) {
  return Object.assign(new Error(message), { code: DRAFT_RECOVERY_ERROR_CODE });
}

function normalizeRecipients(values: Array<string | undefined>) {
  return values
    .flatMap((value) => (value ?? "").split(/[;,]/))
    .map((value) => {
      const match = value.match(/<([^>]+)>/);
      return (match?.[1] ?? value).trim().toLowerCase();
    })
    .filter(Boolean)
    .sort();
}

async function persistDraftReceipt({
  actionId,
  draftId,
  receipt,
}: {
  actionId: string;
  draftId: string;
  receipt: InboxZeroDraftReceipt;
}) {
  for (let attempt = 0; attempt < MAX_RECEIPT_PERSISTENCE_ATTEMPTS; attempt++) {
    const existingAction = await prisma.executedAction.findUnique({
      where: { id: actionId },
      select: { draftContextMetadata: true, updatedAt: true },
    });
    if (!existingAction) {
      throw new Error("Executed action is unavailable for receipt persistence");
    }

    // The version guard makes a competing metadata write retry against fresh data.
    const result = await prisma.executedAction.updateMany({
      where: { id: actionId, updatedAt: existingAction.updatedAt },
      data: {
        draftId,
        draftStatus: DraftEmailStatus.PENDING,
        updatedAt: new Date(),
        draftContextMetadata: {
          ...toMetadataObject(existingAction.draftContextMetadata),
          coastlineDraft: receipt,
        },
        ...(receipt.terminalState === "failed"
          ? {
              executionError: {
                code: "COASTLINE_DRAFT_RECEIPT_FAILED",
                message: "Coastline draft receipt recorded a failed state",
                stack: null,
                statusCode: null,
                requestId: null,
              },
            }
          : {}),
      },
    });
    if (result.count === 1) return;
  }

  throw new Error("Draft receipt metadata changed during persistence");
}

function createReceiptPersistenceError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : "Coastline draft receipt persistence failed";
  return Object.assign(new Error(message), {
    code: RECEIPT_PERSISTENCE_ERROR_CODE,
  });
}

function toMetadataObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Extracts plain text from a draft, handling both Gmail and Outlook formats.
 */
export function extractDraftPlainText(draft: ParsedMessage): string {
  if (draft.bodyContentType === "html") {
    return draft.textPlain
      ? convertEmailHtmlToText({
          htmlText: stripQuotedHtmlContent(draft.textPlain),
          includeLinks: false,
        })
      : "";
  }
  return draft.textPlain || "";
}

/**
 * Removes quoted content from email text.
 */
export function stripQuotedContent(text: string): string {
  const quoteHeaderPatterns = [
    /\n\nOn .* wrote:/,
    /\n\n----+ Original Message ----+/,
    /\n\n>+ On .*/,
    /\n\nFrom: .*/,
  ];

  let result = text;
  for (const pattern of quoteHeaderPatterns) {
    const parts = result.split(pattern);
    if (parts.length > 1) {
      result = parts[0];
      break;
    }
  }

  return result.trim();
}

/**
 * Checks if a draft has been modified by comparing original and current content.
 */
export function isDraftUnmodified({
  originalContent,
  currentDraft,
  logger,
}: {
  originalContent: string;
  currentDraft: ParsedMessage;
  logger: Logger;
}): boolean {
  const { text: currentText, source: comparisonSource } =
    extractDraftComparisonText(currentDraft);
  const currentReplyContent = stripQuotedContent(currentText);

  const originalWithBr = originalContent.replace(/\n/g, "<br>");
  const originalContentPlain = convertEmailHtmlToText({
    htmlText: originalWithBr,
    includeLinks: false,
  });
  const originalContentTrimmed = originalContentPlain.trim();
  const isUnmodified = originalContentTrimmed === currentReplyContent;

  logger.info("Checked draft unmodified status", {
    comparisonSource,
    hasTextHtml: !!currentDraft.textHtml,
    hasTextPlain: !!currentDraft.textPlain,
    bodyContentType: currentDraft.bodyContentType,
    originalLength: originalContentTrimmed.length,
    currentLength: currentReplyContent.length,
    isUnmodified,
  });

  logger.trace("Comparing draft content", {
    comparisonSource,
    original: originalContentTrimmed,
    current: currentReplyContent,
  });

  return isUnmodified;
}

function extractDraftComparisonText(draft: ParsedMessage): {
  text: string;
  source: "textHtml" | "textPlain";
} {
  if (draft.textHtml) {
    return {
      text: convertEmailHtmlToText({
        htmlText: stripQuotedHtmlContent(draft.textHtml),
        includeLinks: false,
      }),
      source: "textHtml",
    };
  }

  return {
    text: extractDraftPlainText(draft),
    source: "textPlain",
  };
}
