import { describe, expect, it, vi } from "vitest";
import type { EmailProvider } from "@/utils/email/types";
import { withCoastlineProviderMutationGuard } from "@/utils/coastline/provider-mutation-guard";

const coastlineEnvironment = vi.hoisted(() => ({
  COASTLINE_DRAFT_PROPOSALS_ENABLED: true,
}));

vi.mock("@/env", () => ({ env: coastlineEnvironment }));

describe("withCoastlineProviderMutationGuard", () => {
  it("blocks a background provider draft delete before the provider sink is called in Coastline mode", () => {
    const deleteDraft = vi.fn();
    const provider = {
      name: "microsoft",
      deleteDraft,
    } as unknown as EmailProvider;

    const guarded = withCoastlineProviderMutationGuard(provider);

    expect(() => guarded.deleteDraft("draft-1")).toThrow(
      expect.objectContaining({
        code: "COASTLINE_DRAFT_ONLY_ACTION_BLOCKED",
        actionType: "DELETE_DRAFT",
      }),
    );
    expect(deleteDraft).not.toHaveBeenCalled();
  });

  it.each([
    "createLabel",
    "deleteDraft",
    "forwardEmail",
    "labelMessage",
    "removeThreadLabel",
    "replyToEmail",
    "sendDraft",
    "sendEmail",
    "sendEmailWithHtml",
    "trashThread",
  ])("does not call the %s provider sink in Coastline mode", (operation) => {
    const providerSink = vi.fn();
    const provider = {
      name: "microsoft",
      [operation]: providerSink,
    } as unknown as EmailProvider;
    const guarded = withCoastlineProviderMutationGuard(provider);

    expect(() => Reflect.get(guarded, operation)()).toThrow(
      expect.objectContaining({ code: "COASTLINE_DRAFT_ONLY_ACTION_BLOCKED" }),
    );
    expect(providerSink).not.toHaveBeenCalled();
  });

  it.each(["archiveThread", "markRead", "moveThreadToFolder"])(
    "allows registered %s provider mutations in Coastline mode",
    async (operation) => {
      const providerSink = vi.fn().mockResolvedValue(undefined);
      const provider = {
        name: "microsoft",
        [operation]: providerSink,
      } as unknown as EmailProvider;

      const guarded = withCoastlineProviderMutationGuard(provider);
      await Reflect.get(guarded, operation)("thread-1", "owner@example.com");
      expect(providerSink).toHaveBeenCalledOnce();
    },
  );

  it("preserves Microsoft draft creation and normal-mode provider mutations", async () => {
    const draftEmail = vi.fn().mockResolvedValue({ draftId: "draft-1" });
    const archiveThread = vi.fn().mockResolvedValue(undefined);
    const provider = {
      name: "microsoft",
      draftEmail,
      archiveThread,
    } as unknown as EmailProvider;

    const coastline = withCoastlineProviderMutationGuard(provider, {
      coastlineDraftProposalsEnabled: true,
    });
    await coastline.draftEmail({} as never, { content: "draft" }, "owner");
    expect(draftEmail).toHaveBeenCalledOnce();
    await coastline.archiveThread("thread-1", "owner@example.com");
    expect(archiveThread).toHaveBeenCalledOnce();

    const normal = withCoastlineProviderMutationGuard(provider, {
      coastlineDraftProposalsEnabled: false,
    });
    await normal.archiveThread("thread-2", "owner@example.com");
    expect(archiveThread).toHaveBeenCalledTimes(2);
  });
});
