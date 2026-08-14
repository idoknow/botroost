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
    approvedArtifactId: "artifact:napcat:mlikiowa.napcat-docker.sha256.9254ec12af101576c5eeb4910847abd1d219297bc6d9a35c52511e12500f0f45",
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
  inspected: string[] = [];
  async inspect(name: string): Promise<DockerInspectResult | null> {
    this.inspected.push(name);
    return null;
  }
  async create(input: Parameters<DockerClient["create"]>[0]) {
    this.created.push(input);
    return { id: "container-id" };
  }
  async start(name: string) {
    this.started.push(name);
  }
  async stop(name: string) {
    this.stopped.push(name);
  }
  async restart(name: string) {
    this.restarted.push(name);
  }
  async exec(container: string, args: string[]) {
    this.execs.push({ container, args });
    return { stdout: "", stderr: "" };
  }
}

describe("NapCat runtime", () => {
  it("creates the pinned container with labels, persistent per-endpoint storage, and no host ports", async () => {
    const docker = new RecordingDocker();
    const root = await mkdtemp(join(tmpdir(), "botroost-napcat-"));
    const runtime = new NapCatRuntime({ docker, stateDirectory: root });

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
    const runtime = new NapCatRuntime({ docker, stateDirectory: local, hostStateDirectory: "/opt/botroost/agent-state/napcat" });
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
    });
    await expect(runtime.apply("runtime:bad-image", { ...baseCommand, metadata: { image: "mlikiowa/napcat-docker:latest" } })).rejects.toThrow(/image/);
    await expect(runtime.apply("runtime:bad-id", { ...baseCommand, endpointId: "../escape" })).rejects.toThrow(/endpoint/);
  });

  it("uses NapCat web auth and authenticated QR/status/probe requests", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ({
      id: "container-id",
      name: "botroost-napcat-33333333-3333-4333-8333-333333333333",
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
        if (String(url).endsWith("/api/QQLogin/GetQQLoginInfo")) return new Response(JSON.stringify({ code: 0, data: { uin: "12345", nickname: "Operator QQ" } }), { status: 200 });
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

  it("reports ongoing NapCat observations on later heartbeats", async () => {
    const docker = new RecordingDocker();
    docker.inspect = async () => ({ id: "container-id", name: "botroost-napcat-33333333-3333-4333-8333-333333333333", state: "running" as const, ipAddress: "172.18.0.10", labels: {} });
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
});
