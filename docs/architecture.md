# Architecture

See also: [Product](product.md) · [Deployment](deployment.md)

## Production target

| Layer | Choice |
| --- | --- |
| Application runtime | Vercel (Next.js App Router under `web/`) plus an external scheduler for launch-job ticks |
| System of record | Managed PostgreSQL |
| Email delivery | Spacemail SMTP (`mail.spacemail.com:465`, implicit TLS) |
| Audience model | Local contacts, lists, and campaign recipient snapshots in PostgreSQL |
| DNS | Cloudflare or Spaceship may host DNS and SPF/DKIM/DMARC records for the Spacemail domain |

SendStack submits ordinary MIME messages one recipient at a time. Spacemail owns outbound delivery after SMTP acceptance. There is no provider broadcast API and no delivery webhook.

## Local runtimes

Two runnable surfaces exist in this repository:

1. **Python test build (`app/`)** — dependency-free local server with SQLite, an in-process worker, and sandbox capture by default. Useful for product testing; not the Vercel deployment.
2. **Next.js app (`web/`)** — production-oriented runtime with the same `/api/*` SPA contract, PostgreSQL, and request-scoped campaign processing. This is what deploys to Vercel.

Both default to sandbox delivery. External send paths are fail-closed until explicitly configured and unlocked.

## Production delivery contract

1. SendStack builds an immutable recipient snapshot from active, consented, unsuppressed contacts.
2. A durable launch job advances a cursor over that snapshot.
3. Each tick renders merge fields for a small batch of recipients and submits one SMTP message per recipient to Spacemail.
4. SMTP acceptance is recorded as **submitted**. Inbox delivery, bounces, and complaints are not reported back by Spacemail webhooks.
5. Cancel stops unsent recipients only. Messages Spacemail already accepted cannot be recalled.

Paid Spacemail mailboxes are limited to **500 outgoing messages per hour**. SendStack enforces `SENDSTACK_SMTP_HOURLY_LIMIT` (default 500) alongside the daily volume limit.

## Non-goals

These are intentionally out of scope for the selected architecture:

- Resend Broadcasts, Contacts, Segments, or provider webhooks
- Message-body encryption (PGP / S/MIME)
- Direct-to-MX delivery from SendStack infrastructure
- Long-lived background workers on Vercel for mass send (ticks are short-lived)
- Multi-tenant SaaS in the MVP
- General-purpose mailbox / inbound human email hosting
- Automatic bounce ingestion over IMAP (future work)

## Operating range

Steady-state volume is bounded by the Spacemail mailbox plan (500 messages/hour on paid plans) and `SENDSTACK_DAILY_LIMIT`. Initial volume must use a small consented canary and increase only while suppression and complaint signals remain healthy.
