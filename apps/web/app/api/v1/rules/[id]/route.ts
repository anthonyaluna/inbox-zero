import { NextResponse } from "next/server";
import prisma from "@/utils/prisma";
import { withAccountApiKey } from "@/utils/api-middleware";
import { deleteRule, updateRule } from "@/utils/rule/rule";
import { toRuleWriteInput } from "@/app/api/v1/rules/request";
import { apiRuleSelect, serializeRule } from "@/app/api/v1/rules/serializers";
import {
  rulePathParamsSchema,
  ruleRequestBodySchema,
} from "@/app/api/v1/rules/validation";
import { assertCanUseDigestsIfNeeded } from "@/utils/premium/server";
import { withCoastlineMutationGuard } from "@/utils/coastline/mutation-route-guard";

export const GET = withAccountApiKey(
  "v1/rules/detail",
  ["RULES_READ"],
  async (request, { params }) => {
    const { emailAccountId } = request.apiAuth;
    const routeParams = rulePathParamsSchema.parse(await params);

    const rule = await prisma.rule.findFirst({
      where: { id: routeParams.id, emailAccountId },
      select: apiRuleSelect,
    });

    if (!rule) {
      return NextResponse.json({ error: "Rule not found" }, { status: 404 });
    }

    return NextResponse.json({ rule: serializeRule(rule) });
  },
);

const updateRulePut = withAccountApiKey(
  "v1/rules/update",
  ["RULES_WRITE"],
  async (request, { params }) => {
    const { emailAccountId, provider, userId } = request.apiAuth;
    const routeParams = rulePathParamsSchema.parse(await params);
    const body = ruleRequestBodySchema.parse(await request.json());
    const ruleInput = toRuleWriteInput(body);

    await assertCanUseDigestsIfNeeded(userId, ruleInput.actions);

    const existingRule = await prisma.rule.findFirst({
      where: { id: routeParams.id, emailAccountId },
      select: { id: true },
    });

    if (!existingRule) {
      return NextResponse.json({ error: "Rule not found" }, { status: 404 });
    }

    await updateRule({
      ruleId: routeParams.id,
      result: {
        name: ruleInput.name,
        condition: ruleInput.condition,
        actions: ruleInput.actions,
      },
      emailAccountId,
      provider,
      logger: request.logger,
      runOnThreads: ruleInput.runOnThreads,
    });

    const rule = await prisma.rule.findFirst({
      where: { id: routeParams.id, emailAccountId },
      select: apiRuleSelect,
    });

    return NextResponse.json({ rule: rule ? serializeRule(rule) : null });
  },
);

export const PUT = withCoastlineMutationGuard(
  { surface: "v1/rules/update", mutation: "UPDATE_RULE" },
  updateRulePut,
);

const deleteRuleDelete = withAccountApiKey(
  "v1/rules/delete",
  ["RULES_WRITE"],
  async (request, { params }) => {
    const { emailAccountId } = request.apiAuth;
    const routeParams = rulePathParamsSchema.parse(await params);

    const existingRule = await prisma.rule.findFirst({
      where: { id: routeParams.id, emailAccountId },
      select: { groupId: true },
    });

    if (!existingRule) {
      return NextResponse.json({ error: "Rule not found" }, { status: 404 });
    }

    await deleteRule({
      emailAccountId,
      ruleId: routeParams.id,
      groupId: existingRule.groupId,
    });

    return new Response(null, { status: 204 });
  },
);

export const DELETE = withCoastlineMutationGuard(
  { surface: "v1/rules/delete", mutation: "DELETE_RULE" },
  deleteRuleDelete,
);
