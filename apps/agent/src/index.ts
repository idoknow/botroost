import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { FileAgentJournal } from "@botroost/agent-journal";
import {
  AgentHeartbeatRequestSchema,
  RuntimeCommandSchema,
  type RuntimeCommand,
} from "@botroost/agent-protocol";

export interface NodeCredential {
  nodeId: string;
  nodeSecret: string;
  workspaceId: string;
}
export class NodeCredentialStore {
  readonly path: string;
  constructor(readonly directory: string) {
    this.path = join(directory, "node-credential.json");
  }
  async read(): Promise<NodeCredential | null> {
    try {
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        return JSON.parse(await file.readFile("utf8")) as NodeCredential;
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async write(credential: NodeCredential): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const existing = await lstat(this.path);
      if (!existing.isFile() || existing.isSymbolicLink())
        throw new Error("credential path must be a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(`${JSON.stringify(credential)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export interface AgentCommandTransport {
  heartbeat(): Promise<{ connectionEpoch: number }>;
  claim(): Promise<RuntimeCommand | null>;
  receipt(commandId: string, receipt: { operationId: string; generation: number; connectionEpoch: number }): Promise<void>;
  result(result: {
    commandId: string;
    operationId: string;
    endpointId: string;
    generation: number;
    connectionEpoch: number;
    outcome: "succeeded" | "failed" | "unknown";
    observations: {
      node: "online";
      runtime: "ready" | "stopped" | "failed" | "unknown";
      provider: "available" | "unavailable" | "unknown" | "degraded";
      protocol: "connected";
      convergence: "converged" | "failed" | "reconciling" | "unknown" | "conflicted";
    };
    error?: string;
  }): Promise<void>;
}

export class HttpAgentTransport implements AgentCommandTransport {
  constructor(
    private readonly controlPlaneUrl: string,
    private readonly nodeSecret: string,
  ) {}
  private async request<T>(path: string, payload: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.controlPlaneUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.nodeSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`control plane request failed: ${response.status}`);
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }
  heartbeat() {
    return this.request<{ connectionEpoch: number }>("/api/v1/agent/heartbeat", {
      status: "online",
      observedAt: new Date().toISOString(),
      runtimes: [],
    });
  }
  async claim() {
    const response = await this.request<{ command: unknown }>("/api/v1/agent/commands/claim", { limit: 1 });
    return response.command ? RuntimeCommandSchema.parse(response.command) : null;
  }
  async receipt(commandId: string, receipt: { operationId: string; generation: number; connectionEpoch: number }) {
    await this.request(`/api/v1/agent/commands/${encodeURIComponent(commandId)}/receipt`, receipt);
  }
  async result(result: Parameters<AgentCommandTransport["result"]>[0]) {
    const { commandId, ...payload } = result;
    await this.request(`/api/v1/agent/commands/${encodeURIComponent(commandId)}/result`, payload);
  }
}

export class FakeRuntime {
  private readonly endpointQueues = new Map<string, Promise<void>>();
  private readonly effects = new Map<string, string[]>();
  private readonly states = new Map<string, "running" | "stopped">();
  async apply(command: RuntimeCommand): Promise<{ state: "running" | "stopped" }> {
    let release!: () => void;
    const previous = this.endpointQueues.get(command.endpointId) ?? Promise.resolve();
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.endpointQueues.set(command.endpointId, previous.then(() => current));
    await previous;
    try {
      const list = this.effects.get(command.endpointId) ?? [];
      list.push(command.action);
      this.effects.set(command.endpointId, list);
      const state = command.action === "stop" ? "stopped" : "running";
      this.states.set(command.endpointId, state);
      return { state };
    } finally {
      release();
    }
  }
  effectsFor(endpointId: string) {
    return [...(this.effects.get(endpointId) ?? [])];
  }
}

export class DurableFakeAgent {
  private constructor(
    private readonly journal: FileAgentJournal,
    private readonly runtime: FakeRuntime,
    private readonly transport: AgentCommandTransport,
  ) {}
  static async open(options: {
    journalPath: string;
    runtime?: FakeRuntime;
    transport: AgentCommandTransport;
  }) {
    return new DurableFakeAgent(
      await FileAgentJournal.open(options.journalPath),
      options.runtime ?? new FakeRuntime(),
      options.transport,
    );
  }
  async pollOnce(): Promise<boolean> {
    await this.transport.heartbeat();
    const command = await this.transport.claim();
    if (!command) return false;
    const receipt = {
      operationId: command.operationId,
      generation: command.generation,
      connectionEpoch: command.connectionEpoch,
    };
    const existing = this.journal.get(command.commandId);
    if (!existing?.receipt) await this.journal.recordReceipt(command.commandId, receipt);
    await this.transport.receipt(command.commandId, receipt);
    let result = this.journal.get(command.commandId)?.result;
    if (!result) {
      if (!this.journal.get(command.commandId)?.effects.runtime)
        await this.journal.recordEffect(command.commandId, "runtime", await this.runtime.apply(command));
      result = {
        operationId: command.operationId,
        endpointId: command.endpointId,
        generation: command.generation,
        connectionEpoch: command.connectionEpoch,
        outcome: "succeeded",
        observations: {
          node: "online",
          runtime: command.action === "stop" ? "stopped" : "ready",
          provider: "available",
          protocol: "connected",
          convergence: "converged",
        },
      };
      await this.journal.recordResult(command.commandId, result);
    }
    const storedResult = {
      ...(result as Partial<Parameters<AgentCommandTransport["result"]>[0]>),
    };
    delete storedResult.commandId;
    await this.transport.result({
      commandId: command.commandId,
      ...(storedResult as Omit<Parameters<AgentCommandTransport["result"]>[0], "commandId">),
    });
    return true;
  }
  async close() {
    await this.journal.close();
  }
}

export async function enroll(controlPlaneUrl: string, token: string, provider = "fake"): Promise<NodeCredential> {
  const response = await fetch(new URL("/api/v1/agent/enroll", controlPlaneUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, provider, version: "botroost-agent" }),
  });
  if (!response.ok) throw new Error(`enrollment failed: ${response.status}`);
  return (await response.json()) as NodeCredential;
}

export async function startAgentFromEnv(): Promise<DurableFakeAgent> {
  const controlPlaneUrl = process.env.CONTROL_PLANE_URL;
  const nodeStateDir = process.env.NODE_STATE_DIR;
  if (!controlPlaneUrl || !nodeStateDir)
    throw new Error("CONTROL_PLANE_URL and NODE_STATE_DIR are required");
  const store = new NodeCredentialStore(nodeStateDir);
  let credential = await store.read();
  if (!credential) {
    const token = process.env.ENROLLMENT_TOKEN;
    if (!token) throw new Error("ENROLLMENT_TOKEN is required for first start");
    credential = await enroll(controlPlaneUrl, token);
    await store.write(credential);
  }
  return DurableFakeAgent.open({
    journalPath: join(nodeStateDir, "agent-journal.jsonl"),
    transport: new HttpAgentTransport(controlPlaneUrl, credential.nodeSecret),
  });
}

AgentHeartbeatRequestSchema.parse({
  status: "online",
  observedAt: new Date().toISOString(),
  runtimes: [],
});
