# Post-remediation checklist (Spacemail)

Operator-only follow-ups after switching delivery from Resend to Spacemail SMTP.

1. **Rotate credentials**
   - Remove `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET` from Vercel and secret stores.
   - Store Spacemail mailbox password in approved secret storage only.

2. **DNS**
   - Remove Resend SPF/DKIM/tracking records from the sending domain.
   - Keep Spacemail’s published SPF/DKIM/DMARC records.

3. **Webhook cleanup**
   - Delete any Resend webhook endpoint pointing at `/api/webhooks/resend`.

4. **Operational limits**
   - Paid Spacemail mailboxes: 500 outgoing messages/hour.
   - Align `SENDSTACK_SMTP_HOURLY_LIMIT` and `SENDSTACK_DAILY_LIMIT` with the mailbox plan.

5. **Bounce handling**
   - Automatic IMAP bounce ingestion is out of scope. Use suppressions and simulated feedback until that exists.
