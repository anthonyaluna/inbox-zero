import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const directMailboxAndRuleMutationRoutes = [
  "app/api/messages/send/route.ts",
  "app/api/messages/forward/route.ts",
  "app/api/threads/[id]/archive/route.ts",
  "app/api/threads/[id]/trash/route.ts",
  "app/api/threads/[id]/unarchive/route.ts",
  "app/api/threads/[id]/untrash/route.ts",
  "app/api/mobile/threads/batch/route.ts",
  "app/api/mobile/all-inboxes/archive/route.ts",
  "app/api/labels/create/route.ts",
  "app/api/user/senders/status/route.ts",
  "app/api/user/senders/unsubscribe/route.ts",
  "app/api/mobile/rules/route.ts",
  "app/api/mobile/rules/[id]/route.ts",
  "app/api/mobile/rules/[id]/toggle/route.ts",
  "app/api/v1/rules/route.ts",
  "app/api/v1/rules/[id]/route.ts",
  "app/api/chat/confirm-email-action/route.ts",
  "app/api/clean/gmail/route.ts",
  "app/api/cron/draft-cleanup/route.ts",
];

const providerMutationSink =
  /\.(?:archiveMessage|archiveThread|archiveThreadWithLabel|blockUnsubscribedEmail|bulkArchiveFromSenders|bulkArchiveThreads|bulkTrashFromSenders|createAutoArchiveFilter|createDraft|createFilter|createLabel|deleteDraft|deleteFilter|deleteLabel|forwardEmail|getOrCreateFolderIdByName|getOrCreateInboxZeroLabel|labelMessage|markRead|markReadThread|markSpam|moveThreadToFolder|removeThreadLabel|removeThreadLabels|replyToEmail|sendDraft|sendEmail|sendEmailWithHtml|starMessage|trashThread|unarchiveThread|untrashThread|unwatchEmails|updateDraft|watchEmails)\s*\(/;

function findTypeScriptSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return findTypeScriptSources(path);
    return entry.isFile() &&
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

describe("Coastline direct mutation route inventory", () => {
  it("puts every direct mailbox and rule mutation behind the shared early guard", () => {
    for (const route of directMailboxAndRuleMutationRoutes) {
      const source = readFileSync(resolve(process.cwd(), route), "utf8");
      expect(source, route).toContain("withCoastlineMutationGuard");
    }
  });

  it("discovers provider mutation sinks and requires their construction boundary to be guarded", () => {
    const root = process.cwd();
    const sinkPaths = findTypeScriptSources(resolve(root, "utils"))
      .filter((path) => providerMutationSink.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(root.length + 1).replaceAll("\\", "/"));

    expect(sinkPaths).toEqual(
      expect.arrayContaining([
        "utils/ai/assistant/chat-folder-tools.ts",
        "utils/ai/assistant/chat-inbox-tools.ts",
        "utils/ai/assistant/chat-label-tools.ts",
        "utils/drive/handle-filing-reply.ts",
        "utils/reply-tracker/draft-tracking.ts",
        "utils/drive/filing-notifications.ts",
        "utils/follow-up/cleanup.ts",
        "utils/follow-up/generate-draft.ts",
        "utils/follow-up/labels.ts",
        "utils/email/send-notification-email.ts",
        "utils/messaging/rule-notifications.ts",
        "utils/reply-tracker/label-helpers.ts",
      ]),
    );

    const providerFactory = readFileSync(
      resolve(root, "utils/email/provider.ts"),
      "utf8",
    );
    expect(providerFactory).toContain("withCoastlineProviderMutationGuard");

    const webhookHistory = readFileSync(
      resolve(root, "utils/webhook/outlook/process-history.ts"),
      "utf8",
    );
    expect(webhookHistory).toContain("createEmailProvider");

    const directProviderConstructors = findTypeScriptSources(
      resolve(root, "utils"),
    ).filter((path) =>
      /new (?:GmailProvider|OutlookProvider)\(/.test(
        readFileSync(path, "utf8"),
      ),
    );
    for (const path of directProviderConstructors) {
      const source = readFileSync(path, "utf8");
      expect(source, path).toContain("withCoastlineProviderMutationGuard");
    }
  });
});
