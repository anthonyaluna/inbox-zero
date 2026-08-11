import { z } from "zod";
import {
  DraftReplyConfidence,
  ReplyMemoryKind,
  ReplyMemoryScopeType,
} from "@/generated/prisma/enums";

export const draftContextMetadataSchema = z.object({
  replyMemories: z.object({
    count: z.number(),
    ids: z.array(z.string()),
    kinds: z.array(z.nativeEnum(ReplyMemoryKind)),
    scopeTypes: z.array(z.nativeEnum(ReplyMemoryScopeType)),
  }),
  knowledgeBase: z.object({
    availableCount: z.number(),
    injected: z.boolean(),
  }),
  senderHistory: z.object({
    summaryInjected: z.boolean(),
    summarySourceMessageCount: z.number(),
    precedentThreadsInjected: z.boolean(),
    precedentThreadCount: z.number(),
    sameSenderReplyExamplesInjected: z.boolean(),
    sameSenderReplyExampleCount: z.number(),
  }),
  calendar: z.object({
    injected: z.boolean(),
    noAvailability: z.boolean(),
    suggestedTimesCount: z.number(),
  }),
  writingStyle: z.object({
    custom: z.boolean(),
  }),
  externalTools: z.object({
    injected: z.boolean(),
  }),
  meetings: z.object({
    injected: z.boolean(),
    count: z.number(),
  }),
  attachments: z.object({
    injected: z.boolean(),
    selectedCount: z.number(),
  }),
  // Optional: rows written before this field existed are still parsed.
  draft: z
    .object({
      confidence: z.nativeEnum(DraftReplyConfidence),
    })
    .optional(),
  coastlineDraft: z
    .object({
      schemaVersion: z.literal("inbox_zero_draft_receipt.v1"),
      provider: z.literal("microsoft"),
      accountId: z.string().min(1),
      threadId: z.string().min(1),
      sourceMessageId: z.string().min(1),
      idempotencyKey: z.string().min(1),
      draftId: z.string().min(1),
      generatedAt: z.string().datetime(),
      readBackAt: z.string().datetime().nullable(),
      terminalState: z.enum([
        "created_verified",
        "created_unverified",
        "failed",
      ]),
    })
    .optional(),
});

export type DraftContextMetadata = z.infer<typeof draftContextMetadataSchema>;
