BEGIN;
-- Existing workspaces, identities, endpoints, and data are preserved in place.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workspace_id uuid;
UPDATE sessions s SET workspace_id=(SELECT m.workspace_id FROM members m WHERE m.user_id=s.user_id ORDER BY m.created_at,m.workspace_id LIMIT 1) WHERE s.workspace_id IS NULL;
ALTER TABLE members ADD COLUMN IF NOT EXISTS workspace_role text NOT NULL DEFAULT 'member' CHECK(workspace_role IN ('owner','member'));
-- Promote every legacy workspace owner while keeping the current RBAC role valid.
UPDATE members SET workspace_role='owner',role='admin' WHERE role='owner';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_owner boolean NOT NULL DEFAULT false;
-- Upgrade every legacy workspace owner to platform owner, as requested.
UPDATE users u SET is_platform_owner=true WHERE EXISTS (SELECT 1 FROM members m WHERE m.user_id=u.id AND m.workspace_role='owner');
CREATE TABLE IF NOT EXISTS platform_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  registration_open boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings(id,registration_open) VALUES(true,false) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS workspace_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK(role IN ('admin','operator','viewer')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  revoked_at timestamptz,
  UNIQUE(workspace_id,email)
);
COMMIT;
