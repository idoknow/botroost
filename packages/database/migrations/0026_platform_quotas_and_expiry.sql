BEGIN;
-- Platform-wide quotas, workspace expiry, per-user endpoint quota overrides,
-- and an editable node remark kept separate from the registration name.
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_endpoints_per_workspace integer CHECK(max_endpoints_per_workspace IS NULL OR max_endpoints_per_workspace>=0);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS workspaces_expiry_idx ON workspaces(expires_at) WHERE expires_at IS NOT NULL;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS max_workspaces_per_user integer NOT NULL DEFAULT 5 CHECK(max_workspaces_per_user>=0);
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS max_endpoints_per_workspace integer NOT NULL DEFAULT 10 CHECK(max_endpoints_per_workspace>=0);
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS endpoint_expiry_grace_hours integer NOT NULL DEFAULT 24 CHECK(endpoint_expiry_grace_hours>=0);
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS remark text;
COMMIT;
