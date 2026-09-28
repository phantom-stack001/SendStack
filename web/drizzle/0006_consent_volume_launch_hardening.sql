-- Consent integrity, atomic daily volume, durable launch jobs, and delivery-state hardening.
-- Additive only: preserves historical campaigns, messages, suppressions, audits, and attachments.
-- Idempotent: safe to re-run statements via IF NOT EXISTS / DROP CONSTRAINT IF EXISTS then ADD.

-- ---------------------------------------------------------------------------
-- Contacts: pending_consent + evidence; active requires attested consent
-- ---------------------------------------------------------------------------
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_status_check;
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_active_requires_consent_check;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS consent_evidence TEXT,
  ADD COLUMN IF NOT EXISTS consent_attested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS consent_verified_at TIMESTAMPTZ;

-- New contacts default to pending_consent until admin activation with evidence.
ALTER TABLE contacts ALTER COLUMN status SET DEFAULT 'pending_consent';

-- Historical contacts without attested affirmative consent become non-sendable
-- (must run before contacts_active_requires_consent_check is added).
UPDATE contacts
   SET status = 'pending_consent',
       updated_at = NOW()
 WHERE status = 'active'
   AND (
     consent_attested_by IS NULL
     OR consent_verified_at IS NULL
     OR consent_evidence IS NULL
     OR btrim(consent_evidence) = ''
   );

ALTER TABLE contacts
  ADD CONSTRAINT contacts_status_check
  CHECK (status IN ('active', 'suppressed', 'pending_consent'));

-- status='active' requires non-empty consent_evidence, attested_by, and verified_at.
ALTER TABLE contacts
  ADD CONSTRAINT contacts_active_requires_consent_check
  CHECK (
    status <> 'active'
    OR (
      consent_evidence IS NOT NULL
      AND btrim(consent_evidence) <> ''
      AND consent_attested_by IS NOT NULL
      AND consent_verified_at IS NOT NULL
    )
  );

-- ---------------------------------------------------------------------------
-- Campaign / recipient / message states
-- ---------------------------------------------------------------------------
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;
ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_status_check
  CHECK (status IN (
    'draft', 'sending', 'paused', 'completed', 'cancelled', 'failed',
    'submission_unknown', 'reconciling', 'partially_sent', 'cancel_requested'
  ));

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS launch_job_id TEXT,
  ADD COLUMN IF NOT EXISTS submission_state TEXT,
  ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS launch_snapshot JSONB;

ALTER TABLE campaign_recipients DROP CONSTRAINT IF EXISTS campaign_recipients_status_check;
ALTER TABLE campaign_recipients
  ADD CONSTRAINT campaign_recipients_status_check
  CHECK (status IN (
    'queued', 'processing', 'sent', 'delayed', 'suppressed', 'failed',
    'bounced', 'complained', 'cancelled', 'cancel_requested', 'outcome_pending',
    'submission_unknown'
  ));

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS volume_reservation_id TEXT,
  ADD COLUMN IF NOT EXISTS status_rank INTEGER NOT NULL DEFAULT 0;

UPDATE messages
   SET status_rank = CASE status
     WHEN 'captured' THEN 10
     WHEN 'submission_unknown' THEN 20
     WHEN 'submitted' THEN 30
     WHEN 'delayed' THEN 40
     WHEN 'delivered' THEN 50
     WHEN 'failed' THEN 100
     WHEN 'bounced' THEN 100
     WHEN 'complained' THEN 100
     WHEN 'suppressed' THEN 100
     WHEN 'unsubscribed' THEN 100
     ELSE status_rank
   END;

-- ---------------------------------------------------------------------------
-- Atomic daily volume (UTC day boundary)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_volume_counters (
  day_utc DATE PRIMARY KEY,
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_volume_reservations (
  id TEXT PRIMARY KEY,
  reservation_key TEXT NOT NULL UNIQUE,
  attempt_key TEXT,
  day_utc DATE NOT NULL REFERENCES daily_volume_counters(day_utc),
  units INTEGER NOT NULL DEFAULT 1 CHECK (units > 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released')),
  campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent column add if table already existed without attempt_key.
ALTER TABLE daily_volume_reservations
  ADD COLUMN IF NOT EXISTS attempt_key TEXT;

CREATE INDEX IF NOT EXISTS daily_volume_reservations_day_status_idx
  ON daily_volume_reservations (day_utc, status);

CREATE INDEX IF NOT EXISTS daily_volume_reservations_attempt_key_idx
  ON daily_volume_reservations (attempt_key)
  WHERE attempt_key IS NOT NULL;

-- Backfill counters from existing same-day messages (never decrease reserved_units).
INSERT INTO daily_volume_counters (day_utc, reserved_units, created_at, updated_at)
SELECT (created_at AT TIME ZONE 'UTC')::date AS day_utc,
       COUNT(*)::int AS reserved_units,
       NOW(),
       NOW()
  FROM messages
 WHERE status IN (
   'captured', 'submitted', 'submission_unknown', 'delivered', 'delayed',
   'bounced', 'complained', 'failed', 'suppressed', 'unsubscribed'
 )
 GROUP BY (created_at AT TIME ZONE 'UTC')::date
ON CONFLICT (day_utc) DO UPDATE
   SET reserved_units = GREATEST(daily_volume_counters.reserved_units, EXCLUDED.reserved_units),
       updated_at = NOW();

-- ---------------------------------------------------------------------------
-- Durable launch jobs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS launch_jobs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'running', 'completed', 'failed', 'cancelled',
    'reconciling', 'submission_unknown', 'manual_review'
  )),
  cursor_offset INTEGER NOT NULL DEFAULT 0 CHECK (cursor_offset >= 0),
  total_recipients INTEGER NOT NULL DEFAULT 0,
  chunk_size INTEGER NOT NULL DEFAULT 100,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  live_mode BOOLEAN NOT NULL DEFAULT FALSE,
  cancel_requested_at TIMESTAMPTZ,
  snapshot_json JSONB,
  max_attempts INTEGER NOT NULL DEFAULT 25,
  next_retry_at TIMESTAMPTZ,
  terminal_reason TEXT,
  provider_segment_id TEXT,
  provider_broadcast_id TEXT,
  provider_import_id TEXT,
  reservation_batch_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Harden existing launch_jobs rows if CREATE TABLE was a no-op.
ALTER TABLE launch_jobs
  ADD COLUMN IF NOT EXISTS lease_generation INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS live_mode BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS snapshot_json JSONB,
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terminal_reason TEXT;

ALTER TABLE launch_jobs DROP CONSTRAINT IF EXISTS launch_jobs_status_check;
ALTER TABLE launch_jobs
  ADD CONSTRAINT launch_jobs_status_check
  CHECK (status IN (
    'pending', 'running', 'completed', 'failed', 'cancelled',
    'reconciling', 'submission_unknown', 'manual_review'
  ));

CREATE INDEX IF NOT EXISTS launch_jobs_status_lease_idx
  ON launch_jobs (status, lease_expires_at);
CREATE INDEX IF NOT EXISTS launch_jobs_campaign_id_idx
  ON launch_jobs (campaign_id);

-- At most one active launch job per campaign.
CREATE UNIQUE INDEX IF NOT EXISTS launch_jobs_one_active_per_campaign
  ON launch_jobs (campaign_id)
  WHERE status IN ('pending', 'running', 'reconciling', 'submission_unknown');

-- launch_job_id is soft-linked (no FK) to avoid circular dependency with launch_jobs.campaign_id.

-- ---------------------------------------------------------------------------
-- Launch job import chunks (provider import progress per chunk)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS launch_job_imports (
  id TEXT PRIMARY KEY,
  launch_job_id TEXT NOT NULL REFERENCES launch_jobs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  provider_import_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'in_progress', 'completed', 'failed')),
  counts_json JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (launch_job_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS launch_job_imports_job_status_idx
  ON launch_job_imports (launch_job_id, status);

-- ---------------------------------------------------------------------------
-- Suppressions: protect hard/provider suppressions from accidental clear
-- ---------------------------------------------------------------------------
ALTER TABLE suppressions
  ADD COLUMN IF NOT EXISTS protected BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE suppressions
   SET protected = TRUE
 WHERE reason IN ('hard_bounce', 'complaint', 'provider_suppression')
    OR source ILIKE '%provider%';

-- ---------------------------------------------------------------------------
-- Webhook claim / processing lease
-- ---------------------------------------------------------------------------
ALTER TABLE provider_events
  ADD COLUMN IF NOT EXISTS claim_owner TEXT,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_token TEXT;

-- Unique per claim; multiple NULL tokens remain allowed.
CREATE UNIQUE INDEX IF NOT EXISTS provider_events_claim_token_uidx
  ON provider_events (claim_token)
  WHERE claim_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS provider_events_unprocessed_idx
  ON provider_events (processed_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS provider_events_claim_expires_idx
  ON provider_events (claim_expires_at)
  WHERE processed_at IS NULL AND claim_expires_at IS NOT NULL;
