import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DurableFakeAgent,
  FakeRuntime,
  NodeCredentialStore,
  type AgentCommandTransport,
} from "../src/index.js";

class MemoryTransport implements AgentCommandTransport {
  receipts: string[] = [];
  results: unknown[] = [];
  constructor(public command: Awaited<ReturnType<AgentCommandTransport["claim"]>>) {}
  async heartbeat() {
    return { connectionEpoch: 1 };
  }
  async claim() {
    const next = this.command;
    this.command = null;
    return next;
  }
  async receipt(commandId: string) {
    this.receipts.push(commandId);
  }
  async result(result: unknown) {
    this.results.push(result);
  }
}

const command = {
  commandId: "cmd-1",
  operationId: "op-1",
  workspaceId: "ws-1",
  nodeId: "node-1",
  endpointId: "endpoint-1",
  generation: 1,
  connectionEpoch: 1,
  action: "start" as const,
  runtimeRequest: {
    approvedArtifactId: "artifact:fake:v1",
    approvedEgressProfile: "egress:none",
    resources: { cpuMillis: 100, memoryMiB: 64 },
    storage: { kind: "ephemeral" as const, sizeMiB: 16 },
  },
  metadata: {},
};

describe("durable fake agent", () => {
  it("writes node credentials 0600 and enrolls only on first start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "botroost-agent-"));
    const store = new NodeCredentialStore(dir);

    expect(await store.read()).toBeNull();
    await store.write({ nodeId: "node-1", nodeSecret: "secret", workspaceId: "ws-1" });

    expect((await lstat(join(dir, "node-credential.json"))).mode & 0o777).toBe(0o600);
    expect(await store.read()).toEqual({
      nodeId: "node-1",
      nodeSecret: "secret",
      workspaceId: "ws-1",
    });
    expect(await readFile(join(dir, "node-credential.json"), "utf8")).not.toContain(
      "ENROLLMENT_TOKEN",
    );
  });

  it("rejects symlink and non-regular credential files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "botroost-agent-"));
    const target = join(dir, "target");
    await writeFile(target, "{}\n");
    await symlink(target, join(dir, "node-credential.json"));
    const symlinkStore = new NodeCredentialStore(dir);
    await expect(symlinkStore.read()).rejects.toThrow();
    await expect(symlinkStore.write({ nodeId: "n", nodeSecret: "s", workspaceId: "w" })).rejects.toThrow();

    const other = await mkdtemp(join(tmpdir(), "botroost-agent-"));
    await mkdir(join(other, "node-credential.json"));
    await expect(new NodeCredentialStore(other).read()).rejects.toThrow();
  });

  it("does not repeat fake runtime effects after duplicate claim or restart replay", async () => {
    const dir = await mkdtemp(join(tmpdir(), "botroost-agent-"));
    const runtime = new FakeRuntime();
    const firstTransport = new MemoryTransport(command);
    const first = await DurableFakeAgent.open({
      journalPath: join(dir, "agent-journal.jsonl"),
      runtime,
      transport: firstTransport,
    });

    await first.pollOnce();
    await first.close();

    expect(runtime.effectsFor("endpoint-1")).toEqual(["start"]);
    expect(firstTransport.receipts).toEqual(["cmd-1"]);
    expect(firstTransport.results).toHaveLength(1);

    const secondTransport = new MemoryTransport(command);
    const second = await DurableFakeAgent.open({
      journalPath: join(dir, "agent-journal.jsonl"),
      runtime,
      transport: secondTransport,
    });
    await second.pollOnce();
    await second.close();

    expect(runtime.effectsFor("endpoint-1")).toEqual(["start"]);
    expect(secondTransport.receipts).toEqual(["cmd-1"]);
    expect(secondTransport.results).toHaveLength(1);
  });

  it("replays a durable receipt after disconnect without repeating the effect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "botroost-agent-"));
    const runtime = new FakeRuntime();
    const failed = new MemoryTransport(command);
    failed.receipt = async () => { throw new Error("disconnected after durable receipt"); };
    const first = await DurableFakeAgent.open({ journalPath: join(dir, "journal"), runtime, transport: failed });
    await expect(first.pollOnce()).rejects.toThrow(/disconnected/);
    await first.close();

    const replay = new MemoryTransport(command);
    const second = await DurableFakeAgent.open({ journalPath: join(dir, "journal"), runtime, transport: replay });
    await second.pollOnce();
    await second.close();
    expect(replay.receipts).toEqual(["cmd-1"]);
    expect(runtime.effectsFor("endpoint-1")).toEqual(["start"]);
  });

  it("runs each endpoint serially while allowing independent endpoints", async () => {
    const runtime = new FakeRuntime();
    await Promise.all([
      runtime.apply({ ...command, commandId: "a", endpointId: "same", action: "start" }),
      runtime.apply({ ...command, commandId: "b", endpointId: "same", action: "restart" }),
      runtime.apply({ ...command, commandId: "c", endpointId: "other", action: "stop" }),
    ]);

    expect(runtime.effectsFor("same")).toEqual(["start", "restart"]);
    expect(runtime.effectsFor("other")).toEqual(["stop"]);
  });
});
