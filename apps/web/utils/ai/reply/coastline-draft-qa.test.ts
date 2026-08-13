import { describe, expect, it } from "vitest";
import { applyCoastlineDraftQa } from "./coastline-draft-qa";

describe("applyCoastlineDraftQa", () => {
  it("keeps a sensitive draft and its escalation marker while removing prohibited punctuation", () => {
    expect(
      applyCoastlineDraftQa(
        "Hi Bond!\n\nThe invoice is under review — I will confirm the next step.\n\n[Escalate: Hold for Anthony]",
      ),
    ).toBe(
      "Hi Bond.\n\nThe invoice is under review, I will confirm the next step.\n\n[Escalate: Hold for Anthony]",
    );
  });

  it("preserves the approved missing-fact placeholder", () => {
    expect(
      applyCoastlineDraftQa("Hi Bond,\n\n[Confirm: case number]"),
    ).toContain("[Confirm: case number]");
  });
});
