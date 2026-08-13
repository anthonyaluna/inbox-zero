import { createHash } from "node:crypto";
import { load } from "cheerio";

const DEFAULT_SIGNATURE_COLOR = "#000000";

export function resolveOutlookSignatureColor({
  signatureHtml,
  sourceMessageId,
  observedAt,
  lastKnownColor,
}: {
  signatureHtml: string;
  sourceMessageId: string;
  observedAt: Date;
  lastKnownColor?: string;
}) {
  const extracted = extractSignatureTextColor(signatureHtml);
  const fallback = normalizeColor(lastKnownColor) || DEFAULT_SIGNATURE_COLOR;

  return {
    color: extracted || fallback,
    sourceMessageId,
    observedAt: observedAt.toISOString(),
    signatureSha256: createHash("sha256").update(signatureHtml).digest("hex"),
    evidenceStatus: extracted
      ? ("verified" as const)
      : lastKnownColor
        ? ("last_known" as const)
        : ("configured_default" as const),
  };
}

function extractSignatureTextColor(signatureHtml: string) {
  const $ = load(signatureHtml);
  let color: string | undefined;

  $("span, div, p, td, font").each((_index, element) => {
    if (color || !$(element).text().trim()) return;
    color = normalizeColor($(element).attr("style")?.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)?.[1]) ||
      normalizeColor($(element).attr("color"));
  });

  return color;
}

function normalizeColor(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return;
  if (/^#[a-f0-9]{6}$/.test(normalized)) return normalized;

  const rgb = normalized.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/);
  if (!rgb) return;

  const channels = rgb.slice(1).map(Number);
  if (channels.some((channel) => channel > 255)) return;
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
