import { createHash } from "node:crypto";
import { z } from "zod";

export const COASTLINE_CALENDAR_INVITATION_VERSION =
  "inbox_zero_calendar_invitation.v1" as const;

const emailSchema = z.string().email();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const invitationAttendeeSchema = z
  .object({
    email: emailSchema,
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const coastlineCalendarInvitationProposalSchema = z
  .object({
    schemaVersion: z.literal(COASTLINE_CALENDAR_INVITATION_VERSION),
    action: z.literal("create_attendee_event"),
    provider: z.literal("microsoft"),
    accountId: z.string().min(1),
    threadId: z.string().min(1),
    sourceMessageId: z.string().min(1),
    title: z.string().trim().min(1).max(255),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    timezone: z.string().trim().min(1).max(100),
    location: z.string().trim().min(1).max(500),
    attendees: z.array(invitationAttendeeSchema).min(1).max(50),
    schedulingStatus: z.enum(["clear", "ambiguous", "conflicting"]),
    idempotencyKey: z.string().min(1),
  })
  .strict();

export type CoastlineCalendarInvitationProposal = z.infer<
  typeof coastlineCalendarInvitationProposalSchema
>;

export type CoastlineCalendarInvitationProposalInput = Omit<
  CoastlineCalendarInvitationProposal,
  "schemaVersion" | "action" | "provider" | "idempotencyKey"
>;

type CalendarReadback = {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  timezone: string;
  location: string;
  attendees: Array<{ email: string; name?: string }>;
};

export type CoastlineCalendarInvitationProvider = {
  createAttendeeEvent: (
    proposal: CoastlineCalendarInvitationProposal,
  ) => Promise<{
    eventId: string;
    providerCalendarId: string;
    providerConnectionId: string;
  }>;
  readEvent: (input: {
    eventId: string;
    providerCalendarId: string;
    providerConnectionId: string;
  }) => Promise<CalendarReadback | null>;
};

export type CoastlineCalendarInvitationReservationStore = {
  reserve: (input: {
    proposal: CoastlineCalendarInvitationProposal;
    proposalFingerprint: string;
  }) => Promise<
    | { reservationId: string; state: "create" }
    | {
        reservationId: string;
        state: "existing";
        eventId: string;
        providerCalendarId: string;
        providerConnectionId: string;
      }
  >;
  complete: (input: {
    reservationId: string;
    eventId: string;
    providerCalendarId: string;
    providerConnectionId: string;
    terminalState: "created_verified";
  }) => Promise<void>;
  fail: (input: {
    reservationId: string;
    recoverableErrorCode: "COASTLINE_CALENDAR_READBACK_FAILED";
  }) => Promise<void>;
};

export type CoastlineCalendarInvitationReceipt = {
  schemaVersion: "inbox_zero_calendar_invitation_receipt.v1";
  provider: "microsoft";
  accountId: string;
  threadId: string;
  sourceMessageId: string;
  idempotencyKey: string;
  eventId: string;
  providerCalendarId: string;
  providerConnectionId: string;
  titleSha256: string;
  attendeeSetSha256: string;
  attendeeCount: number;
  locationSha256: string;
  timezone: string;
  durationMinutes: number;
  readBackAt: string;
  terminalState: "created_verified";
};

export function buildCalendarInvitationIdempotencyKey({
  accountId,
  threadId,
  sourceMessageId,
}: {
  accountId: string;
  threadId: string;
  sourceMessageId: string;
}) {
  return ["inbox-zero", "calendar", accountId, threadId, sourceMessageId]
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function createCoastlineCalendarInvitationProposal(
  input: CoastlineCalendarInvitationProposalInput,
): CoastlineCalendarInvitationProposal {
  const proposal = coastlineCalendarInvitationProposalSchema.parse({
    schemaVersion: COASTLINE_CALENDAR_INVITATION_VERSION,
    action: "create_attendee_event",
    provider: "microsoft",
    ...input,
    idempotencyKey: buildCalendarInvitationIdempotencyKey(input),
  });
  validateProposal(proposal);
  return proposal;
}

export async function executeCoastlineCalendarInvitation({
  proposal: rawProposal,
  provider,
  reservations,
}: {
  proposal: CoastlineCalendarInvitationProposal;
  provider: CoastlineCalendarInvitationProvider;
  reservations: CoastlineCalendarInvitationReservationStore;
}): Promise<{ receipt: CoastlineCalendarInvitationReceipt }> {
  const proposal = coastlineCalendarInvitationProposalSchema.parse(rawProposal);
  validateProposal(proposal);
  if (proposal.schedulingStatus !== "clear") {
    throw coastlineCalendarError(
      "COASTLINE_CALENDAR_SCHEDULING_UNCLEAR",
      "Calendar creation requires an unambiguous scheduling request",
    );
  }

  const reservation = await reservations.reserve({
    proposal,
    proposalFingerprint: fingerprintCalendarInvitation(proposal),
  });
  const created =
    reservation.state === "create"
      ? await provider.createAttendeeEvent(proposal)
      : reservation;
  const readback = await provider.readEvent({
    eventId: created.eventId,
    providerCalendarId: created.providerCalendarId,
    providerConnectionId: created.providerConnectionId,
  });

  if (!matchesCalendarInvitation({ proposal, readback, eventId: created.eventId })) {
    await reservations.fail({
      reservationId: reservation.reservationId,
      recoverableErrorCode: "COASTLINE_CALENDAR_READBACK_FAILED",
    });
    throw coastlineCalendarError(
      "COASTLINE_CALENDAR_READBACK_FAILED",
      "Calendar provider readback did not match the approved invitation",
    );
  }

  await reservations.complete({
    reservationId: reservation.reservationId,
    eventId: created.eventId,
    providerCalendarId: created.providerCalendarId,
    providerConnectionId: created.providerConnectionId,
    terminalState: "created_verified",
  });

  return {
    receipt: {
      schemaVersion: "inbox_zero_calendar_invitation_receipt.v1",
      provider: "microsoft",
      accountId: proposal.accountId,
      threadId: proposal.threadId,
      sourceMessageId: proposal.sourceMessageId,
      idempotencyKey: proposal.idempotencyKey,
      eventId: created.eventId,
      providerCalendarId: created.providerCalendarId,
      providerConnectionId: created.providerConnectionId,
      titleSha256: hash(proposal.title),
      attendeeSetSha256: attendeeSetHash(proposal.attendees),
      attendeeCount: proposal.attendees.length,
      locationSha256: hash(proposal.location),
      timezone: proposal.timezone,
      durationMinutes: durationMinutes(proposal),
      readBackAt: new Date().toISOString(),
      terminalState: "created_verified",
    },
  };
}

export function fingerprintCalendarInvitation(
  proposal: CoastlineCalendarInvitationProposal,
) {
  return hash(
    JSON.stringify({
      accountId: proposal.accountId,
      threadId: proposal.threadId,
      sourceMessageId: proposal.sourceMessageId,
      title: proposal.title,
      startAt: proposal.startAt,
      endAt: proposal.endAt,
      timezone: proposal.timezone,
      location: proposal.location,
      attendees: normalizeAttendees(proposal.attendees),
    }),
  );
}

function validateProposal(proposal: CoastlineCalendarInvitationProposal) {
  const expectedKey = buildCalendarInvitationIdempotencyKey(proposal);
  if (proposal.idempotencyKey !== expectedKey) {
    throw coastlineCalendarError(
      "COASTLINE_CALENDAR_IDEMPOTENCY_INVALID",
      "Calendar invitation idempotency key does not match source IDs",
    );
  }
  if (new Date(proposal.endAt) <= new Date(proposal.startAt)) {
    throw coastlineCalendarError(
      "COASTLINE_CALENDAR_DURATION_INVALID",
      "Calendar invitation end time must follow start time",
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: proposal.timezone });
  } catch {
    throw coastlineCalendarError(
      "COASTLINE_CALENDAR_TIMEZONE_INVALID",
      "Calendar invitation requires an IANA timezone",
    );
  }
  const attendees = normalizeAttendees(proposal.attendees);
  if (new Set(attendees).size !== attendees.length) {
    throw coastlineCalendarError(
      "COASTLINE_CALENDAR_ATTENDEES_INVALID",
      "Calendar invitation attendees must be unique",
    );
  }
}

function matchesCalendarInvitation({
  proposal,
  readback,
  eventId,
}: {
  proposal: CoastlineCalendarInvitationProposal;
  readback: CalendarReadback | null;
  eventId: string;
}) {
  return Boolean(
    readback &&
      readback.id === eventId &&
      readback.title === proposal.title &&
      readback.startAt === proposal.startAt &&
      readback.endAt === proposal.endAt &&
      readback.location === proposal.location &&
      attendeeSetHash(readback.attendees) === attendeeSetHash(proposal.attendees),
  );
}

function attendeeSetHash(attendees: Array<{ email: string }>) {
  return hash(normalizeAttendees(attendees).join("\n"));
}

function normalizeAttendees(attendees: Array<{ email: string }>) {
  return attendees.map((attendee) => attendee.email.trim().toLowerCase()).sort();
}

function durationMinutes(proposal: CoastlineCalendarInvitationProposal) {
  return (new Date(proposal.endAt).getTime() - new Date(proposal.startAt).getTime()) / 60000;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function coastlineCalendarError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export function parseCoastlineCalendarInvitationReceipt(
  receipt: CoastlineCalendarInvitationReceipt,
) {
  return z
    .object({
      schemaVersion: z.literal("inbox_zero_calendar_invitation_receipt.v1"),
      provider: z.literal("microsoft"),
      accountId: z.string().min(1),
      threadId: z.string().min(1),
      sourceMessageId: z.string().min(1),
      idempotencyKey: z.string().min(1),
      eventId: z.string().min(1),
      providerCalendarId: z.string().min(1),
      providerConnectionId: z.string().min(1),
      titleSha256: sha256Schema,
      attendeeSetSha256: sha256Schema,
      attendeeCount: z.number().int().positive(),
      locationSha256: sha256Schema,
      timezone: z.string().min(1),
      durationMinutes: z.number().positive(),
      readBackAt: z.string().datetime(),
      terminalState: z.literal("created_verified"),
    })
    .strict()
    .parse(receipt);
}
