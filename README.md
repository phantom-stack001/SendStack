# SendStack

This repository contains a runnable, dependency-free test build of the SendStack email marketing platform, plus a production-oriented Next.js app under `web/`. It is intentionally safe by default: messages are captured inside the application and no external email is sent.

Production delivery is **Vercel + managed PostgreSQL + Spacemail SMTP**. Each list address receives its own ordinary SMTP message from the Spacemail mailbox. Local and preview environments stay sandboxed by default until live send is unlocked.

## Documentation

| Document | Purpose |
| --- | --- |
| [`docs/product.md`](docs/product.md) | Goals, roles, modules, and MVP boundaries |
| [`docs/architecture.md`](docs/architecture.md) | Production and local stacks, delivery contract |
| [`docs/deployment.md`](docs/deployment.md) | Vercel handover, launch gates, and env vars |
| [`web/README.md`](web/README.md) | Next.js app setup and Vercel deploy checklist |

## Run it now (legacy Python test build)

Requirements: Python 3.11 or newer.

```bash
./scripts/start.sh
```

Open <http://localhost:8080> and sign in with:

- Email: `admin@sendstack.local`
- Password: `ChangeMe123!`

The test build starts with three synthetic contacts on the reserved `.test` domain.

## Vercel app (`web/`)

The production-oriented runtime lives in [`web/`](web/). It is a Next.js App Router app that keeps the same SPA and `/api/*` contract, uses PostgreSQL, and processes sandbox campaigns without a long-lived worker.

```bash
cd web
cp .env.example .env.local
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open <http://localhost:3000>. See [`web/README.md`](web/README.md) for the Vercel Root Directory (`web`), production checklist, Spacemail SMTP env vars, and the live-send kill switch (`SENDSTACK_LIVE_SEND_ENABLED`, default `false`).

The Python server above remains the dependency-free local reference build; it is not the Vercel deployment.

## What can be tested

- Secure sign-in, expiring sessions, CSRF checks, and role-aware writes
- Contact entry, CSV import, deduplication, lists, and consent-source recording
- Campaign authoring in Visual builder, Rich text, Custom HTML, or Plain text mode, with personalization and responsive preview
- Test sends and asynchronous campaign execution
- Per-second and daily safety limits
- Global unsubscribe, hard-bounce, complaint, and manual suppressions
- A sandbox inbox with rendered-message inspection
- Campaign totals, delivery history, queue state, and an audit log
- Administrator-managed users, fixed least-privilege roles, session revocation, and permission-aware navigation

The default transport is `sandbox`. “Sandboxed” means captured locally; it does not mean delivered. If SMTP test mode is configured, “submitted” means the relay accepted the message, not that it reached an inbox.

## Roles and permissions

SendStack includes three built-in roles. Permissions are enforced by the server on every protected route; hiding an interface control is only a usability aid.

- **Administrator:** full access, including users, roles, audit history, and simulated delivery feedback.
- **Marketer:** manages lists, contacts, campaign drafts and previews, deliveries, and manual suppressions. It cannot launch delivery, manage users, or read the audit log.
- **Analyst:** read-only overview, sending readiness, list totals, and campaign reporting without recipient-level contact, delivery, or suppression data.

Administrators can create, update, disable, reactivate, and reset users under **Users & roles**. User deletion is intentionally unavailable so ownership and audit history remain intact. Role, status, and password changes revoke the affected user’s active sessions, and an administrator cannot demote or disable their own account.

## CSV format

The only required column is `email`. Optional columns are `first_name` and `last_name`.

```csv
email,first_name,last_name
person@example.test,Pat,Lee
```

Only use synthetic addresses or contacts with documented permission.

## Run the automated checks

```bash
./scripts/test.sh
```

## Production delivery (Spacemail SMTP)

Live send works like a Spacemail mail client:

1. Vercel hosts the web application and request-scoped API.
2. Managed PostgreSQL stores users, lists, immutable recipient snapshots, delivery rows, and suppressions.
3. A durable launch job submits **one ordinary MIME message per list address** through Spacemail SMTP (`mail.spacemail.com:465`), authenticated as the mailbox — From, To, Subject, and body (optional campaign Reply-To; Spacemail assigns Message-ID; no List-Unsubscribe headers).
4. SMTP acceptance is recorded as submitted and a copy is filed in the mailbox Sent folder. Mailbox in the app reads Inbox and Sent over IMAP. Deliveries remains the local send log. An optional `{{unsubscribe_url}}` merge field still works when the author includes it; suppressions stay server-side.
5. An external scheduler ticks `GET /api/cron/launch-jobs` so campaigns progress without a long-lived Vercel worker.

Sandbox remains the default. Live send stays locked behind `SENDSTACK_LIVE_SEND_ENABLED` (default `false`), Spacemail credentials, identity settings, and the emergency stop. `SENDSTACK_FROM_EMAIL` must match `SENDSTACK_SMTP_USERNAME`. Administrator test sends still require `SENDSTACK_TEST_RECIPIENT_ALLOWLIST`.

DNS may host Spacemail SPF/DKIM/DMARC records. Steady-state volume is bounded by the Spacemail mailbox plan (500 messages/hour on paid plans) and `SENDSTACK_DAILY_LIMIT`.

See [`docs/architecture.md`](docs/architecture.md) and [`docs/deployment.md`](docs/deployment.md) for the full contract and handover checklist.

```bash
SENDSTACK_DELIVERY_MODE=smtp \
SENDSTACK_SMTP_HOST=mail.spacemail.com \
SENDSTACK_SMTP_PORT=465 \
SENDSTACK_SMTP_USERNAME=you@example.com \
SENDSTACK_SMTP_PASSWORD=your-secret \
SENDSTACK_SMTP_FROM_EMAIL=you@example.com \
SENDSTACK_FROM_EMAIL=you@example.com \
SENDSTACK_LIVE_SEND_ENABLED=true \
SENDSTACK_TEST_RECIPIENT_ALLOWLIST=owner@example.com \
./scripts/start.sh
```

Safety defaults include 1 message/second, 50 messages/day, and a 500 messages/hour SMTP cap. Ambiguous SMTP failures after DATA are not automatically retried.

## Docker

```bash
docker compose up --build
```

Data is stored under `./data` and survives restarts.

## Important boundary

This is the immediate functional-test build, not the final production release. The Python path uses SQLite, a persistent HTTP process, and one in-process worker. Those choices make local testing simple, but they are not compatible with a dependable Vercel production deployment.

This repository does **not** send through Spacemail by default and should not be presented as production-ready until live delivery is unlocked. Live send remains locked until SMTP credentials, verified domain DNS, launch-job cron, suppression handling, backup/restore, and administrator security controls are complete.
