import { TZDate } from "@date-fns/tz";
import {
  extractEmailAddress,
  extractNameFromEmail,
  splitRecipientList,
} from "@/utils/email";
import type { ParsedMessage } from "@/utils/types";
import { isCalendarInvite } from "@/utils/parse/calender-event";
import {
  createCoastlineCalendarInvitationProposal,
  type CoastlineCalendarInvitationProposal,
} from "@/utils/coastline/calendar-invitation";

const IANA_TIMEZONE_RE =
  /\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)?\b/;
const TIMEZONE_ALIAS: Record<string, string> = {
  CT: "America/Chicago",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  ET: "America/New_York",
  EST: "America/New_York",
  EDT: "America/New_York",
  MT: "America/Denver",
  MST: "America/Denver",
  MDT: "America/Denver",
  PT: "America/Los_Angeles",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  UTC: "UTC",
};

const SCHEDULING_INTENT_RE =
  /\b(?:schedule|scheduling|meet(?:ing)?|call|availability|available|calendar|book|set up|connect)\b/i;
const CONFLICT_RE =
  /\b(?:or|either|maybe|tentative|tentatively|not sure|whichever)\b/i;

export type CalendarContextPacketV1 = {
  schema: "coastline.calendar_context_packet.v1";
  sourceSystem: "outlook";
  sourceMessageId: string;
  threadId: string;
  status: "not_scheduling" | "ambiguous" | "conflicting" | "clear";
  reason: string;
  // Source identifiers and conflict codes only. Raw Plaud transcripts and
  // notes never cross this boundary into calendar creation.
  sourceAuthorities: string[];
  conflicts: string[];
  proposal?: CoastlineCalendarInvitationProposal;
};

export type MatterContextPacketV1 = {
  schema: "coastline.matter_context_packet.v1";
  status?: string;
  source_authority?: string;
  conflicts?: string[];
  meeting_evidence?: Array<{
    schema: "coastline.plaud.meeting_evidence.v1";
    provider: "plaud_mcp";
    recording_id: string;
    source_hash: string;
    title?: string;
    source_date?: string;
    transcript_coverage?: string;
  }>;
};

export function classifyCalendarContext({
  message,
  accountId,
  accountEmail,
  defaultTimezone,
  matterContext,
}: {
  message: ParsedMessage;
  accountId: string;
  accountEmail: string;
  defaultTimezone?: string | null;
  matterContext?: MatterContextPacketV1;
}): CalendarContextPacketV1 {
  const matterMetadata = getMatterContextMetadata(matterContext);
  const base = {
    schema: "coastline.calendar_context_packet.v1" as const,
    sourceSystem: "outlook" as const,
    sourceMessageId: message.id,
    threadId: message.threadId,
    sourceAuthorities: ["outlook", ...matterMetadata.sourceAuthorities],
    conflicts: matterMetadata.conflicts,
  };
  const body = getMessageText(message);

  if (isCalendarInvite(message)) {
    return {
      ...base,
      status: "not_scheduling",
      reason: "incoming_calendar_invite",
    };
  }
  if (!SCHEDULING_INTENT_RE.test(`${message.headers.subject}\n${body}`)) {
    return {
      ...base,
      status: "not_scheduling",
      reason: "no_scheduling_intent",
    };
  }
  if (CONFLICT_RE.test(body)) {
    return {
      ...base,
      status: "conflicting",
      reason: "multiple_or_uncertain_options",
    };
  }

  const date = extractExactDate(body);
  const time = extractExactTimeRange(body);
  const timezone = extractTimezone(body) ?? normalizeTimezone(defaultTimezone);
  const attendees = extractExternalAttendees(message, accountEmail);

  if (!date || !time || !timezone) {
    return {
      ...base,
      status: "ambiguous",
      reason: !date
        ? "exact_date_missing"
        : !time
          ? "exact_time_range_missing"
          : "timezone_missing",
    };
  }
  if (attendees.length === 0) {
    return {
      ...base,
      status: "ambiguous",
      reason: "external_attendee_missing",
    };
  }

  const startAt = zonedDateTime(
    date,
    time.startHour,
    time.startMinute,
    timezone,
  );
  const endAt = zonedDateTime(date, time.endHour, time.endMinute, timezone);
  if (!startAt || !endAt || endAt <= startAt || startAt <= new Date()) {
    return { ...base, status: "ambiguous", reason: "invalid_or_past_time" };
  }

  const proposal = createCoastlineCalendarInvitationProposal({
    accountId,
    threadId: message.threadId,
    sourceMessageId: message.id,
    title: normalizeSubject(message.headers.subject),
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    timezone,
    location: extractLocation(body),
    attendees,
    schedulingStatus: "clear",
  });

  return {
    ...base,
    status: "clear",
    reason: "explicit_scheduling_request",
    proposal,
  };
}

function getMatterContextMetadata(matterContext?: MatterContextPacketV1) {
  if (matterContext?.schema !== "coastline.matter_context_packet.v1") {
    return { sourceAuthorities: [], conflicts: [] };
  }

  const sourceAuthority = normalizeMetadataValue(matterContext.source_authority);
  const conflicts = (matterContext.conflicts ?? [])
    .map(normalizeMetadataValue)
    .filter((value): value is string => Boolean(value));

  return {
    sourceAuthorities: sourceAuthority ? [sourceAuthority] : [],
    conflicts: [...new Set(conflicts)],
  };
}

function normalizeMetadataValue(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(normalized)) return null;
  return normalized;
}

function getMessageText(message: ParsedMessage) {
  return (message.textPlain || message.textHtml || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSubject(subject: string) {
  const normalized = subject.replace(/^(?:re|fw|fwd):\s*/i, "").trim();
  return normalized || "Meeting";
}

function extractExactDate(text: string) {
  const iso = text.match(/\b(20\d{2})[-/]([01]\d)[-/]([0-3]\d)\b/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    return validDateParts(year, month, day) ? { year, month, day } : null;
  }
  const monthNames =
    "January|February|March|April|May|June|July|August|September|October|November|December";
  const longForm = text.match(
    new RegExp(`\\b(${monthNames})\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b`, "i"),
  );
  if (longForm) {
    const month =
      monthNames.toLowerCase().split("|").indexOf(longForm[1].toLowerCase()) +
      1;
    const year = Number(longForm[3]);
    const day = Number(longForm[2]);
    return validDateParts(year, month, day) ? { year, month, day } : null;
  }
  const european = text.match(
    new RegExp(`\\b(\\d{1,2})\\s+(${monthNames})\\s+(20\\d{2})\\b`, "i"),
  );
  if (european) {
    const month =
      monthNames.toLowerCase().split("|").indexOf(european[2].toLowerCase()) +
      1;
    const year = Number(european[3]);
    const day = Number(european[1]);
    return validDateParts(year, month, day) ? { year, month, day } : null;
  }
  return null;
}

function extractExactTimeRange(text: string) {
  const range = text.match(
    /\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\s*(?:-|–|to|through|until)\s*(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b/i,
  );
  if (range) {
    const startHour = to24Hour(Number(range[1]), range[3]);
    const endHour = to24Hour(Number(range[4]), range[6] || range[3]);
    if (startHour === null || endHour === null) return null;
    return {
      startHour,
      startMinute: Number(range[2] || 0),
      endHour,
      endMinute: Number(range[5] || 0),
    };
  }

  const duration = text.match(
    /\b(?:at|around)\s+(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b[^\n]{0,40}?\bfor\s+(\d{1,3})\s*(?:minutes|min)\b/i,
  );
  if (!duration) return null;
  const startHour = to24Hour(Number(duration[1]), duration[3]);
  const startMinute = Number(duration[2] || 0);
  if (startHour === null) return null;
  const endTotal = startHour * 60 + startMinute + Number(duration[4]);
  return {
    startHour,
    startMinute,
    endHour: Math.floor(endTotal / 60) % 24,
    endMinute: endTotal % 60,
  };
}

function extractTimezone(text: string) {
  const iana = text.match(IANA_TIMEZONE_RE)?.[0];
  if (iana) return normalizeTimezone(iana);
  const alias = text.match(
    /\b(?:PST|PDT|PT|MST|MDT|MT|CST|CDT|CT|EST|EDT|ET|UTC)\b/i,
  )?.[0];
  return normalizeTimezone(alias);
}

function normalizeTimezone(value: string | null | undefined) {
  if (!value) return null;
  const normalized = TIMEZONE_ALIAS[value.toUpperCase()] ?? value;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized });
    return normalized;
  } catch {
    return null;
  }
}

function extractLocation(text: string) {
  return (
    text.match(/\b(?:location|where)\s*[-:]\s*([^.;\n]+)/i)?.[1]?.trim() ?? ""
  );
}

function extractExternalAttendees(
  message: ParsedMessage,
  accountEmail: string,
) {
  const values = [
    ...splitRecipientList(message.headers["reply-to"] || message.headers.from),
    ...splitRecipientList(message.headers.cc || ""),
  ];
  const account = accountEmail.toLowerCase();
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const email = extractEmailAddress(value).toLowerCase();
    if (!email || email === account || seen.has(email)) return [];
    seen.add(email);
    return [{ email, name: extractNameFromEmail(value) || undefined }];
  });
}

function zonedDateTime(
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
  timezone: string,
) {
  const value = new TZDate(
    date.year,
    date.month - 1,
    date.day,
    hour,
    minute,
    0,
    0,
    timezone,
  );
  const utc = new Date(value.getTime());
  return Number.isNaN(utc.getTime()) ? null : utc;
}

function to24Hour(hour: number, meridiem: string) {
  if (hour < 1 || hour > 12) return null;
  const normalized = meridiem.toLowerCase();
  if (normalized === "am") return hour === 12 ? 0 : hour;
  return hour === 12 ? 12 : hour + 12;
}

function validDateParts(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
