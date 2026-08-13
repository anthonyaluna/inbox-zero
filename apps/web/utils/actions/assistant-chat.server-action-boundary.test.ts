import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  coastlineMode: false,
  auth: vi.fn(async () => ({
    user: { id: "u1", email: "owner@example.com" },
  })),
  unsubscribeSenderAndMark: vi.fn(),
  setSenderStatusWithAutoArchive: vi.fn(),
}));

vi.mock("@/utils/prisma");
vi.mock("@/utils/email/provider");
vi.mock("@/utils/auth", () => ({
  auth: mocks.auth,
}));
vi.mock("@/utils/senders/unsubscribe", () => ({
  unsubscribeSenderAndMark: mocks.unsubscribeSenderAndMark,
  setSenderStatusWithAutoArchive: mocks.setSenderStatusWithAutoArchive,
}));
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    env: new Proxy(actual.env, {
      get(target, property, receiver) {
        if (property === "COASTLINE_DRAFT_PROPOSALS_ENABLED") {
          return mocks.coastlineMode;
        }
        return Reflect.get(target, property, receiver);
      },
    }),
  };
});

import prisma from "@/utils/__mocks__/prisma";

describe("assistant chat server action boundary", () => {
  it("only exposes authenticated server actions from the action module", async () => {
    const actions = await import("@/utils/actions/assistant-chat");

    expect(actions).toHaveProperty("confirmAssistantEmailAction");
    expect(actions).toHaveProperty("confirmAssistantCreateRule");
    expect(actions).toHaveProperty("confirmAssistantSaveMemory");
    expect(actions).not.toHaveProperty("confirmAssistantEmailActionForAccount");
    expect(actions).not.toHaveProperty("confirmAssistantCreateRuleForAccount");
    expect(actions).not.toHaveProperty("confirmAssistantSaveMemoryForAccount");
  }, 15_000);

  it("allows verified unsubscribe execution in Coastline mode", async () => {
    mocks.coastlineMode = true;
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "owner@example.com",
      account: { userId: "u1", provider: "microsoft" },
    } as never);
    mocks.unsubscribeSenderAndMark.mockResolvedValue({
      sender: { email: "newsletter@example.com" },
      unsubscribe: { attempted: true, success: true },
    });
    const { unsubscribeSenderAction } = await import(
      "@/utils/actions/unsubscriber"
    );

    const result = await unsubscribeSenderAction("account-1", {
      senderEmail: "newsletter@example.com",
      unsubscribeLink: "https://example.com/unsubscribe",
    });

    expect(result?.data).toEqual({
      sender: { email: "newsletter@example.com" },
      unsubscribe: { attempted: true, success: true },
    });
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledOnce();
    expect(mocks.unsubscribeSenderAndMark).toHaveBeenCalledOnce();
    expect(mocks.setSenderStatusWithAutoArchive).not.toHaveBeenCalled();
  });
});
