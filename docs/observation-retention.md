# Observation storage and retention

## Write path

The agent continues claiming commands on every poll, but sends idle heartbeats
and full runtime telemetry at most once per five seconds. Failed heartbeats are
retried on the next poll; command execution invalidates the cadence so the next
poll refreshes state immediately. Command receipts/results are not throttled.

The API reuses the newest heartbeat observation (`operation_id IS NULL`) per
endpoint rather than appending every sample. Legacy duplicate heartbeat rows
remain until maintenance expires them. Operation-linked observations are never
overwritten. The existing node/session fences and node-then-endpoint lock order
remain in force; stale/future generations, deleted endpoints, and cross-tenant
samples cannot replace current state.

Receive freshness advances using the database clock. QQ, traffic, and resource
metadata are replaced by the complete received sample, including its original
sample timestamps; old sample timestamps are not relabeled as fresh. When JSON
state is equal, the update omits `state`, allowing PostgreSQL to reuse its TOAST
value. Changed metadata still incurs an ordinary JSONB/TOAST write.

## Bounded background maintenance

After normal operation/notification work, each worker runs at most one retention
batch per minute. Each transaction visits up to eight endpoints and deletes at
most 200 observation rows, with a two-second statement timeout. An in-memory
endpoint cursor advances between batches and wraps; restarting a worker starts
the walk again. Busy endpoint/observation locks are skipped and revisited on a
later walk. Cleanup errors are logged and retried on the next cadence rather
than stopping operation processing. No cleanup runs inline in the heartbeat API.

- Unlinked heartbeat history expires after **24 hours**.
- Operation-linked observations expire after **30 days**; operations, results,
  command journals, and audit records themselves are not pruned by this job.
- The newest observation overall and newest heartbeat per endpoint are retained
  regardless of age, including for offline/deleted endpoints. Timestamp ties at
  these boundaries are conservatively retained.
- Endpoint fencing and workspace predicates protect live snapshots from
  concurrent heartbeats/cleaners. No node or operation locks are acquired by
  cleanup.

This cadence is steady-state maintenance, not a fast historical purge. Large
backlogs need a separately scoped, bounded operator cleanup using the same
retention and current-state invariants. For this Botroost cleanup, the owner has
explicitly requested **no backups**. Do not add backup/export work to it.

## Migration and storage behavior

`0017_observations_autovacuum.sql` changes relation options only. It sets heap
vacuum/analyze scale factors to `0.05` and thresholds to `1000`, plus explicit
TOAST vacuum scale factor `0.05` and threshold `1000`. It leaves cluster-wide
worker counts, cost limits/delays, and other tables unchanged. TOAST does not use
analyze settings.

The migration uses transaction-local `lock_timeout = '5s'`. If a conflicting
lock prevents the metadata change, the migration and ledger insert roll back;
retry migration when contention subsides. It performs no backfill, deletion,
foreground scan, index rebuild, or table rewrite. Apply it before starting new
API/worker images, using the ordinary checksum-verified migration job.

Deletes and snapshot updates produce dead heap/TOAST tuples. Autovacuum makes
space reusable internally; it does **not** guarantee the relation files or disk
usage shrink. Do not use `VACUUM FULL`, blocking rewrites, or index rebuilds as
part of this release. Any immediate storage reclamation is a separate operator
decision, not an automatic migration step.

## Verification

Verify all images use the intended release SHA and the migration job succeeded.
Check worker logs for `observation retention` counts or
`observation retention failed`. Verify current endpoint/QQ/resource state and
command execution remain correct. Use PostgreSQL catalogs and statistics to
inspect heap/TOAST reloptions, estimated live/dead tuples, last autovacuum times,
and relation sizes; exact whole-table counts can be expensive on a backlog.

Regression tests use disposable PostgreSQL 16 to cover metadata replacement,
operation immutability, generation/session/tenant fencing, retention boundaries,
multiple cleaners and heartbeats, busy locks, migration timeout/rollback/retry,
heap/TOAST settings, replay, unchanged data, and unchanged relation filenodes.
Agent and worker tests cover cadence, immediate refresh, cursor progression,
and failure isolation.
