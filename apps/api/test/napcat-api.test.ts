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
        approvedArtifactId: "artifact:napcat:mlikiowa.napcat-docker.sha256.9254ec12af101576c5eeb4910847abd1d219297bc6d9a35c52511e12500f0f45",
        approvedEgressProfile: "egress:onebot",
      },
      metadata: {
        image: "mlikiowa/napcat-docker@sha256:9254ec12af101576c5eeb4910847abd1d219297bc6d9a35c52511e12500f0f45",
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
        },
      }],
    });

    expect((await api.inject({ method: "GET", url: `/api/v1/endpoints/${endpoint.id}/napcat/login-qrcode`, headers: { cookie } })).json()).toEqual({ qrcode: "otpauth://qq-login" });
    expect((await api.inject({ method: "GET", url: `/api/v1/endpoints/${endpoint.id}/napcat/status`, headers: { cookie } })).json()).toMatchObject({
      qq: { uin: "12345", nickname: "Operator QQ" },
      onebot: { status: { online: true }, loginInfo: { user_id: 12345 } },
    });
  });
});
