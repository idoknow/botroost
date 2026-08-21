import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { FileAgentJournal } from "@botroost/agent-journal";
import {
  AgentHeartbeatRequestSchema,
  RuntimeCommandSchema,
  type CommandResultRequest,
  type RuntimeCommand,
} from "@botroost/agent-protocol";
import { NapCatTrafficAccumulator } from "./traffic.js";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

type OneBotReadAction = "get_status" | "get_login_info" | "get_friend_list" | "get_group_list" | "get_version_info";
type OneBotProbe = { ok: boolean; durationMs: number; error: string | null };

function rejectedOneBotProbe(reason: unknown): OneBotProbe {
  const withProbe = reason as { probe?: OneBotProbe } | undefined;
  return withProbe?.probe ?? { ok: false, durationMs: 0, error: reason instanceof Error ? reason.message : String(reason) };
}

function oneBotActionData(response: JsonObject): JsonValue {
  const nested = response.data;
  const envelope = nested !== null && typeof nested === "object" && !Array.isArray(nested)
    && ("retcode" in nested || "status" in nested)
    ? nested as JsonObject
    : response;
  if (envelope.status !== "ok" || envelope.retcode !== 0) {
    const message = typeof envelope.message === "string" && envelope.message ? envelope.message : "OneBot action failed";
    throw new Error(`${message} (retcode ${String(envelope.retcode ?? "unknown")})`);
  }
  return envelope.data ?? null;
}

const execFileAsync = promisify(execFile);
export const NAPCAT_IMAGE =
  "mlikiowa/napcat-docker@sha256:1336a777f9a4f1f8cb89fef42f7548deacd3645919a067a50df5b66b5e77390e";
export const NAPCAT_ARTIFACT =
  "artifact:napcat:mlikiowa.napcat-docker.sha256.1336a777f9a4f1f8cb89fef42f7548deacd3645919a067a50df5b66b5e77390e";
const endpointIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const containerPrefixPattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

export interface DockerCreateInput {
  name: string;
  image: string;
  labels: Record<string, string>;
  environment?: Record<string, string>;
  mounts: { type: "bind"; source: string; target: string }[];
  hostConfig: { networkMode: string; portBindings: Record<string, never> };
  resources: { cpuMillis: number; memoryMiB: number };
}
export interface DockerInspectResult {
  id: string;
  name: string;
  image: string;
  state: "created" | "running" | "exited" | "unknown";
  ipAddress: string | null;
  labels: Record<string, string>;
}
export interface DockerClient {
  inspect(name: string): Promise<DockerInspectResult | null>;
  create(input: DockerCreateInput): Promise<{ id: string }>;
  remove(name: string): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  exec(container: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
  logs(container: string, options: { tail: number; sinceSeconds: number; timestamps?: boolean }): Promise<string>;
}

export class DockerCliClient implements DockerClient {
  private async docker(args: string[]) {
    const { stdout, stderr } = await execFileAsync("docker", args, { timeout: 30_000, maxBuffer: 1024 * 1024 });
    return { stdout: String(stdout), stderr: String(stderr) };
  }
  async inspect(name: string): Promise<DockerInspectResult | null> {
    try {
      const { stdout } = await this.docker(["inspect", name]);
      const item = (JSON.parse(stdout) as Record<string, unknown>[])[0];
      if (!item) return null;
      const state = item.State as Record<string, unknown> | undefined;
      const settings = item.NetworkSettings as Record<string, unknown> | undefined;
      const networks = settings?.Networks as Record<string, { IPAddress?: string }> | undefined;
      const ipAddress = Object.values(networks ?? {})[0]?.IPAddress ?? null;
      return {
        id: String(item.Id),
        name: String(item.Name).replace(/^\//, ""),
        image: String((item.Config as Record<string, unknown> | undefined)?.Image ?? ""),
        state: state?.Running ? "running" : "exited",
        ipAddress,
        labels: ((item.Config as Record<string, unknown> | undefined)?.Labels as Record<string, string> | undefined) ?? {},
      };
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      if (String(stderr).includes("No such object")) return null;
      throw error;
    }
  }
  async create(input: DockerCreateInput) {
    const args = [
      "create",
      "--name", input.name,
      "--network", input.hostConfig.networkMode,
      "--memory", `${input.resources.memoryMiB}m`,
      "--cpu-quota", String(input.resources.cpuMillis * 100),
    ];
    for (const [key, value] of Object.entries(input.labels)) args.push("--label", `${key}=${value}`);
    for (const [key, value] of Object.entries(input.environment ?? {})) args.push("--env", `${key}=${value}`);
    for (const mount of input.mounts) args.push("--mount", `type=bind,src=${mount.source},dst=${mount.target}`);
    args.push(input.image);
    const { stdout } = await this.docker(args);
    return { id: stdout.trim() };
  }
  async remove(name: string) { await this.docker(["rm", "-f", name]); }
  async start(name: string) { await this.docker(["start", name]); }
  async stop(name: string) { await this.docker(["stop", "--time", "20", name]); }
  async restart(name: string) { await this.docker(["restart", "--time", "20", name]); }
  async exec(container: string, args: string[]) { return this.docker(["exec", container, ...args]); }
  async logs(container: string, options: { tail: number; sinceSeconds: number; timestamps?: boolean }) {
    const { stdout, stderr } = await this.docker(["logs","--tail",String(options.tail),"--since",`${options.sinceSeconds}s`,...(options.timestamps?["--timestamps"]:[]),container]);
    return `${stdout}${stderr}`.slice(-1024 * 1024);
  }
}

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
  heartbeat(runtimes?: {
    endpointId: string;
    generation: number;
    runtime: "ready" | "stopped" | "failed" | "unknown";
    provider: "available" | "unavailable" | "unknown" | "degraded";
    protocol: "connected" | "disconnected" | "connecting" | "unknown";
    convergence: "converged" | "failed" | "reconciling" | "unknown" | "conflicted";
    metadata?: JsonObject;
  }[]): Promise<{ connectionEpoch: number }>;
  claim(): Promise<RuntimeCommand | null>;
  receipt(commandId: string, receipt: { operationId: string; generation: number; connectionEpoch: number }): Promise<void>;
  result(result: Omit<CommandResultRequest, "sessionId"> & { commandId: string }): Promise<void>;
}

export class HttpAgentTransport implements AgentCommandTransport {
  private readonly sessionId=crypto.randomUUID();
  constructor(
    private readonly controlPlaneUrl: string,
    private readonly nodeSecret: string,
    private readonly options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ) {}
  private async request<T>(path: string, payload: unknown): Promise<T> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15_000);
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout;
    const response = await fetch(new URL(path, this.controlPlaneUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.nodeSecret}`,
        "content-type": "application/json",
        "x-agent-session-id": this.sessionId,
      },
      body: JSON.stringify(payload),
      signal,
    });
    if (!response.ok) throw new Error(`control plane request failed: ${response.status}`);
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }
  heartbeat(runtimes: Parameters<AgentCommandTransport["heartbeat"]>[0] = []) {
    return this.request<{ connectionEpoch: number }>("/api/v1/agent/heartbeat", {
      status: "online",
      sessionId:this.sessionId,
      observedAt: new Date().toISOString(),
      runtimes,
    });
  }
  async claim() {
    const response = await this.request<{ command: unknown }>("/api/v1/agent/commands/claim", { limit: 1 });
    return response.command ? RuntimeCommandSchema.parse(response.command) : null;
  }
  async receipt(commandId: string, receipt: { operationId: string; generation: number; connectionEpoch: number }) {
    await this.request(`/api/v1/agent/commands/${encodeURIComponent(commandId)}/receipt`, { ...receipt, sessionId: this.sessionId });
  }
  async result(result: Parameters<AgentCommandTransport["result"]>[0]) {
    const { commandId, ...body } = result;
    const payload = { ...body, sessionId: this.sessionId };
    await this.request(`/api/v1/agent/commands/${encodeURIComponent(commandId)}/result`, payload);
  }
}

export class FakeRuntime {
  private readonly endpointQueues = new Map<string, Promise<void>>();
  private readonly effects = new Map<string, string[]>();
  private readonly states = new Map<string, "running" | "stopped">();
  private readonly effectRecords = new Map<string,{status:"applied";endpointId:string;action:string;state:"running"|"stopped"}>();
  constructor(private readonly statePath?: string) {}
  static async open(statePath: string) {
    const runtime = new FakeRuntime(statePath);
    try {
      const state = JSON.parse(await readFile(statePath, "utf8")) as {effects:Record<string,{status:"applied";endpointId:string;action:string;state:"running"|"stopped"}>};
      for (const [effectId, effect] of Object.entries(state.effects ?? {})) {
        runtime.effectRecords.set(effectId, effect);
        runtime.effects.set(effect.endpointId, [...(runtime.effects.get(effect.endpointId) ?? []), effect.action]);
        runtime.states.set(effect.endpointId, effect.state);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return runtime;
  }
  private async persist() {
    if (!this.statePath) return;
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({effects:Object.fromEntries(this.effectRecords)})}\n`, {mode:0o600});
    await rename(temporary, this.statePath);
  }
  async apply(effectOrCommand: string | RuntimeCommand, maybeCommand?: RuntimeCommand): Promise<{ state: "running" | "stopped" }> {
    const command = typeof effectOrCommand === "string" ? maybeCommand! : effectOrCommand;
    const effectId = typeof effectOrCommand === "string" ? effectOrCommand : `runtime:${command.commandId}`;
    const existing = this.effectRecords.get(effectId);
    if (existing) return { state: existing.state };
    let release!: () => void;
    const previous = this.endpointQueues.get(command.endpointId) ?? Promise.resolve();
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.endpointQueues.set(command.endpointId, previous.then(() => current));
    await previous;
    try {
      const replay = this.effectRecords.get(effectId);
      if (replay) return { state: replay.state };
      const list = this.effects.get(command.endpointId) ?? [];
      list.push(command.action);
      this.effects.set(command.endpointId, list);
      const state = command.action === "stop" ? "stopped" : "running";
      this.states.set(command.endpointId, state);
      this.effectRecords.set(effectId,{status:"applied",endpointId:command.endpointId,action:command.action,state});
      await this.persist();
      return { state };
    } finally {
      release();
    }
  }
  effectsFor(endpointId: string) {
    return [...(this.effects.get(endpointId) ?? [])];
  }
}

export class NapCatRuntime {
  private readonly networkMode: string;
  private readonly containerPrefix: string;
  private readonly fetcher: typeof fetch;
  private readonly commands = new Map<string, RuntimeCommand>();
  private readonly snapshotCache = new Map<string, { at: number; value: Awaited<ReturnType<NapCatRuntime["snapshot"]>> }>();
  private readonly directoryCache = new Map<string, {
    at: number;
    friends: { items: JsonObject[]; count: number; truncated: boolean; observedAt: string | null; probe: OneBotProbe };
    groups: { items: JsonObject[]; count: number; truncated: boolean; observedAt: string | null; probe: OneBotProbe };
  }>();
  private readonly webCredentials = new Map<string, string>();
  private readonly trafficAccumulators = new Map<string, NapCatTrafficAccumulator>();
  private readonly trafficCache = new Map<string, { at: number; summary: JsonObject }>();
  private commandsLoaded = false;
  constructor(private readonly options: {
    docker?: DockerClient;
    stateDirectory: string;
    hostStateDirectory?: string;
    containerPrefix?: string;
    networkMode?: string;
    napcatToken?: string;
    fetcher?: typeof fetch;
    qrPollIntervalMs?: number;
    qrPollAttempts?: number;
    directoryRefreshMs?: number;
  }) {
    this.networkMode = options.networkMode ?? process.env.NAPCAT_DOCKER_NETWORK ?? "bridge";
    this.containerPrefix = options.containerPrefix ?? "botroost-napcat";
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(this.networkMode) || this.networkMode === "host" || this.networkMode.startsWith("container:")) throw new Error("NapCat docker network is invalid");
    if (!containerPrefixPattern.test(this.containerPrefix)) throw new Error("container prefix is invalid");
    if (!(options.napcatToken ?? process.env.NAPCAT_TOKEN)) throw new Error("NapCat token is required");
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }
  private docker() { return this.options.docker ?? new DockerCliClient(); }
  private commandStatePath() { return join(this.options.stateDirectory, "runtime-commands.json"); }
  private async loadCommands() {
    if (this.commandsLoaded) return;
    this.commandsLoaded = true;
    try {
      const stored = JSON.parse(await readFile(this.commandStatePath(), "utf8")) as unknown[];
      for (const value of stored) { const command = RuntimeCommandSchema.parse(value); this.commands.set(command.endpointId, command); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private async persistCommands() {
    await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${this.commandStatePath()}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify([...this.commands.values()])}\n`, { mode: 0o600 });
    await rename(temporary, this.commandStatePath());
  }
  private endpointDirectory(endpointId: string, child: "qq" | "config") {
    if (!endpointIdPattern.test(endpointId)) throw new Error("endpoint identifier is invalid");
    const root = resolve(this.options.stateDirectory);
    const path = resolve(root, endpointId, child);
    if (!path.startsWith(`${root}${sep}`)) throw new Error("endpoint storage path is invalid");
    return path;
  }
  private hostEndpointDirectory(endpointId: string, child: "qq" | "config") {
    if (!endpointIdPattern.test(endpointId)) throw new Error("endpoint identifier is invalid");
    const root = resolve(this.options.hostStateDirectory ?? this.options.stateDirectory);
    const path = resolve(root, endpointId, child);
    if (!path.startsWith(`${root}${sep}`)) throw new Error("endpoint storage path is invalid");
    return path;
  }
  private containerName(endpointId: string) {
    if (!endpointIdPattern.test(endpointId)) throw new Error("endpoint identifier is invalid");
    return `${this.containerPrefix}-${endpointId}`;
  }
  private assertAllowed(command: RuntimeCommand) {
    const image = typeof command.metadata.image === "string" ? command.metadata.image : NAPCAT_IMAGE;
    if (image !== NAPCAT_IMAGE || command.runtimeRequest.approvedArtifactId !== NAPCAT_ARTIFACT)
      throw new Error("NapCat image is not allowlisted");
  }
  private redactLogs(text:string){return text
    .replace(/([?&](?:token|password|secret|key)=)[^&\s]+/gi,"$1[REDACTED]")
    .replace(/((?:authorization|cookie)\s*:\s*)(?:bearer\s+)?[^\r\n]+/gi,"$1[REDACTED]")
    .replace(/((?:token|password|secret|key|credential|session)\s*[=:]\s*)["']?[^\s,"'}]+["']?/gi,"$1[REDACTED]")
    .replace(/("(?:token|password|secret|key|credential|session)"\s*:\s*")[^"]*(")/gi,"$1[REDACTED]$2")
  }
  private async waitForQr(base:URL,endpointId:string,credential:string){let last:Error|undefined;const attempts=this.options.qrPollAttempts??20;for(let attempt=0;attempt<attempts;attempt++){try{return await this.napcatRequest(base,"/api/QQLogin/GetQQLoginQrcode",credential,{},endpointId)}catch(error){last=error instanceof Error?error:new Error(String(error));if(!last.message.includes("QRCode Get Error"))throw last;if(attempt+1<attempts)await new Promise(resolve=>setTimeout(resolve,this.options.qrPollIntervalMs??500))}}throw new Error(`NapCat login kernel not ready: ${last?.message??"QR unavailable"}`)}
  async apply(_effectId: string, command: RuntimeCommand): Promise<{ state: "running" | "stopped"; observations?: Parameters<AgentCommandTransport["result"]>[0]["observations"]; metadata?: JsonObject }> {
    this.assertAllowed(command);
    await this.loadCommands();
    this.commands.set(command.endpointId, command);
    await this.persistCommands();
    const name = this.containerName(command.endpointId);
    const docker = this.docker();
    const desiredImage = typeof command.metadata.image === "string" ? command.metadata.image : NAPCAT_IMAGE;
    const existing = await docker.inspect(name);
    if(command.action==="read-container-logs"){
      if(!existing||existing.labels["botroost.workspace_id"]!==command.workspaceId||existing.labels["botroost.endpoint_id"]!==command.endpointId||existing.labels["botroost.provider"]!=="napcat")throw new Error("NapCat container ownership check failed");
      const tail=Number(command.metadata.logTail),sinceSeconds=Number(command.metadata.logSinceSeconds);
      if(!Number.isInteger(tail)||tail<1||tail>1000||!Number.isInteger(sinceSeconds)||sinceSeconds<60||sinceSeconds>86400)throw new Error("NapCat log bounds are invalid");
      const text=this.redactLogs(await docker.logs(name,{tail,sinceSeconds}));
      return{state:existing.state==="running"?"running":"stopped",metadata:{logs:{text,tail,sinceSeconds}}};
    }
    if(command.action==="update-onebot-websockets"){
      if(!existing?.ipAddress||existing.state!=="running"||existing.labels["botroost.workspace_id"]!==command.workspaceId||existing.labels["botroost.endpoint_id"]!==command.endpointId||existing.labels["botroost.provider"]!=="napcat")throw new Error("NapCat container ownership check failed");
      const clients=command.metadata.websocketClients,servers=command.metadata.websocketServers;
      if(!Array.isArray(clients)||clients.length>20||!Array.isArray(servers)||servers.length>20)throw new Error("OneBot websocket configuration is invalid");
      const base=new URL(`http://${existing.ipAddress}:6099`),credential=await this.webCredential(command.endpointId,base);
      const current=await this.napcatRequest(base,"/api/OB11Config/GetConfig",credential,{},command.endpointId);
      const config=current.data!==null&&typeof current.data==="object"&&!Array.isArray(current.data)?current.data as Record<string,unknown>:{};
      const network=config.network!==null&&typeof config.network==="object"&&!Array.isArray(config.network)?config.network as Record<string,unknown>:{};
      const preserveTokens=(next:unknown[],previous:unknown)=>next.map(item=>{if(item===null||typeof item!=="object"||Array.isArray(item))throw new Error("OneBot websocket entry is invalid");const value=item as Record<string,unknown>;const old=Array.isArray(previous)?previous.find(entry=>entry!==null&&typeof entry==="object"&&!Array.isArray(entry)&&(entry as Record<string,unknown>).name===value.name) as Record<string,unknown>|undefined:undefined;return{...value,token:typeof value.token==="string"?value.token:typeof old?.token==="string"?old.token:""}});
      const merged={...config,network:{...network,websocketClients:preserveTokens(clients,network.websocketClients),websocketServers:preserveTokens(servers,network.websocketServers)}};
      await this.napcatRequest(base,"/api/OB11Config/SetConfig",await this.webCredential(command.endpointId,base),{config:JSON.stringify(merged)},command.endpointId);
      this.snapshotCache.delete(command.endpointId);
      const snapshot=await this.snapshot(command);
      return{state:"running",observations:{node:"online",runtime:snapshot.runtime,provider:snapshot.provider,protocol:snapshot.protocol,convergence:snapshot.convergence},metadata:snapshot.metadata};
    }
    if (command.action !== "stop" && (!existing || existing.image !== desiredImage)) {
      if (existing) await docker.remove(name);
      const qq = this.endpointDirectory(command.endpointId, "qq");
      const config = this.endpointDirectory(command.endpointId, "config");
      const hostQq = this.hostEndpointDirectory(command.endpointId, "qq");
      const hostConfig = this.hostEndpointDirectory(command.endpointId, "config");
      await mkdir(qq, { recursive: true, mode: 0o700 });
      await mkdir(config, { recursive: true, mode: 0o700 });
      await docker.create({
        name,
        image: NAPCAT_IMAGE,
        labels: {
          "botroost.provider": "napcat",
          "botroost.workspace_id": command.workspaceId,
          "botroost.endpoint_id": command.endpointId,
          "botroost.generation": String(command.generation),
        },
        environment: { NAPCAT_WEBUI_SECRET_KEY: this.options.napcatToken ?? process.env.NAPCAT_TOKEN ?? "" },
        mounts: [
          { type: "bind", source: hostQq, target: "/app/.config/QQ" },
          { type: "bind", source: hostConfig, target: "/app/napcat/config" },
        ],
        hostConfig: { networkMode: this.networkMode, portBindings: {} },
        resources: command.runtimeRequest.resources,
      });
    }
    if (command.action === "stop" && existing) await docker.stop(name);
    else if (command.action === "restart") { this.webCredentials.delete(command.endpointId); await docker.restart(name); }
    else if (command.action === "start") await docker.start(name);
    if (command.action === "refresh-login-qr") {
      if (!existing?.ipAddress) throw new Error("NapCat container is not available for QR refresh");
      const base=new URL(`http://${existing.ipAddress}:6099`);
      const credential=await this.webCredential(command.endpointId,base);
      await this.napcatRequest(base,"/api/QQLogin/RefreshQRcode",credential,{},command.endpointId);
      this.snapshotCache.delete(command.endpointId);
    }
    const snapshot = await this.snapshot(command).catch(error => ({ endpointId:command.endpointId,generation:command.generation,runtime:"unknown" as const,provider:"degraded" as const,protocol:"disconnected" as const,convergence:"reconciling" as const,metadata:{error:error instanceof Error?error.message:String(error)} }));
    const running = command.action !== "stop";
    return {
      state: running ? "running" : "stopped",
      observations: {
        node: "online",
        runtime: snapshot.runtime,
        provider: snapshot.provider,
        protocol: snapshot.protocol,
        convergence: snapshot.convergence,
      }, metadata: snapshot.metadata,
    };
  }
  private async napcatRequest(base: URL, path: string, webToken: string, body?: unknown, endpointId?: string, timeoutMs = 10_000) {
    const request = (token: string) => this.fetcher(new URL(path, base), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let response = await request(webToken);
    if (response.status === 401 && endpointId) {
      const current = this.webCredentials.get(endpointId);
      if (current && current !== webToken) response = await request(current);
      if (response.status === 401) {
        this.webCredentials.delete(endpointId);
        response = await request(await this.webCredential(endpointId, base));
      }
    }
    if (!response.ok) throw new Error(`NapCat request failed: ${response.status}`);
    let payload = await response.json() as JsonObject;
    if (typeof payload.code === "number" && payload.code !== 0 && endpointId && String(payload.message ?? "").toLowerCase().includes("unauthorized")) {
      const current = this.webCredentials.get(endpointId);
      if (current === webToken) this.webCredentials.delete(endpointId);
      response = await request(current && current !== webToken ? current : await this.webCredential(endpointId, base));
      if (!response.ok) throw new Error(`NapCat request failed: ${response.status}`);
      payload = await response.json() as JsonObject;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(`NapCat request rejected: ${String(payload.message ?? payload.code)}`);
    return payload;
  }
  private async callOneBot(base: URL, adapterName: string, webToken: string, endpointId: string, action: OneBotReadAction, timeoutMs = 10_000) {
    const started = Date.now();
    try {
      const response = await this.napcatRequest(base, `/api/Debug/call/${encodeURIComponent(adapterName)}`, webToken, { action, params: {} }, endpointId, timeoutMs);
      return { data: oneBotActionData(response), probe: { ok: true, durationMs: Date.now() - started, error: null } satisfies OneBotProbe };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(message), { probe: { ok: false, durationMs: Date.now() - started, error: message } satisfies OneBotProbe });
    }
  }
  private async webCredential(endpointId: string, base: URL) {
    const cached=this.webCredentials.get(endpointId);
    if(cached)return cached;
    const loginToken=(this.options.napcatToken??process.env.NAPCAT_TOKEN??"").trim();
    const hashed=createHash("sha256").update(`${loginToken}.napcat`).digest("hex");
    const auth=await this.fetcher(new URL("/api/auth/login",base),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({hash:hashed}),signal:AbortSignal.timeout(10_000)});
    if(!auth.ok)throw new Error(`NapCat auth failed: ${auth.status}`);
    const authBody=await auth.json() as JsonObject;
    if(typeof authBody.code==="number"&&authBody.code!==0)throw new Error(`NapCat auth rejected: ${String(authBody.message??authBody.code)}`);
    const authData=authBody.data;
    const credential=authData!==null&&typeof authData==="object"&&!Array.isArray(authData)?authData.Credential:undefined;
    if(typeof credential!=="string"||!credential)throw new Error("NapCat auth token missing");
    this.webCredentials.set(endpointId,credential);
    return credential;
  }
  private async protocolTraffic(endpointId: string): Promise<JsonObject> {
    const now = Date.now();
    const cached = this.trafficCache.get(endpointId);
    if (cached && now - cached.at < 5_000) return cached.summary;
    let accumulator = this.trafficAccumulators.get(endpointId);
    if (!accumulator) {
      accumulator = new NapCatTrafficAccumulator();
      this.trafficAccumulators.set(endpointId, accumulator);
    }
    let status: "ok" | "unavailable" = "ok";
    try {
      const logs = await this.docker().logs(this.containerName(endpointId), { tail: 500, sinceSeconds: 15, timestamps: true });
      accumulator.ingest(logs.split(/\r?\n/), now);
    } catch {
      status = "unavailable";
    }
    const summary = {
      ...accumulator.summary(now),
      status,
      sampleIntervalSeconds: 5,
      ...(status === "unavailable" ? { error: "Container log telemetry unavailable" } : {}),
    } as unknown as JsonObject;
    this.trafficCache.set(endpointId, { at: now, summary });
    return summary;
  }
  async snapshot(command: RuntimeCommand): Promise<{
    endpointId: string;
    generation: number;
    runtime: "ready" | "stopped" | "failed" | "unknown";
    provider: "available" | "unavailable" | "unknown" | "degraded";
    protocol: "connected" | "disconnected" | "connecting" | "unknown";
    convergence: "converged" | "failed" | "reconciling" | "unknown" | "conflicted";
    metadata: JsonObject;
  }> {
    this.assertAllowed(command);
    const inspected = await this.docker().inspect(this.containerName(command.endpointId));
    if (!inspected || inspected.state !== "running" || !inspected.ipAddress) {
      return { endpointId: command.endpointId, generation: command.generation, runtime: "stopped", provider: "unknown", protocol: "disconnected", convergence: "reconciling", metadata: {} };
    }
    const base = new URL(`http://${inspected.ipAddress}:6099`);
    const traffic = await this.protocolTraffic(command.endpointId);
    const webToken=await this.webCredential(command.endpointId,base);
    const loginInfo = await this.napcatRequest(base, "/api/QQLogin/GetQQLoginInfo", await this.webCredential(command.endpointId,base), {}, command.endpointId);
    const objectData = (value: JsonObject): JsonObject => {
      const data = value.data;
      return data !== null && typeof data === "object" && !Array.isArray(data) ? data : value;
    };
    const qq=objectData(loginInfo);
    if(qq.online!==true){
      let qrcode:JsonObject;
      try {
        qrcode=await this.napcatRequest(base,"/api/QQLogin/GetQQLoginQrcode",webToken,{},command.endpointId);
      } catch(error) {
        if(!(error instanceof Error)||!error.message.includes("QRCode Get Error"))throw error;
        await this.napcatRequest(base,"/api/QQLogin/RefreshQRcode",webToken,{},command.endpointId);
        qrcode=await this.waitForQr(base,command.endpointId,await this.webCredential(command.endpointId,base));
      }
      return{endpointId:command.endpointId,generation:command.generation,runtime:"ready",provider:"available",protocol:"disconnected",convergence:"reconciling",metadata:{qq,login:objectData(qrcode),onebot:null,traffic}}
    }
    const debugSession = await this.napcatRequest(base, "/api/Debug/create", webToken, {}, command.endpointId);
    const adapterName = (debugSession.data as Record<string, unknown> | undefined)?.adapterName;
    if (typeof adapterName !== "string" || !adapterName) throw new Error("NapCat debug adapter missing");
    const [statusSettled, loginSettled, versionSettled] = await Promise.allSettled([
      this.callOneBot(base, adapterName, webToken, command.endpointId, "get_status"),
      this.callOneBot(base, adapterName, webToken, command.endpointId, "get_login_info"),
      this.callOneBot(base, adapterName, webToken, command.endpointId, "get_version_info"),
    ]);
    if (statusSettled.status === "rejected") throw statusSettled.reason;
    if (loginSettled.status === "rejected") throw loginSettled.reason;
    const statusResult = statusSettled.value;
    const loginResult = loginSettled.value;
    const versionResult = versionSettled.status === "fulfilled"
      ? versionSettled.value
      : { data: null as JsonValue, probe: rejectedOneBotProbe(versionSettled.reason) };
    const probes: Record<string, OneBotProbe> = {
      get_status: statusResult.probe,
      get_login_info: loginResult.probe,
      get_version_info: versionResult.probe,
    };
    const asObject = (value: JsonValue): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
    const asCollection = (value: JsonValue) => {
      const all = Array.isArray(value)
        ? value.filter((entry): entry is JsonObject => entry !== null && typeof entry === "object" && !Array.isArray(entry))
        : [];
      return { items: all.slice(0, 500), count: all.length, truncated: all.length > 500 };
    };
    let directory = this.directoryCache.get(command.endpointId);
    if (!directory || Date.now() - directory.at >= (this.options.directoryRefreshMs ?? 300_000)) {
      const previous = directory;
      const [friendsResult, groupsResult] = await Promise.allSettled([
        this.callOneBot(base, adapterName, webToken, command.endpointId, "get_friend_list", 45_000),
        this.callOneBot(base, adapterName, webToken, command.endpointId, "get_group_list", 45_000),
      ]);

      const now = new Date().toISOString();
      const emptyCollection = { items: [] as JsonObject[], count: 0, truncated: false, observedAt: null };
      const friends = friendsResult.status === "fulfilled"
        ? { ...asCollection(friendsResult.value.data), observedAt: now, probe: friendsResult.value.probe }
        : { ...(previous?.friends ?? emptyCollection), probe: rejectedOneBotProbe(friendsResult.reason) };
      const groups = groupsResult.status === "fulfilled"
        ? { ...asCollection(groupsResult.value.data), observedAt: now, probe: groupsResult.value.probe }
        : { ...(previous?.groups ?? emptyCollection), probe: rejectedOneBotProbe(groupsResult.reason) };
      directory = {
        at: friendsResult.status === "fulfilled" && groupsResult.status === "fulfilled" ? Date.now() : 0,
        friends,
        groups,
      };
      this.directoryCache.set(command.endpointId, directory);
    }
    probes.get_friend_list = directory.friends.probe;
    probes.get_group_list = directory.groups.probe;
    const obConfig = await this.napcatRequest(base,"/api/OB11Config/GetConfig",await this.webCredential(command.endpointId,base),{},command.endpointId);
    const configData=objectData(obConfig),network=configData.network!==null&&typeof configData.network==="object"&&!Array.isArray(configData.network)?configData.network as Record<string,unknown>:{};
    const safeConnections=(value:unknown)=>Array.isArray(value)?value.slice(0,20).map(entry=>{if(entry===null||typeof entry!=="object"||Array.isArray(entry))return{};const {token,...safe}=entry as Record<string,unknown>;return{...safe,tokenConfigured:typeof token==="string"&&token.length>0}}):[];
    return {
      endpointId: command.endpointId,
      generation: command.generation,
      runtime: "ready",
      provider: "available",
      protocol: "connected",
      convergence: "converged",
      metadata: {
        qq: objectData(loginInfo),
        login: {},
        onebot: {
          status: asObject(statusResult.data),
          loginInfo: asObject(loginResult.data),
          version: asObject(versionResult.data),
          probes,
          directory: {
            friends: directory.friends,
            groups: directory.groups,
          },
          config:{websocketClients:safeConnections(network.websocketClients),websocketServers:safeConnections(network.websocketServers)},
        },
        traffic,
      },
    };
  }
  async observations(): Promise<NonNullable<Parameters<AgentCommandTransport["heartbeat"]>[0]>> {
    await this.loadCommands();
    return Promise.all([...this.commands.values()].map(async command => {
      const cached = this.snapshotCache.get(command.endpointId);
      if (cached && Date.now() - cached.at < 15_000) return { endpointId:cached.value.endpointId,generation:cached.value.generation,runtime:cached.value.runtime,provider:cached.value.provider,protocol:cached.value.protocol,convergence:cached.value.convergence,metadata:cached.value.metadata };
      try {
        const snapshot = await this.snapshot(command);
        this.snapshotCache.set(command.endpointId, { at: Date.now(), value: snapshot });
        return { endpointId:snapshot.endpointId,generation:snapshot.generation,runtime:snapshot.runtime,provider:snapshot.provider,protocol:snapshot.protocol,convergence:snapshot.convergence,metadata:snapshot.metadata };
      } catch (error) {
        return { endpointId:command.endpointId,generation:command.generation,runtime:"failed" as const,provider:"degraded" as const,protocol:"disconnected" as const,convergence:"failed" as const,metadata:{error:error instanceof Error?error.message:String(error)} };
      }
    }));
  }
}

export class DurableFakeAgent {
  private constructor(
    private readonly journal: FileAgentJournal,
    private readonly runtime: FakeRuntime | NapCatRuntime,
    private readonly transport: AgentCommandTransport,
  ) {}
  static async open(options: {
    journalPath: string;
    runtime?: FakeRuntime | NapCatRuntime;
    transport: AgentCommandTransport;
  }) {
    return new DurableFakeAgent(
      await FileAgentJournal.open(options.journalPath),
      options.runtime ?? new FakeRuntime(),
      options.transport,
    );
  }
  async pollOnce(): Promise<boolean> {
    await this.transport.heartbeat(this.runtime instanceof NapCatRuntime ? await this.runtime.observations() : []);
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
      const effectId=`runtime:${command.commandId}`;
      let applied = this.journal.get(command.commandId)?.effects[effectId] as Awaited<ReturnType<NapCatRuntime["apply"]>> | undefined;
      if (!applied)
        applied = await this.runtime.apply(effectId,command);
      if (applied) await this.journal.recordEffect(command.commandId, effectId, applied);
      result = {
        operationId: command.operationId,
        endpointId: command.endpointId,
        generation: command.generation,
        connectionEpoch: command.connectionEpoch,
        outcome: "succeeded",
        observations: applied?.observations ?? {
          node: "online",
          runtime: command.action === "stop" ? "stopped" : "ready",
          provider: "available",
          protocol: "connected",
          convergence: "converged",
        },
        ...(applied?.metadata ? { metadata: applied.metadata } : {}),
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

export async function enroll(controlPlaneUrl: string, token: string, provider = "fake", signal?:AbortSignal): Promise<NodeCredential> {
  const timeout=AbortSignal.timeout(15_000);
  const response = await fetch(new URL("/api/v1/agent/enroll", controlPlaneUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, provider, version: "botroost-agent" }),
    signal:signal?AbortSignal.any([signal,timeout]):timeout,
  });
  if (!response.ok) throw new Error(`enrollment failed: ${response.status}`);
  return (await response.json()) as NodeCredential;
}

export async function startAgentFromEnv(signal?:AbortSignal): Promise<DurableFakeAgent> {
  const controlPlaneUrl = process.env.CONTROL_PLANE_URL;
  const nodeStateDir = process.env.NODE_STATE_DIR;
  if (!controlPlaneUrl || !nodeStateDir)
    throw new Error("CONTROL_PLANE_URL and NODE_STATE_DIR are required");
  const provider = process.env.AGENT_PROVIDER ?? "fake";
  if (!["fake", "napcat"].includes(provider)) throw new Error("AGENT_PROVIDER must be fake or napcat");
  const store = new NodeCredentialStore(nodeStateDir);
  let credential = await store.read();
  if (!credential) {
    const token = process.env.ENROLLMENT_TOKEN;
    if (!token) throw new Error("ENROLLMENT_TOKEN is required for first start");
    credential = await enroll(controlPlaneUrl, token,provider,signal);
    await store.write(credential);
  }
  return DurableFakeAgent.open({
    journalPath: join(nodeStateDir, "agent-journal.jsonl"),
    runtime: provider === "napcat"
      ? new NapCatRuntime({
          stateDirectory: join(nodeStateDir, "napcat"),
          hostStateDirectory: join(process.env.NAPCAT_HOST_STATE_DIR ?? nodeStateDir, "napcat"),
          ...(process.env.NAPCAT_TOKEN === undefined ? {} : { napcatToken: process.env.NAPCAT_TOKEN }),
        })
      : await FakeRuntime.open(join(nodeStateDir,"runtime-effects.json")),
    transport: new HttpAgentTransport(controlPlaneUrl, credential.nodeSecret,signal?{signal}:{}),
  });
}

AgentHeartbeatRequestSchema.parse({
  status: "online",
  sessionId:"schema-check",
  observedAt: new Date().toISOString(),
  runtimes: [],
});
