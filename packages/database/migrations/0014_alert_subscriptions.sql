BEGIN;

CREATE TABLE notification_targets (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(btrim(name)) > 0),
  email text NOT NULL CHECK(length(btrim(email)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,email),
  UNIQUE(workspace_id,id)
);

CREATE TABLE workspace_notification_defaults (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK(event_type IN ('endpoint.offline','endpoint.recovery')),
  target_id uuid NOT NULL,
  PRIMARY KEY(workspace_id,event_type,target_id),
  FOREIGN KEY(workspace_id,target_id) REFERENCES notification_targets(workspace_id,id) ON DELETE CASCADE
);

CREATE TABLE endpoint_notification_subscriptions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('endpoint.offline','endpoint.recovery')),
  target_id uuid NOT NULL,
  PRIMARY KEY(workspace_id,endpoint_id,event_type,target_id),
  FOREIGN KEY(workspace_id,endpoint_id) REFERENCES endpoints(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,target_id) REFERENCES notification_targets(workspace_id,id) ON DELETE CASCADE
);

INSERT INTO notification_targets(id,workspace_id,name,email)
SELECT gen_random_uuid(),id,'Existing alert recipient',settings->'resend'->>'recipient'
FROM workspaces
WHERE settings->'resend'->>'enabled'='true'
  AND length(btrim(coalesce(settings->'resend'->>'recipient',''))) > 0
ON CONFLICT(workspace_id,email) DO NOTHING;

INSERT INTO workspace_notification_defaults(workspace_id,event_type,target_id)
SELECT target.workspace_id,event.event_type,target.id
FROM notification_targets target
CROSS JOIN (VALUES ('endpoint.offline'),('endpoint.recovery')) event(event_type)
WHERE target.name='Existing alert recipient'
ON CONFLICT DO NOTHING;

INSERT INTO endpoint_notification_subscriptions(workspace_id,endpoint_id,event_type,target_id)
SELECT endpoint.workspace_id,endpoint.id,defaults.event_type,defaults.target_id
FROM endpoints endpoint
JOIN workspace_notification_defaults defaults ON defaults.workspace_id=endpoint.workspace_id
WHERE endpoint.deleted_at IS NULL
ON CONFLICT DO NOTHING;

UPDATE workspaces
SET settings=(settings-'resend')||jsonb_build_object(
  'alerts',
  jsonb_build_object('graceSeconds',coalesce((settings->'resend'->>'graceSeconds')::integer,180))
),updated_at=now()
WHERE settings ? 'resend';

ALTER TABLE napcat_notification_state RENAME TO endpoint_notification_state;
ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_event_type_check;
DELETE FROM notification_outbox WHERE event_type='resend.test';
UPDATE notification_outbox SET event_type=CASE event_type WHEN 'napcat.offline' THEN 'endpoint.offline' WHEN 'napcat.recovery' THEN 'endpoint.recovery' ELSE event_type END;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_event_type_check CHECK(event_type IN ('endpoint.offline','endpoint.recovery'));
ALTER TABLE notification_outbox DROP COLUMN sender;

DELETE FROM credentials credential
WHERE NOT EXISTS(SELECT 1 FROM nodes WHERE nodes.credential_id=credential.id);

COMMIT;
