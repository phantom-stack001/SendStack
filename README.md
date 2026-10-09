# SendStack (CTN Slovakia)

Public website and future operator UI for [ctn-sk.com](https://ctn-sk.com).

**Phase 1B** delivered the React + Vite + Tailwind + shadcn/ui foundation. **Phase 2** adds the SendStack **login UI** (`login-04`) and **dashboard shell** (`sidebar-08`).

Authentication, real sessions, SMTP, database, and queue workers are **not** implemented yet. The dashboard is an **unprotected UI prototype** until the backend is built.

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

No secrets or `.env` values are required for the public site. Future API and SMTP configuration will live on the server only—never in client bundles or `localStorage`.

## Authentication limitations (Phase 2)

- Sign in at `/login/` validates input client-side only.
- Submitting the form shows an informational message; **no session is created**.
- `/app/*` routes are reachable without login until server-side auth is added.
- No passwords, tokens, or SMTP credentials are stored in the browser.

## Planned phases (not implemented)

- **Phase 3:** Real authentication, sessions, and protected `/app/*` routes
- **Phase 4+:** Bulk composer, recipients, campaigns, queue monitoring, SpaceMail SMTP (server-side only)
- **Backend:** Node.js API, PostgreSQL, Redis + BullMQ workers
- **Email transport:** SpaceMail SMTP (server-side only)

## Verified public contact

- **Email:** info@ctn-sk.com
