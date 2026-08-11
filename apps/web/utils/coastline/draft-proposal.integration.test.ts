import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createOutlookTestHarness,
  type OutlookTestHarness,
} from "@/__tests__/integration/helpers";
import { createInboxZeroDraftProposalFromAction } from "@/utils/coastline/draft-proposal";

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
  },
);
