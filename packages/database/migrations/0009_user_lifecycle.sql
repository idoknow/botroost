BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
CREATE INDEX IF NOT EXISTS users_enabled_email_idx ON users(email) WHERE disabled_at IS NULL;
COMMIT;
