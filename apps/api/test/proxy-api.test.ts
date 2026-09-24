import { describe, expect, it } from "vitest";
import { buildApi } from "../src/index.js";
import { InMemoryDatabase, digest, type PostgresDatabase } from "@botroost/database";
import { sanitizeProxyConfiguration } from "@botroost/agent-protocol";
import { randomUUID } from "node:crypto";

const SESSION_TOKEN = "unit-test-session-token";
const CSRF_TOKEN = "unit-test-csrf-token";

/** InMemory-backed PostgresDatabase stub: real API routes against an in-memory store. */
function stubDb() {
  const memory = new InMemoryDatabase();
  const workspaceId = memory.createWorkspace("Primary").id;
  memory.createEndpoint(workspaceId, "existing");
  const userId = randomUUID();
  const principal = { sessionId: "session-1", csrfHash: digest(CSRF_TOKEN), userId, email: "owner@example.com", workspaceId, role: "owner" as const };
  const db = {
    principalForToken: async (tokenHash: string) => (tokenHash === digest(SESSION_TOKEN) ? principal : null),
    createEndpoint: (workspace: string, name: string) => memory.createEndpoint(workspace, name),
    mutateEndpoint: (input: { workspaceId: string; endpointId: string; action: never; expectedGeneration: number; idempotencyKey: string; metadata?: Record<string, unknown> }) => memory.mutateEndpoint(input),
    endpoint: async (workspace: string, id: string) => {
      const found = memory.endpoints.find((item) => item.id === id && item.workspaceId === workspace);
      if (!found) return null;
      const configuration = found.configuration ? { ...found.configuration, ...(found.configuration.proxy !== undefined ? { proxy: sanitizeProxyConfiguration(found.configuration.proxy) } : {}) } : undefined;
      return { ...found, ...(configuration !== undefined ? { configuration } : {}) };
    },
  };
  return { db: db as unknown as PostgresDatabase, memory, workspaceId };
}

const mutationHeaders = {
  cookie: `botroost_session=${SESSION_TOKEN}; botroost_csrf=${CSRF_TOKEN}`,
  origin: "https://app.test",
  host: "app.test",
  "x-csrf-token": CSRF_TOKEN,
  "idempotency-key": `proxy-${randomUUID()}`,
};

describe("endpoint proxy API", () => {
  it("saves a valid proxy, rejects invalid payloads with 400, and echoes sanitized configuration on the endpoint", async () => {
    const { db, memory } = stubDb();
    const api = buildApi({ database: db, credentialKey: Buffer.alloc(32, 7), publicOrigin: "https://app.test" });
    await api.ready();
    const endpointId = memory.endpoints[0]!.id;
    const saved = await api.inject({ method: "PUT", url: `/api/v1/endpoints/${endpointId}/proxy`, headers: mutationHeaders, payload: { proxy: { protocol: "socks5", host: "p.internal", port: 1080, username: "alice", password: "s3cret" } } });
    expect(saved.statusCode).toBe(202);
    expect(saved.json()).toMatchObject({ action: "update-endpoint-proxy", status: "queued" });
    const detail = await api.inject({ method: "GET", url: `/api/v1/endpoints/${endpointId}`, headers: { cookie: `botroost_session=${SESSION_TOKEN}` } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().configuration).toMatchObject({ proxy: { protocol: "socks5", host: "p.internal", port: 1080, username: "alice", passwordConfigured: true } });
    expect(detail.body).not.toContain("s3cret");
    const invalid = await api.inject({ method: "PUT", url: `/api/v1/endpoints/${endpointId}/proxy`, headers: { ...mutationHeaders, "idempotency-key": `proxy-invalid-${randomUUID()}` }, payload: { proxy: { protocol: "ftp", host: "h", port: 8080 } } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("validation_error");
    const missing = await api.inject({ method: "PUT", url: `/api/v1/endpoints/${randomUUID()}/proxy`, headers: { ...mutationHeaders, "idempotency-key": `proxy-missing-${randomUUID()}` }, payload: { proxy: null } });
    expect(missing.statusCode).toBe(404);
    await api.close();
  });

  it("requires authentication on the proxy route", async () => {
    const { db } = stubDb();
    const api = buildApi({ database: db, credentialKey: Buffer.alloc(32, 7), publicOrigin: "https://app.test" });
    await api.ready();
    const unauthorized = await api.inject({ method: "PUT", url: `/api/v1/endpoints/${randomUUID()}/proxy`, headers: { cookie: "botroost_session=bogus", origin: "https://app.test", host: "app.test", "x-csrf-token": "x" }, payload: { proxy: null } });
    expect(unauthorized.statusCode).toBe(401);
    await api.close();
  });
});
