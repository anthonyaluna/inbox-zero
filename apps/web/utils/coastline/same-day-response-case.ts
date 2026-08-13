import { TZDate } from "@date-fns/tz";
import { z } from "zod";

export const SAME_DAY_RESPONSE_CASE_SCHEMA =
  "same_day_response_case.v1" as const;

export const SAME_DAY_RESPONSE_STATES = [
  "received",
  "response_due",
  "drafted",
  "responded",
  "awaiting_action",
  "update_due",
  "completed",
  "verified_closed",
] as const;

export type SameDayResponseState = (typeof SAME_DAY_RESPONSE_STATES)[number];

const isoDateTimeSchema = z.string().datetime({ offset: true });

const commitmentSchema = z.object({
  id: z.string().min(1),
  owner: z.string().min(1),
  action: z.string().min(1),
  dueAt: isoDateTimeSchema.nullable(),
  status: z.enum(["open", "completed", "superseded"]),
  source: z.string().min(1),
});

export const sameDayResponseCaseSchema = z.object({
  schemaVersion: z.literal(SAME_DAY_RESPONSE_CASE_SCHEMA),
  matterId: z.string().min(1),
  sourceMessageId: z.string().min(1),
  sourceThreadId: z.string().min(1),
  sender: z.string().min(1),
  recipients: z.object({
    to: z.array(z.string()),
    cc: z.array(z.string()),
    bcc: z.array(z.string()),
  }),
  accountId: z.string().min(1),
  propertyContext: z.record(z.string(), z.string()).optional(),
  matterType: z.string().min(1),
  audience: z.enum([
    "client",
    "tenant",
    "internal",
    "vendor",
    "prospect",
    "other",
  ]),
  state: z.enum(SAME_DAY_RESPONSE_STATES),
  receivedAt: isoDateTimeSchema,
  responseDeadlineAt: isoDateTimeSchema,
  accountableOwner: z.string().min(1),
  nextAction: z.string().min(1),
  nextUpdateAt: isoDateTimeSchema.nullable(),
  sourceEvidence: z.array(
    z.object({
      sourceSystem: z.string().min(1),
      sourceId: z.string().min(1),
      observedAt: isoDateTimeSchema.nullable(),
      sourceHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    }),
  ),
  conflictStatus: z.enum(["none", "conflict", "missing_facts"]),
  missingFacts: z.array(z.string()),
  draftId: z.string().nullable(),
  followUpId: z.string().nullable(),
  responseMessageId: z.string().nullable(),
  respondedAt: isoDateTimeSchema.nullable(),
  commitments: z.array(commitmentSchema),
  escalation: z.string().nullable(),
  terminalEvidence: z.record(z.string(), z.string()).nullable(),
});

export type SameDayResponseCaseV1 = z.infer<typeof sameDayResponseCaseSchema>;

export type SameDayResponseDeadlineOptions = {
  timezone: string;
  startHour?: number;
  endHour?: number;
  holidays?: readonly string[];
};

export type CreateSameDayResponseCaseInput = {
  accountId: string;
  sourceMessageId: string;
  sourceThreadId: string;
  sender: string;
  recipients: SameDayResponseCaseV1["recipients"];
  propertyContext?: Record<string, string>;
  matterType: string;
  audience: SameDayResponseCaseV1["audience"];
  receivedAt: string;
  accountableOwner: string;
  nextAction: string;
  nextUpdateAt?: string | null;
  sourceEvidence?: SameDayResponseCaseV1["sourceEvidence"];
  conflictStatus?: SameDayResponseCaseV1["conflictStatus"];
  missingFacts?: string[];
  escalation?: string | null;
  holidays?: readonly string[];
  timezone?: string;
};

export function calculateSameDayResponseDeadline(
  receivedAt: string,
  options: SameDayResponseDeadlineOptions,
): string {
  const timezone = options.timezone || "America/Los_Angeles";
  const endHour = options.endHour ?? 17;
  const holidays = new Set(options.holidays ?? []);
  const received = new Date(receivedAt);
  if (Number.isNaN(received.getTime())) {
    throw new Error("receivedAt must be a valid ISO timestamp");
  }

  const local = getLocalParts(received, timezone);
  let year = local.year;
  let month = local.month;
  let day = local.day;

  if (
    local.hour >= endHour ||
    !isBusinessDate({ year, month, day }, holidays)
  ) {
    ({ year, month, day } = nextBusinessDate({ year, month, day }, holidays));
  }

  const deadline = new TZDate(year, month - 1, day, endHour, 0, 0, 0, timezone);
  return new Date(deadline.getTime()).toISOString();
}

export function createSameDayResponseCase(
  input: CreateSameDayResponseCaseInput,
): SameDayResponseCaseV1 {
  const timezone = input.timezone ?? "America/Los_Angeles";
  const matterId = [
    "same-day-response",
    input.accountId,
    input.sourceThreadId,
    input.sourceMessageId,
  ]
    .map((value) => encodeURIComponent(value))
    .join("/");

  return sameDayResponseCaseSchema.parse({
    schemaVersion: SAME_DAY_RESPONSE_CASE_SCHEMA,
    matterId,
    sourceMessageId: input.sourceMessageId,
    sourceThreadId: input.sourceThreadId,
    sender: input.sender,
    recipients: input.recipients,
    accountId: input.accountId,
    propertyContext: input.propertyContext,
    matterType: input.matterType,
    audience: input.audience,
    state: "response_due",
    receivedAt: input.receivedAt,
    responseDeadlineAt: calculateSameDayResponseDeadline(input.receivedAt, {
      timezone,
      holidays: input.holidays,
    }),
    accountableOwner: input.accountableOwner,
    nextAction: input.nextAction,
    nextUpdateAt: input.nextUpdateAt ?? null,
    sourceEvidence: input.sourceEvidence ?? [],
    conflictStatus: input.conflictStatus ?? "none",
    missingFacts: input.missingFacts ?? [],
    draftId: null,
    followUpId: null,
    responseMessageId: null,
    respondedAt: null,
    commitments: [],
    escalation: input.escalation ?? null,
    terminalEvidence: null,
  });
}

const allowedTransitions: Record<SameDayResponseState, SameDayResponseState[]> =
  {
    received: ["response_due"],
    response_due: ["drafted"],
    drafted: ["responded", "awaiting_action", "update_due"],
    responded: ["awaiting_action", "completed"],
    awaiting_action: ["update_due", "completed"],
    update_due: ["drafted", "completed"],
    completed: ["verified_closed"],
    verified_closed: [],
  };

export function transitionSameDayResponseCase(
  responseCase: SameDayResponseCaseV1,
  nextState: SameDayResponseState,
  patch: Partial<SameDayResponseCaseV1> = {},
): SameDayResponseCaseV1 {
  if (!allowedTransitions[responseCase.state].includes(nextState)) {
    throw new Error(
      `Invalid Same-Day Response transition: ${responseCase.state} -> ${nextState}`,
    );
  }

  return sameDayResponseCaseSchema.parse({
    ...responseCase,
    ...patch,
    state: nextState,
  });
}

function getLocalParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: value.year,
    month: value.month,
    day: value.day,
    hour: value.hour,
    minute: value.minute,
  };
}

function isBusinessDate(
  date: { year: number; month: number; day: number },
  holidays: Set<string>,
) {
  const utcDate = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const isoDate = utcDate.toISOString().slice(0, 10);
  return (
    utcDate.getUTCDay() !== 0 &&
    utcDate.getUTCDay() !== 6 &&
    !holidays.has(isoDate)
  );
}

function nextBusinessDate(
  date: { year: number; month: number; day: number },
  holidays: Set<string>,
) {
  const cursor = new Date(Date.UTC(date.year, date.month - 1, date.day));
  do {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  } while (
    !isBusinessDate(
      {
        year: cursor.getUTCFullYear(),
        month: cursor.getUTCMonth() + 1,
        day: cursor.getUTCDate(),
      },
      holidays,
    )
  );
  return {
    year: cursor.getUTCFullYear(),
    month: cursor.getUTCMonth() + 1,
    day: cursor.getUTCDate(),
  };
}
