BEGIN;
CREATE TABLE IF NOT EXISTS napcat_notification_state (
  endpoint_id uuid PRIMARY KEY REFERENCES endpoints(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  state text NOT NULL CHECK(state IN ('unknown','online','offline')) DEFAULT 'unknown',
  incident_open boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notification_outbox (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  endpoint_id uuid REFERENCES endpoints(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK(event_type IN ('napcat.offline','napcat.recovery','resend.test')),
  recipient text NOT NULL,
  sender text NOT NULL,
  subject text NOT NULL,
  html text NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  last_error text,
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_outbox_pending ON notification_outbox(available_at,created_at) WHERE sent_at IS NULL AND failed_at IS NULL;
COMMIT;
