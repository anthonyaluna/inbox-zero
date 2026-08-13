import type { MatterContextPacketV1 } from "@/utils/coastline/calendar-context-broker";

export type CalendarMatterContextRequest = {
  accountId: string;
  threadId: string;
  sourceMessageId: string;
  subject: string;
};

export type CalendarMatterContextLoadResult =
  | { status: "available"; context: MatterContextPacketV1 }
  | { status: "unavailable"; reason: string };

export type CalendarMatterContextLoader = (
  request: CalendarMatterContextRequest,
) => Promise<CalendarMatterContextLoadResult>;

type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export async function loadCalendarMatterContext(
  request: CalendarMatterContextRequest,
  {
    brokerUrl = process.env.COASTLINE_MATTER_CONTEXT_BROKER_URL,
    fetch: fetcher = fetch,
  }: {
    brokerUrl?: string;
    fetch?: FetchLike;
  } = {},
): Promise<CalendarMatterContextLoadResult> {
  if (!isTrustedBrokerUrl(brokerUrl)) {
    return {
      status: "unavailable",
      reason: "context_broker_url_not_configured",
    };
  }

  try {
    const response = await fetcher(brokerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account_id: request.accountId,
        thread_id: request.threadId,
        source_message_id: request.sourceMessageId,
        subject: request.subject,
      }),
    });
    if (!response.ok) {
      return { status: "unavailable", reason: "context_broker_unavailable" };
    }

    const context = sanitizeMatterContextPacket(await response.json());
    return context
      ? { status: "available", context }
      : { status: "unavailable", reason: "context_broker_invalid_packet" };
  } catch {
    return { status: "unavailable", reason: "context_broker_unavailable" };
  }
}

export function sanitizeMatterContextPacket(
  value: unknown,
): MatterContextPacketV1 | null {
  if (
    !isRecord(value) ||
    value.schema !== "coastline.matter_context_packet.v1"
  ) {
    return null;
  }

  const sourceAuthority = sanitizeMetadataValue(value.source_authority);
  const status = sanitizeMetadataValue(value.status);
  const conflicts = Array.isArray(value.conflicts)
    ? value.conflicts
        .map(sanitizeMetadataValue)
        .filter((item): item is string => Boolean(item))
    : [];
  const meetingEvidence = Array.isArray(value.meeting_evidence)
    ? value.meeting_evidence
        .map(sanitizeMeetingEvidence)
        .filter(
          (
            item,
          ): item is NonNullable<
            MatterContextPacketV1["meeting_evidence"]
          >[number] => Boolean(item),
        )
    : [];

  return {
    schema: "coastline.matter_context_packet.v1",
    ...(status ? { status } : {}),
    ...(sourceAuthority ? { source_authority: sourceAuthority } : {}),
    ...(conflicts.length ? { conflicts: [...new Set(conflicts)] } : {}),
    ...(meetingEvidence.length ? { meeting_evidence: meetingEvidence } : {}),
  };
}

function sanitizeMeetingEvidence(
  value: unknown,
): NonNullable<MatterContextPacketV1["meeting_evidence"]>[number] | null {
  if (!isRecord(value)) return null;
  if (
    value.schema !== "coastline.plaud.meeting_evidence.v1" ||
    value.provider !== "plaud_mcp" ||
    !isBoundedIdentifier(value.recording_id) ||
    !isSha256(value.source_hash)
  ) {
    return null;
  }

  return {
    schema: "coastline.plaud.meeting_evidence.v1" as const,
    provider: "plaud_mcp" as const,
    recording_id: value.recording_id,
    source_hash: value.source_hash,
  };
}

function isTrustedBrokerUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeMetadataValue(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9_.-]{1,120}$/.test(normalized) ? normalized : null;
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
