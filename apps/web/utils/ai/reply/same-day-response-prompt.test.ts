import { describe, expect, it } from "vitest";
import { COASTLINE_EXECUTIVE_ASSISTANT_SYSTEM_PROMPT } from "@/utils/ai/reply/draft-reply";

describe("Same-Day Response drafting contract", () => {
  it("states the business-day response promise and keeps sensitive matters draftable", () => {
    expect(COASTLINE_EXECUTIVE_ASSISTANT_SYSTEM_PROMPT).toContain(
      "same business day",
    );
    expect(COASTLINE_EXECUTIVE_ASSISTANT_SYSTEM_PROMPT).toContain(
      "8:00 AM-5:00 PM Pacific",
    );
    expect(COASTLINE_EXECUTIVE_ASSISTANT_SYSTEM_PROMPT).toMatch(
      /same-day response is not same-day resolution/i,
    );
    expect(COASTLINE_EXECUTIVE_ASSISTANT_SYSTEM_PROMPT).toContain(
      "Draft those matters; do not exclude them.",
    );
    expect(COASTLINE_EXECUTIVE_ASSISTANT_SYSTEM_PROMPT).toContain(
      "Do not send email",
    );
  });
});
