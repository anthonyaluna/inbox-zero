import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/utils/prisma";
import {
  createSameDayResponseCase,
  sameDayResponseCaseSchema,
  transitionSameDayResponseCase,
  type SameDayResponseCaseV1,
} from "@/utils/coastline/same-day-response-case";
import type { ParsedMessage } from "@/utils/types";
import { extractEmailAddress } from "@/utils/email";

export type SameDayResponseCaseStore = {
  upsert(responseCase: SameDayResponseCaseV1): Promise<SameDayResponseCaseV1>;
  findUnique(input: {
    accountId: string;
    matterId: string;
  }): Promise<SameDayResponseCaseV1 | null>;
  findMany?(input: { accountId: string }): Promise<SameDayResponseCaseV1[]>;
};

export async function persistSameDayResponseCase(
  store: SameDayResponseCaseStore,
  responseCase: SameDayResponseCaseV1,
) {
  const validated = sameDayResponseCaseSchema.parse(responseCase);
  return store.upsert(validated);
}

export async function readSameDayResponseCase(
  store: SameDayResponseCaseStore,
  input: { accountId: string; matterId: string },
) {
  return store.findUnique(input);
}

export async function listSameDayResponseCases(
  store: SameDayResponseCaseStore,
  input: { accountId: string },
) {
  if (!store.findMany) return [];
  return store.findMany(input);
}

export async function ensureSameDayResponseCaseForMessage({
  store,
  accountId,
  accountEmail,
  timezone,
  holidays,
  message,
  accountableOwner = "Coastline Equity",
}: {
  store: SameDayResponseCaseStore;
  accountId: string;
  accountEmail: string;
  timezone?: string | null;
  holidays?: readonly string[];
  message: ParsedMessage;
  accountableOwner?: string;
}) {
  const sender = message.headers.from.trim();
  const senderAddress = extractEmailAddress(sender)?.toLowerCase();
  if (!senderAddress || senderAddress === accountEmail.toLowerCase()) {
    return null;
  }
  if (message.headers["list-unsubscribe"]) return null;

  const receivedAt = new Date(
    message.internalDate ?? message.date ?? message.headers.date,
  ).toISOString();
  const responseCase = createSameDayResponseCase({
    accountId,
    sourceMessageId: message.id,
    sourceThreadId: message.threadId,
    sender,
    recipients: {
      to: splitRecipients(message.headers.to),
      cc: splitRecipients(message.headers.cc),
      bcc: splitRecipients(message.headers.bcc),
    },
    matterType: "inbound_message",
    audience: "other",
    receivedAt,
    accountableOwner,
    nextAction:
      "Draft a substantive same-day response or verified status update",
    sourceEvidence: [
      {
        sourceSystem: "outlook",
        sourceId: message.id,
        observedAt: receivedAt,
        sourceHash: null,
      },
    ],
    timezone: timezone ?? "America/Los_Angeles",
    holidays,
  });

  const existing = await store.findUnique({
    accountId,
    matterId: responseCase.matterId,
  });
  return existing ?? persistSameDayResponseCase(store, responseCase);
}

export async function markSameDayResponseCaseDrafted({
  store,
  accountId,
  sourceThreadId,
  sourceMessageId,
  draftId,
}: {
  store: SameDayResponseCaseStore;
  accountId: string;
  sourceThreadId: string;
  sourceMessageId: string;
  draftId: string;
}) {
  const matterId = [
    "same-day-response",
    accountId,
    sourceThreadId,
    sourceMessageId,
  ]
    .map((value) => encodeURIComponent(value))
    .join("/");
  const existing = await store.findUnique({ accountId, matterId });
  if (!existing || existing.state === "drafted") return existing;
  const drafted = transitionSameDayResponseCase(existing, "drafted", {
    draftId,
    nextAction: "Reconcile the draft readback and track the next response step",
  });
  return persistSameDayResponseCase(store, drafted);
}

export async function markSameDayResponseCaseResponded({
  store,
  accountId,
  sourceThreadId,
  sourceMessageId,
  responseMessageId,
  nextAction = "Track outstanding commitments and the next response step",
  respondedAt = new Date().toISOString(),
}: {
  store: SameDayResponseCaseStore;
  accountId: string;
  sourceThreadId: string;
  sourceMessageId: string;
  responseMessageId: string;
  nextAction?: string;
  respondedAt?: string;
}) {
  const existing = await requireSameDayResponseCase(store, {
    accountId,
    sourceThreadId,
    sourceMessageId,
  });
  if (existing.state === "responded") return existing;
  const responded = transitionSameDayResponseCase(existing, "responded", {
    responseMessageId,
    respondedAt,
    nextAction,
  });
  return persistSameDayResponseCase(store, responded);
}

export async function markSameDayResponseCaseAwaitingAction({
  store,
  accountId,
  sourceThreadId,
  sourceMessageId,
  nextAction,
  nextUpdateAt,
}: {
  store: SameDayResponseCaseStore;
  accountId: string;
  sourceThreadId: string;
  sourceMessageId: string;
  nextAction: string;
  nextUpdateAt: string;
}) {
  const existing = await requireSameDayResponseCase(store, {
    accountId,
    sourceThreadId,
    sourceMessageId,
  });
  if (existing.state === "awaiting_action") return existing;
  const awaitingAction = transitionSameDayResponseCase(
    existing,
    "awaiting_action",
    { nextAction, nextUpdateAt },
  );
  return persistSameDayResponseCase(store, awaitingAction);
}

export async function markSameDayResponseCaseUpdateDue({
  store,
  accountId,
  sourceThreadId,
  sourceMessageId,
  nextAction,
  at = new Date().toISOString(),
}: {
  store: SameDayResponseCaseStore;
  accountId: string;
  sourceThreadId: string;
  sourceMessageId: string;
  nextAction: string;
  at?: string;
}) {
  const existing = await requireSameDayResponseCase(store, {
    accountId,
    sourceThreadId,
    sourceMessageId,
  });
  if (existing.state === "update_due") return existing;
  if (existing.nextUpdateAt && new Date(at) < new Date(existing.nextUpdateAt)) {
    throw new Error("Same-Day Response update is not due");
  }
  const updateDue = transitionSameDayResponseCase(existing, "update_due", {
    nextAction,
  });
  return persistSameDayResponseCase(store, updateDue);
}

export async function markSameDayResponseCaseCompleted({
  store,
  accountId,
  sourceThreadId,
  sourceMessageId,
  terminalEvidence,
}: {
  store: SameDayResponseCaseStore;
  accountId: string;
  sourceThreadId: string;
  sourceMessageId: string;
  terminalEvidence: Record<string, string>;
}) {
  const existing = await requireSameDayResponseCase(store, {
    accountId,
    sourceThreadId,
    sourceMessageId,
  });
  if (existing.state === "completed" || existing.state === "verified_closed") {
    return existing;
  }
  assertTerminalEvidence(terminalEvidence);
  const completed = transitionSameDayResponseCase(existing, "completed", {
    terminalEvidence,
    nextAction: "Verify the completion evidence and close the matter",
  });
  return persistSameDayResponseCase(store, completed);
}

export async function markSameDayResponseCaseVerifiedClosed({
  store,
  accountId,
  sourceThreadId,
  sourceMessageId,
}: {
  store: SameDayResponseCaseStore;
  accountId: string;
  sourceThreadId: string;
  sourceMessageId: string;
}) {
  const existing = await requireSameDayResponseCase(store, {
    accountId,
    sourceThreadId,
    sourceMessageId,
  });
  if (existing.state === "verified_closed") return existing;
  if (existing.state !== "completed") {
    throw new Error(
      "Same-Day Response matter must be completed before verified closure",
    );
  }
  if (!existing.terminalEvidence) {
    throw new Error("Same-Day Response matter requires terminal evidence");
  }
  assertTerminalEvidence(existing.terminalEvidence);
  const closed = transitionSameDayResponseCase(existing, "verified_closed", {
    nextAction: "No further action",
  });
  return persistSameDayResponseCase(store, closed);
}

async function requireSameDayResponseCase(
  store: SameDayResponseCaseStore,
  input: {
    accountId: string;
    sourceThreadId: string;
    sourceMessageId: string;
  },
) {
  const matterId = getMatterId(
    input.accountId,
    input.sourceThreadId,
    input.sourceMessageId,
  );
  const existing = await store.findUnique({
    accountId: input.accountId,
    matterId,
  });
  if (!existing) {
    throw new Error(`Same-Day Response matter not found: ${matterId}`);
  }
  return existing;
}

function getMatterId(
  accountId: string,
  sourceThreadId: string,
  sourceMessageId: string,
) {
  return ["same-day-response", accountId, sourceThreadId, sourceMessageId]
    .map((value) => encodeURIComponent(value))
    .join("/");
}

function assertTerminalEvidence(evidence: Record<string, string>) {
  if (
    !Object.entries(evidence).some(
      ([key, value]) => key.trim().length > 0 && value.trim().length > 0,
    )
  ) {
    throw new Error("Same-Day Response matter requires terminal evidence");
  }
}

export function createPrismaSameDayResponseCaseStore(
  client = prisma,
): SameDayResponseCaseStore {
  return {
    async upsert(responseCase) {
      const row = await client.sameDayResponseCase.upsert({
        where: {
          emailAccountId_matterId: {
            emailAccountId: responseCase.accountId,
            matterId: responseCase.matterId,
          },
        },
        create: toPersistenceInput(responseCase),
        update: toPersistenceInput(responseCase),
      });
      return sameDayResponseCaseSchema.parse(row.contract);
    },
    async findUnique({ accountId, matterId }) {
      const row = await client.sameDayResponseCase.findUnique({
        where: {
          emailAccountId_matterId: {
            emailAccountId: accountId,
            matterId,
          },
        },
        select: { contract: true },
      });
      return row ? sameDayResponseCaseSchema.parse(row.contract) : null;
    },
    async findMany({ accountId }) {
      const rows = await client.sameDayResponseCase.findMany({
        where: { emailAccountId: accountId },
        orderBy: { responseDeadlineAt: "asc" },
        select: { contract: true },
      });
      return rows.map((row) => sameDayResponseCaseSchema.parse(row.contract));
    },
  };
}

function toPersistenceInput(responseCase: SameDayResponseCaseV1) {
  return {
    matterId: responseCase.matterId,
    schemaVersion: responseCase.schemaVersion,
    sourceMessageId: responseCase.sourceMessageId,
    sourceThreadId: responseCase.sourceThreadId,
    state: responseCase.state,
    responseDeadlineAt: new Date(responseCase.responseDeadlineAt),
    nextUpdateAt: responseCase.nextUpdateAt
      ? new Date(responseCase.nextUpdateAt)
      : null,
    accountableOwner: responseCase.accountableOwner,
    nextAction: responseCase.nextAction,
    draftId: responseCase.draftId,
    followUpId: responseCase.followUpId,
    responseMessageId: responseCase.responseMessageId,
    respondedAt: responseCase.respondedAt
      ? new Date(responseCase.respondedAt)
      : null,
    contract: responseCase as unknown as Prisma.InputJsonValue,
    emailAccount: { connect: { id: responseCase.accountId } },
  };
}

function splitRecipients(value: string | undefined) {
  return (value ?? "")
    .split(/[;,]/)
    .map((recipient) => recipient.trim())
    .filter(Boolean);
}
