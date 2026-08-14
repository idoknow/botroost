BEGIN;
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS claim_token uuid;
COMMIT;