import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ActionType } from "@/generated/prisma/enums";
import {
  createOutlookTestHarness,
  type OutlookTestHarness,
} from "@/__tests__/integration/helpers";
import { createTestLogger } from "@/__tests__/helpers";
import { runActionFunction } from "@/utils/ai/actions";
import { createInboxZeroDraftProposalFromAction } from "@/utils/coastline/draft-proposal";

vi.mock("@/env", () => ({
  env: {
    COASTLINE_DRAFT_PROPOSALS_ENABLED: true,
    NEXT_PUBLIC_AUTO_DRAFT_DISABLED: false,
  },
}));

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS;
const OUTLOOK_EMAIL = "coastline-fixture@outlook.example.com";

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "Coastline draft proposal against the Microsoft fixture",
  { timeout: 30_000 },
  () => {
    let harness: OutlookTestHarness;

    beforeAll(async () => {
      harness = await createOutlookTestHarness({
        email: OUTLOOK_EMAIL,
        messages: [
          {
            id: "coastline-source-message",
            conversation_id: "coastline-source-thread",
            user_email: OUTLOOK_EMAIL,
            from: { address: "owner@example.com", name: "Owner" },
            to_recipients: [{ address: OUTLOOK_EMAIL }],
            subject: "Lease packet request",
            body_content: "<p>Please send the lease packet.</p>",
            body_text_content: "Please send the lease packet.",
            parent_folder_id: "inbox",
            is_read: false,
            received_date_time: "2026-01-01T12:00:00Z",
          },
        ],
      });
    });

    afterAll(async () => {
      harness?.restoreFetch();
      await harness?.emulator.close();
    });

    test("creates and reads back an unsent draft with a validated proposal", async () => {
      const source = await harness.provider.getMessage(
        "coastline-source-message",
      );
      expect(source).toBeDefined();

      const proposal = createInboxZeroDraftProposalFromAction({
        accountId: "coastline-account",
        threadId: source!.threadId,
        sourceMessageId: source!.id,
        to: ["owner@example.com"],
        subject: "Re: Lease packet request",
        bodyText: "I will send the lease packet this afternoon.",
        confidence: "high",
        model: "fixture-test",
      });

      const draft = await harness.provider.createDraft({
        to: "owner@example.com",
        subject: proposal.subject,
        messageHtml: `<p>${proposal.body_text}</p>`,
      });

      expect(draft.id).toBeTruthy();
      const readBack = (await harness.graphClient
        .api(`/me/messages/${draft.id}`)
        .get()) as {
        id: string;
        subject?: string;
        isDraft?: boolean;
        parentFolderId?: string;
        toRecipients?: Array<{ emailAddress?: { address?: string } }>;
        body?: { content?: string };
      };

      expect(readBack).toMatchObject({
        id: draft.id,
        subject: proposal.subject,
        isDraft: true,
        parentFolderId: "drafts",
      });
      expect(readBack.toRecipients?.[0]?.emailAddress?.address).toBe(
        "owner@example.com",
      );
      expect(readBack.body?.content).toContain(proposal.body_text);
    });

    test("does not send a Graph mutation for a prohibited Coastline action", async () => {
      const source = await harness.provider.getMessage(
        "coastline-source-message",
      );
      const graphRequests: Array<{ method: string; url: string }> = [];
      const previousFetch = globalThis.fetch;

      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : undefined;
        graphRequests.push({
          method: init?.method ?? request?.method ?? "GET",
          url:
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url,
        });
        return previousFetch(input, init);
      }) as typeof fetch;

      try {
        await expect(
          runActionFunction({
            client: harness.provider,
            email: source!,
            action: {
              id: "coastline-prohibited-send",
              type: ActionType.SEND_EMAIL,
              to: "owner@example.com",
              subject: "Lease packet request",
              content: "This action must never reach Microsoft Graph.",
            },
            emailAccount: {
              id: "coastline-account",
              email: OUTLOOK_EMAIL,
              userId: "coastline-user",
            },
            executedRule: {
              id: "coastline-rule-run",
              threadId: source!.threadId,
              emailAccountId: "coastline-account",
              ruleId: "coastline-rule",
            } as any,
            logger: createTestLogger(),
          }),
        ).rejects.toMatchObject({
          code: "COASTLINE_DRAFT_ONLY_ACTION_BLOCKED",
          actionType: ActionType.SEND_EMAIL,
        });
      } finally {
        globalThis.fetch = previousFetch;
      }

      expect(
        graphRequests.filter(({ method }) =>
          ["POST", "PATCH", "PUT", "DELETE"].includes(method),
        ),
      ).toEqual([]);
    });
  },
);
