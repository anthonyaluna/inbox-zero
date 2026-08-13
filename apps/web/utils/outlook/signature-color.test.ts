import { describe, expect, it } from "vitest";
import { resolveOutlookSignatureColor } from "./signature-color";

describe("resolveOutlookSignatureColor", () => {
  it("records the meaningful signature text color and source evidence", () => {
    expect(
      resolveOutlookSignatureColor({
        signatureHtml:
          '<div><img src="logo.png"><span style="color: rgb(15, 23, 42)">Anthony A. Luna</span></div>',
        sourceMessageId: "sent-message-1",
        observedAt: new Date("2026-08-12T12:00:00.000Z"),
      }),
    ).toEqual({
      color: "#0f172a",
      sourceMessageId: "sent-message-1",
      observedAt: "2026-08-12T12:00:00.000Z",
      signatureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      evidenceStatus: "verified",
    });
  });

  it("keeps the last verified color when a current signature has no text color", () => {
    expect(
      resolveOutlookSignatureColor({
        signatureHtml: "<div>Anthony A. Luna</div>",
        sourceMessageId: "sent-message-2",
        observedAt: new Date("2026-08-12T12:01:00.000Z"),
        lastKnownColor: "rgb(15, 23, 42)",
      }),
    ).toMatchObject({
      color: "#0f172a",
      evidenceStatus: "last_known",
    });
  });

  it("marks the black fallback as configured rather than verified", () => {
    expect(
      resolveOutlookSignatureColor({
        signatureHtml: "<div>Anthony A. Luna</div>",
        sourceMessageId: "sent-message-3",
        observedAt: new Date("2026-08-12T12:02:00.000Z"),
      }),
    ).toMatchObject({ color: "#000000", evidenceStatus: "configured_default" });
  });
});
