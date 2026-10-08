# Production runbook: Spacemail SMTP

This is the human-owned activation sequence for SendStack on Vercel + PostgreSQL + Spacemail SMTP.
The application code does **not** perform these steps. Agents and automation must not deploy, mutate DNS, rotate live credentials, or send real mail unless separately authorized.

## Ordered activation

1. Backup the database and confirm restore works.
2. Apply SQL migrations through `0007_submission_state_machine.sql`.
3. Set identity env vars (`SENDSTACK_FROM_EMAIL`, `SENDSTACK_REPLY_TO_EMAIL`, `SENDSTACK_ALLOWED_LINK_DOMAINS`).
4. Set Spacemail SMTP env vars (`SENDSTACK_SMTP_HOST=mail.spacemail.com`, port `465`, username, password).
5. Confirm Spacemail DNS (MX/SPF/DKIM/DMARC) for the sending domain.
6. Set `CRON_SECRET` and point an external scheduler at `GET /api/cron/launch-jobs` every minute.
7. Keep `SENDSTACK_LIVE_SEND_ENABLED=false` until a consented canary is ready.
8. Unlock live send, send a small canary, confirm SMTP acceptance in Deliveries, then ramp within the 500/hour mailbox limit.

Preview deployments must never receive production SMTP credentials.
