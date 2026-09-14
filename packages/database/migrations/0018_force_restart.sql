BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
ALTER TABLE operations ADD CONSTRAINT operations_action_check_v3
  CHECK(action IN ('start','stop','restart','force-restart','delete','refresh-login-qr','read-container-logs','update-onebot-websockets')) NOT VALID;
ALTER TABLE operations VALIDATE CONSTRAINT operations_action_check_v3;
ALTER TABLE operations DROP CONSTRAINT operations_action_check;
ALTER TABLE operations RENAME CONSTRAINT operations_action_check_v3 TO operations_action_check;
ALTER TABLE agent_commands ADD CONSTRAINT agent_commands_action_check_v3
  CHECK(action IN ('start','stop','restart','force-restart','delete','refresh-login-qr','read-container-logs','update-onebot-websockets')) NOT VALID;
ALTER TABLE agent_commands VALIDATE CONSTRAINT agent_commands_action_check_v3;
ALTER TABLE agent_commands DROP CONSTRAINT agent_commands_action_check;
ALTER TABLE agent_commands RENAME CONSTRAINT agent_commands_action_check_v3 TO agent_commands_action_check;
COMMIT;
