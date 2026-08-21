import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NAPCAT_IMAGE, NapCatRuntime, type DockerClient, type DockerInspectResult } from "../src/index.js";
import type { RuntimeCommand } from "@botroost/agent-protocol";

const baseCommand: RuntimeCommand = {
  commandId: "cmd-1",
  operationId: "op-1",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  nodeId: "22222222-2222-4222-8222-222222222222",
  endpointId: "33333333-3333-4333-8333-333333333333",
  generation: 1,
  connectionEpoch: 1,
  action: "start",
  runtimeRequest: {
    approvedArtifactId: "artifact:napcat:mlikiowa.napcat-docker.sha256.1336a777f9a4f1f8cb89fef42f7548deacd3645919a067a50df5b66b5e77390e",
    approvedEgressProfile: "egress:onebot",
    resources: { cpuMillis: 500, memoryMiB: 512 },
    storage: { kind: "ephemeral", sizeMiB: 512 },
  },
  metadata: {
    image: NAPCAT_IMAGE,
    containerPrefix: "botroost-napcat",
  },
};

class RecordingDocker implements DockerClient {
  created: Parameters<DockerClient["create"]>[0][] = [];
  started: string[] = [];
  stopped: string[] = [];
  restarted: string[] = [];
  execs: { container: string; args: string[] }[] = [];
  removes: string[] = [];
  inspected: string[] = [];
  async inspect(name: string): Promise<DockerInspectResult | null> {
    this.inspected.push(name);
    return null;
  }
  async create(input: Parameters<DockerClient["create"]>[0]) {
    this.created.push(input);
    return { id: "container-id" };
  }
  async remove(name: string) { this.removes.push(name); }
  async start(name: string) {
    this.started.push(name);
  }
  async stop(name: string) {
    this.stopped.push(name);
  }
  async restart(name: string) {
    this.restarted.push(name);
  }
  logRequests: { container: string; tail: number; sinceSeconds: number }[] = [];
  async exec(container: string, args: string[]) {
    this.execs.push({ container, args });
    return { stdout: "", stderr: "" };
  }
  async logs(container: string, options: { tail: number; sinceSeconds: number }) {
    this.logRequests.push({ container, ...options });
    return "08-21 Token=hidden\n{\"token\":\"json-secret\"}\nAuthorization: Bearer bearer-secret\nCookie: session=cookie-secret\nCredential=credential-secret\nready\n";
  }
}

describe("NapCat runtime", () => {
  it("recreates an existing managed container when the pinned NapCat image changes", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async name => ({ id: "old", name, image: "mlikiowa/napcat-docker@sha256:old", state: "running", ipAddress: "172.18.0.10", labels: { "botroost.workspace_id": baseCommand.workspaceId, "botroost.endpoint_id": baseCommand.endpointId, "botroost.provider": "napcat" } });
    const runtime = new NapCatRuntime({ docker, stateDirectory: await mkdtemp(join(tmpdir(), "botroost-napcat-upgrade-")), napcatToken: "operator-token", qrPollAttempts:1, fetcher:async url=>{const path=new URL(String(url)).pathname;if(path==="/api/auth/login")return new Response(JSON.stringify({code:0,data:{Credential:"credential"}}));if(path==="/api/QQLogin/GetQQLoginQrcode")return new Response(JSON.stringify({code:0,data:{qrcode:"qr"}}));if(path==="/api/QQLogin/GetQQLoginInfo")return new Response(JSON.stringify({code:0,data:{online:false}}));throw new Error(`unexpected request ${path}`)} });

    await runtime.apply("runtime:upgrade", baseCommand);

    expect(docker.removes).toEqual([`botroost-napcat-${baseCommand.endpointId}`]);
    expect(docker.created[0]?.image).toBe(NAPCAT_IMAGE);
  });

  it("creates the pinned container with labels, persistent per-endpoint storage, and no host ports", async () => {
    const docker = new RecordingDocker();
    const root = await mkdtemp(join(tmpdir(), "botroost-napcat-"));
    const runtime = new NapCatRuntime({ docker, stateDirectory: root, napcatToken: "operator-token" });

    await runtime.apply("runtime:cmd-1", baseCommand);

    expect(docker.created).toHaveLength(1);
    expect(docker.created[0]).toMatchObject({
      name: "botroost-napcat-33333333-3333-4333-8333-333333333333",
      image: NAPCAT_IMAGE,
      labels: {
        "botroost.provider": "napcat",
        "botroost.workspace_id": baseCommand.workspaceId,
        "botroost.endpoint_id": baseCommand.endpointId,
      },
      hostConfig: {
        networkMode: "bridge",
        portBindings: {},
      },
    });
    expect(docker.created[0]!.mounts).toEqual([
      { type: "bind", source: join(root, baseCommand.endpointId, "qq"), target: "/app/.config/QQ" },
      { type: "bind", source: join(root, baseCommand.endpointId, "config"), target: "/app/napcat/config" },
    ]);
    expect(JSON.stringify(docker.created[0])).not.toContain("/var/run/docker.sock");
    expect(docker.started).toEqual(["botroost-napcat-33333333-3333-4333-8333-333333333333"]);
  });

  it("uses daemon-visible host paths for child-container persistence", async () => {
    const docker = new RecordingDocker();
    const local = await mkdtemp(join(tmpdir(), "botroost-napcat-visible-"));
    const runtime = new NapCatRuntime({ docker, stateDirectory: local, hostStateDirectory: "/opt/botroost/agent-state/napcat", napcatToken: "operator-token" });
    await runtime.apply("runtime:cmd-host-path", baseCommand);
    expect(docker.created[0]!.mounts.map(mount => mount.source)).toEqual([
      `/opt/botroost/agent-state/napcat/${baseCommand.endpointId}/qq`,
      `/opt/botroost/agent-state/napcat/${baseCommand.endpointId}/config`,
    ]);
  });

  it("rejects unpinned images, wrong digests, and unsafe endpoint identifiers", async () => {
    const runtime = new NapCatRuntime({
      docker: new RecordingDocker(),
      stateDirectory: await mkdtemp(join(tmpdir(), "botroost-napcat-")),
      napcatToken: "operator-token",
    });
    await expect(runtime.apply("runtime:bad-image", { ...baseCommand, metadata: { image: "mlikiowa/napcat-docker:latest" } })).rejects.toThrow(/image/);
    await expect(runtime.apply("runtime:bad-id", { ...baseCommand, endpointId: "../escape" })).rejects.toThrow(/endpoint/);
  });

  it("uses NapCat web auth and authenticated QR/status/probe requests", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ({
      id: "container-id",
      name: "botroost-napcat-33333333-3333-4333-8333-333333333333",
      image: NAPCAT_IMAGE,
      state: "running" as const,
      ipAddress: "172.18.0.10",
      labels: {},
    });
    const calls: { url: string; init?: RequestInit }[] = [];
    const runtime = new NapCatRuntime({
      docker,
      stateDirectory: await mkdtemp(join(tmpdir(), "botroost-napcat-")),
      napcatToken: "operator-token",
      fetcher: async (url, init) => {
        calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
        if (String(url).endsWith("/api/auth/login")) return new Response(JSON.stringify({ code: 0, data: { Credential: "web-token" } }), { status: 200 });
        if (String(url).endsWith("/api/QQLogin/GetQQLoginQrcode")) return new Response(JSON.stringify({ data: { qrcode: "otpauth://qq-login" } }), { status: 200 });
        if (String(url).endsWith("/api/QQLogin/GetQQLoginInfo")) return new Response(JSON.stringify({ code: 0, data: { uin: "12345", nickname: "Operator QQ", online: true } }), { status: 200 });
        if (String(url).endsWith("/api/Debug/create")) return new Response(JSON.stringify({ data: { adapterName: "debug-session" } }), { status: 200 });
        return new Response(JSON.stringify({ status: "ok", retcode: 0, data: { online: true } }), { status: 200 });
      },
    });

    const snapshot = await runtime.snapshot(baseCommand);

    expect(calls.map(call => new URL(call.url).pathname)).toEqual([
      "/api/auth/login",
      "/api/QQLogin/GetQQLoginQrcode",
      "/api/QQLogin/GetQQLoginInfo",
      "/api/Debug/create",
      "/api/Debug/call/debug-session",
      "/api/Debug/call/debug-session",
    ]);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      hash: "43b5038ddfcd49202012115189e327dc42f5dd49740202201cfbe0db05fc5037",
    });
    expect(calls.slice(1).every(call => (call.init?.headers as Record<string, string>).authorization === "Bearer web-token")).toBe(true);
    expect(snapshot.metadata).toMatchObject({
      qq: { uin: "12345", nickname: "Operator QQ" },
      login: { qrcode: "otpauth://qq-login" },
      onebot: { status: { online: true } },
    });
  });

  it("reuses one WebUI credential across continuous snapshots instead of hitting the login limiter", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ({ id: "container-id", name: "botroost-napcat-33333333-3333-4333-8333-333333333333", image: NAPCAT_IMAGE, state: "running" as const, ipAddress: "172.18.0.10", labels: {} });
    let authCalls = 0;
    const runtime = new NapCatRuntime({
      docker,
      stateDirectory: await mkdtemp(join(tmpdir(), "botroost-napcat-auth-cache-")),
      napcatToken: "operator-token",
      fetcher: async url => {
        const path = new URL(String(url)).pathname;
        if (path === "/api/auth/login") {
          authCalls++;
          return new Response(JSON.stringify(authCalls === 1 ? { code: 0, data: { Credential: "credential" } } : { code: -1, message: "login rate limit" }));
        }
        if (path === "/api/Debug/create") return new Response(JSON.stringify({ code: 0, data: { adapterName: "debug-session" } }));
        return new Response(JSON.stringify({ code: 0, data: { online: true, qrcode: "qr-current" } }));
      },
    });

    await runtime.snapshot(baseCommand);
    await runtime.snapshot(baseCommand);

    expect(authCalls).toBe(1);
  });

  it("reauthenticates once when a cached WebUI credential expires", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ({ id:"container-id",name:"botroost-napcat-33333333-3333-4333-8333-333333333333",image:NAPCAT_IMAGE,state:"running" as const,ipAddress:"172.18.0.10",labels:{} });
    let authCalls=0;
    const runtime=new NapCatRuntime({docker,stateDirectory:await mkdtemp(join(tmpdir(),"botroost-napcat-reauth-")),napcatToken:"operator-token",fetcher:async(url,init)=>{const path=new URL(String(url)).pathname;if(path==="/api/auth/login"){authCalls++;return new Response(JSON.stringify({code:0,data:{Credential:`credential-${authCalls}`}}))}const authorization=new Headers(init?.headers).get("authorization");if(authorization==="Bearer credential-1")return new Response("expired",{status:401});if(path==="/api/QQLogin/GetQQLoginQrcode")return new Response(JSON.stringify({code:0,data:{qrcode:"qr-current"}}));if(path==="/api/QQLogin/GetQQLoginInfo")return new Response(JSON.stringify({code:0,data:{online:false}}));throw new Error(`unexpected request ${path}`)}});
    const snapshot=await runtime.snapshot(baseCommand);
    expect(snapshot.metadata.login).toEqual({qrcode:"qr-current"});
    expect(authCalls).toBe(2);
  });

  it("reauthenticates once when NapCat reports an expired credential in an HTTP 200 body", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ({ id:"container-id",name:"botroost-napcat-33333333-3333-4333-8333-333333333333",image:NAPCAT_IMAGE,state:"running" as const,ipAddress:"172.18.0.10",labels:{} });
    let authCalls=0;
    const runtime=new NapCatRuntime({docker,stateDirectory:await mkdtemp(join(tmpdir(),"botroost-napcat-body-reauth-")),napcatToken:"operator-token",fetcher:async(url,init)=>{const path=new URL(String(url)).pathname;if(path==="/api/auth/login"){authCalls++;return new Response(JSON.stringify({code:0,data:{Credential:`credential-${authCalls}`}}))}const authorization=new Headers(init?.headers).get("authorization");if(authorization==="Bearer credential-1")return new Response(JSON.stringify({code:-1,message:"Unauthorized"}),{status:200});if(path==="/api/QQLogin/GetQQLoginQrcode")return new Response(JSON.stringify({code:0,data:{qrcode:"qr-current"}}));if(path==="/api/QQLogin/GetQQLoginInfo")return new Response(JSON.stringify({code:0,data:{online:false}}));throw new Error(`unexpected request ${path}`)}});
    const snapshot=await runtime.snapshot(baseCommand);
    expect(snapshot.metadata.login).toEqual({qrcode:"qr-current"});
    expect(authCalls).toBe(2);
  });

  it("keeps a fresh QR available while QQ is not logged in and skips unavailable OneBot probes", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ({ id:"container-id",name:"botroost-napcat-33333333-3333-4333-8333-333333333333",image:NAPCAT_IMAGE,state:"running" as const,ipAddress:"172.18.0.10",labels:{} });
    const paths:string[]=[];
    const runtime=new NapCatRuntime({docker,stateDirectory:await mkdtemp(join(tmpdir(),"botroost-napcat-pending-")),napcatToken:"operator-token",fetcher:async url=>{const path=new URL(String(url)).pathname;paths.push(path);if(path==="/api/auth/login")return new Response(JSON.stringify({code:0,data:{Credential:"credential"}}));if(path==="/api/QQLogin/GetQQLoginQrcode")return new Response(JSON.stringify({code:0,data:{qrcode:"qr-current"}}));if(path==="/api/QQLogin/GetQQLoginInfo")return new Response(JSON.stringify({code:0,data:{online:false}}));throw new Error(`unexpected probe ${path}`)}});
    const snapshot=await runtime.snapshot(baseCommand);
    expect(snapshot).toMatchObject({runtime:"ready",provider:"available",protocol:"disconnected",metadata:{login:{qrcode:"qr-current"}}});
    expect(paths).not.toContain("/api/Debug/create");
  });

  it("asks NapCat to create a QR when none exists yet", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ({ id:"container-id",name:"botroost-napcat-33333333-3333-4333-8333-333333333333",image:NAPCAT_IMAGE,state:"running" as const,ipAddress:"172.18.0.10",labels:{} });
    let qrRequests=0;
    const runtime=new NapCatRuntime({docker,stateDirectory:await mkdtemp(join(tmpdir(),"botroost-napcat-create-qr-")),napcatToken:"operator-token",fetcher:async url=>{const path=new URL(String(url)).pathname;if(path==="/api/auth/login")return new Response(JSON.stringify({code:0,data:{Credential:"credential"}}));if(path==="/api/QQLogin/GetQQLoginQrcode"){qrRequests++;return new Response(JSON.stringify(qrRequests===1?{code:-1,message:"QRCode Get Error"}:{code:0,data:{qrcode:"qr-created"}}))}if(path==="/api/QQLogin/RefreshQRcode")return new Response(JSON.stringify({code:0,data:null}));if(path==="/api/QQLogin/GetQQLoginInfo")return new Response(JSON.stringify({code:0,data:{online:false}}));throw new Error(`unexpected request ${path}`)}});
    const snapshot=await runtime.snapshot(baseCommand);
    expect(snapshot.metadata.login).toEqual({qrcode:"qr-created"});
    expect(qrRequests).toBe(2);
  });

  it("waits for NapCat to publish a replacement QR after refresh", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ({ id: "container-id", name: "botroost-napcat-33333333-3333-4333-8333-333333333333", image: NAPCAT_IMAGE, state: "running" as const, ipAddress: "172.18.0.10", labels: {} });
    let reads = 0;
    const runtime = new NapCatRuntime({
      docker,
      stateDirectory: await mkdtemp(join(tmpdir(), "botroost-napcat-wait-qr-")),
      napcatToken: "operator-token",
      qrPollIntervalMs: 1,
      qrPollAttempts: 4,
      fetcher: async url => {
        const path = new URL(String(url)).pathname;
        if (path === "/api/auth/login") return new Response(JSON.stringify({ code: 0, data: { Credential: "credential" } }));
        if (path === "/api/QQLogin/RefreshQRcode") return new Response(JSON.stringify({ code: 0, data: null }));
        if (path === "/api/QQLogin/GetQQLoginQrcode") {
          reads++;
          return new Response(JSON.stringify(reads < 3 ? { code: -1, message: "QRCode Get Error" } : { code: 0, data: { qrcode: "qr-eventually-ready" } }));
        }
        if (path === "/api/QQLogin/GetQQLoginInfo") return new Response(JSON.stringify({ code: 0, data: { online: false } }));
        throw new Error(`unexpected request ${path}`);
      },
    });

    const result = await runtime.apply("runtime:refresh-wait", { ...baseCommand, action: "refresh-login-qr" });

    expect(result.metadata).toMatchObject({ login: { qrcode: "qr-eventually-ready" } });
    expect(reads).toBe(3);
  });

  it("returns bounded, redacted logs only for the endpoint-owned NapCat container", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async name => ({ id: "container-id", name, image: NAPCAT_IMAGE, state: "running" as const, ipAddress: "172.18.0.10", labels: { "botroost.workspace_id": baseCommand.workspaceId, "botroost.endpoint_id": baseCommand.endpointId, "botroost.provider": "napcat" } });
    const runtime = new NapCatRuntime({ docker, stateDirectory: await mkdtemp(join(tmpdir(), "botroost-napcat-logs-")), napcatToken: "operator-token" });

    const result = await runtime.apply("runtime:logs", { ...baseCommand, runtimeRequest:{...baseCommand.runtimeRequest,approvedArtifactId:"artifact:napcat:mlikiowa.napcat-docker.sha256.1336a777f9a4f1f8cb89fef42f7548deacd3645919a067a50df5b66b5e77390e"}, action: "read-container-logs", metadata: { ...baseCommand.metadata, image:NAPCAT_IMAGE,logTail: 250, logSinceSeconds: 900 } });

    expect(docker.logRequests).toEqual([{ container: `botroost-napcat-${baseCommand.endpointId}`, tail: 250, sinceSeconds: 900 }]);
    expect(result.metadata?.logs).toEqual({ text: "08-21 Token=[REDACTED]\n{\"token\":\"[REDACTED]\"}\nAuthorization: [REDACTED]\nCookie: [REDACTED]\nCredential=[REDACTED]\nready\n", tail: 250, sinceSeconds: 900 });
  });

  it("refreshes an expired QR code through NapCat and returns the replacement", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ({ id: "container-id", name: "botroost-napcat-33333333-3333-4333-8333-333333333333", image: NAPCAT_IMAGE, state: "running" as const, ipAddress: "172.18.0.10", labels: {} });
    const paths: string[] = [];
    let qrcode = "qr-expired";
    const runtime = new NapCatRuntime({
      docker,
      stateDirectory: await mkdtemp(join(tmpdir(), "botroost-napcat-refresh-")),
      napcatToken: "operator-token",
      fetcher: async url => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path === "/api/auth/login") return new Response(JSON.stringify({ code: 0, data: { Credential: "credential" } }));
        if (path === "/api/QQLogin/RefreshQRcode") { qrcode = "qr-fresh"; return new Response(JSON.stringify({ code: 0, data: null })); }
        if (path === "/api/QQLogin/GetQQLoginQrcode") return new Response(JSON.stringify({ code: 0, data: { qrcode } }));
        if (path === "/api/Debug/create") return new Response(JSON.stringify({ code: 0, data: { adapterName: "debug-session" } }));
        return new Response(JSON.stringify({ code: 0, data: { online: true } }));
      },
    });

    const result = await runtime.apply("runtime:refresh", { ...baseCommand, action: "refresh-login-qr" });

    expect(paths).toContain("/api/QQLogin/RefreshQRcode");
    expect(result.metadata).toMatchObject({ login: { qrcode: "qr-fresh" } });
  });

  it("reports ongoing NapCat observations on later heartbeats", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ({ id: "container-id", name: "botroost-napcat-33333333-3333-4333-8333-333333333333", image: NAPCAT_IMAGE, state: "running" as const, ipAddress: "172.18.0.10", labels: {} });
    const runtime = new NapCatRuntime({
      docker,
      stateDirectory: await mkdtemp(join(tmpdir(), "botroost-napcat-heartbeat-")),
      napcatToken: "operator-token",
      fetcher: async url => {
        const path = new URL(String(url)).pathname;
        if (path === "/api/auth/login") return new Response(JSON.stringify({ code: 0, data: { Credential: "credential" } }));
        if (path === "/api/Debug/create") return new Response(JSON.stringify({ code: 0, data: { adapterName: "debug-session" } }));
        return new Response(JSON.stringify({ code: 0, data: { online: true } }));
      },
    });
    await runtime.apply("runtime:heartbeat", baseCommand);
    const observations = await runtime.observations();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ endpointId: baseCommand.endpointId, protocol: "connected" });
  });

  it("restores managed endpoints after an agent restart", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ({ id: "container-id", name: "botroost-napcat-33333333-3333-4333-8333-333333333333", image: NAPCAT_IMAGE, state: "running" as const, ipAddress: "172.18.0.10", labels: {} });
    const stateDirectory = await mkdtemp(join(tmpdir(), "botroost-napcat-restart-"));
    const fetcher = async (url: RequestInfo | URL) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/auth/login") return new Response(JSON.stringify({ code: 0, data: { Credential: "credential" } }));
      if (path === "/api/Debug/create") return new Response(JSON.stringify({ code: 0, data: { adapterName: "debug-session" } }));
      return new Response(JSON.stringify({ code: 0, data: { online: true } }));
    };
    await new NapCatRuntime({ docker, stateDirectory, napcatToken: "operator-token", fetcher }).apply("runtime:first", baseCommand);
    const restarted = new NapCatRuntime({ docker, stateDirectory, napcatToken: "operator-token", fetcher });
    await expect(restarted.observations()).resolves.toMatchObject([{ endpointId: baseCommand.endpointId, protocol: "connected" }]);
  });
});
