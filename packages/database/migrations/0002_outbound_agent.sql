BEGIN;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS credential_hash text UNIQUE;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS enrollment_token_id uuid REFERENCES enrollment_tokens(id);
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS labels jsonb NOT NULL DEFAULT '{}';
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS agent_version text;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS connection_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS heartbeat_metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE enrollment_tokens ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'agent';
ALTER TABLE enrollment_tokens ADD COLUMN IF NOT EXISTS labels jsonb NOT NULL DEFAULT '{}';
ALTER TABLE enrollment_tokens ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE enrollment_tokens ADD COLUMN IF NOT EXISTS used_at timestamptz;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS node_id uuid REFERENCES nodes(id);
ALTER TABLE operations ADD COLUMN IF NOT EXISTS lease_deadline timestamptz;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS command_attempt integer NOT NULL DEFAULT 0;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS connection_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS agent_commands (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES nodes(id),
  endpoint_id uuid NOT NULL,
  operation_id uuid NOT NULL UNIQUE REFERENCES operations(id),
  generation bigint NOT NULL,
  connection_epoch bigint NOT NULL,
  action text NOT NULL CHECK(action IN ('start','stop','restart')),
  runtime_request jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK(status IN ('queued','leased','succeeded','failed','stale')) DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  lease_deadline timestamptz,
  receipt_at timestamptz,
  result_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,endpoint_id) REFERENCES endpoints(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS agent_commands_claim ON agent_commands(node_id,status,lease_deadline,created_at);
COMMIT;
