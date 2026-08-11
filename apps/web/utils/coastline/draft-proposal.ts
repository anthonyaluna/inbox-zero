import { z } from "zod";

export const INBOX_ZERO_DRAFT_PROPOSAL_VERSION =
  "inbox_zero_draft_proposal.v1" as const;

const emailAddressSchema = z.string().email();

export const inboxZeroDraftProposalSchema = z
  .object({
    schema_version: z.literal(INBOX_ZERO_DRAFT_PROPOSAL_VERSION),
    source: z.literal("inbox_zero"),
    action: z.literal("draft_only"),
    provider: z.literal("microsoft"),
    account_id: z.string().min(1),
    thread_id: z.string().min(1),
    source_message_id: z.string().min(1),
    to: z.array(emailAddressSchema).min(1),
    cc: z.array(emailAddressSchema),
    bcc: z.array(emailAddressSchema),
    subject: z.string().min(1).max(998),
    body_text: z.string().min(1),
    confidence: z.enum(["low", "medium", "high"]),
    model: z.string().min(1),
    idempotency_key: z.string().min(1),
    generated_at: z.string().datetime({ offset: true }),
  })
  .strict();

export type InboxZeroDraftProposal = z.infer<
  typeof inboxZeroDraftProposalSchema
>;

export const inboxZeroDraftReceiptSchema = z
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
    terminalState: z.enum(["created_verified", "created_unverified", "failed"]),
  })
  .strict();

export type InboxZeroDraftReceipt = z.infer<
  typeof inboxZeroDraftReceiptSchema
>;

const opaqueCanaryValueSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value === value.trim() &&
      !/[\s@<>]/.test(value) &&
      !/(token|secret|cookie|oauth|bearer|authorization|password|subject|body|recipient)/i.test(
        value,
      ),
    "Expected a bounded opaque value without content or credentials",
  );

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const inboxZeroMicrosoftCanaryReceiptSchema = z
  .object({
    schemaVersion: z.literal("inbox_zero_microsoft_canary_receipt.v1"),
    provider: z.literal("microsoft"),
    action: z.literal("draft_only"),
    accountId: opaqueCanaryValueSchema,
    threadId: opaqueCanaryValueSchema,
    sourceMessageId: opaqueCanaryValueSchema,
    draftId: opaqueCanaryValueSchema,
    idempotencyKey: opaqueCanaryValueSchema,
    graphReadbackStatus: z.literal("verified"),
    scopeIdentity: opaqueCanaryValueSchema.max(256),
    noSendCapability: z.literal("Mail.Send_absent"),
    idempotencyReplay: z.enum([
      "existing_draft_reconciled",
      "duplicate_prevented",
    ]),
    terminalState: z.literal("created_verified"),
    generatedAt: z.string().datetime(),
    executorRegistrationId: opaqueCanaryValueSchema.max(256),
    executorProvenanceSha256: sha256Schema,
    connectedIdentityEvidenceId: opaqueCanaryValueSchema,
    grantedScopesEvidenceId: opaqueCanaryValueSchema,
    noSendEvidenceId: opaqueCanaryValueSchema,
    graphReadbackEvidenceId: opaqueCanaryValueSchema,
    replayGraphReadbackEvidenceId: opaqueCanaryValueSchema,
  })
  .strict();

export type InboxZeroMicrosoftCanaryReceipt = z.infer<
  typeof inboxZeroMicrosoftCanaryReceiptSchema
>;

export type InboxZeroDraftProposalActionInput = {
  accountId: string;
  threadId: string;
  sourceMessageId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  confidence?: InboxZeroDraftProposal["confidence"];
  model?: string;
  generatedAt?: Date;
};

export type CoastlineOutlookDraftRequest = {
  action: "outlook_draft_create";
  provider: "microsoft";
  emailAccountId: string;
  threadId: string;
  messageId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  content: string;
  idempotencyKey: string;
  draftOnly: true;
  externalMessage: false;
};

export function buildDraftIdempotencyKey({
  accountId,
  threadId,
  sourceMessageId,
}: {
  accountId: string;
  threadId: string;
  sourceMessageId: string;
}): string {
  return ["inbox-zero", "draft", accountId, threadId, sourceMessageId]
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function createInboxZeroDraftProposal(
  input: Omit<InboxZeroDraftProposal, "schema_version" | "source" | "action">,
): InboxZeroDraftProposal {
  return inboxZeroDraftProposalSchema.parse({
    schema_version: INBOX_ZERO_DRAFT_PROPOSAL_VERSION,
    source: "inbox_zero",
    action: "draft_only",
    ...input,
  });
}

export function createInboxZeroDraftProposalFromAction({
  accountId,
  threadId,
  sourceMessageId,
  to,
  cc = [],
  bcc = [],
  subject,
  bodyText,
  confidence = "medium",
  model = "inbox-zero-action",
  generatedAt = new Date(),
}: InboxZeroDraftProposalActionInput): InboxZeroDraftProposal {
  return createInboxZeroDraftProposal({
    provider: "microsoft",
    account_id: accountId,
    thread_id: threadId,
    source_message_id: sourceMessageId,
    to,
    cc,
    bcc,
    subject,
    body_text: bodyText,
    confidence,
    model,
    idempotency_key: buildDraftIdempotencyKey({
      accountId,
      threadId,
      sourceMessageId,
    }),
    generated_at: generatedAt.toISOString(),
  });
}

export function parseInboxZeroDraftProposal(
  input: unknown,
): InboxZeroDraftProposal {
  const proposal = inboxZeroDraftProposalSchema.parse(input);
  const expectedKey = buildDraftIdempotencyKey({
    accountId: proposal.account_id,
    threadId: proposal.thread_id,
    sourceMessageId: proposal.source_message_id,
  });
  if (proposal.idempotency_key !== expectedKey) {
    throw new Error(
      "Inbox Zero proposal idempotency_key does not match its source IDs",
    );
  }
  return proposal;
}

export function createInboxZeroDraftReceipt({
  proposal,
  draftId,
}: {
  proposal: InboxZeroDraftProposal;
  draftId: string;
}): InboxZeroDraftReceipt {
  const validatedProposal = parseInboxZeroDraftProposal(proposal);

  return parseInboxZeroDraftReceipt({
    schemaVersion: "inbox_zero_draft_receipt.v1",
    provider: "microsoft",
    accountId: validatedProposal.account_id,
    threadId: validatedProposal.thread_id,
    sourceMessageId: validatedProposal.source_message_id,
    idempotencyKey: validatedProposal.idempotency_key,
    draftId,
    generatedAt: validatedProposal.generated_at,
    readBackAt: null,
    terminalState: "created_unverified",
  });
}

export function parseInboxZeroDraftReceipt(
  input: unknown,
): InboxZeroDraftReceipt {
  return inboxZeroDraftReceiptSchema.parse(input);
}

export function parseInboxZeroMicrosoftCanaryReceipt(
  input: unknown,
): InboxZeroMicrosoftCanaryReceipt {
  const receipt = inboxZeroMicrosoftCanaryReceiptSchema.parse(input);
  const expectedKey = buildDraftIdempotencyKey({
    accountId: receipt.accountId,
    threadId: receipt.threadId,
    sourceMessageId: receipt.sourceMessageId,
  });
  if (receipt.idempotencyKey !== expectedKey) {
    throw new Error(
      "Inbox Zero Microsoft canary idempotencyKey does not match its source IDs",
    );
  }
  return receipt;
}

export function toCoastlineOutlookDraftRequest(
  proposal: InboxZeroDraftProposal,
): CoastlineOutlookDraftRequest {
  const validated = parseInboxZeroDraftProposal(proposal);

  return {
    action: "outlook_draft_create",
    provider: "microsoft",
    emailAccountId: validated.account_id,
    threadId: validated.thread_id,
    messageId: validated.source_message_id,
    to: validated.to,
    cc: validated.cc,
    bcc: validated.bcc,
    subject: validated.subject,
    content: validated.body_text,
    idempotencyKey: validated.idempotency_key,
    draftOnly: true,
    externalMessage: false,
  };
}

export function assertDraftOnlyProposal(
  input: unknown,
): asserts input is InboxZeroDraftProposal {
  const proposal = parseInboxZeroDraftProposal(input);
  if (proposal.action !== "draft_only") {
    throw new Error("Inbox Zero proposals may only request draft_only");
  }
}
