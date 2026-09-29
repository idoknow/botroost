BEGIN;
-- A deleted selected tenant must invalidate its sessions, never make them unbound.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_workspace_id_fkey;
ALTER TABLE sessions ADD CONSTRAINT sessions_workspace_id_fkey FOREIGN KEY(workspace_id,user_id) REFERENCES members(workspace_id,user_id) ON DELETE CASCADE;
COMMIT;
