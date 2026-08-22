import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import { randomBytes } from "node:crypto";
import { z, ZodError } from "zod";
import { AuthService, can, requireSameOriginAndCsrf } from "@botroost/auth";
import { DatabaseError, digest, PostgresDatabase } from "@botroost/database";
import { AgentEnrollmentRequestSchema, AgentHeartbeatRequestSchema, ClaimCommandRequestSchema, CommandProgressRequestSchema, CommandReceiptRequestSchema, CommandResultRequestSchema } from "@botroost/agent-protocol";
import { LoginAttemptLimiter } from "./security-policy.js";

const credentials = z.object({ email: z.string().trim().email(), password: z.string().min(12).max(4096) });
const endpointInput = z.object({ name: z.string().min(1).max(120), providerId: z.string().min(1), nodeId: z.string().uuid().optional() });
const endpointName = z.object({ name: z.string().min(1).max(120) });
const endpointDeleteInput = z.object({ expectedGeneration: z.number().int().nonnegative() });
const nodeInput = z.object({ name: z.string().min(1).max(120), provider: z.string().min(1), credential: z.string().min(1).optional() });
const enrollmentInput = z.object({ name: z.string().min(1).max(120).default("agent"), ttlSeconds: z.number().int().min(60).max(86_400).default(900), labels: z.record(z.string(), z.string()).default({}) });
const operationInput = z.object({ action: z.enum(["start", "stop", "restart", "refresh-login-qr"]), expectedGeneration: z.number().int().nonnegative() });
const containerLogsInput=z.object({tail:z.number().int().min(1).max(1000).default(250),sinceSeconds:z.number().int().min(60).max(86400).default(900)});
const websocketCommon=z.object({name:z.string().min(1).max(80),enable:z.boolean(),token:z.string().max(4096).optional(),messagePostFormat:z.enum(["array","string"]).default("array"),reportSelfMessage:z.boolean().default(false),debug:z.boolean().default(false),heartInterval:z.number().int().min(1000).max(300000).default(30000)});
const onebotWebsocketsInput=z.object({websocketClients:z.array(websocketCommon.extend({url:z.string().url().refine(value=>value.startsWith("ws://")||value.startsWith("wss://"),"must use ws:// or wss://"),reconnectInterval:z.number().int().min(1000).max(300000).default(5000)})).max(20),websocketServers:z.array(websocketCommon.extend({host:z.string().min(1).max(253),port:z.number().int().min(1).max(65535),enableForcePushEvent:z.boolean().default(true)})).max(20)});
const memberInput = z.object({ email: z.string().trim().email(), password: z.string().min(12).max(4096), role: z.enum(["admin", "operator", "viewer"]) });
const memberUpdateInput=z.object({email:z.string().trim().email().optional(),role:z.enum(["admin","operator","viewer"]).optional()}).refine(value=>value.email!==undefined||value.role!==undefined,"at least one field is required");
const passwordInput=z.object({currentPassword:z.string().min(1).max(4096),newPassword:z.string().min(12).max(4096)});
const settingsInput = z.record(z.string(), z.unknown());
const notificationTargetInput=z.object({name:z.string().trim().min(1).max(120),email:z.string().trim().email().max(320)});
const targetIds=z.array(z.string().uuid()).max(100);
const alertSubscriptionInput=z.object({endpointId:z.string().uuid(),offlineTargetIds:targetIds,recoveryTargetIds:targetIds});
const alertSettingsInput=z.object({graceSeconds:z.number().int().min(30).max(86_400),offlineTargetIds:targetIds,recoveryTargetIds:targetIds,endpoints:z.array(alertSubscriptionInput).max(1_000)});
const idParams = z.object({ id: z.string().uuid() });
const providers = [
  { id: "fake", capabilities: ["setup", "configure", "observe"], configSchema: [], availability: { enabled: true } },
  { id: "napcat", capabilities: ["configure", "observe", "login"], configSchema: [], availability: { enabled: true } },
] as const;

type Permission = "read" | "operate" | "manage-members" | "manage-nodes";
export interface ApiOptions { database?: PostgresDatabase; databaseUrl?: string; credentialKey?: Buffer; trustProxy?: FastifyServerOptions["trustProxy"]; publicOrigin?: string }
const page=<T>(items:T[])=>({items,page:1,pageSize:25,total:items.length});
const rolePermissions:Record<string,string[]>={viewer:["endpoint:read","node:read","provider:read","operation:read","audit:read","workspace:read"],operator:["endpoint:read","endpoint:create","endpoint:update","endpoint:delete","endpoint:start","endpoint:stop","endpoint:restart","node:read","provider:read","operation:read","audit:read","workspace:read"],admin:["endpoint:read","endpoint:create","endpoint:update","endpoint:delete","endpoint:start","endpoint:stop","endpoint:restart","node:read","node:create","node:delete","provider:read","operation:read","audit:read","workspace:read","member:read","member:manage","settings:read","settings:manage"],owner:["endpoint:read","endpoint:create","endpoint:update","endpoint:delete","endpoint:start","endpoint:stop","endpoint:restart","node:read","node:create","node:delete","provider:read","operation:read","audit:read","workspace:read","member:read","member:manage","settings:read","settings:manage"]};
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
  const publicOrigin=options.publicOrigin??process.env.BOTROOST_PUBLIC_ORIGIN;
  if(!publicOrigin)throw new Error("BOTROOST_PUBLIC_ORIGIN is required");
  const loginAttempts=new LoginAttemptLimiter();
  const origin=new URL(publicOrigin);
  void api.register(cookie);
  api.addHook("onSend",async(_request,reply,payload)=>{reply.header("x-content-type-options","nosniff").header("x-frame-options","DENY").header("referrer-policy","no-referrer").header("permissions-policy","camera=(), microphone=(), geolocation=()").header("content-security-policy","default-src 'none'; frame-ancestors 'none'");return payload});
  api.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: "validation_error", message: "invalid request", details: error.issues } });
    if (error instanceof DatabaseError) return reply.code(error.code === "not_found" ? 404 : error.code === "unauthorized" ? 401 : error.code === "forbidden" ? 403 : 409).send({ error: { code: error.code, message: error.message } });
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
  async function authorizeContract(request: FastifyRequest, permission: string) {
    const result = await principal(request);
    if (!rolePermissions[result.role]?.includes(permission)) throw fail("forbidden", 403);
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
    try {
      requireSameOriginAndCsrf({ method: request.method, host:origin.host, ...(request.headers.origin ? { origin: request.headers.origin } : {}), ...(request.cookies.botroost_csrf ? { csrfCookie: request.cookies.botroost_csrf } : {}), ...(request.headers["x-csrf-token"] ? { csrfHeader: String(request.headers["x-csrf-token"]) } : {}), expectedCsrfHash: current.csrfHash });
    } catch { throw fail("csrf rejected", 403); }
  });

  api.get("/health", async () => ({ status: "ok" }));
  api.get("/ready", async (_request, reply) => { try { await db.ping();if(!await db.migrationsReady())throw new Error("schema ledger unavailable"); return { status: "ready" }; } catch { return reply.code(503).send({ error: { code: "not_ready", message: "database or schema unavailable" } }); } });
  api.post("/api/v1/auth/login", async (request, reply) => {const body = credentials.parse(request.body),address=request.ip;if(loginAttempts.isBlocked(body.email,address))throw fail("too many login attempts",429); try { const session = await auth.login(body.email, body.password);loginAttempts.recordSuccess(); reply.header("set-cookie", [session.cookie, `botroost_csrf=${session.csrf}; Path=/; Secure; SameSite=Lax; Max-Age=86400`]); return { expiresAt: session.expiresAt.toISOString() }; } catch {loginAttempts.recordFailure(body.email,address); throw fail("invalid credentials", 401); } });
  api.post("/api/v1/auth/logout", async (request, reply) => { const sessionToken = token(request); if (sessionToken) await auth.logout(sessionToken); reply.header("set-cookie", ["botroost_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0", "botroost_csrf=; Path=/; Secure; SameSite=Lax; Max-Age=0"]); return reply.code(204).send(); });
  api.get("/api/v1/auth/me", async request => { const current = await principal(request); return { user: { id: current.userId, email: current.email }, workspaceId: current.workspaceId, role: current.role }; });
  api.get("/api/v1/auth/session", async request => {const current=await principal(request),workspace=await db.workspace(current.workspaceId);return{user:{id:current.userId,email:current.email,name:current.email},workspace:{id:current.workspaceId,name:workspace.name},role:current.role,permissions:rolePermissions[current.role],capabilities:{operations:["create","delete","start","stop","restart"],providers:Object.fromEntries(providers.map(provider=>[provider.id,provider.availability])),configurationSchemas:Object.fromEntries(providers.map(provider=>[provider.id,provider.configSchema]))}}});
  api.get("/api/v1/auth/csrf", async request => { await principal(request); return { csrfToken: request.cookies.botroost_csrf }; });
  api.put("/api/v1/auth/password",async(request,reply)=>{const current=await principal(request),body=passwordInput.parse(request.body),address=request.ip;if(loginAttempts.isBlocked(current.email,address))throw fail("too many password attempts",429);try{await auth.changePassword({...current,currentPassword:body.currentPassword,newPassword:body.newPassword});loginAttempts.recordSuccess(current.email,address)}catch(error){if(error instanceof DatabaseError&&error.code==="forbidden")loginAttempts.recordFailure(current.email,address);throw error}return reply.code(204).send()});
  api.get("/api/v1/workspaces/current", async request => db.workspace((await principal(request)).workspaceId));
  api.get("/api/v1/workspaces/current/summary", async request => db.summary((await principal(request)).workspaceId));
  api.get("/api/v1/overview", async request => db.summary((await principal(request)).workspaceId));
  api.get("/api/v1/workspaces/current/members", async request => page(await db.members((await authorizeContract(request,"member:read")).workspaceId)));
  api.get("/api/v1/workspaces/current/settings", async request => db.workspaceSettings((await authorizeContract(request,"settings:read")).workspaceId));
  api.post("/api/v1/workspaces/current/settings", async request => db.updateWorkspaceSettings((await authorizeContract(request,"settings:manage")).workspaceId,settingsInput.parse(request.body)));
  api.get("/api/v1/workspaces/current/settings/alerts",async request=>db.alertSettings((await authorizeContract(request,"settings:read")).workspaceId));
  api.put("/api/v1/workspaces/current/settings/alerts",async request=>{const current=await authorizeContract(request,"settings:manage");return db.updateAlertSubscriptions(current.workspaceId,alertSettingsInput.parse(request.body),current.userId)});
  api.post("/api/v1/workspaces/current/notification-targets",async(request,reply)=>{const current=await authorizeContract(request,"settings:manage");return reply.code(201).send(await db.createNotificationTarget(current.workspaceId,notificationTargetInput.parse(request.body),current.userId))});
  api.delete("/api/v1/workspaces/current/notification-targets/:id",async(request,reply)=>{const current=await authorizeContract(request,"settings:manage");await db.deleteNotificationTarget(current.workspaceId,idParams.parse(request.params).id,current.userId);return reply.code(204).send()});
  api.post("/api/v1/workspaces/current/members", async (request, reply) => { const current = await authorizeContract(request,"member:manage"),body=memberInput.parse(request.body); return reply.code(201).send(await auth.addMember(current.workspaceId,body.email,body.password,body.role,current.userId)); });
  api.patch("/api/v1/workspaces/current/members/:id",async request=>{const current=await authorizeContract(request,"member:manage"),body=memberUpdateInput.parse(request.body),input={...(body.email!==undefined?{email:body.email}:{}),...(body.role!==undefined?{role:body.role}:{})};return db.updateMember(current.workspaceId,idParams.parse(request.params).id,input,{userId:current.userId,role:current.role})});
  api.delete("/api/v1/workspaces/current/members/:id",async(request,reply)=>{const current=await authorizeContract(request,"member:manage");await db.deleteMember(current.workspaceId,idParams.parse(request.params).id,{userId:current.userId,role:current.role});return reply.code(204).send()});
  api.get("/api/v1/providers", async request => { await principal(request); return page([...providers]); });
  api.get("/api/v1/nodes", async request => page(await db.nodes((await principal(request)).workspaceId)));
  api.post("/api/v1/nodes", async (request, reply) => { const current = await authorize(request, "manage-nodes"); const body = nodeInput.parse(request.body); return reply.code(201).send(await db.createNode(current.workspaceId, body, key)); });
  api.get("/api/v1/nodes/:id", async (request, reply) => { const current = await principal(request); const result = await db.node(current.workspaceId, idParams.parse(request.params).id); return result ?? reply.code(404).send({ error: { code: "not_found", message: "not found" } }); });
  api.post("/api/v1/nodes/enrollment-tokens", async (request, reply) => { const current = await authorize(request, "manage-nodes"); const body = enrollmentInput.parse(request.body ?? {}); const raw = randomBytes(32).toString("base64url"); const expiresAt = new Date(Date.now() + body.ttlSeconds * 1000); return reply.code(201).send({ ...(await db.createEnrollment(current.workspaceId, digest(raw), expiresAt, { name: body.name, labels: body.labels })), token: raw }); });
  api.delete("/api/v1/nodes/:id", async (request, reply) => { const current = await authorize(request, "manage-nodes"); await db.deleteNode(current.workspaceId, idParams.parse(request.params).id); return reply.code(204).send(); });
  api.post("/api/v1/agent/enroll", async (request, reply) => { const body = AgentEnrollmentRequestSchema.parse(request.body); const nodeSecret = randomBytes(32).toString("base64url"); return reply.code(201).send(await db.enrollNode({ tokenHash: digest(body.token), provider: body.provider, ...(body.version ? { agentVersion: body.version } : {}), nodeSecretHash: digest(nodeSecret), nodeSecret })); });
  api.post("/api/v1/agent/heartbeat", async request => { const node = await agentNode(request); const body = AgentHeartbeatRequestSchema.parse(request.body); return db.heartbeat(node.id, body); });
  api.post("/api/v1/agent/commands/claim", async request => { const node = await agentNode(request); ClaimCommandRequestSchema.parse(request.body ?? { limit: 1 }); return { command: await db.claimAgentCommand(node.id, z.string().min(1).max(200).parse(request.headers["x-agent-session-id"])) }; });
  api.post("/api/v1/agent/commands/:id/receipt", async (request, reply) => { const node = await agentNode(request); await db.recordAgentReceipt(node.id, idParams.parse(request.params).id, CommandReceiptRequestSchema.parse(request.body)); return reply.code(202).send({ accepted: true }); });
  api.post("/api/v1/agent/commands/:id/progress", async (request, reply) => { const node = await agentNode(request); await db.recordAgentProgress(node.id, idParams.parse(request.params).id, CommandProgressRequestSchema.parse(request.body)); return reply.code(202).send({ accepted: true }); });
  api.post("/api/v1/agent/commands/:id/result", async (request, reply) => { const node = await agentNode(request); await db.recordAgentResult(node.id, idParams.parse(request.params).id, CommandResultRequestSchema.parse(request.body)); return reply.code(202).send({ accepted: true }); });
  api.get("/api/v1/endpoints", async request => page(await db.endpoints((await principal(request)).workspaceId)));
  api.post("/api/v1/endpoints", async (request, reply) => { const current = await authorize(request, "operate"); const body = endpointInput.parse(request.body); if (!["fake","napcat"].includes(body.providerId)) throw fail("provider unavailable", 409); if(body.providerId==="napcat"&&!body.nodeId)throw fail("NapCat endpoints require an outbound node",409); return reply.code(201).send(await db.createEndpoint(current.workspaceId, body.name, body.providerId, body.nodeId)); });
  api.get("/api/v1/endpoints/:id", async (request, reply) => { const current = await principal(request); const result = await db.endpoint(current.workspaceId, idParams.parse(request.params).id); return result ?? reply.code(404).send({ error: { code: "not_found", message: "not found" } }); });
  api.get("/api/v1/endpoints/:id/napcat/login-qrcode", async (request, reply) => { const current = await authorize(request, "operate"); const metadata = await db.endpointNapcatMetadata(current.workspaceId, idParams.parse(request.params).id); const login = metadata.login as Record<string, unknown>|undefined; const qrcode = typeof login?.qrcode === "string" ? login.qrcode : null; return qrcode ? { qrcode } : reply.code(404).send({ error: { code: "not_found", message: "QR login is not available" } }); });
  api.post("/api/v1/endpoints/:id/napcat/login-qrcode", async (request, reply) => { const current=await authorize(request,"operate");const endpointId=idParams.parse(request.params).id;const endpoint=await db.endpoint(current.workspaceId,endpointId);if(!endpoint)throw fail("not found",404);if(endpoint.providerId!=="napcat")throw fail("QR refresh requires a NapCat endpoint",409);const idempotencyKey=z.string().min(1).max(200).parse(request.headers["idempotency-key"]);const result=await db.mutateEndpoint({workspaceId:current.workspaceId,endpointId,actorUserId:current.userId,action:"refresh-login-qr",expectedGeneration:endpoint.generation,idempotencyKey});return reply.code(202).send(result.operation); });
  api.get("/api/v1/endpoints/:id/napcat/status", async request => { const current = await authorize(request, "operate"); const snapshot = await db.endpointNapcatSnapshot(current.workspaceId, idParams.parse(request.params).id),staleAfterSeconds=15;return { qq: snapshot.metadata.qq ?? null, login: snapshot.metadata.login ?? null, onebot: snapshot.metadata.onebot ?? null, traffic: snapshot.metadata.traffic ?? null,freshness:{observationAt:snapshot.observationAt,nodeHeartbeatAt:snapshot.nodeHeartbeatAt,checkedAt:snapshot.checkedAt,staleAfterSeconds,fresh:snapshot.nodeOnline&&snapshot.observationFresh} }; });
  api.put("/api/v1/endpoints/:id/napcat/onebot/websockets",async(request,reply)=>{const current=await authorize(request,"operate"),endpointId=idParams.parse(request.params).id,body=onebotWebsocketsInput.parse(request.body),endpoint=await db.endpoint(current.workspaceId,endpointId);if(!endpoint)throw fail("not found",404);if(endpoint.providerId!=="napcat")throw fail("OneBot configuration requires a NapCat endpoint",409);const idempotencyKey=z.string().min(1).max(200).parse(request.headers["idempotency-key"]);const result=await db.mutateEndpoint({workspaceId:current.workspaceId,endpointId,actorUserId:current.userId,action:"update-onebot-websockets",expectedGeneration:endpoint.generation,idempotencyKey,metadata:body});return reply.code(202).send(result.operation)});
  api.post("/api/v1/endpoints/:id/napcat/container-logs",async(request,reply)=>{const current=await authorize(request,"operate"),endpointId=idParams.parse(request.params).id,body=containerLogsInput.parse(request.body??{}),endpoint=await db.endpoint(current.workspaceId,endpointId);if(!endpoint)throw fail("not found",404);if(endpoint.providerId!=="napcat")throw fail("container logs require a NapCat endpoint",409);const idempotencyKey=z.string().min(1).max(200).parse(request.headers["idempotency-key"]);const result=await db.mutateEndpoint({workspaceId:current.workspaceId,endpointId,actorUserId:current.userId,action:"read-container-logs",expectedGeneration:endpoint.generation,idempotencyKey,metadata:{logTail:body.tail,logSinceSeconds:body.sinceSeconds}});return reply.code(202).send(result.operation)});
  api.patch("/api/v1/endpoints/:id", async request => { const current = await authorize(request, "operate"); return db.updateEndpoint(current.workspaceId, idParams.parse(request.params).id, endpointName.parse(request.body).name); });
  api.delete("/api/v1/endpoints/:id", async (request, reply) => { const current = await authorize(request, "operate"),{id}=idParams.parse(request.params),body=endpointDeleteInput.parse(request.body),key=request.headers["idempotency-key"];if(typeof key!=="string"||!key)throw fail("Idempotency-Key required",400);const {operation}=await db.mutateEndpoint({workspaceId:current.workspaceId,endpointId:id,actorUserId:current.userId,action:"delete",expectedGeneration:body.expectedGeneration,idempotencyKey:key});return reply.code(202).send(operation); });
  api.post("/api/v1/endpoints/:id/operations", async (request, reply) => { const current = await authorize(request, "operate"); const body = operationInput.parse(request.body); const idempotencyKey = z.string().min(1).max(200).parse(request.headers["idempotency-key"]); const result = await db.mutateEndpoint({ workspaceId: current.workspaceId, endpointId: idParams.parse(request.params).id, actorUserId: current.userId, ...body, idempotencyKey }); return reply.code(202).send(result.operation); });
  api.get("/api/v1/operations", async request => {const current=await principal(request),items=await db.operations(current.workspaceId);return page(current.role==="viewer"?items.filter(item=>item.action!=="read-container-logs"):items)});
  api.get("/api/v1/operations/:id", async (request, reply) => { const current = await principal(request); const result = await db.operation(current.workspaceId, idParams.parse(request.params).id); if(result?.action==="read-container-logs"&&current.role==="viewer")return reply.code(404).send({error:{code:"not_found",message:"not found"}});return result ?? reply.code(404).send({ error: { code: "not_found", message: "not found" } }); });
  api.get("/api/v1/audit", async request => page(await db.audit((await principal(request)).workspaceId)));
  if(!options.database)api.addHook("onClose",async()=>db.close());
  return api;
}

async function stdin(){const chunks:Buffer[]=[];for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks).toString("utf8").trimEnd()}
export async function bootstrapCli(args = process.argv.slice(2)) { if (args[0] !== "bootstrap") throw new Error("usage: api bootstrap --email ... --workspace ... (password from BOOTSTRAP_PASSWORD_FILE or stdin)"); const value = (name: string) => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`); return args[index + 1]!; };if(args.includes("--password"))throw new Error("--password is forbidden; use BOOTSTRAP_PASSWORD_FILE or stdin");const {readFile}=await import("node:fs/promises");const password=process.env.BOOTSTRAP_PASSWORD_FILE?(await readFile(process.env.BOOTSTRAP_PASSWORD_FILE,"utf8")).trimEnd():await stdin();if(!password)throw new Error("bootstrap password is required"); const db = new PostgresDatabase(process.env.DATABASE_URL!); try { await new AuthService(db).bootstrapOwner(value("--email"), password, value("--workspace")); } finally { await db.close(); } }
