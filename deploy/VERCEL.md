# SendStack on Vercel (SPA + Hono API)

Production site: **https://www.ctn-sk.com**

The Vercel project serves:

- **Static SPA** from `dist/` (Vite build)
- **Hono API** from `api/[...path].ts` → `server/app.ts` (Node.js serverless, `maxDuration` 30s)

No Railway or separate API host is required for login, drafts, campaigns, mail APIs, or admin.

## Files to commit

- `api/[...path].ts` — Vercel entry (Hono `handle`)
- `server/app.ts` — shared Hono application
- `server/index.ts` — local dev / optional `npm run start:api`
- `server/db/index.ts` — serverless-friendly DB pooling
- `vercel.json` — SPA rewrites exclude `/api/`

## Vercel environment variables

Set these in **Project → Settings → Environment Variables** (Production, and Preview if needed). Never commit values; do not use `VITE_*` for secrets.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Existing Neon PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | Yes | ≥ 32 characters; same value as today |
| `BETTER_AUTH_URL` | Yes | `https://www.ctn-sk.com` |
| `FRONTEND_URL` | Yes | `https://www.ctn-sk.com` |
| `NODE_ENV` | Recommended | `production` on Production |
| `AUTH_EMAIL_DELIVERY` | Yes | `smtp` or `console` / `disabled` per environment |
| `SMTP_HOST` | If SMTP | |
| `SMTP_PORT` | If SMTP | |
| `SMTP_USER` | If SMTP | |
| `SMTP_PASS` | If SMTP | |
| `SMTP_FROM` | If SMTP | |
| `SPACEMAIL_*` | If using mailbox | Server-only mailbox credentials |
| `REDIS_URL` | If queue APIs | Upstash TCP/TLS URL (`rediss://…`) |
| `QUEUE_ENABLED` | Optional | `true` to enqueue simulation jobs from API |
| `QUEUE_SIMULATION_ONLY` | Optional | Keep `true` until real sending is approved |

Remove **`API_ORIGIN`** if it was set for the old Railway proxy.

Optional client variable (only if auth must target a non-default origin):

- `VITE_APP_URL` — usually **unset** on Vercel (same-origin `/api`).

## Deployment procedure

1. Merge and push changes (including `api/` and `server/app.ts`).
2. Confirm Vercel **Root Directory** is repo root (not `web/`).
3. Set env vars above on the Vercel project.
4. Trigger **Redeploy** (Production).
5. Run verification commands below.

Build on Vercel: `npm run build` (frontend only). The API function is bundled separately from `api/[...path].ts` and traced server imports.

## Production verification

```bash
# Health must be JSON, not HTML
curl -sS https://www.ctn-sk.com/api/health | jq .

# Auth endpoint must not return 405 / index.html
curl -sS -o /dev/null -w "%{http_code}\n" \
  -X POST https://www.ctn-sk.com/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{"email":"not-a-real-user@example.com","password":"wrongpassword1"}'
# Expect 401/400 from Better Auth, not 405
```

Sign in in the browser at https://www.ctn-sk.com/login/ with a real production account. Session cookie should persist after refresh (`GET /api/auth/get-session` returns a user).

## Rollback

1. Vercel → **Deployments** → previous successful deployment → **Promote to Production**.
2. If env vars were changed, restore previous values and redeploy.

## Queue workers (not on Vercel)

With `QUEUE_ENABLED=true`, run **dispatcher** and **worker** as long-lived Node processes (separate from this Vercel project), using the same `DATABASE_URL` and `REDIS_URL`. See `deploy/railway.worker.toml` / `deploy/railway.dispatcher.toml` only if you choose Railway for those processes; they are optional for API/auth/mail UI.

## Local development

Unchanged: `npm run dev` (Vite + `server/index.ts` on port 3001, proxied `/api`).
