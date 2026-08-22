# Botroost

**Botroost is a cloud-native OneBot protocol endpoint cluster console.**

It gives operators one control plane for running multiple OneBot 11 protocol endpoints across Linux agent nodes, reconciling endpoint desired state, managing NapCat-backed QQ identities and WebSocket transports, and retaining an audited record of every change.

Botroost is not a generic container dashboard and OneBot is not a runtime. The product model deliberately keeps infrastructure, implementation, identity, protocol, and transport as separate concepts.

## Product model

```text
Workspace
├── Members / roles / per-endpoint alert subscriptions
├── Agent nodes
│   └── Protocol endpoints
│       ├── Runtime driver (for example, NapCat)
│       ├── Managed container / process
│       ├── QQ account identity
│       ├── OneBot 11 protocol service
│       ├── WebSocket clients and servers
│       └── Operations and audit events
└── Unified activity history (changes + audit)
```

### Entities

| Entity | Meaning |
| --- | --- |
| **Workspace** | Tenant and RBAC boundary. Owns nodes, endpoints, members, notification targets, alert subscriptions, operations, and audit events. |
| **Agent node** | A machine running the Botroost agent. It maintains an authenticated control connection and hosts endpoint workloads. |
| **Protocol endpoint** | The primary managed resource: one desired OneBot service assigned to one agent node and one runtime driver. |
| **Runtime driver** | Provider-specific integration that turns endpoint desired state into a workload. `napcat` manages a pinned NapCat container; it is not the OneBot protocol itself. |
| **QQ account** | The messaging identity signed into NapCat. QR login and account profile belong to this layer. |
| **OneBot 11 service** | The protocol API exposed by the endpoint implementation. A successful status probe means the API answered; it does not mean every WebSocket peer is connected. |
| **WebSocket client** | An outbound connection initiated by the endpoint toward a OneBot consumer, such as LangBot. |
| **WebSocket server** | A listening interface exposed by the endpoint for consumers that connect inbound. |
| **Operation** | An audited desired-state change such as start, stop, restart, QR refresh, WebSocket configuration, or bounded log retrieval. |

### Endpoint health layers

The console reports five independent layers rather than collapsing unrelated states into one ambiguous badge:

1. **Agent node** — whether the assigned node's control heartbeat is fresh.
2. **Container** — whether the managed endpoint workload is running and ready.
3. **Driver probe** — whether the runtime driver can inspect and manage its implementation.
4. **Protocol service** — whether the OneBot status API is available.
5. **Desired state** — whether observed state has converged with the requested generation.

WebSocket client and server configuration is shown separately because transport configuration and peer connectivity are not equivalent to OneBot API availability.

## Capabilities

- Multi-workspace authentication and role-based authorization
- One-time agent enrollment tokens and persistent agent control sessions
- Agent heartbeat, connection fencing, generation checks, and stale-operation handling
- Multiple protocol endpoints per agent node
- Runtime-driver capability discovery and license gates
- Immutable, digest-pinned NapCat deployment
- QQ login bootstrap and QR refresh with immediate QR removal after login
- Read-only OneBot queries for login, status, version, friends, and groups
- Forward WebSocket client and listening WebSocket server management
- Write-only token handling: configured tokens are never returned to the browser
- Bounded, redacted container log retrieval
- Audited operations and per-endpoint offline/recovery alert subscriptions with multi-recipient targets
- Campux-aligned responsive UI with light, dark, and system appearance modes

## Architecture

| Component | Responsibility |
| --- | --- |
| `apps/api` | HTTP API, sessions, RBAC, endpoint desired state, operation dispatch, audit, settings, node heartbeat and command-polling control plane |
| `apps/agent` | Node enrollment, control session, runtime-driver execution, NapCat lifecycle and management commands |
| `apps/worker` | Operation timeout/recovery and notification processing |
| `apps/web` | Operator console for cluster, endpoint, node, change, audit, and workspace views |
| `packages/contracts` | Shared API and control-plane contracts |
| `packages/database` | PostgreSQL schema, migrations, and repositories |
| `packages/provider-sdk` | Runtime-driver interface |
| `packages/provider-napcat` | NapCat runtime driver |
| `packages/provider-fake` | Deterministic test driver |

The agent makes outbound authenticated HTTP requests to heartbeat, claim commands, and report receipts, results, and observed endpoint state. The API claims operations transactionally and dispatches commands with endpoint generation and node connection-session fencing; PostgreSQL remains the source of truth.

## Local development

Requirements: Node.js 22+, Bun 1.3.14, Docker, and PostgreSQL 16+. The repository is a Bun workspace; the older pnpm lockfile is retained for compatibility, but the current `packageManager` and canonical local commands use Bun.

Install dependencies, create the local environment file, and generate a 32-byte credential key:

```bash
bun install --frozen-lockfile
cp .env.example .env
openssl rand -base64 32
openssl rand -hex 32
```

Paste the generated values into `CREDENTIAL_MASTER_KEY` and `NAPCAT_TOKEN` in `.env`, and replace the two Agent state paths with the same writable absolute directory. To deliver email alerts locally, also set both `RESEND_API_KEY` and `ALERT_EMAIL_FROM`; leaving both blank keeps delivery disabled. Bun loads this file automatically for the development commands below.

Start PostgreSQL the first time, then build the workspace packages and apply migrations:

```bash
docker run -d --name botroost-dev-postgres \
  -e POSTGRES_USER=botroost \
  -e POSTGRES_PASSWORD=botroost_dev \
  -e POSTGRES_DB=botroost \
  -p 127.0.0.1:5432:5432 \
  postgres:16-alpine

bun run build
bun --env-file=.env --filter @botroost/api migrate
```

On later runs, use `docker start botroost-dev-postgres`. Bootstrap the first owner once; the command reads the password from standard input, so enter it and press Ctrl-D when finished:

```bash
bun apps/api/dist/cli.js bootstrap \
  --email owner@example.com \
  --workspace Local
```

Run the API, worker, and web app in separate terminals:

```bash
bun --watch apps/api/src/server.ts
bun --watch apps/worker/src/cli.ts
bun --filter @botroost/web dev --host 127.0.0.1 --port 5173
```

Open `http://localhost:5173`. Vite proxies `/api` to the API on port 3000. Sign in, open **Agent nodes**, and generate a one-time enrollment token. Start the real NapCat Agent in a fourth terminal:

```bash
ENROLLMENT_TOKEN='paste-the-one-time-token' bun apps/agent/src/cli.ts
```

The Agent exchanges the token for a persistent node credential in `NODE_STATE_DIR`. Later restarts use that credential, so run `bun apps/agent/src/cli.ts` without the enrollment token. Do not use watch mode for the Agent: its durable journal intentionally allows only one process, and rapid hot reloads are rejected by the journal lock and control-session fencing. The source Agent currently supports `napcat` and the test-only `fake` provider; `.env.example` selects `napcat`. On macOS, a host-run NapCat Agent requires a Docker runtime that makes bridge-network container addresses reachable from the host, such as OrbStack. Otherwise, run the Agent in a container attached to `NAPCAT_DOCKER_NETWORK`, as in the production Compose stack.

When editing a shared workspace package, rerun `bun run build` so its `dist` output is refreshed.

Package scripts:

```bash
bun run typecheck
bun run lint
bun run test
bun run build
bun --filter @botroost/web e2e
```

For a production-shaped local stack:

```bash
docker compose -f deploy/compose.yml up -d --build
```

Open the web console through the configured public origin. Do not expose PostgreSQL or internal service ports publicly.

## NapCat endpoint lifecycle

1. Enroll an agent node with a one-time token.
2. Create a protocol endpoint, assign the node, and select the NapCat runtime driver.
3. Start the endpoint. The agent creates the digest-pinned workload and observes its state.
4. If no QQ account is signed in, scan the QR code in the endpoint's **QQ account** section.
5. After login, inspect the separate **OneBot 11 service** section and query friends/groups.
6. Configure outbound WebSocket clients or listening WebSocket servers under **WebSocket connections**.
7. Use **Activity** to review desired-state changes and the administrative audit trail together.

NapCat images must be referenced by digest. Mutable tags and credential values are rejected or redacted at the relevant boundaries.

## Security model

- Server-side sessions and CSRF protection on mutations
- Workspace-scoped RBAC for every API resource
- One-time enrollment credentials and hashed long-lived agent credentials
- Connection-session fencing to reject stale agents
- Optimistic endpoint generation checks
- Internal encrypted storage for legacy node credentials; no generic workspace credential API
- WebSocket token presence only (`tokenConfigured`), never plaintext readback
- Strict OneBot action allowlist
- Bounded logs with credential redaction
- Append-only audit records for sensitive actions

## Deployment

Production images are built from a single Git SHA and published for API, worker, web, and agent. Deploy all components from the same SHA, run database migrations before application rollout, reconcile the runtime, and verify:

- public health endpoint;
- exact image SHA for every service;
- fresh agent heartbeat and new connection epoch;
- endpoint health-layer convergence;
- authenticated web behavior in both light and dark modes.

See [`deploy/compose.yml`](deploy/compose.yml), [`docs/deployment.md`](docs/deployment.md), and [`docs/threat-model.md`](docs/threat-model.md).

## License

Apache-2.0. See [`LICENSE`](LICENSE).
