BEGIN;
CREATE TABLE IF NOT EXISTS platform_node_pool (
  node_id uuid PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  owner_workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS workspace_node_pool_grants (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES platform_node_pool(node_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY(workspace_id,node_id)
);
CREATE INDEX IF NOT EXISTS workspace_node_pool_grants_node_idx ON workspace_node_pool_grants(node_id,workspace_id);
-- Pool ownership remains anchored to the node's original workspace. Endpoints and commands
-- may belong to a different workspace only via the explicit grant trigger below.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='nodes'::regclass AND conname='nodes_workspace_id_id_key') THEN
    ALTER TABLE nodes ADD CONSTRAINT nodes_workspace_id_id_key UNIQUE(workspace_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform_node_pool'::regclass AND conname='platform_node_pool_workspace_node_fkey') THEN
    ALTER TABLE platform_node_pool ADD CONSTRAINT platform_node_pool_workspace_node_fkey FOREIGN KEY(owner_workspace_id,node_id) REFERENCES nodes(workspace_id,id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='endpoints'::regclass AND conname='endpoints_workspace_id_id_key') THEN
    ALTER TABLE endpoints ADD CONSTRAINT endpoints_workspace_id_id_key UNIQUE(workspace_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='operations'::regclass AND conname='operations_workspace_endpoint_id_fkey') THEN
    ALTER TABLE operations ADD CONSTRAINT operations_workspace_endpoint_id_fkey FOREIGN KEY(workspace_id,endpoint_id) REFERENCES endpoints(workspace_id,id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_commands'::regclass AND conname='agent_commands_workspace_endpoint_id_fkey') THEN
    ALTER TABLE agent_commands ADD CONSTRAINT agent_commands_workspace_endpoint_id_fkey FOREIGN KEY(workspace_id,endpoint_id) REFERENCES endpoints(workspace_id,id) NOT VALID;
  END IF;
END $$;
ALTER TABLE platform_node_pool VALIDATE CONSTRAINT platform_node_pool_workspace_node_fkey;
ALTER TABLE operations VALIDATE CONSTRAINT operations_workspace_endpoint_id_fkey;
ALTER TABLE agent_commands VALIDATE CONSTRAINT agent_commands_workspace_endpoint_id_fkey;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='endpoints'::regclass AND conname='endpoints_node_id_fkey') THEN
    ALTER TABLE endpoints ADD CONSTRAINT endpoints_node_id_fkey FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION enforce_shared_node_pool_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='platform_node_pool' THEN
    IF TG_OP='UPDATE' AND (NEW.node_id IS DISTINCT FROM OLD.node_id OR NEW.owner_workspace_id IS DISTINCT FROM OLD.owner_workspace_id) THEN
      RAISE EXCEPTION 'node ownership is immutable' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM nodes n WHERE n.id=NEW.node_id AND n.workspace_id=NEW.owner_workspace_id AND n.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'pool owner must match an active node owner' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='operations' THEN
    IF NEW.node_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM endpoints e WHERE e.id=NEW.endpoint_id AND e.workspace_id=NEW.workspace_id AND e.node_id=NEW.node_id) THEN
      RAISE EXCEPTION 'operation node must match its endpoint node' USING ERRCODE='23514';
    END IF;
    IF NEW.node_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.id=NEW.node_id AND n.revoked_at IS NULL AND (n.workspace_id=NEW.workspace_id OR EXISTS(SELECT 1 FROM platform_node_pool p JOIN workspace_node_pool_grants g ON g.node_id=p.node_id WHERE p.node_id=n.id AND p.enabled AND g.workspace_id=NEW.workspace_id))) THEN
      RAISE EXCEPTION 'operation node is not authorized for workspace' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='agent_commands' THEN
    IF TG_OP='UPDATE' AND OLD.status='leased' AND NEW.status IN ('succeeded','failed') THEN
      IF NOT EXISTS(SELECT 1 FROM nodes n WHERE n.id=NEW.node_id AND n.revoked_at IS NULL AND (n.workspace_id=NEW.workspace_id OR EXISTS(SELECT 1 FROM platform_node_pool p JOIN workspace_node_pool_grants g ON g.node_id=p.node_id WHERE p.node_id=NEW.node_id AND p.enabled AND g.workspace_id=NEW.workspace_id))) THEN
        RAISE EXCEPTION 'agent command result rejected after shared node access revocation' USING ERRCODE='23514';
      END IF;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM endpoints e WHERE e.id=NEW.endpoint_id AND e.workspace_id=NEW.workspace_id AND e.node_id=NEW.node_id) THEN
      RAISE EXCEPTION 'agent command node must match its endpoint node' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM nodes n WHERE n.id=NEW.node_id AND n.revoked_at IS NULL AND (n.workspace_id=NEW.workspace_id OR EXISTS(SELECT 1 FROM platform_node_pool p JOIN workspace_node_pool_grants g ON g.node_id=p.node_id WHERE p.node_id=n.id AND p.enabled AND g.workspace_id=NEW.workspace_id))) THEN
      RAISE EXCEPTION 'agent command node is not authorized for workspace' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.node_id IS NULL THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM nodes n WHERE n.id=NEW.node_id AND n.workspace_id=NEW.workspace_id AND n.revoked_at IS NULL) THEN RETURN NEW; END IF;
  PERFORM 1 FROM platform_node_pool p JOIN nodes n ON n.id=p.node_id WHERE p.node_id=NEW.node_id FOR UPDATE OF p;
  IF EXISTS(SELECT 1 FROM workspace_node_pool_grants g JOIN platform_node_pool p ON p.node_id=g.node_id JOIN nodes n ON n.id=p.node_id WHERE g.workspace_id=NEW.workspace_id AND g.node_id=NEW.node_id AND p.enabled AND n.revoked_at IS NULL) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'node is not owned by workspace or granted from shared pool' USING ERRCODE='23514';
END;
$$;
CREATE OR REPLACE FUNCTION guard_agent_command_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE node_workspace uuid; node_epoch bigint; node_revoked timestamptz; stale_reason jsonb;
BEGIN
  IF NEW.status='leased' AND OLD.status IS DISTINCT FROM 'leased' THEN
    SELECT workspace_id,connection_epoch,revoked_at INTO node_workspace,node_epoch,node_revoked FROM nodes WHERE id=NEW.node_id FOR UPDATE;
    IF node_workspace IS NULL OR node_revoked IS NOT NULL OR node_epoch<>NEW.connection_epoch THEN
      stale_reason=jsonb_build_object('reason','node_session_stale');
    ELSIF node_workspace<>NEW.workspace_id THEN
      PERFORM 1 FROM platform_node_pool p WHERE p.node_id=NEW.node_id AND p.enabled FOR UPDATE;
      IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM workspace_node_pool_grants g WHERE g.node_id=NEW.node_id AND g.workspace_id=NEW.workspace_id) THEN
        stale_reason=jsonb_build_object('reason','shared_node_access_revoked');
      END IF;
    END IF;
    IF stale_reason IS NOT NULL THEN
      -- This is a BEFORE UPDATE of the candidate command. Return a stale row instead of
      -- issuing a recursive UPDATE against the same agent_commands relation.
      NEW.status='stale';
      NEW.result_at=now();
      NEW.lease_deadline=NULL;
      NEW.result=stale_reason;
      NEW.updated_at=now();
      RETURN NEW;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM endpoints e WHERE e.id=NEW.endpoint_id AND e.workspace_id=NEW.workspace_id AND e.node_id=NEW.node_id) THEN
      RAISE EXCEPTION 'command endpoint node mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='leased' AND NEW.status IN ('succeeded','failed') THEN
    IF NOT EXISTS(SELECT 1 FROM nodes n WHERE n.id=NEW.node_id AND n.revoked_at IS NULL AND (n.workspace_id=NEW.workspace_id OR EXISTS(SELECT 1 FROM platform_node_pool p JOIN workspace_node_pool_grants g ON g.node_id=p.node_id WHERE p.node_id=NEW.node_id AND p.enabled AND g.workspace_id=NEW.workspace_id))) THEN
      RAISE EXCEPTION 'agent command result rejected after shared node access revocation' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agent_commands_claim_guard ON agent_commands;
CREATE TRIGGER agent_commands_claim_guard BEFORE UPDATE OF status,attempts ON agent_commands FOR EACH ROW EXECUTE FUNCTION guard_agent_command_claim();
CREATE OR REPLACE FUNCTION invalidate_shared_node_leases() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revoked_node uuid; revoked_workspace uuid;
BEGIN
  IF TG_TABLE_NAME='workspace_node_pool_grants' THEN
    revoked_node:=OLD.node_id; revoked_workspace:=OLD.workspace_id;
  ELSE
    revoked_node:=OLD.node_id;
  END IF;
  UPDATE operations o SET status='stale',result=jsonb_build_object('reason','shared_node_access_revoked'),updated_at=now()
    WHERE o.node_id=revoked_node AND o.status='running'
      AND (revoked_workspace IS NULL OR o.workspace_id=revoked_workspace);
  UPDATE agent_commands c SET status='stale',result=jsonb_build_object('reason','shared_node_access_revoked'),result_at=now(),lease_deadline=NULL,updated_at=now()
    WHERE c.node_id=revoked_node AND c.status IN ('pending','leased')
      AND (revoked_workspace IS NULL OR c.workspace_id=revoked_workspace);
  RETURN COALESCE(NEW,OLD);
END;
$$;
DROP TRIGGER IF EXISTS workspace_node_pool_grants_revoke_work ON workspace_node_pool_grants;
CREATE TRIGGER workspace_node_pool_grants_revoke_work AFTER DELETE ON workspace_node_pool_grants FOR EACH ROW EXECUTE FUNCTION invalidate_shared_node_leases();
DROP TRIGGER IF EXISTS platform_node_pool_revoke_work ON platform_node_pool;
CREATE TRIGGER platform_node_pool_revoke_work AFTER UPDATE OF enabled ON platform_node_pool FOR EACH ROW WHEN (OLD.enabled AND NOT NEW.enabled) EXECUTE FUNCTION invalidate_shared_node_leases();
DROP TRIGGER IF EXISTS platform_node_pool_delete_work ON platform_node_pool;
CREATE TRIGGER platform_node_pool_delete_work AFTER DELETE ON platform_node_pool FOR EACH ROW EXECUTE FUNCTION invalidate_shared_node_leases();
CREATE OR REPLACE FUNCTION platform_node_pool_disable_on_node_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    UPDATE endpoints SET node_id=NULL,updated_at=now() WHERE node_id=NEW.id;
    DELETE FROM workspace_node_pool_grants WHERE node_id=NEW.id;
    DELETE FROM platform_node_pool WHERE node_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS platform_node_pool_node_revoke ON nodes;
CREATE TRIGGER platform_node_pool_node_revoke AFTER UPDATE OF revoked_at ON nodes FOR EACH ROW EXECUTE FUNCTION platform_node_pool_disable_on_node_revoke();
DROP TRIGGER IF EXISTS endpoints_node_workspace_guard ON endpoints;
DROP TRIGGER IF EXISTS operations_node_workspace_guard ON operations;
CREATE TRIGGER operations_node_workspace_guard BEFORE INSERT OR UPDATE OF workspace_id,node_id,endpoint_id ON operations FOR EACH ROW EXECUTE FUNCTION enforce_shared_node_pool_grant();
DROP TRIGGER IF EXISTS agent_commands_node_workspace_guard ON agent_commands;
CREATE TRIGGER agent_commands_node_workspace_guard BEFORE INSERT OR UPDATE OF workspace_id,node_id,endpoint_id ON agent_commands FOR EACH ROW EXECUTE FUNCTION enforce_shared_node_pool_grant();
DROP TRIGGER IF EXISTS platform_node_pool_owner_guard ON platform_node_pool;
CREATE TRIGGER platform_node_pool_owner_guard BEFORE INSERT OR UPDATE OF node_id,owner_workspace_id ON platform_node_pool FOR EACH ROW EXECUTE FUNCTION enforce_shared_node_pool_grant();
CREATE TRIGGER endpoints_node_workspace_guard BEFORE INSERT OR UPDATE OF workspace_id,node_id ON endpoints FOR EACH ROW EXECUTE FUNCTION enforce_shared_node_pool_grant();
COMMIT;
