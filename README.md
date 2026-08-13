# botroost

botroost is a **backend vertical slice and architecture/contracts foundation**, not a complete product. The API, authentication, worker, and durable control-plane state use real PostgreSQL. The Web console remains a separate thin client surface.

## Workspace

- `packages/contracts`: neutral branded IDs, schemas, five-layer status, desired and operation state.
- `packages/runtime-sdk`: schema/type for declarative, untrusted runtime requests.
- `packages/control-plane-policy`: control-plane resolution of approved artifact and egress references into driver-facing runtime specs.
- `packages/provider-sdk`: capabilities and adapter contract; it never resolves executable runtime specs.
- `packages/reconciler`: deterministic pure endpoint simulation.
- `packages/agent-journal`: fsync-backed JSONL receipt/effect/result replay.
- `packages/provider-fake`: contract-test reference provider.
- `packages/provider-napcat`: declaration/schema/redaction skeleton only.
- `packages/database`: PostgreSQL schema, idempotent migration, tenant-scoped repositories, outbox.
- `packages/auth`: Argon2id credentials, opaque server-side sessions, RBAC and CSRF policy.
- `apps/api`: Fastify HTTP API and one-time owner bootstrap CLI.
- `apps/worker`: PostgreSQL outbox polling worker; only deterministic `fake` effects execute.

## Verify

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm verify:packages
```

The integration suite starts a real `postgres:16-alpine` Docker container with a random host port and always removes it. Docker must be available; the four original PostgreSQL tests plus Web-contract regression run without skip.

## Run the backend vertical slice

```sh
export DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DB
export CREDENTIAL_MASTER_KEY="$(openssl rand -base64 32)"
export TRUST_PROXY=false # set true only behind a trusted proxy that sets X-Forwarded-Host
corepack pnpm --filter @botroost/database build
corepack pnpm --filter @botroost/auth build
corepack pnpm --filter @botroost/worker build
corepack pnpm --filter @botroost/api build
corepack pnpm --filter @botroost/api bootstrap -- bootstrap --email owner@example.com --password 'replace-with-12+-chars' --workspace Primary
corepack pnpm --filter @botroost/api start
# separate process:
node apps/worker/dist/server.js
```

`packages/database/migrations/0001_control_plane.sql` is idempotent and enables `pgcrypto`. Cookies are `HttpOnly` (session), `Secure`, and `SameSite=Lax`; every mutation including logout requires same-origin plus the double-submit CSRF token. Node enrollment/revocation is owner/admin-only. Endpoint operation is owner/admin/operator. Viewer is read-only. Member creation deliberately rejects `owner`; ownership transfer is not implemented in this slice. Only provider `fake` is executable; NapCat is returned as unavailable/license-gated.

NapCat has **not** been downloaded, copied, run, integrated, or validated. No license is selected for botroost, so this repository intentionally contains no `LICENSE` file; see `docs/license-boundary.md`.

## Journal writer lock recovery

`FileAgentJournal` uses an atomic, exclusive `journal.jsonl.lock/` directory. An existing lock always fails closed; the journal never guesses that a lock is stale or removes it automatically. After a writer crash, an operator must first confirm that the owning process is dead and that no writer can still access the journal, then manually remove the lock directory. Do not remove a live or uncertain lock.
