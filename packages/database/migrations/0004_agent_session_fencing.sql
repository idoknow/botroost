BEGIN;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS connection_session_id text;
CREATE TABLE IF NOT EXISTS retired_node_sessions (
  node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(node_id,session_id)
);
COMMIT;
