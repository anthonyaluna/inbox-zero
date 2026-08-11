import { describe, expect, it } from "vitest";
import { ActionType } from "@/generated/prisma/enums";
import {
  CoastlineDraftOnlyPolicyError,
  assertCoastlineDraftOnlyAction,
} from "@/utils/coastline/draft-only-policy";

describe("assertCoastlineDraftOnlyAction", () => {
  it("allows Microsoft drafts when the Coastline policy is enabled", () => {
    expect(() =>
      assertCoastlineDraftOnlyAction({
        actionType: ActionType.DRAFT_EMAIL,
        providerName: "microsoft",
        coastlineDraftProposalsEnabled: true,
        providerCapabilities: { canDraftEmail: true },
      }),
    ).not.toThrow();
  });

  it.each([
    ActionType.SEND_EMAIL,
    ActionType.REPLY,
    ActionType.FORWARD,
    ActionType.ARCHIVE,
    ActionType.MARK_READ,
    ActionType.MOVE_FOLDER,
    "UNSUBSCRIBE",
    "CREATE_RULE",
  ])("rejects %s with a stable policy error", (actionType) => {
    try {
      assertCoastlineDraftOnlyAction({
        actionType,
        providerName: "microsoft",
        coastlineDraftProposalsEnabled: true,
        providerCapabilities: { canDraftEmail: true },
      });
      throw new Error("Expected the Coastline draft-only policy to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(CoastlineDraftOnlyPolicyError);
      expect(error).toMatchObject({
        code: "COASTLINE_DRAFT_ONLY_ACTION_BLOCKED",
        actionType,
      });
    }
  });

  it("rejects Gmail even for a draft action", () => {
    expect(() =>
      assertCoastlineDraftOnlyAction({
        actionType: ActionType.DRAFT_EMAIL,
        providerName: "google",
        coastlineDraftProposalsEnabled: true,
        providerCapabilities: { canDraftEmail: true },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "COASTLINE_DRAFT_ONLY_ACTION_BLOCKED",
        actionType: ActionType.DRAFT_EMAIL,
      }),
    );
  });

  it("preserves normal behavior when the Coastline policy is disabled", () => {
    expect(() =>
      assertCoastlineDraftOnlyAction({
        actionType: ActionType.SEND_EMAIL,
        providerName: "google",
        coastlineDraftProposalsEnabled: false,
        providerCapabilities: { canDraftEmail: false },
      }),
    ).not.toThrow();
  });
});
