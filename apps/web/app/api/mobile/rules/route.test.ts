import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  coastlineMode: true,
  aiPromptToRules: vi.fn(),
  createRuleAction: vi.fn(),
  getEmailAccountWithAi: vi.fn(),
  coastlineEnv: { COASTLINE_DRAFT_PROPOSALS_ENABLED: true },
}));

vi.mock("@/env", () => ({
  env: mocks.coastlineEnv,
}));

vi.mock("@/utils/middleware", () => ({
  withEmailAccount:
    (_scope: string, handler: (request: NextRequest) => Promise<Response>) =>
    (request: NextRequest) => {
      Object.assign(request, {
        auth: {
          userId: "user-1",
          emailAccountId: "account-1",
          email: "user@example.com",
        },
      });
      return handler(request);
    },
}));

vi.mock("@/utils/ai/rule/prompt-to-rules", () => ({
  aiPromptToRules: mocks.aiPromptToRules,
}));

vi.mock("@/utils/actions/rule", () => ({
  createRuleAction: mocks.createRuleAction,
}));

vi.mock("@/utils/user/get", () => ({
  getEmailAccountWithAi: mocks.getEmailAccountWithAi,
}));

import { POST } from "./route";

function postRule(body: string) {
  return POST(
    new NextRequest("http://localhost:3000/api/mobile/rules", {
      method: "POST",
      body,
    }),
    {} as never,
  );
}

describe("POST /api/mobile/rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.coastlineMode = true;
    mocks.coastlineEnv.COASTLINE_DRAFT_PROPOSALS_ENABLED = true;
  });

  it("rejects before parsing an AI prompt or invoking rule mutation in Coastline mode", async () => {
    const response = await postRule("not-json");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Coastline draft-only policy blocked CREATE_RULE",
      errorCode: "COASTLINE_DRAFT_ONLY_ACTION_BLOCKED",
    });
    expect(mocks.getEmailAccountWithAi).not.toHaveBeenCalled();
    expect(mocks.aiPromptToRules).not.toHaveBeenCalled();
    expect(mocks.createRuleAction).not.toHaveBeenCalled();
  });

  it("preserves rule creation outside Coastline mode", async () => {
    mocks.coastlineMode = false;
    mocks.coastlineEnv.COASTLINE_DRAFT_PROPOSALS_ENABLED = false;
    mocks.createRuleAction.mockResolvedValue({
      data: { rule: { id: "rule-1", name: "Receipts" } },
    });

    const response = await postRule(
      JSON.stringify({
        source: "manual",
        rule: {
          name: "Receipts",
          actions: [{ type: "MARK_READ" }],
          conditions: [{ type: "STATIC", from: "billing@example.com" }],
        },
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      rule: { id: "rule-1", name: "Receipts" },
    });
    expect(mocks.createRuleAction).toHaveBeenCalledOnce();
  });
});
