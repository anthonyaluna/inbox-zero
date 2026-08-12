import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createRuleBody,
  type CreateRuleBody,
} from "@/utils/actions/rule.validation";
import { createRuleAction } from "@/utils/actions/rule";
import { withEmailAccount } from "@/utils/middleware";
import { aiPromptToRules } from "@/utils/ai/rule/prompt-to-rules";
import { getEmailAccountWithAi } from "@/utils/user/get";
import { toCreateRuleBodyFromAiRule } from "@/utils/rule/mobile-rule";
import { env } from "@/env";
import {
  assertCoastlineMutationAllowed,
  CoastlineDraftOnlyPolicyError,
} from "@/utils/coastline/draft-only-policy";

export const maxDuration = 120;

const bodySchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("prompt"),
    prompt: z.string().trim().min(1).max(4000),
  }),
  z.object({
    source: z.literal("manual"),
    rule: createRuleBody,
  }),
]);

const createRulePost = withEmailAccount("mobile/rules/create", async (request) => {
  const body = bodySchema.parse(await request.json());
  const emailAccountId = request.auth.emailAccountId;

  let ruleInput: CreateRuleBody;
  if (body.source === "manual") {
    ruleInput = body.rule;
  } else {
    const emailAccount = await getEmailAccountWithAi({ emailAccountId });
    if (!emailAccount) {
      return NextResponse.json(
        { error: "Email account not found" },
        { status: 404 },
      );
    }

    const generatedRules = await aiPromptToRules({
      emailAccount,
      promptFile: body.prompt,
    });
    if (generatedRules.length !== 1) {
      return NextResponse.json(
        { error: "Describe one rule at a time." },
        { status: 422 },
      );
    }

    ruleInput = toCreateRuleBodyFromAiRule(generatedRules[0]);
  }

  const result = await createRuleAction(emailAccountId, ruleInput);
  if (result?.serverError) {
    return NextResponse.json({ error: result.serverError }, { status: 400 });
  }
  if (!result?.data?.rule) {
    return NextResponse.json(
      { error: "Could not create rule" },
      { status: 500 },
    );
  }

  return NextResponse.json({ rule: result.data.rule }, { status: 201 });
});

export const POST: typeof createRulePost = async (request, context) => {
  try {
    assertCoastlineMutationAllowed({
      surface: "mobile/rules/create",
      mutation: "CREATE_RULE",
      coastlineDraftProposalsEnabled: env.COASTLINE_DRAFT_PROPOSALS_ENABLED,
    });
  } catch (error) {
    if (error instanceof CoastlineDraftOnlyPolicyError) {
      return NextResponse.json(
        { error: error.message, errorCode: error.code, isKnownError: true },
        { status: 400 },
      );
    }
    throw error;
  }

  return createRulePost(request, context);
};
