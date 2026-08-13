import { describe, expect, it } from "vitest";
import { ActionType } from "@/generated/prisma/enums";
import {
  COASTLINE_REGISTERED_CAPABILITIES,
  CoastlineDraftOnlyPolicyError,
  assertCoastlineDraftOnlyAction,
  assertCoastlineMutationAllowed,
  assertCoastlineServerActionAllowed,
} from "@/utils/coastline/draft-only-policy";

describe("assertCoastlineDraftOnlyAction", () => {
  it("registers calendar, attachment filing, and owned stale-draft cleanup without send capability", () => {
    expect(COASTLINE_REGISTERED_CAPABILITIES).toEqual(
      expect.arrayContaining([
        "calendar_event",
        "attachment_filing",
        "stale_ai_draft_cleanup",
      ]),
    );
    expect(COASTLINE_REGISTERED_CAPABILITIES).not.toContain("send_email");
  });
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
    ActionType.ARCHIVE,
    ActionType.LABEL,
    ActionType.MOVE_FOLDER,
    ActionType.MARK_READ,
  ])("allows registered %s actions when the Coastline runtime is enabled", (actionType) => {
    expect(() =>
      assertCoastlineDraftOnlyAction({
        actionType,
        providerName: "microsoft",
        coastlineDraftProposalsEnabled: true,
        providerCapabilities: { canDraftEmail: true },
      }),
    ).not.toThrow();
  });

  it.each([ActionType.SEND_EMAIL, ActionType.REPLY, ActionType.FORWARD])(
    "rejects outbound %s actions with a stable policy error",
    (actionType) => {
      expect(() =>
        assertCoastlineDraftOnlyAction({
          actionType,
          providerName: "microsoft",
          coastlineDraftProposalsEnabled: true,
          providerCapabilities: { canDraftEmail: true },
        }),
      ).toThrow(
        expect.objectContaining({
          code: "COASTLINE_DRAFT_ONLY_ACTION_BLOCKED",
          actionType,
        }),
      );
    },
  );

  it("keeps Coastline production actions on Microsoft", () => {
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

describe("assertCoastlineServerActionAllowed", () => {
  it.each([
    "unsubscribeSender",
    "bulkArchive",
    "cleanInbox",
  ])("allows the registered %s mutation surface in Coastline mode", (actionName) => {
    expect(() =>
      assertCoastlineServerActionAllowed({
        actionName,
        coastlineDraftProposalsEnabled: true,
      }),
    ).not.toThrow();
  });

  it.each([
    "sendEmail",
    "replyToEmail",
    "forwardEmail",
    "trashThread",
  ])("blocks the %s non-registered mutation surface in Coastline mode", (actionName) => {
    expect(() =>
      assertCoastlineServerActionAllowed({
        actionName,
        coastlineDraftProposalsEnabled: true,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "COASTLINE_DRAFT_ONLY_ACTION_BLOCKED",
        actionType: actionName,
      }),
    );
  });

  it.each(["createRule", "updateRule", "deleteRule", "markSpam", "starMessage", "setSenderStatus"])(
    "blocks unrelated %s mutations in Coastline mode",
    (actionName) => {
      expect(() =>
        assertCoastlineServerActionAllowed({
          actionName,
          coastlineDraftProposalsEnabled: true,
        }),
      ).toThrow(
        expect.objectContaining({
          code: "COASTLINE_DRAFT_ONLY_ACTION_BLOCKED",
          actionType: actionName,
        }),
      );
    },
  );

  it("allows the owned stale draft cleanup mutation", () => {
    expect(() =>
      assertCoastlineMutationAllowed({
        surface: "ai/draft-cleanup",
        mutation: "DELETE_AI_DRAFT",
        coastlineDraftProposalsEnabled: true,
      }),
    ).not.toThrow();
  });

  it("allows registered direct route mutations in Coastline mode", () => {
    expect(() =>
      assertCoastlineMutationAllowed({
        surface: "mobile/senders/unsubscribe",
        mutation: "UNSUBSCRIBE",
        coastlineDraftProposalsEnabled: true,
      }),
    ).not.toThrow();
  });

  it("rejects direct send mutations in Coastline mode", () => {
    expect(() =>
      assertCoastlineMutationAllowed({
        surface: "mobile/mail/send",
        mutation: "SEND_EMAIL",
        coastlineDraftProposalsEnabled: true,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "COASTLINE_DRAFT_ONLY_ACTION_BLOCKED",
        actionType: "SEND_EMAIL",
      }),
    );
  });

  it("preserves server actions outside Coastline mode", () => {
    expect(() =>
      assertCoastlineServerActionAllowed({
        actionName: "createRule",
        coastlineDraftProposalsEnabled: false,
      }),
    ).not.toThrow();
  });
});

describe("assertCoastlineMutationAllowed", () => {
  it("preserves direct mutations outside Coastline mode", () => {
    expect(() =>
      assertCoastlineMutationAllowed({
        surface: "mobile/rules/create",
        mutation: "CREATE_RULE",
        coastlineDraftProposalsEnabled: false,
      }),
    ).not.toThrow();
  });
});
