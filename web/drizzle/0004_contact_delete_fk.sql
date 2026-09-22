-- Allow deleting contacts that have campaign history.
-- Recipients keep historical email rows; contact_id becomes null.

ALTER TABLE campaign_recipients
  ALTER COLUMN contact_id DROP NOT NULL;

ALTER TABLE campaign_recipients
  DROP CONSTRAINT IF EXISTS campaign_recipients_contact_id_fkey;

ALTER TABLE campaign_recipients
  ADD CONSTRAINT campaign_recipients_contact_id_fkey
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
