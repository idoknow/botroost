import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { buildApi } from "../src/index.js";
import { AuthService } from "@botroost/auth";
import { PostgresDatabase } from "@botroost/database";
import { DurableWorker } from "@botroost/worker";

const name = `botroost-napcat-api-${process.pid}-${Date.now()}`;
let db: PostgresDatabase;
let api: ReturnType<typeof buildApi>;
let auth: AuthService;
const cookies = (set: unknown) => String(Array.isArray(set) ? set.join(";") : set);
const csrf = (cookie: string) => /botroost_csrf=([^;]+)/.exec(cookie)![1]!;
const mutation = (cookie: string) => ({ cookie, origin: "https://app.test", host: "app.test", "x-csrf-token": csrf(cookie) });

beforeAll(async () => {
  execFileSync("docker", ["run", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=botroost", "-p", "127.0.0.1::5432", "postgres:16-alpine"]);
  for (let i = 0; i < 60; i++) {
    try {
      execFileSync("docker", ["exec", name, "pg_isready", "-U", "postgres"], { stdio: "ignore" });
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  const port = /:(\d+)$/.exec(execFileSync("docker", ["port", name, "5432/tcp"]).toString().trim())?.[1];
  if (!port) throw new Error("PostgreSQL test port unavailable");
  db = new PostgresDatabase(`postgresql://postgres:postgres@127.0.0.1:${port}/botroost`);
  for (let i = 0; i < 60; i++) {
    try {
      await db.ping();
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  await db.migrate();
  auth = new AuthService(db);
  await auth.bootstrapOwner("owner@example.com", "correct horse battery staple", "Primary");
  api = buildApi({ database: db, credentialKey: Buffer.alloc(32, 7), publicOrigin: "https://app.test" });
  await api.ready();
}, 120_000);

afterAll(async () => {
  await api?.close();
  await db?.close();
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  } catch {
    // Best-effort cleanup: the container may already have exited or been removed.
  }
}, 30_000);

describe("NapCat API vertical slice", () => {
  it("rejects NapCat endpoints assigned to a non-NapCat node", async () => {
    const login = await api.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "owner@example.com", password: "correct horse battery staple" } });
    const cookie = cookies(login.headers["set-cookie"]);
    const node = (await api.inject({ method: "POST", url: "/api/v1/nodes", headers: mutation(cookie), payload: { name: `fake-node-${Date.now()}`, provider: "fake" } })).json();
    const response = await api.inject({ method: "POST", url: "/api/v1/endpoints", headers: mutation(cookie), payload: { name: "bad-binding", providerId: "napcat", nodeId: node.id } });
    expect(response.statusCode).toBe(409);
  });

  it("enables NapCat endpoints on an outbound node and dispatches pinned runtime requests", async () => {
    const login = await api.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "owner@example.com", password: "correct horse battery staple" } });
    const cookie = cookies(login.headers["set-cookie"]);
    const provider = await api.inject({ method: "GET", url: "/api/v1/providers", headers: { cookie } });
    expect(provider.json().items.find((item: { id: string }) => item.id === "napcat")).toMatchObject({ availability: { enabled: true } });

    const node = (await api.inject({ method: "POST", url: "/api/v1/nodes", headers: mutation(cookie), payload: { name: `napcat-node-${Date.now()}`, provider: "napcat" } })).json();
    const endpointResponse = await api.inject({
      method: "POST",
      url: "/api/v1/endpoints",
      headers: mutation(cookie),
      payload: { name: `napcat-${Date.now()}`, providerId: "napcat", nodeId: node.id },
    });
    expect(endpointResponse.statusCode).toBe(201);
    const endpoint = endpointResponse.json();
    expect(endpoint).toMatchObject({ providerId: "napcat", node: { id: node.id }, configuration: { qq: {} } });

    const operation = (await api.inject({
      method: "POST",
      url: `/api/v1/endpoints/${endpoint.id}/operations`,
      headers: { ...mutation(cookie), "idempotency-key": "napcat-start" },
      payload: { action: "start", expectedGeneration: 0 },
    })).json();
    await new DurableWorker(db).runOnce();
    const command = await db.pool.query("SELECT runtime_request,metadata FROM agent_commands WHERE operation_id=$1", [operation.id]);
    expect(command.rows[0]).toMatchObject({
      runtime_request: {
        approvedArtifactId: "artifact:napcat:mlikiowa.napcat-docker.sha256.1336a777f9a4f1f8cb89fef42f7548deacd3645919a067a50df5b66b5e77390e",
        approvedEgressProfile: "egress:onebot",
      },
      metadata: {
        image: "mlikiowa/napcat-docker@sha256:1336a777f9a4f1f8cb89fef42f7548deacd3645919a067a50df5b66b5e77390e",
      },
    });
  });

  it("exposes QR login and probe metadata from authenticated agent observations", async () => {
    const login = await api.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "owner@example.com", password: "correct horse battery staple" } });
    const cookie = cookies(login.headers["set-cookie"]);
    const node = (await api.inject({ method: "POST", url: "/api/v1/nodes", headers: mutation(cookie), payload: { name: `napcat-meta-${Date.now()}`, provider: "napcat" } })).json();
    const endpoint = (await api.inject({ method: "POST", url: "/api/v1/endpoints", headers: mutation(cookie), payload: { name: `napcat-meta-${Date.now()}`, providerId: "napcat", nodeId: node.id } })).json();
    await db.heartbeat(node.id, {
      sessionId: "agent-session",
      observedAt: new Date().toISOString(),
      runtimes: [{
        endpointId: endpoint.id,
        generation: endpoint.generation,
        runtime: "ready",
        provider: "available",
        protocol: "connected",
        convergence: "converged",
        metadata: {
          qq: { uin: "12345", nickname: "Operator QQ" },
          login: { qrcode: "otpauth://qq-login" },
          onebot: { status: { online: true }, loginInfo: { user_id: 12345 } },
          traffic: { status: "ok", privacy: "aggregate_only", oneMinute: { inbound: 2, outbound: 1, total: 3, bytes: 240 } },
        },
      }],
    });

    expect((await api.inject({ method: "GET", url: `/api/v1/endpoints/${endpoint.id}/napcat/login-qrcode`, headers: { cookie } })).json()).toEqual({ qrcode: "otpauth://qq-login" });
    const freshStatus=(await api.inject({ method: "GET", url: `/api/v1/endpoints/${endpoint.id}/napcat/status`, headers: { cookie } })).json();
    expect(freshStatus).toMatchObject({
      qq: { uin: "12345", nickname: "Operator QQ" },
      onebot: { status: { online: true }, loginInfo: { user_id: 12345 } },
      traffic: { status: "ok", privacy: "aggregate_only", oneMinute: { total: 3 } },
      freshness: {
        fresh: true,
        staleAfterSeconds: 15,
      },
    });
    expect(Date.parse(freshStatus.freshness.observationAt)).not.toBeNaN();
    expect(Date.parse(freshStatus.freshness.nodeHeartbeatAt)).not.toBeNaN();
    expect(Date.parse(freshStatus.freshness.checkedAt)).not.toBeNaN();

    await db.pool.query("UPDATE observations SET created_at=now()-interval '30 seconds' WHERE endpoint_id=$1",[endpoint.id]);
    const staleStatus=(await api.inject({ method: "GET", url: `/api/v1/endpoints/${endpoint.id}/napcat/status`, headers: { cookie } })).json();
    expect(staleStatus.freshness).toMatchObject({fresh:false,staleAfterSeconds:15});

    await db.pool.query("UPDATE observations SET created_at=now() WHERE endpoint_id=$1",[endpoint.id]);
    await db.pool.query("UPDATE nodes SET last_heartbeat_at=now()-interval '3 minutes' WHERE id=$1",[node.id]);
    const offlineStatus=(await api.inject({ method: "GET", url: `/api/v1/endpoints/${endpoint.id}/napcat/status`, headers: { cookie } })).json();
    expect(offlineStatus.freshness).toMatchObject({fresh:false});
  });

  it("queues an audited, read-only NapCat container log command with strict bounds", async () => {
    const login = await api.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "owner@example.com", password: "correct horse battery staple" } });
    const cookie = cookies(login.headers["set-cookie"]);
    const node = (await api.inject({ method:"POST",url:"/api/v1/nodes",headers:mutation(cookie),payload:{name:`napcat-logs-${Date.now()}`,provider:"napcat"} })).json();
    const endpoint = (await api.inject({ method:"POST",url:"/api/v1/endpoints",headers:mutation(cookie),payload:{name:`napcat-logs-${Date.now()}`,providerId:"napcat",nodeId:node.id} })).json();

    const response = await api.inject({ method:"POST",url:`/api/v1/endpoints/${endpoint.id}/napcat/container-logs`,headers:{...mutation(cookie),"idempotency-key":"read-logs"},payload:{tail:250,sinceSeconds:900} });
    expect(response.statusCode).toBe(202);
    await new DurableWorker(db).runOnce();
    const command = await db.pool.query("SELECT action,metadata FROM agent_commands WHERE endpoint_id=$1 ORDER BY created_at DESC LIMIT 1",[endpoint.id]);
    expect(command.rows[0]).toMatchObject({ action:"read-container-logs", metadata:{ logTail:250,logSinceSeconds:900 } });
    const audit = await db.pool.query("SELECT action,metadata FROM audit_events WHERE resource_id=$1 ORDER BY created_at DESC LIMIT 1",[response.json().id]);
    expect(audit.rows[0]).toMatchObject({ action:"operation.queued",metadata:{ action:"read-container-logs",logTail:250,logSinceSeconds:900 } });

    expect((await api.inject({ method:"POST",url:`/api/v1/endpoints/${endpoint.id}/napcat/container-logs`,headers:{...mutation(cookie),"idempotency-key":"bad-logs"},payload:{tail:5001,sinceSeconds:900} })).statusCode).toBe(400);
  });

  it("returns completed, redacted container logs from the operation result", async () => {
    const login = await api.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "owner@example.com", password: "correct horse battery staple" } });
    const cookie = cookies(login.headers["set-cookie"]);
    const node = (await api.inject({ method:"POST",url:"/api/v1/nodes",headers:mutation(cookie),payload:{name:`napcat-log-result-${Date.now()}`,provider:"napcat"} })).json();
    const endpoint = (await api.inject({ method:"POST",url:"/api/v1/endpoints",headers:mutation(cookie),payload:{name:`napcat-log-result-${Date.now()}`,providerId:"napcat",nodeId:node.id} })).json();
    const operation = (await api.inject({ method:"POST",url:`/api/v1/endpoints/${endpoint.id}/napcat/container-logs`,headers:{...mutation(cookie),"idempotency-key":"read-log-result"},payload:{tail:100,sinceSeconds:300} })).json();
    await new DurableWorker(db).runOnce();
    await db.pool.query("UPDATE operations SET status='succeeded',result=$2 WHERE id=$1",[operation.id,{outcome:"succeeded",metadata:{logs:{text:"Token=[REDACTED]\\nready",tail:100,sinceSeconds:300}}}]);
    const result = await api.inject({ method:"GET",url:`/api/v1/operations/${operation.id}`,headers:{cookie} });
    expect(result.json().result.metadata.logs).toEqual({ text:"Token=[REDACTED]\\nready",tail:100,sinceSeconds:300 });
  });

  it("queues a dedicated refresh command for an expired NapCat login QR", async () => {
    const login = await api.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "owner@example.com", password: "correct horse battery staple" } });
    const cookie = cookies(login.headers["set-cookie"]);
    const node = (await api.inject({ method:"POST",url:"/api/v1/nodes",headers:mutation(cookie),payload:{name:`napcat-refresh-${Date.now()}`,provider:"napcat"} })).json();
    const endpoint = (await api.inject({ method:"POST",url:"/api/v1/endpoints",headers:mutation(cookie),payload:{name:`napcat-refresh-${Date.now()}`,providerId:"napcat",nodeId:node.id} })).json();
    const response = await api.inject({ method:"POST",url:`/api/v1/endpoints/${endpoint.id}/napcat/login-qrcode`,headers:{...mutation(cookie),"idempotency-key":"refresh-qr"} });
    expect(response.statusCode).toBe(202);
    const endpointAfter=(await api.inject({method:"GET",url:`/api/v1/endpoints/${endpoint.id}`,headers:{cookie}})).json();
    expect(endpointAfter.desired).toEqual({state:"stopped"});
    await new DurableWorker(db).runOnce();
    const command=await db.pool.query("SELECT action FROM agent_commands WHERE endpoint_id=$1 ORDER BY created_at DESC LIMIT 1",[endpoint.id]);
    expect(command.rows[0]?.action).toBe("refresh-login-qr");
  });
});
