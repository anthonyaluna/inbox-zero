import { describe, expect, it } from "vitest";
import { applyCoastlineDraftQa } from "./coastline-draft-qa";
import { addHighRiskEscalationMarker } from "./draft-reply";

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

  it("rejects more than one ask and unapproved placeholders", () => {
    expect(() =>
      applyCoastlineDraftQa("Can you send the invoice? Can you also confirm the date? [Pending: owner]"),
    ).toThrow(/one clear ask|placeholder/i);
  });

  it("rejects slop tells and drafts over the word limit", () => {
    expect(() => applyCoastlineDraftQa("Hope you are well.")).toThrow(/slop/i);
    expect(() => applyCoastlineDraftQa(Array(182).fill("word").join(" "))).toThrow(
      /180 word/i,
    );
  });

  it("adds the escalation marker for an unmarked sensitive incoming matter", () => {
    expect(
      addHighRiskEscalationMarker({
        reply: "Hi Bond,\n\nI will review the information.",
        latestMessage: {
          subject: "Invoice status",
          content: "Please confirm the payment status.",
          to: "anthony@coastlineequity.net",
        } as never,
      }),
    ).toContain("[Escalate: Hold for Anthony]");
  });
});
