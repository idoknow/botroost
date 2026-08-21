# Botroost

**Botroost is a cloud-native OneBot protocol endpoint cluster console.**

It gives operators one control plane for running multiple OneBot 11 protocol endpoints across Linux agent nodes, reconciling endpoint desired state, managing NapCat-backed QQ identities and WebSocket transports, and retaining an audited record of every change.

Botroost is not a generic container dashboard and OneBot is not a runtime. The product model deliberately keeps infrastructure, implementation, identity, protocol, and transport as separate concepts.

## Product model

```text
Workspace
├── Members / roles / credentials / alert settings
├── Agent nodes
│   └── Protocol endpoints
│       ├── Runtime driver (for example, NapCat)
│       ├── Managed container / process
│       ├── QQ account identity
│       ├── OneBot 11 protocol service
│       ├── WebSocket clients and servers
│       └── Operations and audit events
└── Audit log
```

### Entities

| Entity | Meaning |
| --- | --- |
| **Workspace** | Tenant and RBAC boundary. Owns nodes, endpoints, members, credentials, alert settings, operations, and audit events. |
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
- Audited operations, workspace credentials, and Resend offline/recovery alerts
- Campux-aligned responsive UI with light, dark, and system appearance modes

## Architecture

| Component | Responsibility |
| --- | --- |
| `apps/api` | HTTP API, sessions, RBAC, endpoint desired state, operation dispatch, audit, settings, node WebSocket control plane |
| `apps/agent` | Node enrollment, control session, runtime-driver execution, NapCat lifecycle and management commands |
| `apps/worker` | Operation timeout/recovery and notification processing |
| `apps/web` | Operator console for cluster, endpoint, node, change, audit, and workspace views |
| `packages/contracts` | Shared API and control-plane contracts |
| `packages/database` | PostgreSQL schema, migrations, and repositories |
| `packages/provider-sdk` | Runtime-driver interface |
| `packages/provider-napcat` | NapCat runtime driver |
| `packages/provider-fake` | Deterministic test driver |

The agent opens an outbound authenticated WebSocket to the API. The API claims operations transactionally and dispatches commands with endpoint generation and node connection-session fencing. The agent reports results and observed endpoint state; PostgreSQL remains the source of truth.

## Quick start

Requirements: Node.js 22+, pnpm 10+, Docker, and PostgreSQL 16+.

```bash
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Package scripts:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm --filter @botroost/web e2e
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
7. Use **Changes** and **Audit** to trace desired-state and administrative actions.

NapCat images must be referenced by digest. Mutable tags and credential values are rejected or redacted at the relevant boundaries.

## Security model

- Server-side sessions and CSRF protection on mutations
- Workspace-scoped RBAC for every API resource
- One-time enrollment credentials and hashed long-lived agent credentials
- Connection-session fencing to reject stale agents
- Optimistic endpoint generation checks
- Encrypted credential storage with write-only API responses
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

See [`deploy/compose.yml`](deploy/compose.yml), [`docs/deployment-runbook.md`](docs/deployment-runbook.md), and [`docs/agent-installation.md`](docs/agent-installation.md).

## License

Apache-2.0. See [`LICENSE`](LICENSE).
