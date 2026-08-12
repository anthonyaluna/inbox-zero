import { z } from "zod";
import type { Logger } from "@/utils/logger";
import {
  coastlineCalendarInvitationProposalSchema,
  createCoastlineCalendarInvitationProposal,
  parseCoastlineCalendarInvitationReceipt,
  type CoastlineCalendarInvitationProposalInput,
} from "@/utils/coastline/calendar-invitation";
import { createAndVerifyMicrosoftCalendarInvitation } from "@/utils/coastline/calendar-invitation-microsoft";

export const COASTLINE_REGISTERED_ACTIONS = [
  "CREATE_CALENDAR_EVENT",
] as const;

const coastlineCalendarEventActionSchema = z
  .object({
    action: z.literal("CREATE_CALENDAR_EVENT"),
    proposal: coastlineCalendarInvitationProposalSchema,
    destinationCalendarId: z.string().min(1).nullable().optional(),
  })
  .strict();

export type CoastlineCalendarEventAction = z.infer<
  typeof coastlineCalendarEventActionSchema
>;

export type CoastlineCalendarEventActionInput =
  CoastlineCalendarInvitationProposalInput & {
    destinationCalendarId?: string | null;
  };

export function createCalendarEventAction(
  input: CoastlineCalendarEventActionInput,
): CoastlineCalendarEventAction {
  const { destinationCalendarId, ...proposalInput } = input;
  return coastlineCalendarEventActionSchema.parse({
    action: "CREATE_CALENDAR_EVENT",
    proposal: createCoastlineCalendarInvitationProposal(proposalInput),
    destinationCalendarId,
  });
}

export async function runCoastlineAction({
  action: rawAction,
  logger,
}: {
  action: unknown;
  logger: Logger;
}): Promise<{
  action: "CREATE_CALENDAR_EVENT";
  proposal: CoastlineCalendarEventAction["proposal"];
  receipt: ReturnType<typeof parseCoastlineCalendarInvitationReceipt>;
}> {
  const action = coastlineCalendarEventActionSchema.parse(rawAction);
  return dispatchClearCoastlineCalendarProposal({
    proposal: action.proposal,
    destinationCalendarId: action.destinationCalendarId,
    logger,
  });
}

export async function dispatchClearCoastlineCalendarProposal({
  proposal,
  destinationCalendarId,
  logger,
}: {
  proposal: CoastlineCalendarEventAction["proposal"];
  destinationCalendarId?: string | null;
  logger: Logger;
}): Promise<{
  action: "CREATE_CALENDAR_EVENT";
  proposal: CoastlineCalendarEventAction["proposal"];
  receipt: ReturnType<typeof parseCoastlineCalendarInvitationReceipt>;
}> {
  if (proposal.schedulingStatus !== "clear") {
    throw Object.assign(
      new Error("Calendar creation requires an unambiguous scheduling request"),
      { code: "COASTLINE_CALENDAR_SCHEDULING_UNCLEAR" },
    );
  }

  const result = await createAndVerifyMicrosoftCalendarInvitation({
    proposal,
    destinationCalendarId,
    logger,
  });
  const receipt = parseCoastlineCalendarInvitationReceipt(result.receipt);
  if (
    receipt.accountId !== proposal.accountId ||
    receipt.threadId !== proposal.threadId ||
    receipt.sourceMessageId !== proposal.sourceMessageId ||
    receipt.idempotencyKey !== proposal.idempotencyKey
  ) {
    throw Object.assign(
      new Error("Calendar receipt does not match the executing action"),
      { code: "COASTLINE_CALENDAR_RECEIPT_CONTEXT_MISMATCH" },
    );
  }

  return {
    action: "CREATE_CALENDAR_EVENT",
    proposal,
    receipt,
  };
}
