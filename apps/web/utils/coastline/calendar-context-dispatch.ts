import type { Logger } from "@/utils/logger";
import type { ParsedMessage } from "@/utils/types";
import { dispatchClearCoastlineCalendarProposal } from "@/utils/coastline/action-router";
import {
  classifyCalendarContext,
  type CalendarContextPacketV1,
  type MatterContextPacketV1,
} from "@/utils/coastline/calendar-context-broker";
import type { CoastlineCalendarInvitationProposal } from "@/utils/coastline/calendar-invitation";

type CalendarClassification = Pick<
  CalendarContextPacketV1,
  "status" | "reason" | "proposal"
>;

type CalendarAccount = {
  id: string;
  email: string;
  timezone?: string | null;
};

type CalendarDispatch = (input: {
  proposal: CoastlineCalendarInvitationProposal;
  logger: Logger;
}) => Promise<{ receipt: { eventId: string } }>;

export async function dispatchCalendarForMessage({
  clientName,
  message,
  account,
  logger,
  matterContext,
  classify = classifyCalendarContext,
  dispatch = dispatchClearCoastlineCalendarProposal,
}: {
  clientName: string;
  message: ParsedMessage;
  account: CalendarAccount;
  logger: Logger;
  classify?: (input: {
    message: ParsedMessage;
    accountId: string;
    accountEmail: string;
    defaultTimezone?: string | null;
    matterContext?: MatterContextPacketV1;
  }) => CalendarClassification;
  dispatch?: CalendarDispatch;
  matterContext?: MatterContextPacketV1;
}): Promise<
  | { status: "not_microsoft" | "not_scheduling" | "ambiguous" | "conflicting"; reason?: string }
  | { status: "dispatched"; eventId: string }
> {
  if (clientName !== "microsoft") return { status: "not_microsoft" };

  const context = classify({
    message,
    accountId: account.id,
    accountEmail: account.email,
    defaultTimezone: account.timezone,
    matterContext,
  });
  if (context.status !== "clear" || !context.proposal) {
    return { status: context.status, reason: context.reason };
  }

  const result = await dispatch({ proposal: context.proposal, logger });
  return { status: "dispatched", eventId: result.receipt.eventId };
}
