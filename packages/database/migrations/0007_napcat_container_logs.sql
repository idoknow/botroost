BEGIN;
ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_action_check;
ALTER TABLE operations ADD CONSTRAINT operations_action_check CHECK(action IN ('start','stop','restart','refresh-login-qr','read-container-logs'));
ALTER TABLE agent_commands DROP CONSTRAINT IF EXISTS agent_commands_action_check;
ALTER TABLE agent_commands ADD CONSTRAINT agent_commands_action_check CHECK(action IN ('start','stop','restart','refresh-login-qr','read-container-logs'));
COMMIT;