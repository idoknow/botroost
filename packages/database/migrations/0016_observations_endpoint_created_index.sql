-- botroost:no-transaction
DROP INDEX CONCURRENTLY IF EXISTS observations_endpoint_created_at;
CREATE INDEX CONCURRENTLY observations_endpoint_created_at ON observations(endpoint_id,created_at DESC);
