import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentHeartbeatRequestSchema, type RuntimeCommand } from "@botroost/agent-protocol";
import { NAPCAT_ARTIFACT, NAPCAT_IMAGE, NapCatRuntime, type DockerClient, type DockerInspectResult } from "../src/index.js";

import type { DockerStatsReader } from "../src/resource-usage.js";
const endpointIds = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
async function fixture() {
  const commands: RuntimeCommand[] = endpointIds.map((endpointId, i) => ({ commandId: `cmd-${i}`, operationId: `op-${i}`, workspaceId: "11111111-1111-4111-8111-111111111111", nodeId: "22222222-2222-4222-8222-222222222222", endpointId, generation: 1, connectionEpoch: 1, action: "start", runtimeRequest: { approvedArtifactId: NAPCAT_ARTIFACT, approvedEgressProfile: "egress:onebot", resources: { cpuMillis: 500, memoryMiB: 512 }, storage: { kind: "ephemeral", sizeMiB: 512 } }, metadata: { image: NAPCAT_IMAGE, containerPrefix: "botroost-napcat" } }));
  const containers = new Map<string, DockerInspectResult>(commands.map((command, i) => [`botroost-napcat-${command.endpointId}`, { id: `container-${i}`, name: `botroost-napcat-${command.endpointId}`, image: NAPCAT_IMAGE, state: "running", ipAddress: `172.18.0.${10+i}`, labels: { "botroost.workspace_id": command.workspaceId, "botroost.endpoint_id": command.endpointId, "botroost.provider": "napcat" }, resourceLimits: { cpuLimitMillis: 1500, memoryLimitBytes: 123456789 } }]));
  const stats = vi.fn<DockerStatsReader>(async () => new Map([["container-0", { cpuPercent: 125.5, memoryBytes: 100000000 }], ["container-1", { cpuPercent: 0, memoryBytes: 0 }]]));
  const docker: DockerClient = { inspect: vi.fn(async name => containers.get(name) ?? null), stats, create: vi.fn(async () => ({ id: "must-not-create" })), start: vi.fn(), stop: vi.fn(), restart: vi.fn(), remove: vi.fn(), removeHostEndpoint: vi.fn(), exec: vi.fn(), logs: vi.fn(async () => "") };
  const root = await mkdtemp(join(tmpdir(), "botroost-resource-observations-"));
  await writeFile(join(root, "runtime-commands.json"), JSON.stringify(commands));
  const fetcher = vi.fn(async url => { const path = new URL(String(url)).pathname; if (path === "/api/auth/login") return Response.json({ code: 0, data: { Credential: "private-token" } }); if (path === "/api/QQLogin/GetQQLoginInfo") return Response.json({ code: 0, data: { online: false } }); if (path === "/api/QQLogin/GetQQLoginQrcode") return Response.json({ code: 0, data: { qrcode: "qr" } }); throw new Error(`unexpected ${path}`); });
  const runtime = new NapCatRuntime({ docker, stateDirectory: root, napcatToken: "private-token", fetcher: fetcher as unknown as typeof fetch });
  return { runtime, docker, stats, containers, fetcher };
}
afterEach(() => vi.restoreAllMocks());
it("serializes real stats with actual limits in observations independently of health-cache freshness", async () => {
  const f = await fixture(); let now = Date.parse("2026-09-05T00:00:00Z"); vi.spyOn(Date, "now").mockImplementation(() => now);
  const first = await f.runtime.observations();
  expect(f.stats).toHaveBeenCalledTimes(1); expect(f.stats.mock.calls[0]?.[0]).toEqual(["container-0", "container-1"]);
  expect(first[0]).toMatchObject({ runtime: "ready", provider: "available", metadata: { resourceUsage: { source: "docker.stats", status: "ok", observedAt: "2026-09-05T00:00:00.000Z", cpuPercent: 125.5, memoryBytes: 100000000, cpuLimitMillis: 1500, memoryLimitBytes: 123456789 } } });
  const wire = AgentHeartbeatRequestSchema.parse(JSON.parse(JSON.stringify({ sessionId: "session", status: "online", observedAt: new Date(now).toISOString(), runtimes: first })));
  expect(wire.runtimes?.[0]?.metadata?.resourceUsage).toEqual(first[0]?.metadata?.resourceUsage);
  const calls = f.fetcher.mock.calls.length;
  now += 1000;
  expect((await f.runtime.observations())[0]?.metadata?.resourceUsage).toEqual(first[0]?.metadata?.resourceUsage);
  expect(f.stats).toHaveBeenCalledTimes(1);
  now += 4000;
  expect((await f.runtime.observations())[0]?.metadata?.resourceUsage).toMatchObject({ observedAt: "2026-09-05T00:00:05.000Z" });
  expect(f.stats).toHaveBeenCalledTimes(2); expect(f.fetcher).toHaveBeenCalledTimes(calls);
  for (const action of [f.docker.create, f.docker.start, f.docker.stop, f.docker.restart, f.docker.remove]) expect(action).not.toHaveBeenCalled();
});
it("keeps healthy observations on stats errors and makes stopped/foreign/missing containers unsampled", async () => {
  const f = await fixture(); f.stats.mockRejectedValue(new Error("daemon private-token details"));
  expect((await f.runtime.observations())[0]).toMatchObject({ runtime: "ready", provider: "available", metadata: { resourceUsage: { status: "unavailable", cpuPercent: null, memoryBytes: null, observedAt: null, cpuLimitMillis: 1500, memoryLimitBytes: 123456789 } } });
  const stopped = f.containers.get(`botroost-napcat-${endpointIds[0]}`)!; stopped.state = "exited";
  const foreign = f.containers.get(`botroost-napcat-${endpointIds[1]}`)!; foreign.labels = {};
  f.stats.mockClear();
  const observations = await f.runtime.observations();
  expect(observations[0]).toMatchObject({ runtime: "stopped", metadata: { resourceUsage: { status: "stopped", observedAt: null, cpuPercent: null, memoryBytes: null, cpuLimitMillis: 1500 } } });
  expect(observations[1]).toMatchObject({ runtime: "failed", metadata: { resourceUsage: { status: "unavailable", cpuLimitMillis: null, memoryLimitBytes: null } } });
  expect(f.stats).not.toHaveBeenCalled(); expect(JSON.stringify(observations)).not.toContain("private-token");
  f.containers.clear();
  expect((await f.runtime.observations())[0]?.metadata?.resourceUsage).toMatchObject({ status: "unavailable", cpuPercent: null, observedAt: null });
});
it("isolates one endpoint inspection failure from other health and usage observations", async () => {
  const f = await fixture(); await f.runtime.observations();
  vi.mocked(f.docker.inspect).mockImplementation(async name => { if (name.endsWith(endpointIds[0]!)) throw new Error("inspection failed"); return f.containers.get(name) ?? null; });
  const observations = await f.runtime.observations();
  expect(observations[0]).toMatchObject({ runtime: "failed", metadata: { resourceUsage: { status: "unavailable", observedAt: null } } });
  expect(observations[1]).toMatchObject({ runtime: "ready", metadata: { resourceUsage: { status: "ok", cpuPercent: 0, memoryBytes: 0 } } });
});
