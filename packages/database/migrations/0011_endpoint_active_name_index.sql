-- botroost:no-transaction
DROP INDEX CONCURRENTLY IF EXISTS endpoints_workspace_name_active;
CREATE UNIQUE INDEX CONCURRENTLY endpoints_workspace_name_active ON endpoints(workspace_id,name) WHERE deleted_at IS NULL;
