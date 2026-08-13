const ESCALATION_MARKER = "[Escalate: Hold for Anthony]";
const SLOP_TELLS = [
  /^\s*hope you are well[.!]?/i,
  /^\s*just following up[.!]?/i,
  /let me know if you need anything else/i,
];

export function applyCoastlineDraftQa(
  reply: string,
  { requiresEscalation = false }: { requiresEscalation?: boolean } = {},
) {
  let normalized = reply
    .replace(/\s*—\s*/g, ", ")
    .replace(/!/g, ".");

  normalized = normalized.replace(/\[[^\]]+\]/g, (placeholder) =>
    /^\[Confirm: .+\]$/.test(placeholder) || placeholder === ESCALATION_MARKER
      ? placeholder
      : "[Confirm: details]",
  );
  let askCount = 0;
  normalized = normalized.replace(/\?/g, () => (++askCount <= 1 ? "?" : "."));
  for (const pattern of SLOP_TELLS) normalized = normalized.replace(pattern, "");
  normalized = normalized.trim();

  const marker = normalized.includes(ESCALATION_MARKER)
    ? ESCALATION_MARKER
    : requiresEscalation
      ? ESCALATION_MARKER
      : null;
  normalized = normalized.replace(ESCALATION_MARKER, "").trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 180) normalized = words.slice(0, 180).join(" ");
  if (!normalized) normalized = "[Confirm: details]";
  if (marker) normalized = `${normalized}\n\n${marker}`;
  return normalized;
}
