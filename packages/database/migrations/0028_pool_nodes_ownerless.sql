BEGIN;
-- Shared-pool nodes belong to no workspace: usage is authorized exclusively
-- through workspace_node_pool_grants while the pool entry stays enabled.
ALTER TABLE nodes ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE platform_node_pool DROP CONSTRAINT IF EXISTS platform_node_pool_workspace_node_fkey;
ALTER TABLE platform_node_pool DROP COLUMN IF EXISTS owner_workspace_id;
-- Preserve the previous owner's access: grant before nulling ownership.
INSERT INTO workspace_node_pool_grants(workspace_id,node_id)
SELECT n.workspace_id,p.node_id FROM nodes n JOIN platform_node_pool p ON p.node_id=n.id
WHERE n.workspace_id IS NOT NULL
ON CONFLICT DO NOTHING;
UPDATE nodes SET workspace_id=NULL WHERE id IN (SELECT node_id FROM platform_node_pool) AND workspace_id IS NOT NULL;

-- Rewritten grant enforcement: ownership branch matches only non-NULL
-- workspace_id; pool nodes (workspace_id IS NULL) always require a grant.
CREATE OR REPLACE FUNCTION enforce_shared_node_pool_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='platform_node_pool' THEN
    IF NOT EXISTS(SELECT 1 FROM nodes n WHERE n.id=NEW.node_id AND n.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'pool node must be active' USING ERRCODE='23514';
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

-- Claim guard: pool nodes carry workspace_id NULL; NULL ownership is legal and
-- must fall through to the grant check instead of the stale-session branch.
CREATE OR REPLACE FUNCTION guard_agent_command_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE node_owned boolean; node_epoch bigint; node_revoked timestamptz; stale_reason jsonb;
BEGIN
  IF NEW.status='leased' AND OLD.status IS DISTINCT FROM 'leased' THEN
    SELECT workspace_id IS NOT NULL AND workspace_id=NEW.workspace_id,connection_epoch,revoked_at INTO node_owned,node_epoch,node_revoked FROM nodes WHERE id=NEW.node_id FOR UPDATE;
    IF node_owned IS NULL OR node_revoked IS NOT NULL OR node_epoch<>NEW.connection_epoch THEN
      stale_reason=jsonb_build_object('reason','node_session_stale');
    ELSIF NOT node_owned THEN
      PERFORM 1 FROM platform_node_pool p WHERE p.node_id=NEW.node_id AND p.enabled FOR UPDATE;
      IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM workspace_node_pool_grants g WHERE g.node_id=NEW.node_id AND g.workspace_id=NEW.workspace_id) THEN
        stale_reason=jsonb_build_object('reason','shared_node_access_revoked');
      END IF;
    END IF;
    IF stale_reason IS NOT NULL THEN
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
COMMIT;
