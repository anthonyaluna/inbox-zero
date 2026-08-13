import { describe, expect, it, vi } from "vitest";
import {
  loadCalendarMatterContext,
  sanitizeMatterContextPacket,
} from "@/utils/coastline/calendar-matter-context-loader";

describe("calendar matter-context loader", () => {
  it("returns an explicit unavailable result when no internal broker URL is configured", async () => {
    await expect(
      loadCalendarMatterContext(
        {
          accountId: "account-1",
          threadId: "thread-1",
          sourceMessageId: "message-1",
          subject: "Freeman security review",
        },
        { brokerUrl: undefined },
      ),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "context_broker_url_not_configured",
    });
  });

  it("sends only bounded request fields and strips raw Plaud content from broker output", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schema: "coastline.matter_context_packet.v1",
        status: "complete",
        source_authority: "plaud_transcript",
        conflicts: ["transcript_gap"],
        transcript: "raw transcript that must not cross the boundary",
        notes: "raw notes that must not cross the boundary",
        meeting_evidence: [
          {
            schema: "coastline.plaud.meeting_evidence.v1",
            provider: "plaud_mcp",
            recording_id: "recording-1",
            source_hash: "a".repeat(64),
            transcript: "also forbidden",
          },
        ],
      }),
    });

    const result = await loadCalendarMatterContext(
      {
        accountId: "account-1",
        threadId: "thread-1",
        sourceMessageId: "message-1",
        subject: "Freeman security review",
      },
      { brokerUrl: "https://context-broker.example/internal/context", fetch },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://context-broker.example/internal/context",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          account_id: "account-1",
          thread_id: "thread-1",
          source_message_id: "message-1",
          subject: "Freeman security review",
        }),
      }),
    );
    expect(result).toMatchObject({
      status: "available",
      context: {
        source_authority: "plaud_transcript",
        conflicts: ["transcript_gap"],
      },
    });
    expect(JSON.stringify(result)).not.toContain(
      "raw transcript that must not cross the boundary",
    );
    expect(JSON.stringify(result)).not.toContain(
      "raw notes that must not cross the boundary",
    );
  });

  it("rejects a context packet with an invalid schema", () => {
    expect(
      sanitizeMatterContextPacket({
        schema: "untrusted.packet",
        source_authority: "plaud_transcript",
      }),
    ).toBeNull();
  });
});
