import { describe, expect, it, vi } from "vitest";

const envState = vi.hoisted(() => ({
  COASTLINE_DRAFT_PROPOSALS_ENABLED: true,
  RESEND_API_KEY: "resend-key",
  RESEND_FROM_EMAIL: "noreply@example.com",
}));
const sendColdEmailNotificationViaResend = vi.hoisted(() => vi.fn());

vi.mock("@/env", () => ({ env: envState }));
vi.mock("@inboxzero/resend", () => ({
  sendColdEmailNotification: sendColdEmailNotificationViaResend,
}));

import { sendColdEmailNotification } from "./send-notification";

describe("sendColdEmailNotification", () => {
  it("does not send through Resend in Coastline mode", async () => {
    const result = await sendColdEmailNotification({
      senderEmail: "sender@example.com",
      recipientEmail: "anthony@example.com",
      originalSubject: "A cold pitch",
      originalMessageId: "message-1",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });

    expect(result).toEqual({
      success: false,
      error: "COASTLINE_DRAFT_ONLY_ACTION_BLOCKED",
    });
    expect(sendColdEmailNotificationViaResend).not.toHaveBeenCalled();
  });

  it("preserves normal Resend delivery outside Coastline mode", async () => {
    envState.COASTLINE_DRAFT_PROPOSALS_ENABLED = false;
    sendColdEmailNotificationViaResend.mockResolvedValue({
      data: { id: "resend-1" },
    });

    const result = await sendColdEmailNotification({
      senderEmail: "sender@example.com",
      recipientEmail: "anthony@example.com",
      originalSubject: "A cold pitch",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });

    expect(result).toEqual({ success: true });
    expect(sendColdEmailNotificationViaResend).toHaveBeenCalledOnce();
    envState.COASTLINE_DRAFT_PROPOSALS_ENABLED = true;
    sendColdEmailNotificationViaResend.mockReset();
  });
});
