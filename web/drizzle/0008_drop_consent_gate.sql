-- Drop the SendStack consent gate. Spacemail SMTP sends to an email address;
-- active contacts no longer require consent evidence. Suppressions remain.

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_active_requires_consent_check;

ALTER TABLE contacts ALTER COLUMN status SET DEFAULT 'active';

-- Promote unsuppressed pending contacts so they are sendable again.
UPDATE contacts
   SET status = 'active',
       updated_at = NOW()
 WHERE status = 'pending_consent'
   AND NOT EXISTS (
     SELECT 1 FROM suppressions s WHERE s.email = contacts.email
   );

-- Pending contacts that are still on the suppression list stay non-sendable.
UPDATE contacts
   SET status = 'suppressed',
       updated_at = NOW()
 WHERE status = 'pending_consent'
   AND EXISTS (
     SELECT 1 FROM suppressions s WHERE s.email = contacts.email
   );
