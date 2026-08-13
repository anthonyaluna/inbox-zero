export function applyCoastlineDraftQa(reply: string) {
  return reply
    .replace(/\s*—\s*/g, ", ")
    .replace(/!/g, ".");
}
