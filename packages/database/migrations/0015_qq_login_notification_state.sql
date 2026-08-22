BEGIN;
CREATE TABLE qq_login_notification_state (
  endpoint_id uuid PRIMARY KEY REFERENCES endpoints(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  state text NOT NULL CHECK(state IN ('unknown','online','offline')) DEFAULT 'unknown',
  incident_open boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
