BEGIN;
-- Metadata only: no historical cleanup, table rewrite, or foreground scan.
-- Fail promptly on busy relations so deployment can retry in a quiet window.
SET LOCAL lock_timeout = '5s';
ALTER TABLE observations SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.05,
  autovacuum_analyze_threshold = 1000,
  toast.autovacuum_vacuum_scale_factor = 0.05,
  toast.autovacuum_vacuum_threshold = 1000
);
COMMIT;
