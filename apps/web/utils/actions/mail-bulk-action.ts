"use server";

import { actionClient } from "@/utils/actions/safe-action";
import { bulkSenderActionSchema } from "@/utils/actions/mail-bulk-action.validation";
import { createEmailProvider } from "@/utils/email/provider";
import { env } from "@/env";
import { assertCoastlineMutationAllowed } from "@/utils/coastline/draft-only-policy";

export const bulkArchiveAction = actionClient
  .metadata({ name: "bulkArchive" })
  .inputSchema(bulkSenderActionSchema)
  .action(
    async ({
      ctx: { emailAccountId, provider, emailAccount, logger },
      parsedInput: { froms },
    }) => {
      assertCoastlineMutationAllowed({
        surface: "server-action/bulk-archive",
        mutation: "BULK_ARCHIVE",
        coastlineDraftProposalsEnabled: env.COASTLINE_DRAFT_PROPOSALS_ENABLED,
      });
      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });

      await emailProvider.bulkArchiveFromSenders(
        froms,
        emailAccount.email,
        emailAccountId,
      );
    },
  );

export const bulkTrashAction = actionClient
  .metadata({ name: "bulkTrash" })
  .inputSchema(bulkSenderActionSchema)
  .action(
    async ({
      ctx: { emailAccountId, provider, emailAccount, logger },
      parsedInput: { froms },
    }) => {
      assertCoastlineMutationAllowed({
        surface: "server-action/bulk-trash",
        mutation: "BULK_TRASH",
        coastlineDraftProposalsEnabled: env.COASTLINE_DRAFT_PROPOSALS_ENABLED,
      });
      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });

      await emailProvider.bulkTrashFromSenders(
        froms,
        emailAccount.email,
        emailAccountId,
      );
    },
  );
