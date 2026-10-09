-- Spacemail parity: ordinary SMTP messages, optional opt-out tokens only,
-- no Resend broadcast columns, no webhooks, no campaign attachments.

-- Opt-out tokens are minted only when the author uses {{unsubscribe_url}}.
ALTER TABLE messages ALTER COLUMN unsubscribe_token DROP NOT NULL;

-- Resend / broadcast leftovers on campaigns.
DROP INDEX IF EXISTS campaigns_provider_broadcast_id_idx;
ALTER TABLE campaigns DROP COLUMN IF EXISTS provider_broadcast_id;
ALTER TABLE campaigns DROP COLUMN IF EXISTS provider_segment_id;

-- Same leftovers on launch_jobs (and related import tracking).
ALTER TABLE launch_jobs DROP COLUMN IF EXISTS provider_broadcast_id;
ALTER TABLE launch_jobs DROP COLUMN IF EXISTS provider_segment_id;
ALTER TABLE launch_jobs DROP COLUMN IF EXISTS provider_import_id;

-- Spacemail SMTP has no delivery webhooks.
DROP TABLE IF EXISTS provider_events;

-- Attachments removed from SendStack (compose body only).
DROP TABLE IF EXISTS campaign_attachments;

-- Consent evidence columns are unused after 0008; contacts are active|suppressed.
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_active_requires_consent_check;
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_status_check;

UPDATE contacts
   SET status = CASE
         WHEN status = 'pending_consent'
           AND EXISTS (SELECT 1 FROM suppressions s WHERE s.email = contacts.email)
         THEN 'suppressed'
         WHEN status = 'pending_consent' THEN 'active'
         ELSE status
       END,
       updated_at = NOW()
 WHERE status = 'pending_consent';

ALTER TABLE contacts
  ADD CONSTRAINT contacts_status_check
  CHECK (status IN ('active', 'suppressed'));

ALTER TABLE contacts DROP COLUMN IF EXISTS consent_evidence;
ALTER TABLE contacts DROP COLUMN IF EXISTS consent_attested_by;
ALTER TABLE contacts DROP COLUMN IF EXISTS consent_verified_at;
