-- botroost:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS observations_endpoint_created_at ON observations(endpoint_id,created_at DESC);
SELECT 1 / count(*)
FROM pg_index i
JOIN pg_class c ON c.oid=i.indexrelid
JOIN pg_am am ON am.oid=c.relam
WHERE c.relname='observations_endpoint_created_at'
  AND i.indrelid='observations'::regclass
  AND i.indisvalid
  AND i.indisready
  AND i.indisunique=false
  AND i.indnkeyatts=2
  AND i.indnatts=2
  AND i.indpred IS NULL
  AND i.indexprs IS NULL
  AND am.amname='btree'
  AND pg_get_indexdef(i.indexrelid,1,true)='endpoint_id'
  AND pg_get_indexdef(i.indexrelid,2,true)='created_at'
  AND i.indoption[0]=0
  AND i.indoption[1]=3;
