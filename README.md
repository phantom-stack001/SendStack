# SendStack

SendStack is a bulk compose-and-queue UI on top of **Spacemail SMTP**. Each list address gets its own ordinary SMTP submit — From, To, Subject, body, and optional Reply-To — the same fields you would send from the Spacemail web UI.

Production delivery is **Vercel + managed PostgreSQL + Spacemail SMTP**. Local and preview environments stay sandboxed by default until live send is unlocked.

## Documentation

| Document | Purpose |
| --- | --- |
| [`docs/product.md`](docs/product.md) | Goals, roles, modules, and MVP boundaries |
| [`docs/architecture.md`](docs/architecture.md) | Stack and delivery contract |
| [`docs/deployment.md`](docs/deployment.md) | Vercel handover, launch gates, and env vars |
| [`web/README.md`](web/README.md) | Next.js app setup and Vercel deploy checklist |

## Run locally

```bash
cd web
cp .env.example .env.local
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open <http://localhost:3000>. See [`web/README.md`](web/README.md) for the Vercel Root Directory (`web`), production checklist, Spacemail SMTP env vars, and the live-send kill switch (`SENDSTACK_LIVE_SEND_ENABLED`, default `false`).

## What it does

- Secure sign-in, expiring sessions, CSRF checks, and role-aware writes
- Contact entry, CSV import, deduplication, and lists
- Campaign authoring (Visual, Rich text, Custom HTML, or Plain text) with optional merge fields and preview
- Queue and launch: one Spacemail SMTP message per list address
- Hourly and daily volume caps, suppressions, and a live-send kill switch
- Optional `{{unsubscribe_url}}` only when you insert it; no forced List-Unsubscribe headers
- Mailbox (Inbox/Sent over IMAP), delivery log, audit history, and admin users

The default transport is `sandbox`. “Sandboxed” means captured locally; it does not mean delivered. Live “submitted” means Spacemail accepted the message over SMTP, not that it reached an inbox.

## Roles and permissions

- **Administrator:** full access, including users, roles, audit history, and simulated delivery feedback.
- **Marketer:** manages lists, contacts, campaign drafts and previews, deliveries, and manual suppressions. Cannot launch delivery, manage users, or read the audit log.
- **Analyst:** read-only overview, sending readiness, list totals, and campaign reporting without recipient-level contact, delivery, or suppression data.

## CSV format

The only required column is `email`. Optional columns are `first_name` and `last_name`.

```csv
email,first_name,last_name
person@example.test,Pat,Lee
```

## Automated checks

```bash
cd web && pnpm test
# Disposable Postgres (see web/README.md):
# pnpm test:pg
```

## Production delivery (Spacemail SMTP)

1. Vercel hosts the web application and request-scoped API.
2. Managed PostgreSQL stores users, lists, immutable recipient snapshots, delivery rows, and suppressions.
3. A durable launch job submits **one ordinary MIME message per list address** through Spacemail SMTP (`mail.spacemail.com:465`), authenticated as the mailbox.
4. SMTP acceptance is recorded as submitted and a copy is filed in the mailbox Sent folder when IMAP works.
5. An external scheduler ticks `GET /api/cron/launch-jobs` so campaigns progress without a long-lived Vercel worker.

Sandbox remains the default. Live send stays locked behind `SENDSTACK_LIVE_SEND_ENABLED` (default `false`), Spacemail credentials, identity settings, and the emergency stop. `SENDSTACK_FROM_EMAIL` must match `SENDSTACK_SMTP_USERNAME`.

Steady-state volume is bounded by the Spacemail mailbox plan (500 messages/hour on paid plans) and `SENDSTACK_DAILY_LIMIT`.

See [`docs/architecture.md`](docs/architecture.md) and [`docs/deployment.md`](docs/deployment.md) for the full contract and handover checklist.
