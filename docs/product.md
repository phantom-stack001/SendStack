# Product overview

See also: [Architecture](architecture.md) · [Deployment](deployment.md)

## Purpose

SendStack is a marketing email workspace for campaign management, audience handling, and controlled outbound delivery. The MVP is a single-client application: users manage contacts and lists, author campaigns, launch sends through Spacemail SMTP, and inspect submission and suppression history.

Production delivery submits **one ordinary Spacemail SMTP message per list address** from the authenticated mailbox (the same path as a Spacemail mail client). Local and preview environments stay sandboxed by default so no external email is sent until live send is explicitly unlocked.

## Goals

- Import and organize contacts by email address and list membership.
- Author campaigns in Visual builder, Rich text, Custom HTML, or Plain text, with optional merge fields and preview.
- Queue and send campaigns without blocking the web UI; in production, each list address is submitted as its own Spacemail SMTP message from the mailbox (authored body only — optional Reply-To, no SendStack Message-ID or List-Unsubscribe headers).
- Read the Spacemail mailbox Inbox and Sent folders over IMAP; Deliveries remains the local send log.
- Enforce manual and server-side suppressions before every send. An opt-out link (`{{unsubscribe_url}}`) is optional; existing bounce and complaint suppressions stay protected.
- Keep auditable campaign, delivery, and administrative history.
- Hand over a deployable Vercel + PostgreSQL application the client can operate.

## Roles

Permissions are enforced on every protected API route. Hiding a control in the UI is only a usability aid.

| Role | Access |
| --- | --- |
| **Administrator** | Full access: users, roles, audit history, suppressions, and campaign launch |
| **Marketer** | Lists, contacts, campaign drafts and previews, deliveries, and manual suppressions; cannot launch delivery, manage users, or read the audit log |
| **Analyst** | Read-only overview, list totals, and campaign reporting without recipient-level contact, delivery, or suppression data |

Administrators can create, update, disable, reactivate, and reset users. User deletion is unavailable so ownership and audit history remain intact. Role, status, and password changes revoke the affected user’s sessions. An administrator cannot demote or disable their own account.

## Core modules

| Module | Purpose |
| --- | --- |
| Contacts & lists | Audience membership, CSV import by email, deduplication |
| Campaigns | Authoring, test sends, launch, pause/cancel where supported |
| Delivery | Sandbox capture locally; Spacemail SMTP acceptance in production |
| Mailbox | Read-only Inbox and Sent from the Spacemail mailbox (IMAP) |
| Suppressions | Global unsubscribe and manual blocks; protected bounce/complaint rows when present |
| Reporting | Campaign totals, submission history, queue state |
| Administration | Users, roles, sessions, audit log, sending setup |

## MVP boundaries

In scope: campaign management, email audiences, sandbox and Spacemail SMTP send, Spacemail Inbox/Sent read, suppressions, reporting, and admin controls.

Out of scope for MVP: multi-tenant SaaS, CRM, SMS/WhatsApp, complex journey automation, composing replies inside SendStack, automatic IMAP bounce classification, and self-hosted direct-to-MX MTA operation.

## Safety defaults

- Sandbox is the default transport; messages are captured locally and are not delivered.
- Live Spacemail SMTP requires the mailbox credentials, `SENDSTACK_FROM_EMAIL` matching that mailbox, launch-job cron, and `SENDSTACK_LIVE_SEND_ENABLED=true`.
- Preview deployments must not receive production SMTP credentials and cannot unlock live send.
- SMTP mode is fail-closed: implicit TLS on port 465, mailbox From and envelope, hourly/daily caps, and an exact allowlist for administrator test sends.
- Outbound mail matches normal Spacemail compose (From, To, Subject, body; optional campaign Reply-To). Hourly and daily caps are the volume brakes.
- Suppressions remain server-side whether or not the author includes an opt-out link.
- Spacemail does not report inbox delivery, bounces, or complaints back to this workspace. Live outcomes are submitted or failed.
