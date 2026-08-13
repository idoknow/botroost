import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { randomBytes } from "node:crypto";
import { z, ZodError } from "zod";
import { AuthService, can, requireSameOriginAndCsrf } from "@botroost/auth";
import { DatabaseError, digest, PostgresDatabase } from "@botroost/database";
import { AgentEnrollmentRequestSchema, AgentHeartbeatRequestSchema, ClaimCommandRequestSchema, CommandReceiptRequestSchema, CommandResultRequestSchema } from "@botroost/agent-protocol";

const credentials = z.object({ email: z.string().email(), password: z.string().min(12) });
const endpointInput = z.object({ name: z.string().min(1).max(120), providerId: z.string().min(1), nodeId: z.string().uuid().optional() });
const endpointName = z.object({ name: z.string().min(1).max(120) });
const nodeInput = z.object({ name: z.string().min(1).max(120), provider: z.string().min(1), credential: z.string().min(1).optional() });
const enrollmentInput = z.object({ name: z.string().min(1).max(120).default("agent"), ttlSeconds: z.number().int().min(60).max(86_400).default(900), labels: z.record(z.string(), z.string()).default({}) });
const operationInput = z.object({ action: z.enum(["start", "stop", "restart"]), expectedGeneration: z.number().int().nonnegative() });
const memberInput = z.object({ email: z.string().email(), password: z.string().min(12), role: z.enum(["admin", "operator", "viewer"]) });
const idParams = z.object({ id: z.string().uuid() });
const providers = [
  { id: "fake", capabilities: ["setup", "configure", "observe"], configSchema: { type: "object", additionalProperties: false, properties: {} }, availability: { enabled: true } },
  { id: "napcat", capabilities: ["configure", "observe"], configSchema: { type: "object", additionalProperties: false, properties: {} }, availability: { enabled: false, reason: "license-gated" } },
] as const;

type Permission = "read" | "operate" | "manage-members" | "manage-nodes";
export interface ApiOptions { database?: PostgresDatabase; databaseUrl?: string; credentialKey?: Buffer; trustProxy?: boolean }
function token(request: FastifyRequest) { return request.cookies.botroost_session }
function statusCode(error: unknown): number | undefined { return typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined }
function fail(message: string, code: number): Error { return Object.assign(new Error(message), { statusCode: code }) }

export function buildApi(options: ApiOptions = {}): FastifyInstance {
  if (!options.database && !options.databaseUrl && !process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const db = options.database ?? new PostgresDatabase(options.databaseUrl ?? process.env.DATABASE_URL!);
  const key = options.credentialKey ?? Buffer.from(process.env.CREDENTIAL_MASTER_KEY ?? "", "base64");
  if (key.length !== 32) throw new Error("CREDENTIAL_MASTER_KEY must be 32 bytes base64");
  const auth = new AuthService(db);
  const api = Fastify({ trustProxy: options.trustProxy ?? false });
  void api.register(cookie);
  api.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: "validation_error", message: "invalid request", details: error.issues } });
    if (error instanceof DatabaseError) return reply.code(error.code === "not_found" ? 404 : error.code === "unauthorized" ? 401 : 409).send({ error: { code: error.code, message: error.message } });
    const status = statusCode(error) ?? 500;
    const message = error instanceof Error ? error.message : "internal error";
    return reply.code(status).send({ error: { code: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 409 ? "conflict" : "internal_error", message: status === 500 ? "internal error" : message } });
  });
  async function principal(request: FastifyRequest) {
    const sessionToken = token(request);
    const result = sessionToken ? await auth.me(sessionToken) : null;
    if (!result) throw fail("authentication required", 401);
    return result;
  }
  async function authorize(request: FastifyRequest, permission: Permission) {
    const result = await principal(request);
    if (!can(result.role, permission)) throw fail("forbidden", 403);
    return result;
  }
  async function agentNode(request: FastifyRequest) {
    const header = request.headers.authorization;
    const match = typeof header === "string" ? /^Bearer (.+)$/.exec(header) : null;
    if (!match) throw fail("bearer token required", 401);
    const result = await db.authenticateNode(digest(match[1]!));
    if (!result) throw fail("bearer token rejected", 401);
    return result;
  }
  api.addHook("preHandler", async request => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method) || request.url === "/api/v1/auth/login" || request.url.startsWith("/api/v1/agent/")) return;
    const current = await principal(request);
    const forwardedHost = options.trustProxy ? request.headers["x-forwarded-host"] : undefined;
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? request.headers.host ?? "";
    try {
      requireSameOriginAndCsrf({ method: request.method, host, ...(request.headers.origin ? { origin: request.headers.origin } : {}), ...(request.cookies.botroost_csrf ? { csrfCookie: request.cookies.botroost_csrf } : {}), ...(request.headers["x-csrf-token"] ? { csrfHeader: String(request.headers["x-csrf-token"]) } : {}), expectedCsrfHash: current.csrfHash });
    } catch { throw fail("csrf rejected", 403); }
  });

  api.get("/health", async () => ({ status: "ok" }));
  api.get("/ready", async (_request, reply) => { try { await db.ping(); return { status: "ready" }; } catch { return reply.code(503).send({ error: { code: "not_ready", message: "database unavailable" } }); } });
  api.post("/api/v1/auth/login", async (request, reply) => { const body = credentials.parse(request.body); try { const session = await auth.login(body.email, body.password); reply.header("set-cookie", [session.cookie, `botroost_csrf=${session.csrf}; Path=/; Secure; SameSite=Lax; Max-Age=86400`]); return { expiresAt: session.expiresAt.toISOString() }; } catch { throw fail("invalid credentials", 401); } });
  api.post("/api/v1/auth/logout", async (request, reply) => { const sessionToken = token(request); if (sessionToken) await auth.logout(sessionToken); reply.header("set-cookie", ["botroost_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0", "botroost_csrf=; Path=/; Secure; SameSite=Lax; Max-Age=0"]); return reply.code(204).send(); });
  api.get("/api/v1/auth/me", async request => { const current = await principal(request); return { user: { id: current.userId, email: current.email }, workspaceId: current.workspaceId, role: current.role }; });
  api.get("/api/v1/auth/csrf", async request => { await principal(request); return { csrfToken: request.cookies.botroost_csrf }; });
  api.get("/api/v1/workspaces/current", async request => db.workspace((await principal(request)).workspaceId));
  api.get("/api/v1/workspaces/current/summary", async request => db.summary((await principal(request)).workspaceId));
  api.get("/api/v1/workspaces/current/members", async request => db.members((await principal(request)).workspaceId));
  api.post("/api/v1/workspaces/current/members", async (request, reply) => { const current = await authorize(request, "manage-members"); const body = memberInput.parse(request.body); return reply.code(201).send(await auth.addMember(current.workspaceId, body.email, body.password, body.role)); });
  api.get("/api/v1/providers", async request => { await principal(request); return providers; });
  api.get("/api/v1/nodes", async request => db.nodes((await principal(request)).workspaceId));
  api.post("/api/v1/nodes", async (request, reply) => { const current = await authorize(request, "manage-nodes"); const body = nodeInput.parse(request.body); return reply.code(201).send(await db.createNode(current.workspaceId, body, key)); });
  api.get("/api/v1/nodes/:id", async (request, reply) => { const current = await principal(request); const result = await db.node(current.workspaceId, idParams.parse(request.params).id); return result ?? reply.code(404).send({ error: { code: "not_found", message: "not found" } }); });
  api.post("/api/v1/nodes/enrollment-tokens", async (request, reply) => { const current = await authorize(request, "manage-nodes"); const body = enrollmentInput.parse(request.body ?? {}); const raw = randomBytes(32).toString("base64url"); const expiresAt = new Date(Date.now() + body.ttlSeconds * 1000); return reply.code(201).send({ ...(await db.createEnrollment(current.workspaceId, digest(raw), expiresAt, { name: body.name, labels: body.labels })), token: raw }); });
  api.delete("/api/v1/nodes/:id", async (request, reply) => { const current = await authorize(request, "manage-nodes"); await db.deleteNode(current.workspaceId, idParams.parse(request.params).id); return reply.code(204).send(); });
  api.post("/api/v1/agent/enroll", async (request, reply) => { const body = AgentEnrollmentRequestSchema.parse(request.body); const nodeSecret = randomBytes(32).toString("base64url"); return reply.code(201).send(await db.enrollNode({ tokenHash: digest(body.token), provider: body.provider, ...(body.version ? { agentVersion: body.version } : {}), nodeSecretHash: digest(nodeSecret), nodeSecret })); });
  api.post("/api/v1/agent/heartbeat", async request => { const node = await agentNode(request); const body = AgentHeartbeatRequestSchema.parse(request.body); return db.heartbeat(node.id, body); });
  api.post("/api/v1/agent/commands/claim", async request => { const node = await agentNode(request); ClaimCommandRequestSchema.parse(request.body ?? { limit: 1 }); return { command: await db.claimAgentCommand(node.id) }; });
  api.post("/api/v1/agent/commands/:id/receipt", async (request, reply) => { const node = await agentNode(request); await db.recordAgentReceipt(node.id, idParams.parse(request.params).id, CommandReceiptRequestSchema.parse(request.body)); return reply.code(202).send({ accepted: true }); });
  api.post("/api/v1/agent/commands/:id/result", async (request, reply) => { const node = await agentNode(request); await db.recordAgentResult(node.id, idParams.parse(request.params).id, CommandResultRequestSchema.parse(request.body)); return reply.code(202).send({ accepted: true }); });
  api.get("/api/v1/endpoints", async request => db.endpoints((await principal(request)).workspaceId));
  api.post("/api/v1/endpoints", async (request, reply) => { const current = await authorize(request, "operate"); const body = endpointInput.parse(request.body); if (body.providerId !== "fake") throw fail("provider unavailable", 409); return reply.code(201).send(await db.createEndpoint(current.workspaceId, body.name, body.providerId, body.nodeId)); });
  api.get("/api/v1/endpoints/:id", async (request, reply) => { const current = await principal(request); const result = await db.endpoint(current.workspaceId, idParams.parse(request.params).id); return result ?? reply.code(404).send({ error: { code: "not_found", message: "not found" } }); });
  api.patch("/api/v1/endpoints/:id", async request => { const current = await authorize(request, "operate"); return db.updateEndpoint(current.workspaceId, idParams.parse(request.params).id, endpointName.parse(request.body).name); });
  api.delete("/api/v1/endpoints/:id", async (request, reply) => { const current = await authorize(request, "operate"); await db.deleteEndpoint(current.workspaceId, idParams.parse(request.params).id); return reply.code(204).send(); });
  api.post("/api/v1/endpoints/:id/operations", async (request, reply) => { const current = await authorize(request, "operate"); const body = operationInput.parse(request.body); const idempotencyKey = z.string().min(1).max(200).parse(request.headers["idempotency-key"]); const result = await db.mutateEndpoint({ workspaceId: current.workspaceId, endpointId: idParams.parse(request.params).id, actorUserId: current.userId, ...body, idempotencyKey }); return reply.code(202).send(result.operation); });
  api.get("/api/v1/operations", async request => db.operations((await principal(request)).workspaceId));
  api.get("/api/v1/operations/:id", async (request, reply) => { const current = await principal(request); const result = await db.operation(current.workspaceId, idParams.parse(request.params).id); return result ?? reply.code(404).send({ error: { code: "not_found", message: "not found" } }); });
  api.get("/api/v1/audit", async request => db.audit((await principal(request)).workspaceId));
  return api;
}

export async function bootstrapCli(args = process.argv.slice(2)) { if (args[0] !== "bootstrap") throw new Error("usage: api bootstrap --email ... --password ... --workspace ..."); const value = (name: string) => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`); return args[index + 1]!; }; const db = new PostgresDatabase(process.env.DATABASE_URL!); try { await new AuthService(db).bootstrapOwner(value("--email"), value("--password"), value("--workspace")); } finally { await db.close(); } }
