-- Deliverability, anti-abuse, and webhook correlation hardening.
-- Preserves historical attachment rows (including disallowed archives) without deleting content.

ALTER TABLE suppressions DROP CONSTRAINT IF EXISTS suppressions_reason_check;
ALTER TABLE suppressions
  ADD CONSTRAINT suppressions_reason_check
  CHECK (reason IN ('unsubscribe', 'hard_bounce', 'complaint', 'manual', 'provider_suppression'));

ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;
ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_status_check
  CHECK (status IN ('draft', 'sending', 'paused', 'completed', 'cancelled', 'failed'));

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS reply_to_email TEXT,
  ADD COLUMN IF NOT EXISTS provider_status TEXT,
  ADD COLUMN IF NOT EXISTS cancellable BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE campaign_recipients DROP CONSTRAINT IF EXISTS campaign_recipients_status_check;
ALTER TABLE campaign_recipients
  ADD CONSTRAINT campaign_recipients_status_check
  CHECK (status IN (
    'queued', 'processing', 'sent', 'delayed', 'suppressed', 'failed',
    'bounced', 'complained', 'cancelled'
  ));

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_email TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS diagnostic_json TEXT NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

-- NULL idempotency keys remain allowed; non-null keys must be unique for safe retries.
CREATE UNIQUE INDEX IF NOT EXISTS messages_idempotency_key_uidx
  ON messages (idempotency_key);

CREATE INDEX IF NOT EXISTS messages_provider_id_idx ON messages (provider_id);
CREATE INDEX IF NOT EXISTS campaign_recipients_provider_email_id_idx
  ON campaign_recipients (provider_email_id);
CREATE INDEX IF NOT EXISTS campaign_recipients_campaign_email_idx
  ON campaign_recipients (campaign_id, lower(email));
CREATE INDEX IF NOT EXISTS campaigns_provider_broadcast_id_idx
  ON campaigns (provider_broadcast_id);

-- Historical archive attachments remain stored; new uploads are rejected in application code.
ALTER TABLE campaign_attachments
  ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE campaign_attachments
   SET blocked = TRUE
 WHERE lower(split_part(filename, '.', -1)) IN ('zip', 'rar', '7z', 'gz', 'tgz', 'tar')
    OR lower(content_type) LIKE '%zip%';
