BEGIN;
-- A deleted selected tenant must invalidate its sessions, never make them unbound.
-- ON UPDATE CASCADE keeps a session bound to its membership when that membership moves
-- workspace: the session follows the tenant instead of blocking the move or going unbound.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_workspace_id_fkey;
ALTER TABLE sessions ADD CONSTRAINT sessions_workspace_id_fkey FOREIGN KEY(workspace_id,user_id) REFERENCES members(workspace_id,user_id) ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;
