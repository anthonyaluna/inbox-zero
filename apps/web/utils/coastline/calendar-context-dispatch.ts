import type { Logger } from "@/utils/logger";
import type { ParsedMessage } from "@/utils/types";
import { dispatchClearCoastlineCalendarProposal } from "@/utils/coastline/action-router";
import {
  classifyCalendarContext,
  type CalendarContextPacketV1,
  type MatterContextPacketV1,
} from "@/utils/coastline/calendar-context-broker";
import type { CoastlineCalendarInvitationProposal } from "@/utils/coastline/calendar-invitation";
import {
  loadCalendarMatterContext,
  type CalendarMatterContextLoader,
} from "@/utils/coastline/calendar-matter-context-loader";

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
  matterContextLoader = loadCalendarMatterContext,
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
  matterContextLoader?: CalendarMatterContextLoader;
}): Promise<
  | {
      status: "not_microsoft" | "not_scheduling" | "ambiguous" | "conflicting";
      reason?: string;
    }
  | { status: "dispatched"; eventId: string }
> {
  if (clientName !== "microsoft") return { status: "not_microsoft" };

  const loadedMatterContext = matterContext
    ? { status: "available" as const, context: matterContext }
    : await matterContextLoader({
        accountId: account.id,
        threadId: message.threadId,
        sourceMessageId: message.id,
        subject: message.headers?.subject ?? message.subject ?? "",
      });
  const context = classify({
    message,
    accountId: account.id,
    accountEmail: account.email,
    defaultTimezone: account.timezone,
    matterContext:
      loadedMatterContext.status === "available"
        ? loadedMatterContext.context
        : undefined,
  });
  if (context.status !== "clear") {
    return { status: context.status, reason: context.reason };
  }
  if (!context.proposal) {
    return { status: "ambiguous", reason: "calendar_proposal_missing" };
  }

  const result = await dispatch({ proposal: context.proposal, logger });
  return { status: "dispatched", eventId: result.receipt.eventId };
}
