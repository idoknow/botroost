# botroost

botroost is currently a **Phase B architecture/contracts slice**, not a complete product. It establishes neutral control-plane contracts, constrained provider/runtime interfaces, deterministic reconciliation, and a durable agent journal.

## Workspace

- `packages/contracts`: neutral branded IDs, schemas, five-layer status, desired and operation state.
- `packages/runtime-sdk`: schema/type for declarative, untrusted runtime requests.
- `packages/control-plane-policy`: control-plane resolution of approved artifact and egress references into driver-facing runtime specs.
- `packages/provider-sdk`: capabilities and adapter contract; it never resolves executable runtime specs.
- `packages/reconciler`: deterministic pure endpoint simulation.
- `packages/agent-journal`: fsync-backed JSONL receipt/effect/result replay.
- `packages/provider-fake`: contract-test reference provider.
- `packages/provider-napcat`: declaration/schema/redaction skeleton only.

## Verify

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

NapCat has **not** been downloaded, copied, run, integrated, or validated. No license is selected for botroost, so this repository intentionally contains no `LICENSE` file; see `docs/license-boundary.md`.

## Journal writer lock recovery

`FileAgentJournal` uses an atomic, exclusive `journal.jsonl.lock/` directory. An existing lock always fails closed; the journal never guesses that a lock is stale or removes it automatically. After a writer crash, an operator must first confirm that the owning process is dead and that no writer can still access the journal, then manually remove the lock directory. Do not remove a live or uncertain lock.
