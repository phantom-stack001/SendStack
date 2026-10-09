# SendStack web (Vercel)

Next.js App Router runtime that preserves the existing `/api/*` SPA contract and targets
**Vercel + managed PostgreSQL + Spacemail SMTP**.

The Python test build under `../app` remains available for local comparison. This `web/`
app is the production-oriented runtime. Project docs: [`../docs/`](../docs/).

## Prerequisites

- Node.js 20+
- pnpm
- A PostgreSQL database (`DATABASE_URL`)

## Setup

```bash
cd web
cp .env.example .env.local
# edit DATABASE_URL and SENDSTACK_SESSION_SECRET
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open http://localhost:3000 and sign in. Default local seed credentials (when used) force a password change.

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Local Next.js server |
| `pnpm build` | Production build |
| `pnpm db:migrate` | Apply incremental SQL migrations |
| `pnpm db:seed` | Seed admin + sample `.test` contacts |
| `pnpm test` | Unit/safe suite (never uses `DATABASE_URL` for destructive PG work) |
| `pnpm test:pg` | PostgreSQL integration/migration suite (**requires** `SENDSTACK_TEST_DATABASE_URL`) |

### PostgreSQL test safety

Destructive Postgres tests **never** fall back to `DATABASE_URL`. They require an explicit disposable URL:

```bash
# Database name must include a `_test` marker (e.g. sendstack_test), or
# append ?sendstack_disposable=1
export SENDSTACK_TEST_DATABASE_URL='postgresql://sendstack:sendstack@127.0.0.1:55432/sendstack_test'
cd web && pnpm test:pg
```

Ordinary `pnpm test` skips PG suites when `SENDSTACK_TEST_DATABASE_URL` is unset and will not wipe or migrate the application database from `.env`.

To provision the documented disposable database locally:

```bash
# from repository root
docker compose -f docker-compose.test.yml up -d
export SENDSTACK_TEST_DATABASE_URL='postgresql://sendstack:sendstack@127.0.0.1:55432/sendstack_test'
cd web && pnpm test:pg
```

Never set application `DATABASE_URL` to the disposable test database.

## Delivery modes

- **Sandbox (default):** campaign launch processes recipients inside the request and writes local `messages` rows. No external email is sent.
- **Live Spacemail SMTP:** each list address is submitted as its own ordinary SMTP message from the authenticated mailbox (From, To, Subject, body — same as Spacemail webmail). Requires `SENDSTACK_SMTP_HOST`, `SENDSTACK_SMTP_USERNAME`, `SENDSTACK_SMTP_PASSWORD`, `SENDSTACK_DELIVERY_MODE=smtp`, `SENDSTACK_FROM_EMAIL` matching the mailbox, `CRON_SECRET`, and `SENDSTACK_LIVE_SEND_ENABLED=true`. Reply-To and link-domain allowlists are optional. After accept, a copy is appended to Sent. **Mailbox** reads Inbox and Sent over IMAP (`SENDSTACK_IMAP_HOST`, default `mail.spacemail.com:993`) using the same credentials; reading does not require live send to be unlocked. Preview deployments cannot open SMTP or IMAP. Apply migrations through `0008_drop_consent_gate.sql` before live send.

## Vercel deploy checklist

1. Create a Vercel project with **Root Directory** set to `web` (use `web/vercel.json`).
2. Provision managed Postgres and set `DATABASE_URL`.
3. Set a strong `SENDSTACK_SESSION_SECRET` (≥32 chars, not the example default).
4. Set `SENDSTACK_PUBLIC_URL` to the HTTPS production origin.
5. Run `pnpm db:migrate` against production (and seed only with a non-default admin password). This applies all SQL under `drizzle/`, including `0003_campaign_attachments.sql` required for campaign file attachments.
6. Deploy. Each build stamps `/app.js` and `/styles.css` with the git commit and serves the SPA shell with `Cache-Control: no-store`, so browsers pick up new UI after a push. Confirm `/healthz` returns ok.
7. Add Spacemail SMTP credentials when ready; leave `SENDSTACK_LIVE_SEND_ENABLED=false` until the mailbox, DNS, and launch-job cron are verified.
8. Point an external scheduler at `GET /api/cron/launch-jobs` with `Authorization: Bearer ${CRON_SECRET}` every minute.

Preview deployments must not receive production SMTP credentials.

## DNS

DNS may remain with Cloudflare or Spaceship for the app hostname and Spacemail SPF/DKIM/DMARC records. It does not host this runtime.

## Production guards built into this app

- Startup env validation fails loudly in production on missing DB/session secret; incomplete live-send identity/provider settings are logged only (send paths stay locked)
- Secure cookies auto-enable on Vercel production / HTTPS public URL
- Preview environments cannot unlock live send
- Default admin password requires change before mutating APIs
- Migrations are tracked in `schema_migrations` and are idempotent
