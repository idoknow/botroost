BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE endpoints DROP CONSTRAINT IF EXISTS endpoints_workspace_id_name_key;
COMMIT;
