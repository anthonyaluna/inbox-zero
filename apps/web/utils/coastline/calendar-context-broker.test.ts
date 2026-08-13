import { describe, expect, it } from "vitest";
import { classifyCalendarContext } from "@/utils/coastline/calendar-context-broker";
import type { ParsedMessage } from "@/utils/types";

const baseMessage = (
  overrides: Partial<ParsedMessage> = {},
): ParsedMessage => ({
  id: "message-1",
  threadId: "thread-1",
  historyId: "history-1",
  internalDate: "1786579200000",
  date: "2026-08-12T12:00:00.000Z",
  subject: "Schedule Freeman security review",
  snippet: "",
  textPlain:
    "Can we meet on August 13, 2026 from 2:00 PM to 2:30 PM PT? Location: Microsoft Teams.",
  textHtml: "",
  inline: [],
  attachments: [],
  headers: {
    from: "Bond Nichols <bond@example.com>",
    to: "Anthony <anthony@example.com>",
    cc: "",
    subject: "Schedule Freeman security review",
    date: "Wed, 12 Aug 2026 12:00:00 +0000",
    "message-id": "<message-1@example.com>",
  },
  ...overrides,
});

describe("classifyCalendarContext", () => {
  it("emits a clear proposal from exact date, time, timezone, and attendee evidence", () => {
    const result = classifyCalendarContext({
      message: baseMessage(),
      accountId: "account-1",
      accountEmail: "anthony@example.com",
      defaultTimezone: "America/Los_Angeles",
    });

    expect(result.status).toBe("clear");
    expect(result.reason).toBe("explicit_scheduling_request");
    expect(result.proposal).toMatchObject({
      accountId: "account-1",
      threadId: "thread-1",
      sourceMessageId: "message-1",
      timezone: "America/Los_Angeles",
      location: "Microsoft Teams",
      attendees: [{ email: "bond@example.com", name: "Bond Nichols" }],
      schedulingStatus: "clear",
    });
    expect(result.proposal?.startAt).toBe("2026-08-13T21:00:00.000Z");
    expect(result.proposal?.endAt).toBe("2026-08-13T21:30:00.000Z");
  });

  it("uses the account timezone only when the message omits a timezone", () => {
    const result = classifyCalendarContext({
      message: baseMessage({
        textPlain:
          "Can we meet on August 13, 2026 from 2:00 PM to 2:30 PM? Location: 1400 Freeman Ave.",
      }),
      accountId: "account-1",
      accountEmail: "anthony@example.com",
      defaultTimezone: "America/Los_Angeles",
    });

    expect(result.status).toBe("clear");
    expect(result.proposal?.timezone).toBe("America/Los_Angeles");
  });

  it("preserves bounded Plaud authority and conflicts without exposing transcript text", () => {
    const result = classifyCalendarContext({
      message: baseMessage(),
      accountId: "account-1",
      accountEmail: "anthony@example.com",
      defaultTimezone: "America/Los_Angeles",
      matterContext: {
        schema: "coastline.matter_context_packet.v1",
        status: "transcript_gap",
        source_authority: "plaud_transcript",
        conflicts: ["transcript_gap"],
        meeting_evidence: [
          {
            schema: "coastline.plaud.meeting_evidence.v1",
            provider: "plaud_mcp",
            recording_id: "rec-1",
            title: "Freeman security review",
            source_date: "2026-08-10",
            transcript_coverage: "gap",
            source_hash: "a".repeat(64),
          },
        ],
        transcript: "This raw transcript must never reach a calendar proposal.",
        notes: "This raw note must never reach a calendar proposal.",
      } as unknown as never,
    });

    expect(result.status).toBe("clear");
    expect(result.sourceAuthorities).toEqual(["outlook", "plaud_transcript"]);
    expect(result.conflicts).toEqual(["transcript_gap"]);
    expect(JSON.stringify(result)).not.toContain(
      "This raw transcript must never reach a calendar proposal.",
    );
    expect(JSON.stringify(result)).not.toContain(
      "This raw note must never reach a calendar proposal.",
    );
  });

  it("blocks calendar mutation when the context broker reports a material conflict", () => {
    const result = classifyCalendarContext({
      message: baseMessage(),
      accountId: "account-1",
      accountEmail: "anthony@example.com",
      defaultTimezone: "America/Los_Angeles",
      matterContext: {
        schema: "coastline.matter_context_packet.v1",
        status: "conflict",
        source_authority: "appfolio",
        conflicts: ["material_conflict"],
      },
    });

    expect(result).toMatchObject({
      status: "conflicting",
      reason: "matter_context_conflict",
    });
    expect(result.proposal).toBeUndefined();
  });

  it("does not dispatch when an exact scheduling fact is missing", () => {
    const result = classifyCalendarContext({
      message: baseMessage({
        textPlain: "Can we meet next week? Location: Microsoft Teams.",
      }),
      accountId: "account-1",
      accountEmail: "anthony@example.com",
      defaultTimezone: "America/Los_Angeles",
    });

    expect(result).toMatchObject({
      status: "ambiguous",
      reason: "exact_date_missing",
    });
    expect(result.proposal).toBeUndefined();
  });

  it("does not dispatch an incoming calendar invitation or conflicting options", () => {
    const invite = classifyCalendarContext({
      message: baseMessage({
        attachments: [
          { filename: "invite.ics", mimeType: "text/calendar" } as never,
        ],
      }),
      accountId: "account-1",
      accountEmail: "anthony@example.com",
      defaultTimezone: "America/Los_Angeles",
    });
    const conflict = classifyCalendarContext({
      message: baseMessage({
        textPlain:
          "Can we meet on August 13, 2026 at 2:00 PM PT or August 14, 2026 at 3:00 PM PT?",
      }),
      accountId: "account-1",
      accountEmail: "anthony@example.com",
      defaultTimezone: "America/Los_Angeles",
    });

    expect(invite).toMatchObject({
      status: "not_scheduling",
      reason: "incoming_calendar_invite",
    });
    expect(conflict).toMatchObject({
      status: "conflicting",
      reason: "multiple_or_uncertain_options",
    });
  });
});
