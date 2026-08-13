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
  const normalized = reply
    .replace(/\s*—\s*/g, ", ")
    .replace(/!/g, ".");

  const placeholders = normalized.match(/\[[^\]]+\]/g) ?? [];
  if (
    placeholders.some(
      (placeholder) =>
        !/^\[Confirm: .+\]$/.test(placeholder) &&
        placeholder !== ESCALATION_MARKER,
    )
  ) {
    throw new Error("Draft contains an unapproved placeholder");
  }
  if (normalized.split(/\s+/).filter(Boolean).length > 180) {
    throw new Error("Draft exceeds the 180 word limit");
  }
  if ((normalized.match(/\?/g) ?? []).length > 1) {
    throw new Error("Draft contains more than one clear ask");
  }
  if (SLOP_TELLS.some((pattern) => pattern.test(normalized))) {
    throw new Error("Draft contains an AI slop tell");
  }
  if (requiresEscalation && !normalized.includes(ESCALATION_MARKER)) {
    throw new Error("Sensitive draft requires an escalation marker");
  }
  return normalized;
}
