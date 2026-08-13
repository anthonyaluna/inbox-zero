---
title: The Same-Day Response System
description: Internal Coastline operating contract for response matters, drafts, and verified follow-through.
---

# The Same-Day Response System

Inbox Zero is the application runtime for Coastline's internal **Same-Day
Response System**. Coastline Agentic OS supplies the source context, routing,
Plaud adapter, and operating evidence.

## Repository boundary

This application intentionally remains separate from Coastline Agentic OS.

- This repository owns response matters, deadlines, drafting, follow-ups,
  calendar attendee-event execution, registered mailbox actions, and the
  Same-Day Response dashboard.
- Coastline Agentic OS owns source adapters, Plaud and Fyxer integration,
  routing, authority policy, credential references, recovery, and cross-system
  receipts.
- AppFolio, Microsoft 365, SharePoint, OneDrive, Teams, and Plaud remain the
  authoritative source systems for their respective facts.
- The repositories communicate through versioned, sanitized contracts for
  matter context, Plaud evidence, draft proposals, action proposals, and
  execution receipts. Inbox Zero must not reach raw Plaud MCP, AppFolio,
  SharePoint, OneDrive, Teams, or OS credential stores directly.
- No third commercial repository is created at this stage. Productization can
  be evaluated later without changing this internal boundary.

The system manages a response matter from receipt through verified closure. A
same-day response does not promise same-day resolution. It promises that a
legitimate message received Monday through Friday from 8:00 AM through 5:00 PM
Pacific receives a substantive response that either completes the request or
states verified status, accountable owner, next action, and an exact
completion or next-update time. Messages received after the cutoff are due by
the next business day. Configured Coastline holidays are excluded. Emergencies
follow immediate routing.

## Lifecycle

`received -> response_due -> drafted -> responded -> awaiting_action -> update_due -> completed -> verified_closed`

Cases are stored with source message and thread IDs, recipient buckets,
deadline, owner, next action, evidence, commitments, escalation markers, and
terminal proof. A matter is not verified closed until independent completion
evidence is recorded.

## Draft lane

The system drafts legitimate incoming messages, including sensitive matters.
Sensitive, legal, financial, insurance, Fair Housing, habitability, life
safety, client-risk, and high-dollar matters receive
`[Escalate: Hold for Anthony]` when appropriate. They are not suppressed.
Missing facts use `[Confirm: X]` only.

Drafts use Anthony's approved voice contract, deterministic Verdana 10pt HTML,
the verified Outlook signature color and signature HTML, preserved reply-all
recipient buckets, threading, attachments, quoted history, and provider
readback. Email sending is unavailable. The Coastline lane does not request or
use `Mail.Send`.

## Calendar and organization

Clear scheduling requests can create attendee events and invitations after
exact date, time, timezone, attendees, duration, and location facts are
verified. Calendar creation uses durable idempotency, a reservation claim,
provider readback, and a correction path. Ambiguous or conflicting scheduling
facts do not mutate the calendar.

Registered archive, filing, HTTPS unsubscribe, attachment filing, Teams
notification, analytics, and stale unchanged AI-owned draft cleanup lanes use
their existing rollback and independent readback contracts.

## Evidence and monitoring

AppFolio remains authoritative for property and financial facts. Approved
SharePoint and OneDrive documents, Outlook and Teams history, Calendar, and the
Coastline Plaud broker provide bounded context. Transcript evidence outranks a
Plaud summary. Raw transcripts, credentials, presigned URLs, device details,
and unbounded exports never enter prompts, logs, Git, or receipts.

Monitor response deadlines, overdue commitments, updates due, escalation
markers, unsupported-fact blocks, duplicate attempts, readback failures,
verified closures, calendar invitations, and no-send violations. A no-send or
unauthorized provider mutation is a stop-the-line incident. Other failures
remain in autonomous recovery until configured recovery is exhausted.

Protected Azure readiness and live canaries are separate from local tests. A
production claim requires current-SHA protected evidence, immutable receipts,
independent readback, and a completed verified canary for each enabled lane.
