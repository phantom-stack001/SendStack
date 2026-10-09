# Production handover: Vercel + PostgreSQL + Spacemail SMTP

See also: [Architecture](architecture.md) · [Product](product.md) · [`web/README.md`](../web/README.md)

## Decision

SendStack's selected production architecture is:

- **Application runtime:** Vercel (plus an external scheduler for launch-job ticks)
- **System of record:** managed PostgreSQL
- **Email delivery:** Spacemail SMTP (`mail.spacemail.com:465`, implicit TLS)
- **Audience model:** Local contacts, lists, and campaign recipient snapshots
- **DNS:** Cloudflare or Spaceship may host DNS and Spacemail SPF/DKIM/DMARC records

Use `web/` for local development and Vercel deployment.

## Production delivery contract

1. SendStack creates an immutable recipient snapshot from active, unsuppressed contacts.
2. A durable launch job advances over that snapshot in small chunks.
3. Each tick renders personalization and submits one ordinary MIME message per list address through Spacemail SMTP (mailbox From and envelope, single To, Spacemail Message-ID).
4. SMTP acceptance is **submitted**; a copy is appended to Sent when IMAP works. Deliveries is the local log; Mailbox shows Inbox and Sent from Spacemail.
5. Cancel stops unsent recipients only. Messages Spacemail already accepted cannot be recalled.

## Spacemail SMTP client boundary

- Keep sandbox for local, preview, and automated tests.
- Authenticate to `mail.spacemail.com` on port 465 with the mailbox username and password.
- Send one recipient per message from that mailbox (From and envelope match `SENDSTACK_SMTP_USERNAME`); store Spacemail’s Message-ID as `provider_id` on acceptance.
- Require `SENDSTACK_FROM_EMAIL` to match the Spacemail mailbox. Reply-To is optional on the campaign.
- Append accepted messages to the IMAP Sent folder; expose Inbox and Sent under Mailbox.
- Enforce daily and hourly volume caps (`SENDSTACK_DAILY_LIMIT`, `SENDSTACK_SMTP_HOURLY_LIMIT`).
- Mint `/u/` opt-out tokens only when the author included `{{unsubscribe_url}}`.

## Feedback and suppression

- Spacemail does not report bounces or complaints. Live outcomes are submitted or failed.
- Manual suppressions and optional unsubscribe links write local exclusions.
- Automatic bounce classification from IMAP is out of scope.

## Server-only production configuration

Preview deployments must remain in sandbox mode and must not receive production SMTP credentials.

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
| `SENDSTACK_PUBLIC_URL` | HTTPS production origin used in opt-out links when present |
| `SENDSTACK_SESSION_SECRET` | Production session signing/encryption secret |
| `SENDSTACK_FROM_EMAIL` | Must match `SENDSTACK_SMTP_USERNAME` (the Spacemail mailbox) |
| `SENDSTACK_REPLY_TO_EMAIL` | Optional default Reply-To preference (not forced onto every message) |
| `SENDSTACK_ALLOWED_LINK_DOMAINS` | Optional HTTP(S) link host allowlist; empty allows any https host |
| `SENDSTACK_TEST_RECIPIENT_ALLOWLIST` | Exact addresses permitted for administrator live test sends |
| `SENDSTACK_DAILY_LIMIT` | Daily volume cap |
| `SENDSTACK_LIVE_SEND_ENABLED` | Explicit kill switch; default must be `false` |
| `SENDSTACK_EMERGENCY_STOP` | Hard stop for new SMTP submits |
| `CRON_SECRET` | Bearer secret for authenticated launch-job ticks |

If live send is enabled but identity/SMTP settings are incomplete, the app still boots. Issues are logged at startup; readiness and send APIs keep live mail blocked until the gaps are fixed.

## Launch gates

Live sending stays locked until:

- Migrations through `0009_spacemail_parity.sql` are applied.
- Concurrent launch requests create at most one active launch job per campaign.
- Production and preview secrets are isolated; no SMTP password appears in responses, browser bundles, logs, or audit details.
- The From address is enforced server-side and must be the Spacemail mailbox.
- A tested emergency stop prevents new SMTP submits.
- A controlled canary confirms SMTP acceptance.

## Volume

Steady-state volume is bounded by the Spacemail mailbox plan (**500 messages/hour** on paid plans) and `SENDSTACK_DAILY_LIMIT`. Launch is blocked by emergency stop and unresolved queue issues, not by ESP bounce/complaint/unsubscribe rate thresholds (Spacemail does not provide those webhooks).

## Product behavior

- **Pause/resume:** local sandbox delivery may pause. Cancel stops unsent recipients; accepted SMTP messages cannot be recalled.
- **Queue:** SendStack owns the launch-job cursor; Spacemail accepts each message over SMTP.
- **Deliveries:** local captures remain available for testing. Live status means Spacemail accepted the message.
- **Unsubscribe:** only when the campaign includes `{{unsubscribe_url}}`; those links write the global suppression list.
