BEGIN;
-- Two invitation scopes:
--   'workspace': classic — the invited user joins the inviter's workspace.
--   'platform':  the invited user registers and gets a NEW workspace of their
--                own (as workspace owner); they never join the inviter's
--                workspace. Proxy nodes stay workspace-scoped, so the new
--                workspace starts with no nodes and cannot see the inviter's.
ALTER TABLE workspace_invitations ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'workspace';
ALTER TABLE workspace_invitations ADD CONSTRAINT workspace_invitations_scope_check CHECK (scope IN ('workspace','platform'));
CREATE INDEX IF NOT EXISTS workspace_invitations_scope_idx ON workspace_invitations(workspace_id, scope);
COMMIT;
