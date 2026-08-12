// https://learn.microsoft.com/en-us/graph/permissions-reference

import { env } from "@/env";

const COASTLINE_MICROSOFT_DRAFT_ONLY_SCOPES = [
  "Calendars.ReadWrite",
  "Mail.ReadWrite",
  "User.Read",
  "email",
  "offline_access",
  "openid",
  "profile",
] as const;

const MICROSOFT_SCOPE_ERROR =
  "Microsoft scopes must exactly match the Coastline draft-only allowlist";

export function parseExactMicrosoftScopes(value: string): string[] {
  const scopes = value.split(/[,\s]+/).filter(Boolean).sort();

  if (
    scopes.length !== COASTLINE_MICROSOFT_DRAFT_ONLY_SCOPES.length ||
    scopes.some(
      (scope, index) => scope !== COASTLINE_MICROSOFT_DRAFT_ONLY_SCOPES[index],
    )
  ) {
    throw new Error(MICROSOFT_SCOPE_ERROR);
  }

  return scopes;
}

export const SCOPES = env.COASTLINE_DRAFT_PROPOSALS_ENABLED
  ? COASTLINE_MICROSOFT_DRAFT_ONLY_SCOPES
  : ([
      "openid",
      "profile",
      "email",
      "User.Read",
      "offline_access", // Required for refresh tokens
      "Mail.ReadWrite", // Read and write access to mailbox
      ...(env.NEXT_PUBLIC_EMAIL_SEND_ENABLED ? ["Mail.Send"] : []), // Send emails
    ] as const);

export const CALENDAR_SCOPES = [
  "openid",
  "profile",
  "email",
  "User.Read",
  "offline_access", // Required for refresh tokens
  "Calendars.Read", // Read user calendars
  "Calendars.ReadWrite", // Read and write user calendars
] as const;
