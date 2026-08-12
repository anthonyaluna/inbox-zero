import { SafeError } from "@/utils/error";
import prisma from "@/utils/prisma";
import type { Logger } from "@/utils/logger";
import {
  isGoogleProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";
import { GoogleCalendarEventProvider } from "@/utils/calendar/providers/google-events";
import { MicrosoftCalendarEventProvider } from "@/utils/calendar/providers/microsoft-events";
import { getProviderAlignedLocationType } from "@/utils/booking/location";
import type { BookingLinkLocationType } from "@/generated/prisma/enums";
import type {
  CalendarEventAttendee,
  CalendarEvent,
  CalendarEventWriteResult,
} from "@/utils/calendar/event-types";

export type CreateCalendarEventInput = {
  attendees: CalendarEventAttendee[];
  description?: string;
  destinationCalendarId?: string | null;
  emailAccountId: string;
  endTime: Date;
  locationType: BookingLinkLocationType;
  locationValue?: string | null;
  preserveTimezone?: boolean;
  startTime: Date;
  timezone: string;
  title: string;
};

export type CreatedCalendarEvent = CalendarEventWriteResult & {
  provider: string;
  providerConnectionId: string;
};

export type CreatedCalendarEventWithReadback = CreatedCalendarEvent & {
  readback: CalendarEvent;
};

export async function createCalendarEvent({
  emailAccountId,
  destinationCalendarId,
  title,
  description,
  startTime,
  endTime,
  timezone,
  attendees,
  locationType,
  locationValue,
  preserveTimezone,
  logger,
}: CreateCalendarEventInput & {
  logger: Logger;
}): Promise<CreatedCalendarEvent> {
  const destination = await getWritableCalendar({
    emailAccountId,
    destinationCalendarId,
  });
  const provider = createWritableProvider({
    connection: destination.connection,
    emailAccountId,
    logger,
  });

  const createdEvent = await provider.createEvent({
    calendarId: destination.calendarId,
    title,
    description,
    startTime,
    endTime,
    timezone,
    attendees,
    locationType: getProviderAlignedLocationType({
      locationType,
      provider: destination.connection.provider,
    }),
    locationValue,
    preserveTimezone,
  });

  return {
    ...createdEvent,
    provider: destination.connection.provider,
    providerConnectionId: destination.connection.id,
  };
}

export async function createCalendarEventWithReadback(
  input: CreateCalendarEventInput & { logger: Logger },
): Promise<CreatedCalendarEventWithReadback> {
  const destination = await getWritableCalendar({
    emailAccountId: input.emailAccountId,
    destinationCalendarId: input.destinationCalendarId,
  });
  const provider = createWritableProvider({
    connection: destination.connection,
    emailAccountId: input.emailAccountId,
    logger: input.logger,
  });
  const created = await provider.createEvent({
    calendarId: destination.calendarId,
    title: input.title,
    description: input.description,
    startTime: input.startTime,
    endTime: input.endTime,
    timezone: input.timezone,
    attendees: input.attendees,
    locationType: getProviderAlignedLocationType({
      locationType: input.locationType,
      provider: destination.connection.provider,
    }),
    locationValue: input.locationValue,
  });
  if (!("getEvent" in provider) || typeof provider.getEvent !== "function") {
    throw new SafeError("Calendar provider does not support event readback");
  }
  const readback = await provider.getEvent({
    calendarId: destination.calendarId,
    eventId: created.id,
  });
  if (!readback) {
    throw new SafeError("Calendar event readback not found");
  }
  return {
    ...created,
    provider: destination.connection.provider,
    providerConnectionId: destination.connection.id,
    readback,
  };
}

export async function readCalendarEvent({
  providerConnectionId,
  providerCalendarId,
  providerEventId,
  emailAccountId,
  logger,
}: {
  providerConnectionId: string;
  providerCalendarId: string;
  providerEventId: string;
  emailAccountId: string;
  logger: Logger;
}): Promise<CalendarEvent | null> {
  const provider = await getWritableProviderForExistingEvent({
    providerConnectionId,
    providerCalendarId,
    emailAccountId,
    logger,
  });
  if (!("getEvent" in provider) || typeof provider.getEvent !== "function") {
    throw new SafeError("Calendar provider does not support event readback");
  }
  return provider.getEvent({
    calendarId: providerCalendarId,
    eventId: providerEventId,
  });
}

export async function updateCalendarEvent({
  providerConnectionId,
  providerCalendarId,
  providerEventId,
  emailAccountId,
  startTime,
  endTime,
  timezone,
  logger,
}: {
  providerConnectionId: string;
  providerCalendarId: string;
  providerEventId: string;
  emailAccountId: string;
  startTime: Date;
  endTime: Date;
  timezone: string;
  logger: Logger;
}) {
  const writableProvider = await getWritableProviderForExistingEvent({
    providerConnectionId,
    providerCalendarId,
    emailAccountId,
    logger,
  });

  await writableProvider.updateEvent({
    calendarId: providerCalendarId,
    eventId: providerEventId,
    startTime,
    endTime,
    timezone,
  });
}

export async function cancelCalendarEvent({
  providerConnectionId,
  providerCalendarId,
  providerEventId,
  emailAccountId,
  logger,
}: {
  providerConnectionId: string;
  providerCalendarId: string;
  providerEventId: string;
  emailAccountId: string;
  logger: Logger;
}) {
  const writableProvider = await getWritableProviderForExistingEvent({
    providerConnectionId,
    providerCalendarId,
    emailAccountId,
    logger,
  });

  await writableProvider.cancelEvent({
    calendarId: providerCalendarId,
    eventId: providerEventId,
  });
}

async function getWritableProviderForExistingEvent({
  providerConnectionId,
  providerCalendarId,
  emailAccountId,
  logger,
}: {
  providerConnectionId: string;
  providerCalendarId: string;
  emailAccountId: string;
  logger: Logger;
}) {
  // Look up by connection id (unique) instead of (emailAccountId, provider)
  // — a host can have multiple connections of the same provider, and
  // calendarIds like "primary" recur across them.
  const connection = await prisma.calendarConnection.findFirst({
    where: { id: providerConnectionId, emailAccountId, isConnected: true },
    select: {
      id: true,
      provider: true,
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
      calendars: {
        where: { calendarId: providerCalendarId },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!connection) {
    throw new SafeError("Calendar connection not found");
  }
  if (connection.calendars.length === 0) {
    throw new SafeError("Destination calendar not found");
  }

  return createWritableProvider({
    connection,
    emailAccountId,
    logger,
  });
}

async function getWritableCalendar({
  emailAccountId,
  destinationCalendarId,
}: {
  emailAccountId: string;
  destinationCalendarId?: string | null;
}) {
  // Without an explicit destination, prefer the primary calendar (via
  // orderBy) but accept any enabled calendar — accounts synced before
  // Microsoft primary tracking have no primary row.
  const where = destinationCalendarId ? { id: destinationCalendarId } : {};
  // Availability scans only consider enabled calendars, so writing to a
  // disabled one would silently bypass conflict detection.
  const calendar = await prisma.calendar.findFirst({
    where: {
      ...where,
      isEnabled: true,
      connection: {
        emailAccountId,
        isConnected: true,
      },
    },
    orderBy: [{ primary: "desc" }, { createdAt: "asc" }],
    select: {
      calendarId: true,
      connection: {
        select: {
          id: true,
          provider: true,
          accessToken: true,
          refreshToken: true,
          expiresAt: true,
        },
      },
    },
  });

  if (!calendar) {
    throw new SafeError("Destination calendar not found");
  }

  return calendar;
}

function createWritableProvider({
  connection,
  emailAccountId,
  logger,
}: {
  connection: {
    accessToken: string | null;
    expiresAt: Date | null;
    id: string;
    provider: string;
    refreshToken: string | null;
  };
  emailAccountId: string;
  logger: Logger;
}) {
  const providerParams = {
    accessToken: connection.accessToken,
    connectionId: connection.id,
    refreshToken: connection.refreshToken,
    expiresAt: connection.expiresAt?.getTime() ?? null,
    emailAccountId,
  };

  if (isGoogleProvider(connection.provider)) {
    return new GoogleCalendarEventProvider(providerParams, logger);
  }

  if (isMicrosoftProvider(connection.provider)) {
    return new MicrosoftCalendarEventProvider(providerParams, logger);
  }

  throw new SafeError("Unsupported calendar provider");
}
