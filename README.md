# SendStack (CTN Slovakia)

Public website and future operator UI for [ctn-sk.com](https://ctn-sk.com).

**Phase 1B** delivered the React + Vite + Tailwind + shadcn/ui foundation. **Phase 2** adds the SendStack **login UI** (`login-04`) and **dashboard shell** (`sidebar-08`). **Phase 2.5** unifies the design system. **Phase 3** adds **Better Auth**, a Hono API, **Neon PostgreSQL**, and protected `/app/*` routes. **Phase 4** adds the **email composer** (Tiptap), **draft persistence**, and **preview**. **Phase 5** adds **recipient management** (contacts, lists, CSV import, consent events, suppressions)—still **no outbound sending**.

Campaign execution, queue processing, and SMTP delivery are **not** implemented yet.

## Stack

| Layer | Technology |
| --- | --- |
| UI | React 19, TypeScript (strict) |
| Build | Vite 8 |
| Styling | Tailwind CSS 4 + preserved Phase 1 CSS (`src/styles/landing.css`) |
| Components | shadcn/ui (New York), Lucide React |
| Routing | React Router 7 |
| SEO | `react-helmet-async` + build-time SSR prerender for public routes |

## Project structure

```
SendStack/
├── public/                 # Static assets (favicon, .htaccess)
├── src/
│   ├── app/                # App shell, router, route table
│   ├── components/
│   │   ├── ui/             # shadcn/ui primitives
│   │   ├── layout/         # Header, Footer, PageMeta, …
│   │   ├── shared/         # AppPageContainer, PageHeader, EmptyState, StatCard
│   │   └── landing/        # Hero, Services, About, Contact, SVG art
│   ├── content/            # Shared copy/data
│   ├── hooks/
│   ├── pages/              # Route-level pages
│   ├── styles/             # globals.css, landing.css, legal.css
│   ├── entry-server.tsx    # SSR prerender entry
│   └── main.tsx
├── scripts/prerender.mjs   # Writes static HTML for public URLs
├── index.html              # Vite entry
├── components.json         # shadcn/ui config
└── dist/                   # Production output (generated)
```

The legacy `web/` Next.js tree is **not** part of this frontend. Do not deploy or restore it for the public site.

## Routes

### Public

| Path | Page |
| --- | --- |
| `/` | Landing page |
| `/privacy/` | Privacy Policy |
| `/terms/` | Terms of Service |
| `/login/` | Sign in (login-04 UI, no backend auth yet) |

### Application (protected — Better Auth session)

| Path | Page |
| --- | --- |
| `/app/` | Dashboard overview |
| `/app/compose/` | New email draft |
| `/app/compose/:draftId/` | Edit saved draft |
| `/app/drafts/` | Draft list |
| `/app/campaigns/` | Campaigns placeholder |
| `/app/recipients/` | Recipients placeholder |
| `/app/templates/` | Templates placeholder |
| `/app/queue/` | Queue placeholder |
| `/app/history/` | Sending history placeholder |
| `/app/settings/` | Settings placeholder |

| `*` | Not found |

Trailing slashes are canonical; bare paths (`/privacy`) redirect to `/privacy/`.

## Local development

```bash
cd /Users/thomasbrown/Herd/SendStack
npm install
npm run dev
```

Default URL: **http://localhost:5173**

Other commands:

```bash
npm run typecheck   # TypeScript
npm run lint        # ESLint
npm run test        # Vitest (server content/safety tests)
npm run build       # Client + SSR bundle + prerender
npm run preview     # Serve dist/ locally
```

With [Laravel Herd](https://herd.laravel.com/), you can proxy or link `dist/` after a build, or run `npm run dev` alongside your local site configuration.

## shadcn/ui

Configured in `components.json` with CTN primary `#0f7a72` mapped to design tokens in `src/styles/globals.css`.

Add components with the official CLI (from project root):

```bash
npx shadcn@latest add <component>
```

Official blocks installed via CLI:

- `login-04` → `src/components/auth/LoginForm.tsx` + `LoginPage`
- `sidebar-08` → `src/components/app-sidebar.tsx`, `nav-main.tsx`, `nav-user.tsx`, `ui/sidebar.tsx`, etc.

Additional UI: **Button**, **Card**, **Sheet**, **Separator**, **Input**, **Field**, **Breadcrumb**, **Avatar**, **Dropdown Menu**, **Tooltip**, **Collapsible**, **Skeleton**, **Dialog**, **Alert Dialog**, **Table**, **Textarea**, **Badge**.

## Design system (Phase 2.5)

Tokens live in `src/styles/globals.css`. The landing page keeps its Phase 1 palette via `src/styles/landing.css` (scoped under `.page`); the app shell uses shadcn semantic variables.

| Token | Value / role |
| --- | --- |
| Primary | `#0f7a72` — CTN teal; primary actions, focus rings, sidebar brand mark |
| Accent | Soft teal tint — hover surfaces for ghost/outline controls (not full primary fill) |
| Canvas / background | `#e8ecef` — matches public site `--canvas` |
| Foreground | `#141821` — body text and headings in the app |
| Muted foreground | `#5b6578` — descriptions, helper text, stat hints |

**Typography:** Public marketing copy uses landing CSS (display serif in hero, Avenir-style sans elsewhere). Dashboard and auth use the same sans stack via `body` in `globals.css`. Page titles use `text-2xl font-semibold`; supporting copy uses `text-muted-foreground`.

**Layout:** App routes wrap content in `AppPageContainer` (`max-w-6xl`, vertical `gap-6`). `PageHeader` standardizes title, description, and prototype notice. `EmptyState` provides dashed-border placeholders with optional Lucide icon and action.

**Buttons:** `default` = primary CTA; `outline` = secondary navigation in the dashboard; `secondary` = low-emphasis surfaces (e.g. public mobile menu). Landing hero CTAs keep `.btn-primary` / `.btn-secondary` classes from `landing.css`.

**Icons:** Lucide at `size-4` in buttons/sidebar, `size-5` in empty states (`stroke-[1.75]`).

When adding screens, reuse `AppPageContainer`, `PageHeader`, and `EmptyState` before introducing new layout patterns.

## Production build

```bash
npm run build
```

Output: **`dist/`**

The build:

1. Type-checks the project
2. Bundles the client SPA
3. Bundles `src/entry-server.tsx`
4. Prerenders `/`, `/privacy/`, `/terms/`, `/login/`, and `/app/` into static `index.html` files (SEO-friendly HTML for crawlers)

Deploy **only** the contents of `dist/` (not `src/` or `node_modules`).

### Vercel

The app lives at the **repository root** (Vite), not in `web/`.

In **Project Settings → General → Root Directory**, clear `web` and leave the root **empty** (or `.`), then redeploy.

This repo includes `vercel.json` at the root:

- **Build command:** `npm run build`
- **Output directory:** `dist`
- **SPA rewrites** for client routes (e.g. `/app/compose/`, `/login/`)

If you see *“Root Directory web does not exist”*, the dashboard still points at the old Next.js layout—update Root Directory as above.

**API on Vercel:** the static `dist/` build serves the SPA; `api/index.ts` runs the same Hono app as `server/index.ts` via `hono/vercel` (Node.js runtime, no separate API host). `vercel.json` rewrites every `/api/*` path to that function because a bracket catch-all only matches one segment. Set server env vars on the **Vercel project** (see [deploy/VERCEL.md](deploy/VERCEL.md)).

Use the canonical browser origin for auth:

- `BETTER_AUTH_URL=https://www.ctn-sk.com`
- `FRONTEND_URL=https://www.ctn-sk.com`

After deploy, `GET https://www.ctn-sk.com/api/health` must return JSON (`{"ok":true,"service":"sendstack-api",...}`), not HTML. SPA fallback in `vercel.json` excludes `/api/` so API routes are not rewritten to `index.html`.

### Apache

`public/.htaccess` is copied into `dist/` and provides SPA fallback for unknown routes while serving prerendered folders directly.

### Nginx (reference)

```nginx
location / {
  try_files $uri $uri/ /index.html;
}
```

## Environment

Copy `.env.example` to `.env` for local API development. **Never** commit `.env` or put secrets in `VITE_*` variables.

| Variable | Scope | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Server | Neon PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | Server | Session signing secret (≥ 32 chars) |
| `BETTER_AUTH_URL` | Server | Public origin Better Auth uses for links/cookies (e.g. `http://localhost:5173`) |
| `FRONTEND_URL` | Server | Trusted browser origin for CORS |
| `AUTH_EMAIL_DELIVERY` | Server | `console` (dev logs), `disabled`, or future `smtp` |
| `SENDSTACK_DB_RESET_CONFIRM` | Server | Must be `yes` to run `npm run db:reset` |
| `BOOTSTRAP_ADMIN_EMAIL` | Server | Target email for `admin:bootstrap` |
| `BOOTSTRAP_ADMIN_NAME` | Server | Display name for bootstrap (optional) |
| `BOOTSTRAP_ADMIN_PASSWORD` | Server | One-time bootstrap password (never commit) |
| `VITE_APP_URL` | Client (optional) | Auth client base URL when not same-origin |

## Authentication (Phase 3)

SendStack uses **Better Auth** on a **Hono** API (`server/`) with **Drizzle ORM** and **Neon PostgreSQL**. Sessions are **HttpOnly cookies**—nothing is stored in `localStorage`.

### Local development

```bash
cp .env.example .env
# Set DATABASE_URL (Neon dev branch) and BETTER_AUTH_SECRET

npm run db:migrate   # applies drizzle/migrations
npm run dev          # Vite on :5173 + API on :3001 (proxied /api → API)
```

| Command | Description |
| --- | --- |
| `npm run dev:client` | Vite only |
| `npm run dev:server` | Hono API only |
| `npm run db:generate` | Drizzle Kit migration from schema |
| `npm run db:migrate` | Apply migrations |
| `npm run db:inspect` | List scoped public tables on Neon (no secrets) |
| `npm run db:reset` | Drop allowlisted SendStack tables (requires `SENDSTACK_DB_RESET_CONFIRM=yes`) |
| `npm run admin:bootstrap` | One-time super-admin provisioning (CLI only) |
| `npm run auth:generate` | Regenerate Better Auth Drizzle schema (after config changes) |

### Roles (Phase 3.1)

Better Auth **admin plugin** enforces privileged roles on the server:

| Role | Purpose |
| --- | --- |
| `user` | Default for self-service registration |
| `super-admin` | Initial administrator (`adminRoles` in `server/auth/auth.ts`) |

Registration never accepts a client-supplied role. Only `npm run admin:bootstrap` (or future admin APIs) may assign `super-admin`.

### Neon reset and bootstrap

1. **Inspect** (safe): `npm run db:inspect`
2. **Reset** (destructive, allowlisted tables only):

   ```bash
   SENDSTACK_DB_RESET_CONFIRM=yes npm run db:reset
   npm run db:migrate
   ```

3. **Bootstrap** the first administrator (password is **not** stored in Git):

   ```bash
   export BOOTSTRAP_ADMIN_EMAIL=roux.thomas@ctn-sk.com
   export BOOTSTRAP_ADMIN_NAME="Thomas Roux"
   # Either export BOOTSTRAP_ADMIN_PASSWORD='…' for one command, or omit for an interactive prompt:
   npm run admin:bootstrap
   ```

The reset script refuses to run if unexpected `public` tables exist outside the SendStack allowlist (`server/lib/sendstack-tables.ts`). It does **not** drop the Neon database or branch.

### Routes

| Path | Access |
| --- | --- |
| `/login/`, `/register/`, `/forgot-password/`, `/reset-password/` | Public auth UI |
| `/verify-email/` | Post-registration / verification help |
| `/app/*` | Requires verified session |
| `/api/auth/*` | Better Auth handler |
| `GET /api/health` | Public health check |
| `GET /api/me` | Current session user |
| `POST/GET/PATCH/DELETE /api/drafts` | Draft CRUD (session required) |

Email verification and password reset **require outbound email**. With `AUTH_EMAIL_DELIVERY=console`, links are printed to the API server log (development only). Configure a transactional provider before production.

## Email composer & drafts (Phase 4)

### Architecture

- **Editor:** [Tiptap](https://tiptap.dev/) (`@tiptap/react`, StarterKit, Underline, Link) with a shadcn/ui toolbar.
- **Canonical content:** Tiptap JSON stored in `email_drafts.content_json` (JSONB).
- **Derived fields:** `body_html` (sanitized) and `body_text` generated on the server when saving.
- **Preview:** Client-side HTML from the current editor state, rendered in a **sandboxed** iframe (`sandbox=""`, no scripts).
- **Persistence:** Drizzle ORM → Neon PostgreSQL table `email_drafts` (migration `drizzle/migrations/0001_adorable_power_pack.sql`).

### Supported formatting

Bold, italic, underline, strikethrough, paragraph, heading (H2), bullet/numbered lists, blockquote, hyperlinks (http/https/mailto), undo/redo, clear formatting.

### Draft API

All endpoints require a valid Better Auth session cookie. The API **never** accepts a client `user_id`; ownership is enforced with `WHERE user_id = session.user.id`. Inaccessible drafts return **404**.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/drafts` | Create draft (first explicit save on `/app/compose/`) |
| `GET` | `/api/drafts` | List drafts (`page`, `limit`; default 25) |
| `GET` | `/api/drafts/:id` | Fetch one draft |
| `PATCH` | `/api/drafts/:id` | Update draft |
| `DELETE` | `/api/drafts/:id` | Delete draft |

Validation uses **Zod** (`server/validation/drafts.ts`). Incomplete drafts are allowed; size limits apply to subject, sender fields, and JSON/HTML payload.

### HTML sanitization

`server/lib/email-content.ts` validates Tiptap documents, renders HTML with `@tiptap/html`, then sanitizes with **sanitize-html** (allowlisted tags/attributes, safe link protocols, `rel="noopener noreferrer"` on links). Script tags, event handlers, and dangerous URL schemes are stripped.

### Local testing

```bash
npm run test          # email content / sanitization unit tests
npm run db:migrate    # ensure email_drafts exists
npm run dev           # compose at /app/compose/, list at /app/drafts/
```

### Known limitations (Phase 4)

- No email sending, SMTP, or campaigns.
- Sender name/email are draft metadata only (not verified sending identities).
- Preview approximates common clients; it is not a guarantee for all inboxes.
- Explicit **Save draft** only (no autosave).
- Super-admin does **not** grant access to other users’ drafts.

## Recipient management (Phase 5)

### Routes

| Path | Purpose |
| --- | --- |
| `/app/recipients/` | All contacts, search, filters, bulk actions |
| `/app/recipients/lists/` | Contact lists |
| `/app/recipients/lists/:listId/` | List members |
| `/app/recipients/import/` | CSV import wizard |
| `/app/recipients/suppressions/` | Suppression registry |

### Database tables

`contacts`, `contact_lists`, `contact_list_members`, `contact_consent_events`, `email_suppressions` (migration `drizzle/migrations/0002_recipient_management.sql`).

- Unique contact email per user (`user_id` + normalized `email`).
- CSV imports default to **`unknown`** consent; suppressions block re-subscription via import.
- **Subscribed** status requires consent source + timestamp (append-only `contact_consent_events`).
- Deleting a contact does not remove `email_suppressions` compliance records.

### APIs (session required)

Contacts: `GET/POST /api/contacts`, `GET/PATCH/DELETE /api/contacts/:id`, `GET /api/contacts/stats`, `POST /api/contacts/:id/unsubscribe`, bulk unsubscribe/delete.

Lists: `GET/POST /api/contact-lists`, `GET/PATCH/DELETE /api/contact-lists/:id`, list membership endpoints under `/api/contact-lists/:id/contacts`.

Import: `POST /api/contacts/import/preview`, `POST /api/contacts/import` (uses `csv-parse`, max 2MB / 10k rows).

Suppressions: `GET/POST /api/suppressions`.

## Campaign management (Phase 6)

Phase 6 covers **campaign preparation only** — no SMTP, queues, workers, or automatic sending.

### Routes

| Path | Purpose |
| --- | --- |
| `/app/campaigns/` | Campaign list, stats, filters |
| `/app/campaigns/new/` | Multi-step create wizard |
| `/app/campaigns/:campaignId/` | Details, preview, events |
| `/app/campaigns/:campaignId/edit/` | Edit draft campaigns |

### Database tables

`campaigns`, `campaign_recipient_sources`, `campaign_recipients`, `campaign_events` (migration `drizzle/migrations/0003_campaign_management.sql`).

- Campaign content is **snapshotted** from `email_drafts` (`source_draft_id` is traceability only).
- Recipient **sources** reference contacts and/or lists; **snapshots** in `campaign_recipients` store normalized email + eligibility at prepare/ready time.
- Status lifecycle (Phase 6 active): `draft`, `ready`, `scheduled`, `cancelled`. Reserved for delivery phases: `queued`, `sending`, `completed`, `failed`.
- `scheduled_at` + `schedule_timezone` record **intended** delivery only (no job execution).

### Eligibility rules

Server-side evaluation (`server/services/campaign-eligibility.ts`):

- Deduplicate by normalized email (deterministic contact ID tie-break).
- **Eligible:** `subscription_status = subscribed` and not on `email_suppressions`.
- **Excluded:** unsubscribed, pending consent, unknown consent, suppressed, invalid email (each unique address counted once using a fixed priority: invalid → suppressed → unsubscribed → pending → unknown).
- Recalculated on validate/prepare and before marking ready.
- Live wizard preview: `POST /api/campaigns/recipient-eligibility-preview` with `contactIds` / `contactListIds` (no campaign state change).

### Campaign wizard validation (Phase 7.5)

The create/edit wizard shows **step-scoped** errors:

| Step | Validates |
| --- | --- |
| Details | Name/description length |
| Email | Draft selection, sender fields, content issues |
| Recipients | Selection, live eligibility summary, exclusion reasons |
| Review | Full summary + warnings |
| Prepare | Blocking issues for **Mark as ready**; **Save as draft** always allowed |

Recipient issues (e.g. no eligible addresses) appear on **Recipients** and **Prepare**, not on Details. **Review recipients** jumps back to step 3 without losing wizard state.

Manual contact adds default to **subscribed** with dashboard consent metadata; CSV import still defaults to **unknown** until consent is recorded.

### Campaign APIs (session required)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/campaigns` | Paginated list (`q`, `status`) |
| `POST` | `/api/campaigns` | Create draft campaign |
| `GET` | `/api/campaigns/stats` | Aggregate counts |
| `GET` | `/api/campaigns/:id` | Detail + sources + recent events |
| `PATCH` | `/api/campaigns/:id` | Update (`expectedRevision` for optimistic locking) |
| `DELETE` | `/api/campaigns/:id` | Delete **draft** only |
| `POST` | `/api/campaigns/:id/duplicate` | Duplicate as new draft |
| `POST` | `/api/campaigns/:id/validate` | Content + eligibility preview + exclusion list |
| `POST` | `/api/campaigns/recipient-eligibility-preview` | Eligibility for arbitrary contact/list IDs |
| `POST` | `/api/campaigns/:id/prepare` | Recipient snapshot (`markReady` optional) |
| `POST` | `/api/campaigns/:id/cancel` | Cancel pre-processing campaigns |
| `GET` | `/api/campaigns/:id/events` | Audit history |

Ownership is enforced on campaigns, drafts, contacts, and lists. Cross-user IDs are rejected.

### Known limitations (Phase 6)

- Campaign delivery, open/click tracking, and bounce handling are not part of campaign management. A separate mailbox connection can send one controlled test message and does not send campaigns.
- Scheduled times are stored but **not executed**.
- Eligibility snapshots are point-in-time; future delivery must re-check consent and suppressions.
- Sender addresses are syntactically validated only (not verified sending identities).

## Queue infrastructure (Phase 7)

Phase 7 adds **Redis + BullMQ** workers for **simulation-only** campaign processing. Campaign workers do not send email. Direct mailbox SMTP is a separate path and is not wired into these workers.

**Neon PostgreSQL** remains the durable source of truth (`delivery_jobs`, campaigns, audit events). **Redis** (local or [Upstash](https://upstash.com/docs/redis/overall/getstarted)) only coordinates BullMQ workers—it does not replace the database.

### Processes

| Script | Role |
| --- | --- |
| `npm run dev:server` | Hono API |
| `npm run dev:dispatcher` | Publishes pending `delivery_jobs` to BullMQ |
| `npm run dev:worker` | Simulates per-recipient jobs |
| `npm run queue:reconcile` | Republish orphaned pending jobs |
| `npm run queue:check` | Safe Redis/BullMQ connectivity diagnostic (no secrets in output) |

Upstash does **not** run BullMQ workers for you. In production you still need **three long-lived Node processes** (or equivalent containers): API, dispatcher, and worker. Do not run workers inside short-lived serverless handlers (for example a Vercel function).

### Environment (server only)

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon PostgreSQL (unchanged) |
| `REDIS_URL` | `redis://` (local) or `rediss://` (Upstash TCP/TLS). **Not** the Upstash REST URL. |
| `QUEUE_ENABLED` | `true` when Redis is configured |
| `QUEUE_SIMULATION_ONLY` | Must stay `true` (simulation only; no campaign SMTP) |
| `QUEUE_WORKER_CONCURRENCY` | Worker parallelism (default `2`) |
| `QUEUE_MAX_JOBS_PER_SECOND` | Worker rate limit (default `5`; production often `1`) |
| `QUEUE_MAX_ATTEMPTS` | BullMQ retry attempts |
| `QUEUE_JOB_RETENTION_DAYS` | Completed/failed job retention in Redis |
| `QUEUE_SIMULATION_DELAY_MS` | Artificial delay per simulated job |

The API starts without Redis when `QUEUE_ENABLED=false`.

**Upstash setup:** create a Redis database, copy the **TCP** connection string (`rediss://…`), set it as `REDIS_URL` on the host that runs the dispatcher and worker. Use a separate Upstash database for development. TLS uses default certificate validation (no `rejectUnauthorized: false`).

**Shared Neon warning:** if `.env` and `.env.production` point at the same `DATABASE_URL`, local and production share one database. Use a Neon **branch** for development and avoid destructive queue tests against production data.

### Redis diagnostics

```bash
npm run queue:check           # PING + TLS/scheme summary (no credentials logged)
npm run queue:check -- --bullmq # Also enqueue/remove a probe job (BullMQ compatibility)
```

### Database tables

`delivery_jobs`, `delivery_job_attempts`, `queue_events` (migration `0004_queue_infrastructure.sql`).

Durable jobs are created in PostgreSQL first; the dispatcher publishes to BullMQ (`sendstack-campaign-dispatch`, `sendstack-email-processing`).

### Queue APIs

`GET /api/queue/overview`, `GET /api/queue/jobs`, `GET /api/queue/jobs/:id`, `GET /api/queue/events`, `POST /api/queue/jobs/:id/retry`, `POST /api/queue/reconcile`, `POST /api/campaigns/:id/enqueue`, `POST /api/campaigns/:id/pause`, `POST /api/campaigns/:id/resume` (cancel uses extended `/api/campaigns/:id/cancel`).

### Job statuses

`pending`, `queued`, `processing`, `retry_wait`, `simulation_completed`, `simulation_failed`, `skipped`, `cancelled` — never `sent` or `delivered`.

### UI

`/app/queue/` — live stats and job table (polls every 5s). Campaign details include **Activate simulation queue** controls.

Labels use **Simulation completed** / **Simulation failed** / **Skipped** — never “Sent” or “Delivered”.

### Queue local verification (Phase 7.5)

1. Set `QUEUE_ENABLED=true`, `QUEUE_SIMULATION_ONLY=true`, and `REDIS_URL` in `.env` (server-only).
2. Run `npm run dev`, `npm run dev:dispatcher`, and `npm run dev:worker` in separate terminals.
3. Mark a campaign **ready** with at least one eligible test contact, then activate simulation from campaign details.
4. Confirm jobs in `/app/queue/` move through `pending` → `queued` → `processing` → `simulation_completed` (or `skipped` for ineligible recipients).
5. Optional: `npm run queue:reconcile` after worker/dispatcher restarts to republish orphaned `pending` rows.

Scheduling, pause/resume, cancellation, retries, and Redis interruption should be validated against a **dedicated dev Redis** instance — results depend on your local infrastructure.

### Production deployment

| Component | Hosting notes |
| --- | --- |
| **SPA + API** | Vercel: `dist/` static output + `api/index.ts` (Hono on Node serverless; `/api/:path*` rewrite) |
| **Dispatcher** | Persistent Node elsewhere (not Vercel): `npm run start:dispatcher` or `tsx server/dispatchers/campaign-dispatcher.ts` |
| **Worker** | Persistent Node elsewhere (not Vercel): `npm run start:worker` or `tsx server/workers/email-processing.worker.ts` |
| **Redis** | Upstash (or other Redis) via `REDIS_URL` — required when `QUEUE_ENABLED=true` |

Vercel runs request/response APIs and Better Auth; BullMQ **workers and the campaign dispatcher must not run inside Vercel Functions**. Queue simulation still needs a long-lived worker process (local machine, a free-tier VM, or optional Railway worker service). Do not expose Neon or Redis credentials to the browser (`VITE_` prefix must never carry secrets).

## Direct mailbox

The dashboard can connect to one mailbox for inbox, sent mail, and a single controlled test message. Campaign queues stay simulation-only.

### Server environment

Set these in `.env` only. Do not use a `VITE_` prefix, and do not return the password from the API.

`SPACEMAIL_SMTP_HOST`, `SPACEMAIL_SMTP_PORT`, `SPACEMAIL_SMTP_SECURE`, `SPACEMAIL_IMAP_HOST`, `SPACEMAIL_IMAP_PORT`, `SPACEMAIL_IMAP_SECURE`, `SPACEMAIL_EMAIL`, `SPACEMAIL_PASSWORD`, `SPACEMAIL_SENDER_NAME`, `SPACEMAIL_TEST_RECIPIENT`.

The accepted server settings match the published client configuration for this mailbox host: `mail.spacemail.com`, IMAP port 993 with SSL/TLS, and SMTP port 465 with SSL/TLS or port 587 with STARTTLS. Other hosts and cleartext ports are rejected. This workspace uses SMTP port 587 with required STARTTLS, which is the account setting already present for `SMTP_PORT`, plus IMAP port 993.

`npm run mail:check` verifies both connections. `npm run mail:check -- --send` sends one message to `SPACEMAIL_TEST_RECIPIENT` and records the result. SMTP acceptance is stored as acceptance, not as confirmed inbox delivery.

### Sent folder

The provider does not document an automatic copy of SMTP submissions into Sent. After the outgoing server accepts a test message, SendStack searches the IMAP special-use Sent folder (or a folder named Sent, Sent Items, Sent Messages, or Sent Mail) for the same Message-ID. It appends the submitted message only when that id is absent. If the folder is missing, the submission is still recorded and the sent-copy status is `folder_missing`.

POP3 is not implemented.

### Mail APIs

All of these require a Better Auth session and the `mailbox.read`, `mailbox.send_test`, or `mailbox.manage_connection` permission. By default only `super-admin` has those permissions.

`GET /api/mail/status`, `POST /api/mail/test-connection`, `POST /api/mail/test-send`, `POST /api/mail/send`, `GET /api/mail/sends`, `GET /api/mail/folders`, `GET /api/mail/inbox`, `GET /api/mail/sent`, `GET /api/mail/mailbox`, `GET /api/mail/messages/:uid`.

Test sending requires `confirm: true`, a UUID idempotency key, and the server-side recipient. The limit is one message per minute and three per hour. The UI asks for confirmation before the request is sent.

## Direct composer sending (Phase 9)

The composer can submit one individual message through the same server-side SMTP account used for the controlled test send. Campaign workers stay simulation-only (`QUEUE_SIMULATION_ONLY=true`). This does not start a Redis worker.

### What the composer does

To is required. Cc and Bcc are optional. Addresses can be typed, pasted as a comma-separated list, or chosen from the signed-in user's saved contacts. Choosing a contact does not change that contact's consent. Duplicate addresses in one field are kept once. The same address in two fields is rejected. The server validates every address again.

Bcc is placed on the SMTP envelope only. It is not added to the To or Cc headers of the message that recipients receive. The review step shows Bcc only to the person sending. Ordinary history rows show a Bcc count, not a shared copy of the list for other users.

The sender is always the configured mailbox (`SPACEMAIL_EMAIL`). A draft that names a different sender is not sent. The composer explains the difference and can switch the field to the authorized address. The browser cannot supply SMTP credentials or another user's id.

### Who can send

`mailbox.send` is separate from `mailbox.send_test`. Only the super-admin role template includes it. The API checks the permission even if the Send button is hidden. Other roles do not receive it automatically.

### Who can receive

For this phase, every recipient must be the configured test recipient (`SPACEMAIL_TEST_RECIPIENT`). An address is still blocked when that user has a suppression for it, or when a saved contact with that address is unsubscribed, pending, or missing recorded consent. Typing an address does not create consent.

At most 3 recipients are accepted, and at most 5 individual submissions per hour, with at least one minute between them. These are application defaults, not a verified provider quota.

### What gets stored

`POST /api/mail/send` writes `individual_email_submissions` in Neon before SMTP starts. Statuses are `pending` (not yet submitted), `submitting` (SMTP has started), `accepted`, `rejected`, `failed`, and `uncertain`. The same idempotency key does not call SMTP again. A retry that finds `submitting` is recorded as `uncertain` and is not sent again. A `pending` row can still be continued because SMTP had not started. SMTP itself cannot promise exactly-once delivery.

`accepted` means the outgoing server accepted the message. It does not mean the recipient inbox delivered it. After acceptance, SendStack appends one IMAP Sent copy when that Message-ID is not already there. If the Sent copy fails, the submission stays `accepted` and the sent-copy status records the failure.

Drafts are not deleted when a message is sent. Sending history at `/app/history/` lists these records only. It does not include simulated campaign jobs.

The API runs in a Vercel Function: each send opens SMTP and IMAP for that request, with the existing connection timeouts, and does not keep a process-wide mail connection or start a campaign worker.

## Manual email verification (Phase 9.1)

A super-admin can mark one user's current email address verified from `/app/admin/users/:userId/` after confirming they have independently checked that the person controls that mailbox. The button is not shown for other roles. The API rejects anyone whose Better Auth role string does not include `super-admin`, including users who only have `users.update` or a custom role. This action is not in the assignable permission catalog.

The dialog requires an unchecked-by-default acknowledgement and a written reason of at least 12 characters. `POST /api/admin/users/:userId/verify-email` updates only `emailVerified` on that Better Auth user, and only while the address still matches the address the administrator reviewed and the account is not already verified. Roles, suspensions, passwords, and sessions are left unchanged. A successful update writes `user.email_verified_manually` to `admin_audit_events` with the actor, target, email, method `manual`, and reason. A failed update does not write that event. Repeating verification does not add another event.

If the account is verified and a matching manual audit event exists, the details page shows the event time and method Manual. Otherwise a verified account shows method Unknown and date Not recorded. SendStack does not invent an email-link timestamp. Login still requires a valid password. `requireEmailVerification` remains enabled, so a manually verified active account can pass that check. A suspended or deactivated account stays in that status.

Composer sending is unchanged: `mailbox.send` is still required, recipients must still be `SPACEMAIL_TEST_RECIPIENT`, and SMTP acceptance is still not inbox delivery. A live production send was not executed in this phase.

## Administration (Phase 8)

Better Auth remains authoritative for accounts, passwords, email verification, sessions, and the `user.role` string. SendStack permissions are authoritative for feature access. A role key registered with Better Auth (`user`, `viewer`, `editor`, `campaign-manager`, `admin`, `super-admin`) is stored on `user.role`. Custom roles are stored in `app_user_roles` and included when permissions are resolved. Only `super-admin` can call the Better Auth admin plugin.

### Default roles

| Role | Access |
| --- | --- |
| `super-admin` | Every permission, including the shared mailbox and role administration |
| `admin` | Users, campaigns, contacts, drafts, queue operations, and the audit log. No mailbox access and no ability to assign `admin` or `super-admin` |
| `campaign-manager` | Campaigns, recipients, drafts, templates, and simulation queue actions |
| `editor` | Drafts and templates, plus read access to related resources |
| `viewer` | Read-only access to resources the account is otherwise allowed to see |
| `user` | Default self-service registration. Same working permissions as a campaign manager so existing owner access is preserved |

Ownership checks still apply. `campaigns.read` does not grant another user's campaigns. Mailbox permissions are not included in any role except `super-admin`.

### Status

`active` accounts can sign in. `suspended` and `deactivated` accounts are banned in Better Auth and their sessions are deleted. Deactivation keeps campaigns, drafts, contacts, consent events, and history. Hard deletion is not used.

### Invitations

Administrators invite by email and role. The invitation token is stored only as a SHA-256 hash, expires after 7 days, and can be accepted once by a verified session for that same email. If email delivery fails, the invitation stays pending and is not marked sent.

### Password reset and sessions

Password reset uses Better Auth's reset email. Administrators never see passwords. Session lists omit the session token. Revoking a session deletes that row.

### Last super admin

The final active super admin cannot be suspended, deactivated, or removed from that role. The check runs inside a database lock.

## Verified public contact

- **Email:** info@ctn-sk.com
