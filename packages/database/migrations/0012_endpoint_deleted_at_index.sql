-- botroost:no-transaction
DROP INDEX CONCURRENTLY IF EXISTS endpoints_deleted_at;
CREATE INDEX CONCURRENTLY endpoints_deleted_at ON endpoints(deleted_at);
