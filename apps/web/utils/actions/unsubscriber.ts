"use server";

import {
  setSenderStatusBody,
  unsubscribeSenderBody,
} from "@/utils/actions/unsubscriber.validation";
import { actionClient } from "@/utils/actions/safe-action";
import { createEmailProvider } from "@/utils/email/provider";
import {
  setSenderStatusWithAutoArchive,
  unsubscribeSenderAndMark,
} from "@/utils/senders/unsubscribe";
import { env } from "@/env";
import { assertCoastlineMutationAllowed } from "@/utils/coastline/draft-only-policy";

export const setSenderStatusAction = actionClient
  .metadata({ name: "setSenderStatus", mutation: "SET_SENDER_STATUS" })
  .inputSchema(setSenderStatusBody)
  .action(
    async ({
      parsedInput: { senderEmail, status, labelId, labelName },
      ctx: { emailAccountId, provider, logger },
    }) => {
      assertCoastlineMutationAllowed({
        surface: "server-action/set-sender-status",
        mutation: "SET_SENDER_STATUS",
        coastlineDraftProposalsEnabled: env.COASTLINE_DRAFT_PROPOSALS_ENABLED,
      });
      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });

      return setSenderStatusWithAutoArchive({
        emailAccountId,
        emailProvider,
        senderEmail,
        status,
        labelId,
        labelName,
      });
    },
  );

export const unsubscribeSenderAction = actionClient
  .metadata({ name: "unsubscribeSender", mutation: "UNSUBSCRIBE" })
  .inputSchema(unsubscribeSenderBody)
  .action(
    async ({
      parsedInput: { senderEmail, unsubscribeLink, listUnsubscribeHeader },
      ctx: { emailAccountId, logger },
    }) => {
      assertCoastlineMutationAllowed({
        surface: "server-action/unsubscribe-sender",
        mutation: "UNSUBSCRIBE",
        coastlineDraftProposalsEnabled: env.COASTLINE_DRAFT_PROPOSALS_ENABLED,
      });
      return unsubscribeSenderAndMark({
        emailAccountId,
        senderEmail,
        unsubscribeLink,
        listUnsubscribeHeader,
        logger,
      });
    },
  );
