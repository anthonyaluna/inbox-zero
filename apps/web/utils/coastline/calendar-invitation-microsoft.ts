import { BookingLinkLocationType } from "@/generated/prisma/enums";
import {
  createCalendarEvent,
  readCalendarEvent,
} from "@/utils/calendar/event-writer";
import type { Logger } from "@/utils/logger";
import type {
  CoastlineCalendarInvitationProposal,
  CoastlineCalendarInvitationProvider,
} from "@/utils/coastline/calendar-invitation";
import { executeCoastlineCalendarInvitation } from "@/utils/coastline/calendar-invitation";
import { coastlineCalendarInvitationReservations } from "@/utils/coastline/calendar-invitation-reservation";

export async function createAndVerifyMicrosoftCalendarInvitation({
  proposal,
  destinationCalendarId,
  logger,
}: {
  proposal: CoastlineCalendarInvitationProposal;
  destinationCalendarId?: string | null;
  logger: Logger;
}) {
  return executeCoastlineCalendarInvitation({
    proposal,
    provider: createMicrosoftCalendarInvitationProvider({
      emailAccountId: proposal.accountId,
      destinationCalendarId,
      logger,
    }),
    reservations: coastlineCalendarInvitationReservations,
  });
}

export function createMicrosoftCalendarInvitationProvider({
  emailAccountId,
  destinationCalendarId,
  logger,
}: {
  emailAccountId: string;
  destinationCalendarId?: string | null;
  logger: Logger;
}): CoastlineCalendarInvitationProvider {
  return {
    async createAttendeeEvent(proposal: CoastlineCalendarInvitationProposal) {
      if (proposal.accountId !== emailAccountId) {
        throw Object.assign(
          new Error("Calendar invitation account does not match the bound mailbox"),
          { code: "COASTLINE_CALENDAR_ACCOUNT_MISMATCH" },
        );
      }
      const created = await createCalendarEvent({
        attendees: proposal.attendees,
        destinationCalendarId,
        emailAccountId,
        endTime: new Date(proposal.endAt),
        locationType: BookingLinkLocationType.CUSTOM,
        locationValue: proposal.location,
        logger,
        preserveTimezone: true,
        startTime: new Date(proposal.startAt),
        timezone: proposal.timezone,
        title: proposal.title,
      });
      if (created.provider !== "microsoft") {
        throw Object.assign(
          new Error("Coastline calendar invitations require Microsoft"),
          { code: "COASTLINE_CALENDAR_PROVIDER_UNAVAILABLE" },
        );
      }
      return {
        eventId: created.id,
        providerCalendarId: created.providerCalendarId,
        providerConnectionId: created.providerConnectionId,
      };
    },
    async readEvent({
      eventId,
      providerCalendarId,
      providerConnectionId,
    }) {
      const event = await readCalendarEvent({
        providerConnectionId,
        providerCalendarId,
        providerEventId: eventId,
        emailAccountId,
        logger,
      });
      return event
        ? {
            id: event.id,
            title: event.title,
            startAt: event.startTime.toISOString(),
            endAt: event.endTime.toISOString(),
            timezone: event.timezone ?? "",
            location: event.location ?? "",
            attendees: event.attendees.map(({ email, name }) => ({ email, name })),
          }
        : null;
    },
  };
}
