# SendStack (CTN Slovakia)

Public website and future operator UI for [ctn-sk.com](https://ctn-sk.com).

**Phase 1B** delivers a modern frontend foundation (React + TypeScript + Vite + Tailwind CSS + shadcn/ui) while preserving the Phase 1 landing page design. Backend, authentication, SMTP, database, and queue workers are **not** implemented yet.

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

| Path | Page |
| --- | --- |
| `/` | Landing page |
| `/privacy/` | Privacy Policy |
| `/terms/` | Terms of Service |
| `/app/` | Workspace placeholder (auth in a later phase) |
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

Components in use today: **Button**, **Card**, **Sheet**, **Separator**.

## Production build

```bash
npm run build
```

Output: **`dist/`**

The build:

1. Type-checks the project
2. Bundles the client SPA
3. Bundles `src/entry-server.tsx`
4. Prerenders `/`, `/privacy/`, `/terms/`, and `/app/` into static `index.html` files (SEO-friendly HTML for crawlers)

Deploy **only** the contents of `dist/` (not `src/` or `node_modules`).

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

## Planned phases (not implemented)

- **Phase 2:** Authentication and sessions under `/app/`
- **Phase 3+:** Dashboard, bulk composer, recipients, campaigns, queue monitoring
- **Backend:** Node.js API, PostgreSQL, Redis + BullMQ workers
- **Email transport:** SpaceMail SMTP (server-side only)

## Verified public contact

- **Email:** info@ctn-sk.com
