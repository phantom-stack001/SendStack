# SendStack (CTN Slovakia)

Public website and future operator UI for [ctn-sk.com](https://ctn-sk.com).

**Phase 1B** delivered the React + Vite + Tailwind + shadcn/ui foundation. **Phase 2** adds the SendStack **login UI** (`login-04`) and **dashboard shell** (`sidebar-08`). **Phase 2.5** unifies the design system. **Phase 3** adds **Better Auth**, a Hono API, **Neon PostgreSQL**, and protected `/app/*` routes.

Campaign, queue, and SMTP delivery features are **not** implemented yet. The dashboard remains a UI shell with placeholder data.

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

### Application (UI prototype — not protected)

| Path | Page |
| --- | --- |
| `/app/` | Dashboard overview |
| `/app/compose/` | Compose placeholder |
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

Additional UI: **Button**, **Card**, **Sheet**, **Separator**, **Input**, **Field**, **Breadcrumb**, **Avatar**, **Dropdown Menu**, **Tooltip**, **Collapsible**, **Skeleton**.

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

Email verification and password reset **require outbound email**. With `AUTH_EMAIL_DELIVERY=console`, links are printed to the API server log (development only). Configure a transactional provider before production.

### Production deployment

The static `dist/` SPA alone is **not** sufficient: you need a Node (or serverless) host for `server/` with `DATABASE_URL` and auth secrets, plus reverse-proxy `/api` to that service (or deploy frontend and API on one origin). Update `vercel.json` / hosting accordingly—do not expose Neon credentials to the browser.

## Planned phases (not implemented)

- **Phase 4+:** Bulk composer, recipients, campaigns, queue monitoring, server-side email delivery
- **Backend:** Node.js API, PostgreSQL, Redis + BullMQ workers
- **Email transport:** Server-side SMTP delivery (provider configured in infrastructure, not exposed in the UI)

## Verified public contact

- **Email:** info@ctn-sk.com
