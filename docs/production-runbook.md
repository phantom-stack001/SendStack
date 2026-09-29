# Production operator runbook (`ctn-sk.com`)

This is the definitive human-owned activation sequence for SendStack on Vercel + PostgreSQL + Resend.
The application code does **not** perform these steps. Agents and automation must not deploy, mutate DNS, rotate live credentials, change Resend, or send real mail unless separately authorized.

Primary domain: **`ctn-sk.com`**.

Related: [post-remediation.md](post-remediation.md) · [deployment.md](deployment.md) · [`web/README.md`](../web/README.md)

---

## Ordered activation checklist

### 1. Back up the production database and verify restoration

- Take a full logical backup of production PostgreSQL.
- Restore into an isolated staging database and confirm row counts for campaigns, contacts, messages, suppressions, provider_events, and audit_events.
- Record the backup location and restore procedure before any schema change.

### 2. Apply migration `0006` in staging

```bash
cd web
# DATABASE_URL must point at staging only
pnpm db:migrate
```

- Confirms `0006_consent_volume_launch_hardening.sql` is recorded in `schema_migrations`.
- Do **not** invent a destructive rollback. Prefer forward recovery (fix-forward, restore from backup).

### 3. Verify constraints, data preservation, and readiness

- Confirm historical campaigns, contacts, messages, webhooks, consent, suppressions, and delivery rows remain.
- Expect contacts without consent evidence to be demoted to `pending_consent`.
- Call `GET /api/production-readiness` as an administrator (live sending should remain blocked until secrets/DNS/cron are complete).
- Confirm daily volume counters exist for the current UTC day after migrate.

### 4. Deploy code to staging with live sending disabled

- Vercel root directory: `web`.
- Set `SENDSTACK_LIVE_SEND_ENABLED=false`.
- Confirm `/healthz` returns ok.
- Confirm preview deployments never receive production Resend credentials.

### 5. Configure secrets and identity

Required for login/runtime:

- `DATABASE_URL`
- `SENDSTACK_SESSION_SECRET` (≥32 chars, not the example default)
- `SENDSTACK_PUBLIC_URL` (HTTPS production origin, e.g. `https://ctn-sk.com` or the app hostname)

Required before live unlock:

- `RESEND_API_KEY`
- `RESEND_WEBHOOK_SECRET`
- `CRON_SECRET` (Bearer for `/api/cron/launch-jobs`)
- `SENDSTACK_FROM_EMAIL` / `SENDSTACK_REPLY_TO_EMAIL`
- `SENDSTACK_COMPANY_NAME` / `SENDSTACK_POSTAL_ADDRESS` / contact email for footers
- `SENDSTACK_ALLOWED_LINK_DOMAINS` (registrable hosts only; never public suffixes like `co.uk` or `github.io`)
- `SENDSTACK_TEST_RECIPIENT_ALLOWLIST`
- `SENDSTACK_HEALTH_MIN_SAMPLE` and `SENDSTACK_HEALTH_MAX_*_RATE`
- Keep `SENDSTACK_EMERGENCY_STOP` unset/false until you intentionally halt sending

Rotate credentials if prior unauthorized use is suspected.

### 6. Manual worker tick on Vercel Hobby

`web/vercel.json` has **no** cron schedule. Do not add one on Hobby, and do not run an external loop to imitate Pro.

From `web/`, with `CRON_SECRET` and the canonical `SENDSTACK_PUBLIC_URL` in `.env.production`:

```bash
pnpm launch-jobs:tick
```

The command makes exactly one `GET /api/cron/launch-jobs` request, refuses redirects, prints only the bounded tick result, and exits. It is for a controlled manual check while live sending is disabled and the emergency stop is on. Continuous scheduling waits for Vercel Pro.

Admins can also tick once via `POST /api/launch-jobs/tick` (CSRF + `campaigns.send`). That path is not a scheduler either.

### 7. Configure and verify signed Resend webhooks

- Endpoint: `https://<production-host>/api/webhooks/resend`
- Use the signing secret from the Resend dashboard (`RESEND_WEBHOOK_SECRET`).
- Verify invalid signatures are rejected and a test event is claimed exactly once.

### 8. Verify DNS and domain alignment

Do **not** invent DNS records. Copy the **exact current records** from the verified Resend domain for `ctn-sk.com` (and any tracking subdomain).

Operator checklist:

- Resend domain verification status = verified
- SPF includes Resend’s published include
- DKIM published; prefer **2048-bit** when Resend supports rotation for the domain
- DMARC start at `p=none` with aggregate reporting; advance to quarantine/reject only after monitoring
- Align From domain, DKIM domain, return-path/bounce domain, and tracking domain with the brand
- Configure a **custom tracking domain** on the brand domain, or disable unused open/click tracking
- Keep Cloudflare DNS-only for app and mail records (do not proxy mail-critical records in a way that breaks SPF/DKIM)

### 9. Run sandbox / fake-provider checks

- With live send disabled, launch a sandbox campaign and confirm local recipient/message rows.
- Confirm suppressions, unsubscribe (`/u/:token`), and readiness fail-closed behavior.
- Confirm disposable PG suites pass in CI/local (`docker-compose.test.yml` + `pnpm test:pg`).

### 10. Run one allowlisted canary with explicit operator approval

- Enable live send only after steps 1–9.
- Send a single allowlisted test via `POST /api/campaigns/:id/test-send` to an address on `SENDSTACK_TEST_RECIPIENT_ALLOWLIST`.
- Do not broadcast to production audiences yet.

### 11. Observe webhook, bounce, complaint, and delivery state

- Confirm the canary reaches submitted/delivered via webhooks.
- Confirm delivery health snapshot and open health blocks (resolve/waive only with audit notes).
- Confirm no ambiguous `submission_unknown` remains without a reconciliation path.

### 12. Enable limited production volume

- Set a low `SENDSTACK_DAILY_LIMIT`.
- Launch only to consented, activated, unsuppressed contacts.
- Activate demoted contacts only with durable evidence via `POST /api/contacts/:id/activate`.

### 13. Warm up gradually

- Increase volume slowly while watching bounce, complaint, delay, unsubscribe, and webhook backlog rates.
- Enroll in **Gmail Postmaster Tools** for `ctn-sk.com`.
- Where applicable, enroll in **Microsoft SNDS / JMRP**.
- Use seed-list / mailbox-placement tests before each major volume step.
- Spamhaus or other blocklist remediation **only after** the generating source is removed and gates prevent recurrence.

### 14. Emergency stop and rollback

- Immediate halt: set `SENDSTACK_EMERGENCY_STOP=true` (or `1`) and redeploy/restart env; workers and live test sends fail closed.
- Pause/cancel in-flight campaigns via admin pause (provider cancel when still possible; honest `outcome_pending` when not).
- Resolve durable health blocks only with audited resolve/waive notes — aging alone never clears them.
- Rollback = redeploy previous known-good build + restore DB from verified backup if schema/data corruption is suspected.
- Forward-recover migrations; do not delete production history to “fix” schema issues.

---

## Explicit non-actions

- Do not deploy without operator approval
- Do not change DNS or invent records
- Do not rotate live credentials without authorization
- Do not modify the live Resend account without authorization
- Do not request Spamhaus/blocklist removal while abusive content remains reachable
- Do not delete historical campaigns, messages, audit events, or suppressions
- Do not open, extract, or execute suspicious ZIP/archive attachments
