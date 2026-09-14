# Force restart

Use **Force restart** on an endpoint when a provider is unresponsive or a pending operation prevents ordinary restart. Confirm the warning before submission. Operator, admin, and owner roles use the existing restart permission; viewers cannot submit it.

The API accepts `POST /api/v1/endpoints/:id/operations` with `action: "force-restart"`, the current `expectedGeneration`, and the normal session, CSRF, and idempotency headers. A stale generation returns a conflict: refresh and retry rather than silently acting on a changed endpoint. Active deletion cannot be interrupted.

The request atomically marks an active non-delete operation stale, invalidates its command/outbox delivery, preserves audit history, and queues a new generation. Delayed old receipts, progress and results cannot overwrite the new operation. Agent effects are serialized and bounded; an emergency operation does not depend on successful provider observation before command dispatch.

For NapCat, the agent verifies workspace/endpoint ownership, uses the immutable container ID, force-kills the process and starts the same container. It does not recreate the container or delete QQ/configuration data, and it does not require the NapCat HTTP API. Successful restart confirms the container is running, **not** that QQ is logged in or OneBot is connected. A new QR login may be required. An offline agent or unavailable Docker daemon cannot be repaired by this endpoint action.

Provider business errors now finish the operation with a persisted failure instead of occupying the endpoint until repeated lease expiry. Routine QR observations are read-only: QR retrieval failure keeps the known QQ status and running-container state visible without attempting a QR refresh.

## Release checks

Migration `0018_force_restart.sql` extends operation and command action constraints. Apply it before serving the updated API and agent. Automated coverage includes PostgreSQL authorization/supersession/idempotency/fencing, agent failure replay, bounded provider IO, runtime ownership and serialization, and browser confirmation/error recovery in four locales.
