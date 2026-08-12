import { type NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import {
  assertCoastlineMutationAllowed,
  CoastlineDraftOnlyPolicyError,
} from "@/utils/coastline/draft-only-policy";

type RouteHandler = (
  request: NextRequest,
  context: unknown,
) => Response | Promise<Response>;

/**
 * Reject a direct REST mutation before its auth/provider middleware, request
 * body parsing, or persistence work starts when Coastline draft-only mode is
 * active. Keep the guard outside the route middleware stack.
 */
export function withCoastlineMutationGuard<T extends RouteHandler>(
  {
    surface,
    mutation,
  }: {
    surface: string;
    mutation: string;
  },
  handler: T,
): T {
  return (async (request: NextRequest, context: unknown) => {
    try {
      assertCoastlineMutationAllowed({
        surface,
        mutation,
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

    return handler(request, context);
  }) as T;
}
