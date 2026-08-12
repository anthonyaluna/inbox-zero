import { readFileSync } from "node:fs";
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
];

describe("Coastline direct mutation route inventory", () => {
  it("puts every direct mailbox and rule mutation behind the shared early guard", () => {
    for (const route of directMailboxAndRuleMutationRoutes) {
      const source = readFileSync(resolve(process.cwd(), route), "utf8");
      expect(source, route).toContain("withCoastlineMutationGuard");
    }
  });
});
