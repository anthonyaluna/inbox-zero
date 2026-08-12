import { describe, expect, it } from "vitest";
import { createCoastlineCronAuthProbe } from "@/utils/coastline/cron-auth-probe";

describe("createCoastlineCronAuthProbe", () => {
  it("returns nonce-bound authenticated evidence without executing cron work", () => {
    const result = createCoastlineCronAuthProbe({
      runNonce: "a".repeat(32),
      cronSecret: "protected-test-secret",
      observedAt: new Date("2026-08-11T12:00:00.000Z"),
    });

    expect(result).toEqual({
      authenticated: true,
      runNonce: "a".repeat(32),
      evidenceId: expect.stringMatching(/^[a-f0-9]{64}$/),
      observedAt: "2026-08-11T12:00:00.000Z",
    });
  });

  it("rejects an unbounded nonce", () => {
    expect(() =>
      createCoastlineCronAuthProbe({
        runNonce: "not-valid",
        cronSecret: "protected-test-secret",
      }),
    ).toThrow("Invalid Coastline cron probe nonce");
  });
});
