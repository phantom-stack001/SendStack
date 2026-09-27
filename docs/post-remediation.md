# Post-remediation operator checklist

This checklist is for humans after the SendStack deliverability/anti-abuse hardening code is deployed. The application does **not** perform these actions automatically.

## Do not skip

1. **Credential rotation (if the phishing-like campaign was unauthorized)**
   - Rotate Resend API keys and webhook secrets.
   - Rotate SendStack session secrets and administrator passwords.
   - Revoke any unexpectedly created API tokens or user sessions.

2. **Resend DKIM key length**
   - Rotate domain DKIM from 1024-bit to **2048-bit** in the Resend dashboard.
   - Publish the new DNS records and confirm validation before increasing volume.

3. **DMARC monitoring before enforcement**
   - Keep `p=none` while monitoring aggregate/forensic reports.
   - Move to `quarantine` / `reject` only after authenticated legitimate mail is confirmed and spoofing noise is understood.

4. **Tracking domain**
   - Either configure a **custom tracking domain** on the sending brand domain, or **disable open/click tracking** if unused.
   - Avoid third-party tracking hosts that dilute brand alignment.

5. **Spamhaus / blocklist remediation**
   - Confirm the abusive content source is removed and cannot recur (code gates + operational controls).
   - Only then request delisting. Do not request removal while the generating campaign or similar content remains reachable.

6. **Warm-up**
   - Resume with small volumes to consented, engaged recipients only.
   - Increase gradually while watching bounces, complaints, delays, and unsubscribe rates in SendStack delivery health.

## Application gates already enforced in code

- Enforced `SENDSTACK_FROM_EMAIL` / `SENDSTACK_REPLY_TO_EMAIL`
- Required company name, postal address, and allowed link domains before live send
- Special-use recipient domain rejection
- Administrator-only allowlisted test sends that count toward daily limits
- Launch preflight against placeholders, fake RE/FW subjects, disallowed links, and archives
- Provider unsubscribe preservation (never `unsubscribed:false` on contact upsert)
- Webhook coverage for suppressed/failed/delayed/bounce/complaint/contact.updated
- Idempotent webhook event IDs and terminal-status protection
- Real Resend broadcast cancel (no false “paused” when the provider cannot stop sending)
- Daily volume accounting across direct, test, and broadcast recipient paths

## Explicit non-actions for agents/automation

- Do not deploy without operator approval
- Do not change DNS
- Do not request Spamhaus removal
- Do not rotate live credentials without authorization
- Do not modify the live Resend account without authorization
- Do not delete historical campaigns, messages, audit events, or suppressions
- Do not open, extract, or execute historical suspicious ZIP attachments
