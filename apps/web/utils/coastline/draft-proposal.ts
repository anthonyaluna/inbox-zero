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
