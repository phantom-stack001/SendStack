# Production handover: Vercel + PostgreSQL + Spacemail SMTP

See also: [Architecture](architecture.md) · [Product](product.md) · [`web/README.md`](../web/README.md)

## Decision

SendStack's selected production architecture is:

- **Application runtime:** Vercel (plus an external scheduler for launch-job ticks)
- **System of record:** managed PostgreSQL
- **Email delivery:** Spacemail SMTP (`mail.spacemail.com:465`, implicit TLS)
- **Audience model:** Local contacts, lists, and campaign recipient snapshots
- **DNS:** Cloudflare or Spaceship may host DNS and Spacemail SPF/DKIM/DMARC records

The Python test build under `app/` remains a local sandbox environment (SQLite, in-process queue). It is safe for product testing. Use `web/` for the Vercel path.

## Production delivery contract

1. SendStack creates an immutable recipient snapshot from active, unsuppressed contacts.
2. A durable launch job advances over that snapshot in small chunks.
3. Each tick renders personalization and submits one ordinary MIME message per list address through Spacemail SMTP (mailbox From and envelope, single To, Spacemail Message-ID).
4. SMTP acceptance is **submitted**; a copy is appended to Sent when IMAP works. Deliveries is the local log; Mailbox shows Inbox and Sent from Spacemail.
5. Cancel stops unsent recipients only. Messages Spacemail already accepted cannot be recalled.

## Fastest safe implementation sequence

### 1. Preserve the working test build

- Keep sandbox as the default and keep all external delivery fail-closed.
- Preserve the four composer formats: Visual builder, Rich text, Custom HTML, and Plain text.
- Freeze the current SQLite data before migration and record table counts and checksums.

### 2. Move the runtime and database

- Refactor the HTTP entry point for request-scoped Vercel execution without changing the existing `/api/*` browser contract.
- Move static files to the Vercel static output directory.
- Replace SQLite with pooled PostgreSQL connections and transactional state changes.
- Move login throttling, sessions, launch locks, and all queue state out of process memory.
- Add repeatable migrations and a one-time SQLite-to-PostgreSQL import with reconciliation.

### 3. Spacemail SMTP client boundary

- Keep sandbox for local, preview, and automated tests.
- Authenticate to `mail.spacemail.com` on port 465 with the mailbox username and password.
- Send one recipient per message from that mailbox (From and envelope match `SENDSTACK_SMTP_USERNAME`); store Spacemail’s Message-ID as `provider_id` on acceptance.
- Require `SENDSTACK_FROM_EMAIL` to match the Spacemail mailbox. Reply-To is optional on the campaign.
- Append accepted messages to the IMAP Sent folder; expose Inbox and Sent under Mailbox.
- Enforce daily and hourly volume caps (`SENDSTACK_DAILY_LIMIT`, `SENDSTACK_SMTP_HOURLY_LIMIT`).
- Render personalization tokens locally before SMTP submit.

### 4. Feedback and suppression

- Spacemail does not report bounces or complaints. Live outcomes are submitted or failed.
- Global unsubscribe links and manual suppressions continue to write local exclusions.
- Automatic bounce classification from IMAP is out of scope for this handover.

### 5. Unlock live delivery only after verification

- Verify the Spacemail mailbox and DNS (SPF/DKIM/DMARC) for the sending domain.
- Complete backup and restore testing.
- Remove the default administrator password and require secure cookies over HTTPS.
- Configure an external scheduler to hit `GET /api/cron/launch-jobs` every minute with `CRON_SECRET`.
- Run a small internal canary before increasing volume.

## Server-only production configuration

The production implementation should consume these Vercel environment variables. Preview deployments must remain in sandbox mode and must not receive production SMTP credentials.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Pooled managed PostgreSQL connection |
| `SENDSTACK_SMTP_HOST` | SMTP host (`mail.spacemail.com`) |
| `SENDSTACK_SMTP_PORT` | SMTP port (`465` for implicit TLS) |
| `SENDSTACK_SMTP_USERNAME` | Full Spacemail mailbox address |
| `SENDSTACK_SMTP_PASSWORD` | Mailbox password (also used for IMAP) |
| `SENDSTACK_IMAP_HOST` | IMAP host (default `mail.spacemail.com`) |
| `SENDSTACK_IMAP_PORT` | IMAP port (default `993`) |
| `SENDSTACK_SMTP_HOURLY_LIMIT` | Hourly outbound cap (default 500) |
| `SENDSTACK_PUBLIC_URL` | HTTPS production origin used in links and callbacks |
| `SENDSTACK_SESSION_SECRET` | Production session signing/encryption secret |
| `SENDSTACK_FROM_EMAIL` | Must match `SENDSTACK_SMTP_USERNAME` (the Spacemail mailbox) |
| `SENDSTACK_REPLY_TO_EMAIL` | Optional default Reply-To preference (not forced onto every message) |
| `SENDSTACK_ALLOWED_LINK_DOMAINS` | Optional HTTP(S) link host allowlist; empty allows any https host |
| `SENDSTACK_TEST_RECIPIENT_ALLOWLIST` | Exact addresses permitted for administrator live test sends |
| `SENDSTACK_DAILY_LIMIT` | Daily volume cap across direct, test, and campaign recipient paths |
| `SENDSTACK_LIVE_SEND_ENABLED` | Explicit kill switch; default must be `false` |
| `CRON_SECRET` | Bearer secret for authenticated launch-job ticks |

If live send is enabled but identity/SMTP settings are incomplete, the app still boots (login and session keep working). Issues are logged at startup; readiness and send APIs keep live mail blocked until the gaps are fixed.

## Launch gates

Live sending stays locked until every item below passes:

- PostgreSQL migration preserves row counts, IDs, consent, memberships, campaign content, statuses, and suppressions.
- Concurrent launch requests create at most one active launch job per campaign.
- A dry run against a fake SMTP sender produces no missing or duplicate recipients.
- Production and preview secrets are isolated; no SMTP password appears in responses, browser bundles, logs, or audit details.
- The From address is enforced server-side and must be the Spacemail mailbox.
- A tested emergency stop prevents new SMTP submits.
- A controlled canary confirms SMTP acceptance and unsubscribe.

## Volume ramp

Steady-state volume is bounded by the Spacemail mailbox plan (**500 messages/hour** on paid plans) and `SENDSTACK_DAILY_LIMIT`. Treat higher marketing targets as requiring a different delivery product.

Start with a small, engaged segment. Increase volume only when authentication is valid and SMTP acceptance failures and manual suppressions remain healthy. Stop automatically when a safety threshold is exceeded.

## Product behavior that changes in production

- **Pause/resume:** local sandbox delivery may pause. Cancel stops unsent recipients; accepted SMTP messages cannot be recalled.
- **Queue:** SendStack owns the launch-job cursor; Spacemail accepts each message over SMTP.
- **Deliveries:** local captures remain available for testing. Live status means Spacemail accepted the message.
- **Unsubscribe:** SendStack unsubscribe links remain authoritative and write the global suppression list.
