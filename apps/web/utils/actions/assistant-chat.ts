"use server";

import { actionClient } from "@/utils/actions/safe-action";
import {
  confirmAssistantCreateRuleBody,
  confirmAssistantEmailActionBody,
  confirmAssistantSaveMemoryBody,
} from "./assistant-chat.validation";
import {
  confirmAssistantCreateRuleForAccount,
  confirmAssistantEmailActionForAccount,
  confirmAssistantSaveMemoryForAccount,
} from "./assistant-chat-confirmation";
import { env } from "@/env";
import { assertCoastlineMutationAllowed } from "@/utils/coastline/draft-only-policy";

export const confirmAssistantEmailAction = actionClient
  .metadata({ name: "confirmAssistantEmail" })
  .inputSchema(confirmAssistantEmailActionBody)
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: {
        chatId,
        chatMessageId,
        toolCallId,
        actionType,
        contentOverride,
      },
    }) => {
      assertCoastlineMutationAllowed({
        surface: "server-action/confirm-assistant-email",
        mutation: "CONFIRM_ASSISTANT_EMAIL_ACTION",
        coastlineDraftProposalsEnabled: env.COASTLINE_DRAFT_PROPOSALS_ENABLED,
      });
      return confirmAssistantEmailActionForAccount({
        chatId,
        chatMessageId,
        toolCallId,
        actionType,
        contentOverride,
        waitForPersistence: true,
        emailAccountId,
        provider,
        logger,
      });
    },
  );

export const confirmAssistantCreateRule = actionClient
  .metadata({ name: "confirmAssistantCreateRule" })
  .inputSchema(confirmAssistantCreateRuleBody)
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { chatId, chatMessageId, toolCallId },
    }) => {
      assertCoastlineMutationAllowed({
        surface: "server-action/confirm-assistant-create-rule",
        mutation: "CONFIRM_ASSISTANT_CREATE_RULE",
        coastlineDraftProposalsEnabled: env.COASTLINE_DRAFT_PROPOSALS_ENABLED,
      });
      return confirmAssistantCreateRuleForAccount({
        chatId,
        chatMessageId,
        toolCallId,
        waitForPersistence: true,
        emailAccountId,
        provider,
        logger,
      });
    },
  );

export const confirmAssistantSaveMemory = actionClient
  .metadata({ name: "confirmAssistantSaveMemory" })
  .inputSchema(confirmAssistantSaveMemoryBody)
  .action(
    async ({
      ctx: { emailAccountId, logger },
      parsedInput: { chatId, chatMessageId, toolCallId },
    }) =>
      confirmAssistantSaveMemoryForAccount({
        chatId,
        chatMessageId,
        toolCallId,
        waitForPersistence: true,
        emailAccountId,
        logger,
      }),
  );
