import { NextResponse } from "next/server";
import { withEmailProvider } from "@/utils/middleware";
import { z } from "zod";
import { withCoastlineMutationGuard } from "@/utils/coastline/mutation-route-guard";

const createLabelBody = z.object({
  name: z.string(),
  description: z.string().nullish(),
});

export const maxDuration = 15;

const createLabelPost = withEmailProvider(async (request) => {
  const { emailProvider } = request;
  const body = await request.json();
  const { name, description } = createLabelBody.parse(body);

  const label = await emailProvider.createLabel(
    name,
    description ? description : undefined,
  );

  return NextResponse.json({ label });
});

export const POST = withCoastlineMutationGuard(
  { surface: "labels/create", mutation: "CREATE_LABEL" },
  createLabelPost,
);
