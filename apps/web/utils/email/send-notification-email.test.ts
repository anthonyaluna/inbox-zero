import { describe, expect, it, vi } from "vitest";

const envState = vi.hoisted(() => ({
  COASTLINE_DRAFT_PROPOSALS_ENABLED: true,
  RESEND_API_KEY: "resend-key",
}));
const createEmailProvider = vi.hoisted(() => vi.fn());

vi.mock("@/env", () => ({ env: envState }));
vi.mock("@/utils/email/provider", () => ({ createEmailProvider }));

import { sendNotificationEmail } from "./send-notification-email";

describe("sendNotificationEmail", () => {
  it("does not call Resend or an email provider in Coastline mode", async () => {
    const sendViaResend = vi.fn();
    const renderHtml = vi.fn();
    await sendNotificationEmail({
      emailAccountId: "account-1",
      userEmail: "anthony@example.com",
      provider: "microsoft",
      subject: "Meeting recap",
      sendViaResend,
      renderHtml,
      logger: { info: vi.fn() } as never,
    });

    expect(sendViaResend).not.toHaveBeenCalled();
    expect(renderHtml).not.toHaveBeenCalled();
    expect(createEmailProvider).not.toHaveBeenCalled();
  });

  it("keeps normal notification delivery outside Coastline mode", async () => {
    envState.COASTLINE_DRAFT_PROPOSALS_ENABLED = false;
    const sendViaResend = vi.fn().mockResolvedValue(undefined);
    await sendNotificationEmail({
      emailAccountId: "account-1",
      userEmail: "anthony@example.com",
      provider: "microsoft",
      subject: "Meeting recap",
      sendViaResend,
      renderHtml: vi.fn(),
      logger: { info: vi.fn() } as never,
    });
    expect(sendViaResend).toHaveBeenCalledOnce();
    envState.COASTLINE_DRAFT_PROPOSALS_ENABLED = true;
  });
});
