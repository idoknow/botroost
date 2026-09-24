import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NAPCAT_IMAGE, NapCatRuntime, type DockerClient, type DockerInspectResult } from "../src/index.js";
import type { RuntimeCommand } from "@botroost/agent-protocol";

const baseCommand = (proxy: unknown): RuntimeCommand => ({
  commandId: "cmd-proxy-1",
  operationId: "op-proxy-1",
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
    configuration: { proxy },
  },
});

const ownedLabels = {
  "botroost.workspace_id": "11111111-1111-4111-8111-111111111111",
  "botroost.endpoint_id": "33333333-3333-4333-8333-333333333333",
  "botroost.provider": "napcat",
};

class RecordingDocker implements DockerClient {
  created: Parameters<DockerClient["create"]>[0][] = [];
  started: string[] = [];
  inspected: DockerInspectResult | null = null;
  async inspect(name: string): Promise<DockerInspectResult | null> { void name; return this.inspected; }
  async create(input: Parameters<DockerClient["create"]>[0]) { this.created.push(input); return { id: "container-id" }; }
  async remove(name: string) { void name; }
  async removeHostEndpoint(root: string, endpointId: string, image: string) { void root; void endpointId; void image; }
  async start(name: string) { this.started.push(name); }
  async stop(name: string) { void name; }
  async restart(name: string) { void name; }
  async exec(container: string, args: string[]) { void container; void args; return { stdout: "", stderr: "" }; }
  async logs(container: string, options: { tail: number; sinceSeconds: number }) { void container; void options; return ""; }
}

function runtime(docker: DockerClient, stateDirectory: string) {
  return new NapCatRuntime({
    docker,
    stateDirectory,
    hostStateDirectory: stateDirectory,
    napcatToken: "test-token",
    fetcher: (async () => new Response(JSON.stringify({ code: 0, data: { isLogin: false } }), { status: 200 })) as unknown as typeof fetch,
    qrPollAttempts: 1,
  });
}

describe("NapCat runtime proxy injection", () => {
  it("injects proxy environment variables into created endpoint containers", async () => {
    const docker = new RecordingDocker();
    const state = await mkdtemp(join(tmpdir(), "botroost-proxy-"));
    await runtime(docker, state).apply("effect-1", baseCommand({ protocol: "http", host: "10.0.0.1", port: 8080 }));
    expect(docker.created).toHaveLength(1);
    const env = docker.created[0]!.environment ?? {};
    expect(env.HTTP_PROXY).toBe("http://10.0.0.1:8080");
    expect(env.HTTPS_PROXY).toBe("http://10.0.0.1:8080");
    expect(env.NO_PROXY).toContain("127.0.0.1");
  });

  it("injects socks5 URLs with credentials from the configuration", async () => {
    const docker = new RecordingDocker();
    const state = await mkdtemp(join(tmpdir(), "botroost-proxy-"));
    await runtime(docker, state).apply("effect-2", baseCommand({ protocol: "socks5", host: "p.internal", port: 1080, username: "u", password: "pw" }));
    const env = docker.created[0]!.environment ?? {};
    expect(env.ALL_PROXY).toBe("socks5://u:pw@p.internal:1080");
  });

  it("recreates the running container when the proxy configuration drifts", async () => {
    const docker = new RecordingDocker();
    const state = await mkdtemp(join(tmpdir(), "botroost-proxy-"));
    docker.inspected = {
      id: "owned-id",
      name: "botroost-napcat-33333333-3333-4333-8333-333333333333",
      image: NAPCAT_IMAGE,
      state: "running",
      ipAddress: "172.18.0.10",
      labels: ownedLabels,
      proxyEnvironment: { HTTP_PROXY: "http://old-proxy:1", HTTPS_PROXY: "http://old-proxy:1", ALL_PROXY: "http://old-proxy:1" },
    };
    await runtime(docker, state).apply("effect-3", baseCommand({ protocol: "http", host: "10.0.0.9", port: 3128 }));
    expect(docker.created).toHaveLength(1);
    const env = docker.created[0]!.environment ?? {};
    expect(env.HTTP_PROXY).toBe("http://10.0.0.9:3128");
  });

  it("recreates the running container without proxy environment when the proxy is removed", async () => {
    const docker = new RecordingDocker();
    const state = await mkdtemp(join(tmpdir(), "botroost-proxy-"));
    docker.inspected = {
      id: "owned-id",
      name: "botroost-napcat-33333333-3333-4333-8333-333333333333",
      image: NAPCAT_IMAGE,
      state: "running",
      ipAddress: "172.18.0.10",
      labels: ownedLabels,
      proxyEnvironment: { HTTP_PROXY: "http://10.0.0.1:8080", HTTPS_PROXY: "http://10.0.0.1:8080", ALL_PROXY: "http://10.0.0.1:8080" },
    };
    await runtime(docker, state).apply("effect-4", baseCommand(null));
    expect(docker.created).toHaveLength(1);
    const env = docker.created[0]!.environment ?? {};
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.ALL_PROXY).toBeUndefined();
  });

  it("does not inject proxy environment when no proxy is configured", async () => {
    const docker = new RecordingDocker();
    const state = await mkdtemp(join(tmpdir(), "botroost-proxy-"));
    await runtime(docker, state).apply("effect-5", baseCommand(undefined));
    expect(docker.created).toHaveLength(1);
    const env = docker.created[0]!.environment ?? {};
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.NAPCAT_WEBUI_SECRET_KEY).toBe("test-token");
  });

  it("starts a container recreated by a proxy change dispatched via update-endpoint-proxy", async () => {
    const docker = new RecordingDocker();
    const state = await mkdtemp(join(tmpdir(), "botroost-proxy-"));
    docker.inspected = {
      id: "owned-id",
      name: "botroost-napcat-33333333-3333-4333-8333-333333333333",
      image: NAPCAT_IMAGE,
      state: "running",
      ipAddress: "172.18.0.10",
      labels: ownedLabels,
      proxyEnvironment: { HTTP_PROXY: "http://old:1", HTTPS_PROXY: "http://old:1", ALL_PROXY: "http://old:1" },
    };
    const command = { ...baseCommand({ protocol: "http", host: "10.0.0.5", port: 8080 }), action: "update-endpoint-proxy" as const };
    await runtime(docker, state).apply("effect-6", command);
    expect(docker.created).toHaveLength(1);
    expect((docker.created[0]!.environment ?? {}).HTTP_PROXY).toBe("http://10.0.0.5:8080");
    expect(docker.started).toEqual(["botroost-napcat-33333333-3333-4333-8333-333333333333"]);
  });

  it("does not boot a stopped endpoint when applying a proxy change; config applies on next start", async () => {
    const docker = new RecordingDocker();
    const state = await mkdtemp(join(tmpdir(), "botroost-proxy-"));
    docker.inspected = {
      id: "owned-id",
      name: "botroost-napcat-33333333-3333-4333-8333-333333333333",
      image: NAPCAT_IMAGE,
      state: "exited",
      ipAddress: null,
      labels: ownedLabels,
      proxyEnvironment: { HTTP_PROXY: "http://old:1", HTTPS_PROXY: "http://old:1", ALL_PROXY: "http://old:1" },
    };
    const command = { ...baseCommand({ protocol: "http", host: "10.0.0.5", port: 8080 }), action: "update-endpoint-proxy" as const, metadata: { ...baseCommand({ protocol: "http", host: "10.0.0.5", port: 8080 }).metadata, desiredState: { state: "stopped" } } };
    const result = await runtime(docker, state).apply("effect-7", command);
    expect(docker.created).toHaveLength(0);
    expect(docker.started).toHaveLength(0);
    expect(result.state).toBe("stopped");
  });
});
