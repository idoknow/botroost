import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dockerCreateArguments, NAPCAT_IMAGE, type DockerClient, type DockerInspectResult, type FetchLike } from "../src/index.js";
import { SNOWLUMA_ARTIFACT, SNOWLUMA_IMAGE, SnowLumaRuntime, snowlumaLoginPorts } from "../src/snowluma-runtime.js";
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
    approvedArtifactId: SNOWLUMA_ARTIFACT,
    approvedEgressProfile: "egress:onebot",
    resources: { cpuMillis: 500, memoryMiB: 512 },
    storage: { kind: "ephemeral", sizeMiB: 1024 },
  },
  metadata: {
    image: SNOWLUMA_IMAGE,
    containerPrefix: "botroost-snowluma",
  },
};

class RecordingDocker implements DockerClient {
  created: Parameters<DockerClient["create"]>[0][] = [];
  started: string[] = [];
  stopped: string[] = [];
  restarted: string[] = [];
  removes: string[] = [];
  hostStateRemovals: { root: string; endpointId: string; image: string }[] = [];
  logsRequests: { container: string; tail: number; sinceSeconds: number }[] = [];
  async inspect(name: string): Promise<DockerInspectResult | null> {
    void name;
    return null;
  }
  async create(input: Parameters<DockerClient["create"]>[0]) {
    this.created.push(input);
    return { id: "container-id" };
  }
  async remove(name: string) { this.removes.push(name); }
  async removeHostEndpoint(root: string, endpointId: string, image: string) {
    this.hostStateRemovals.push({ root, endpointId, image });
  }
  async start(name: string) { this.started.push(name); }
  async stop(name: string) { this.stopped.push(name); }
  async restart(name: string) { this.restarted.push(name); }
  execCalls: string[][] = [];
  async exec(_container: string, args: string[]) {
    this.execCalls.push(args);
    return { stdout: "", stderr: "" };
  }
  async logs(container: string, options: { tail: number; sinceSeconds: number }) {
    this.logsRequests.push({ container, ...options });
    return "log output";
  }
}

const ownedContainer = (): DockerInspectResult => ({
  id: "owned-id",
  name: "botroost-snowluma-33333333-3333-4333-8333-333333333333",
  image: SNOWLUMA_IMAGE,
  state: "running",
  ipAddress: "172.18.0.10",
  labels: {
    "botroost.workspace_id": baseCommand.workspaceId,
    "botroost.endpoint_id": baseCommand.endpointId,
    "botroost.provider": "snowluma",
  },
});

const oneBotFetcher = (online: boolean): FetchLike => async url => {
  const action = new URL(String(url)).pathname.replace("/", "");
  const data = action === "get_status"
    ? { online, good: true }
    : action === "get_login_info"
      ? online ? { user_id: 10001, nickname: "tester" } : null
      : action === "get_version_info"
        ? { app_name: "SnowLuma", app_version: "1.10.0" }
        : action === "get_friend_list"
          ? [{ user_id: 10001, nickname: "tester", remark: "self" }]
          : action === "get_group_list"
            ? [{ group_id: 10086, group_name: "test-group", member_count: 2 }]
            : {};
  return new Response(JSON.stringify({ status: "ok", retcode: 0, data }), { status: 200 });
};

describe("SnowLuma runtime", () => {
  it("creates the container with QQ injection privileges, shm, mounts and login ports", async () => {
    const docker = new RecordingDocker();
    const runtime = new SnowLumaRuntime({ docker, stateDirectory: await mkdtemp(join(tmpdir(), "snowluma-create-")) });
    await runtime.apply("effect-1", baseCommand);
    expect(docker.created).toHaveLength(1);
    const created = docker.created[0]!;
    expect(created.image).toBe(SNOWLUMA_IMAGE);
    expect(created.capAdd).toEqual(["SYS_PTRACE"]);
    expect(created.securityOpt).toEqual(["seccomp=unconfined"]);
    expect(created.shmBytes).toBe(1024 * 1024 * 1024);
    expect(created.labels["botroost.provider"]).toBe("snowluma");
    expect(created.mounts).toEqual([
      { type: "bind", source: expect.stringContaining(join("33333333-3333-4333-8333-333333333333", "qq")), target: "/app/.config" },
      { type: "bind", source: expect.stringContaining(join("33333333-3333-4333-8333-333333333333", "config")), target: "/app/snowluma-data" },
    ]);
    const ports = snowlumaLoginPorts(baseCommand.endpointId);
    expect(created.publishedPorts).toEqual([
      { hostPort: String(ports.novncPort), containerPort: "6081" },
      { hostPort: String(ports.webuiPort), containerPort: "5099" },
    ]);
    expect(created.resources).toEqual({ cpuMillis: 1000, memoryMiB: 1024, memorySwapMiB: 1536 });
    expect(docker.started).toEqual([`botroost-snowluma-${baseCommand.endpointId}`]);
  });

  it("observes QQ login state over the OneBot v11 HTTP endpoint", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ownedContainer();
    const runtime = new SnowLumaRuntime({ docker, stateDirectory: await mkdtemp(join(tmpdir(), "snowluma-obs-")), fetcher: oneBotFetcher(true) });
    const result = await runtime.apply("effect-1", baseCommand);
    expect(result.state).toBe("running");
    expect(result.observations).toEqual({ node: "online", runtime: "ready", provider: "available", protocol: "connected", convergence: "converged" });
    const metadata = result.metadata as { qq: { online: boolean; user_id: number }; onebot: { probes: Record<string, { ok: boolean }> } };
    expect(metadata.qq.online).toBe(true);
    expect(metadata.qq.user_id).toBe(10001);
    expect(metadata.onebot.probes.get_status?.ok).toBe(true);
  });

  it("reports a disconnected protocol while QQ login is pending", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ownedContainer();
    const runtime = new SnowLumaRuntime({ docker, stateDirectory: await mkdtemp(join(tmpdir(), "snowluma-qr-")), fetcher: oneBotFetcher(false) });
    const result = await runtime.apply("effect-1", baseCommand);
    expect(result.observations?.protocol).toBe("disconnected");
    expect(result.observations?.convergence).toBe("reconciling");
    const metadata = result.metadata as { loginGuide: { novncPort: number; webuiPort: number } };
    expect(metadata.loginGuide.novncPort).toBe(snowlumaLoginPorts(baseCommand.endpointId).novncPort);
    expect(metadata.loginGuide.webuiPort).toBe(snowlumaLoginPorts(baseCommand.endpointId).webuiPort);
  });

  it("treats an unreachable OneBot endpoint as pending login and still publishes the login guide", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ownedContainer();
    docker.logs = async () => "00:34:36 INFO [WebUI] initial credentials: user=admin password=07f3c18cc36ed2b8\n";
    const runtime = new SnowLumaRuntime({
      docker,
      stateDirectory: await mkdtemp(join(tmpdir(), "snowluma-unreach-")),
      fetcher: async () => { throw new Error("Unable to connect. Is the computer able to access the url?"); },
    });
    const result = await runtime.apply("effect-1", baseCommand);
    expect(result.observations).toEqual({ node: "online", runtime: "ready", provider: "available", protocol: "disconnected", convergence: "reconciling" });
    const metadata = result.metadata as { qq: { online: boolean }; loginGuide: { novncPort: number; webuiPort: number; webuiUsername?: string; webuiPassword?: string }; error: string };
    expect(metadata.qq.online).toBe(false);
    expect(metadata.loginGuide.novncPort).toBe(snowlumaLoginPorts(baseCommand.endpointId).novncPort);
    expect(metadata.loginGuide.webuiPort).toBe(snowlumaLoginPorts(baseCommand.endpointId).webuiPort);
    expect(metadata.loginGuide.webuiUsername).toBe("admin");
    expect(metadata.loginGuide.webuiPassword).toBe("07f3c18cc36ed2b8");
    expect(metadata.error).toContain("Unable to connect");
  });

  it("reports a connected protocol with directory probes and log-derived traffic telemetry after login", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ownedContainer();
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
    docker.logs = async () => [
      `${at(-10_000)} 14:21:44 OK    [212499575]  [Event] 群 [▫️、haohaoxuedi...(985933590)] | [我(1623746337)]: ID:-1851207845 #登录`,
      `${at(-8_000)} 14:21:52 OK    [212499575]  [Event] [自身] 群 [▫️、haohaoxuedi...(985933590)] | [▫️(212499575)]: ID:-386607208 OneBot 动作 get_cookies 等待响应超时`,
      `${at(-9_000)} 14:14:43 WARN               [Bridge] packet OidbSvcTrpcTcp.0xfd4_1 failed: code=-1 gotResponse=false send reply 22 timed out after 15000 ms (uin=212499575, 82B, 15001ms)`,
      `${at(-13_000)} 14:14:43 OK    [212499575]  [OneBot.WS-Server] [ws-default] listening 0.0.0.0:3001/`,
      `${at(-12_000)} 14:14:43 INFO  [212499575]  [OneBot.WS-Client] [WebSocket 客户端] connected wss://app.campux.example/onebot/v11/ws`,
    ].join("\n");
    const runtime = new SnowLumaRuntime({ docker, stateDirectory: await mkdtemp(join(tmpdir(), "snowluma-online-")), fetcher: oneBotFetcher(true) });
    const result = await runtime.apply("effect-1", baseCommand);
    expect(result.observations).toEqual({ node: "online", runtime: "ready", provider: "available", protocol: "connected", convergence: "converged" });
    const metadata = result.metadata as { onebot: { directory: { friends: { count: number; probe: { ok: boolean } }; groups: { count: number; probe: { ok: boolean } } }; probes: Record<string, { ok: boolean }> }; traffic: { status: string; source: string; oneMinute: { inbound: number; outbound: number; total: number }; buckets: Array<{ inbound: number; total: number }>; recent: Array<{ direction: string; scope: string }>; recentConnections: Array<{ transport: string; status: string }>; error?: string } };
    expect(metadata.onebot.directory.friends.count).toBe(1);
    expect(metadata.onebot.directory.groups.count).toBe(1);
    expect(metadata.onebot.directory.friends.probe.ok).toBe(true);
    expect(metadata.onebot.probes.get_friend_list?.ok).toBe(true);
    expect(metadata.traffic.status).toBe("ok");
    expect(metadata.traffic.error).toBeUndefined();
    expect(metadata.traffic.source).toBe("snowluma.container_logs");
    expect(metadata.traffic.oneMinute).toEqual({ inbound: 1, outbound: 1, total: 2, bytes: expect.any(Number) });
    expect(metadata.traffic.recent.map(event => `${event.direction}/${event.scope}`)).toEqual(["outbound/group", "inbound/group"]);
    expect(metadata.traffic.recentConnections.map(event => `${event.transport}/${event.status}`)).toEqual(["websocket-client/connected", "websocket-server/listening"]);
  });

  it("rejects commands carrying a NapCat image", async () => {
    const docker = new RecordingDocker();
    const runtime = new SnowLumaRuntime({ docker, stateDirectory: await mkdtemp(join(tmpdir(), "snowluma-fence-")) });
    await expect(runtime.apply("effect-1", { ...baseCommand, metadata: { ...baseCommand.metadata, image: NAPCAT_IMAGE } })).rejects.toThrow("not allowlisted");
    expect(docker.created).toHaveLength(0);
  });

  it("refuses NapCat-only actions", async () => {
    const docker = new RecordingDocker();
    const runtime = new SnowLumaRuntime({ docker, stateDirectory: await mkdtemp(join(tmpdir(), "snowluma-action-")) });
    await expect(runtime.apply("effect-1", { ...baseCommand, action: "refresh-login-qr" })).rejects.toThrow("not supported for SnowLuma");
  });

  it("stops and deletes owned containers without touching foreign images", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ownedContainer();
    const runtime = new SnowLumaRuntime({ docker, stateDirectory: await mkdtemp(join(tmpdir(), "snowluma-lifecycle-")) });
    await runtime.apply("effect-1", { ...baseCommand, action: "stop" });
    expect(docker.stopped).toEqual([`botroost-snowluma-${baseCommand.endpointId}`]);
    await runtime.apply("effect-2", { ...baseCommand, action: "delete", commandId: "cmd-2" });
    expect(docker.removes).toEqual([`botroost-snowluma-${baseCommand.endpointId}`]);
    expect(docker.hostStateRemovals).toEqual([{ root: expect.any(String), endpointId: baseCommand.endpointId, image: SNOWLUMA_IMAGE }]);
  });

  it("reads and redacts container logs for owned endpoints", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ownedContainer();
    const runtime = new SnowLumaRuntime({ docker, stateDirectory: await mkdtemp(join(tmpdir(), "snowluma-logs-")) });
    const result = await runtime.apply("effect-1", { ...baseCommand, action: "read-container-logs", metadata: { ...baseCommand.metadata, logTail: 100, logSinceSeconds: 600 } });
    const metadata = result.metadata as { logs: { text: string; tail: number } };
    expect(metadata.logs.text).toBe("log output");
    expect(metadata.logs.tail).toBe(100);
  });

  it("writes SnowLuma websocket configuration, preserves tokens and reloads the OneBot service", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ownedContainer();
    const stateDirectory = await mkdtemp(join(tmpdir(), "snowluma-ws-"));
    const configDirectory = join(stateDirectory, baseCommand.endpointId, "config", "config");
    await mkdir(configDirectory, { recursive: true });
    const configPath = join(configDirectory, "onebot_212499575.json");
    const seed = {
      networks: {
        httpServers: [{ name: "http-default", accessToken: "http-token", messageFormat: "array", reportSelfMessage: false, host: "0.0.0.0", port: 3000, path: "/" }],
        httpClients: [],
        wsServers: [{ name: "ws-default", accessToken: "RWDWbvtKpMqsbJNTVtDbbc70O9yDt2feket3Gr54_SY", messageFormat: "array", reportSelfMessage: false, host: "0.0.0.0", port: 3001, path: "/", role: "Universal" }],
        wsClients: [],
      },
    };
    await writeFile(configPath, JSON.stringify(seed, null, 2), "utf8");
    const runtime = new SnowLumaRuntime({ docker, stateDirectory, fetcher: oneBotFetcher(true) });
    const result = await runtime.apply("effect-1", {
      ...baseCommand,
      action: "update-onebot-websockets",
      metadata: {
        ...baseCommand.metadata,
        websocketClients: [{ name: "outbound", enable: true, url: "ws://example.com/ws", messagePostFormat: "string", reportSelfMessage: false, debug: false, heartInterval: 30000, reconnectInterval: 8000 }],
        websocketServers: [{ name: "ws-default", enable: true, host: "127.0.0.1", port: 4000, messagePostFormat: "string", reportSelfMessage: false, debug: false, heartInterval: 30000, enableForcePushEvent: true }],
      },
    });
    expect(docker.execCalls).toEqual([expect.arrayContaining(["supervisorctl", "restart", "snowluma"])]);
    const written = JSON.parse(await readFile(configPath, "utf8")) as { networks: { wsServers: { name: string; host: string; port: number; messageFormat: string; accessToken: string; path: string; role: string }[]; wsClients: { name: string; url: string; messageFormat: string; reconnectIntervalMs: number }[] } };
    expect(written.networks.wsServers[0]).toMatchObject({ name: "ws-default", host: "127.0.0.1", port: 4000, messageFormat: "string", accessToken: "RWDWbvtKpMqsbJNTVtDbbc70O9yDt2feket3Gr54_SY", path: "/", role: "Universal" });
    expect(written.networks.wsClients[0]).toMatchObject({ name: "outbound", url: "ws://example.com/ws", messageFormat: "string", reconnectIntervalMs: 8000 });
    const metadata = result.metadata as { onebot: { config: { websocketServers: { name: string; tokenConfigured: boolean }[] } } };
    expect(metadata.onebot.config.websocketServers[0]).toMatchObject({ name: "ws-default", tokenConfigured: true });
  });

  it("applies websocket configuration through the SnowLuma WebUI API without restarting the service", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ownedContainer();
    docker.logs = async () => "11:16:29 INFO [WebUI] initial credentials: user=admin password=webui-pass\n";
    const stateDirectory = await mkdtemp(join(tmpdir(), "snowluma-ws-webui-"));
    const configDirectory = join(stateDirectory, baseCommand.endpointId, "config", "config");
    await mkdir(configDirectory, { recursive: true });
    const configPath = join(configDirectory, "onebot_212499575.json");
    const seed = {
      networks: {
        httpServers: [{ name: "http-default", accessToken: "http-token", messageFormat: "array", reportSelfMessage: false, host: "0.0.0.0", port: 3000, path: "/" }],
        httpClients: [],
        wsServers: [{ name: "ws-default", accessToken: "server-token", messageFormat: "array", reportSelfMessage: false, host: "0.0.0.0", port: 3001, path: "/", role: "Universal" }],
        wsClients: [],
      },
    };
    await writeFile(configPath, JSON.stringify(seed, null, 2), "utf8");
    const webuiCalls: { url: string; init: RequestInit | undefined; body?: unknown }[] = [];
    const fetcher: FetchLike = async (url, init) => {
      const target = String(url);
      if (target.endsWith(":5099/api/login")) {
        webuiCalls.push({ url: target, init, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ token: "webui-token" }), { status: 200 });
      }
      if (target.endsWith(":5099/api/agreements")) {
        return new Response(JSON.stringify({ version: "agr-1", consentRequired: true, documents: [] }), { status: 200 });
      }
      if (target.endsWith(":5099/api/agreements/record-consent")) {
        webuiCalls.push({ url: target, init, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ success: true, version: "agr-1" }), { status: 200 });
      }
      if (target.endsWith(":5099/api/config/212499575")) {
        const method = init?.method ?? "GET";
        webuiCalls.push({ url: target, init, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify(method === "POST" ? { config: {} } : { config: seed }), { status: 200 });
      }
      return oneBotFetcher(true)(url, init);
    };
    const runtime = new SnowLumaRuntime({ docker, stateDirectory, fetcher });
    await runtime.apply("effect-1", {
      ...baseCommand,
      action: "update-onebot-websockets",
      metadata: {
        ...baseCommand.metadata,
        websocketClients: [],
        websocketServers: [{ name: "ws-default", enable: true, host: "127.0.0.1", port: 4000, messagePostFormat: "string", reportSelfMessage: false, debug: false, heartInterval: 30000, enableForcePushEvent: true }],
      },
    });
    // No supervisor restart: the WebUI applies the change live.
    expect(docker.execCalls).toEqual([]);
    expect(webuiCalls.map(call => new URL(call.url).pathname)).toEqual(["/api/login", "/api/agreements/record-consent", "/api/config/212499575", "/api/config/212499575"]);
    expect(webuiCalls[0]?.body).toEqual({ password: "webui-pass" });
    expect(webuiCalls[1]?.body).toEqual({ version: "agr-1" });
    expect((webuiCalls[1]?.init?.headers as Record<string, string>).authorization).toBe("Bearer webui-token");
    const saved = webuiCalls[3]?.body as { networks: { wsServers: { name: string; host: string; port: number; messageFormat: string; accessToken: string }[] } };
    expect(saved.networks.wsServers[0]).toMatchObject({ name: "ws-default", host: "127.0.0.1", port: 4000, messageFormat: "string", accessToken: "server-token" });
    // The host file is left for the WebUI to manage; the agent did not write it directly.
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(seed);
  });

  it("takes over the WebUI password on first apply so later changes hot-apply without a restart", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ownedContainer();
    docker.logs = async () => "initial credentials: user=admin password=banner-pass\n";
    const stateDirectory = await mkdtemp(join(tmpdir(), "snowluma-ws-takeover-"));
    const configDirectory = join(stateDirectory, baseCommand.endpointId, "config", "config");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "onebot_212499575.json"), JSON.stringify({ networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] } }), "utf8");
    const webuiCalls: string[] = [];
    const fetcher: FetchLike = async (url, init) => {
      const target = new URL(String(url));
      if (target.port === "5099") {
        if (target.pathname === "/api/login") return new Response(JSON.stringify({ token: "t", mustChangePassword: true }), { status: 200 });
        if (target.pathname === "/api/auth/change-password") {
          webuiCalls.push(`${target.pathname}:${String(init?.body)}:${(init?.headers as Record<string, string>).authorization}`);
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        if (target.pathname === "/api/agreements") return new Response(JSON.stringify({ version: "agr-1", consentRequired: false }), { status: 200 });
        if (target.pathname === "/api/config/212499575") return new Response(JSON.stringify({ config: { networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] } } }), { status: 200 });
      }
      return oneBotFetcher(true)(url, init);
    };
    const runtime = new SnowLumaRuntime({ docker, stateDirectory, fetcher });
    await runtime.apply("effect-1", {
      ...baseCommand,
      action: "update-onebot-websockets",
      metadata: { ...baseCommand.metadata, websocketClients: [], websocketServers: [] },
    });
    expect(docker.execCalls).toEqual([]);
    expect(webuiCalls).toHaveLength(1);
    expect(webuiCalls[0]).toContain("banner-pass");
    expect(webuiCalls[0]).toContain("Bearer t");
    const stored = JSON.parse(await readFile(join(stateDirectory, "snowluma-webui-credentials.json"), "utf8")) as { [endpointId: string]: { password: string } };
    const managed = stored[baseCommand.endpointId]?.password;
    expect(managed).toMatch(/^Bt![A-Za-z0-9_-]{16}$/);
    // The console now shows the managed password instead of the regenerating banner one.
    expect(webuiCalls[0]).toContain(managed!);
  });
});

describe("docker create arguments", () => {
  it("emits SnowLuma privileges and published ports when provided", () => {
    const args = dockerCreateArguments({
      name: "botroost-snowluma-x",
      image: SNOWLUMA_IMAGE,
      labels: {},
      mounts: [],
      hostConfig: { networkMode: "bridge", portBindings: {} },
      resources: { cpuMillis: 1000, memoryMiB: 1024, memorySwapMiB: 1536 },
      capAdd: ["SYS_PTRACE"],
      securityOpt: ["seccomp=unconfined"],
      shmBytes: 1024 * 1024 * 1024,
      publishedPorts: [{ hostPort: "6081", containerPort: "6081" }],
    });
    expect(args).toContain("--cap-add");
    expect(args).toEqual(expect.arrayContaining(["SYS_PTRACE", "seccomp=unconfined", "--shm-size", "1073741824", "-p", "6081:6081"]));
    expect(args.indexOf("--cap-add")).toBeGreaterThan(-1);
    expect(args.at(-1)).toBe(SNOWLUMA_IMAGE);
  });

  it("does not change arguments for providers that pass no extras (NapCat unchanged)", () => {
    const input = {
      name: "botroost-napcat-x",
      image: NAPCAT_IMAGE,
      labels: { "botroost.provider": "napcat" },
      environment: { NAPCAT_WEBUI_SECRET_KEY: "s" },
      mounts: [{ type: "bind" as const, source: "/qq", target: "/app/napcat/config" }],
      hostConfig: { networkMode: "bridge", portBindings: {} },
      resources: { cpuMillis: 1000, memoryMiB: 1024, memorySwapMiB: 1536 },
    };
    const args = dockerCreateArguments(input);
    expect(args).not.toContain("--cap-add");
    expect(args).not.toContain("--security-opt");
    expect(args).not.toContain("--shm-size");
    expect(args).not.toContain("-p");
    expect(args).toEqual([
      "create", "--name", "botroost-napcat-x", "--network", "bridge",
      "--memory", "1024m", "--memory-swap", "1536m", "--cpu-quota", "100000",
      "--label", "botroost.provider=napcat",
      "--env", "NAPCAT_WEBUI_SECRET_KEY=s",
      "--mount", "type=bind,src=/qq,dst=/app/napcat/config",
      NAPCAT_IMAGE,
    ]);
  });
});
