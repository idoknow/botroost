// SnowLuma runtime: an independent OneBot v11 provider runtime.
// Deliberately does not import runtime values from ./index.js so it stays
// fully isolated from the NapCat code paths (type-only imports are erased).
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";
import {
  RuntimeCommandSchema,
  applyProxyEnvironment,
  type CommandProgressRequest,
  type RuntimeCommand,
} from "@botroost/agent-protocol";
import { NapCatTrafficAccumulator, parseSnowlumaConnectionLine, parseSnowlumaTrafficLine } from "./traffic.js";
import type {
  AgentCommandTransport,
  DockerClient,
  DockerInspectResult,
  FetchLike,
} from "./index.js";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

export const SNOWLUMA_IMAGE = "motricseven7/snowluma:v1.10.0";
export const SNOWLUMA_ARTIFACT = "artifact:snowluma:motricseven7.snowluma.v1.10.0";
const ONEBOT_HTTP_PORT = 3000;
const NOVNC_CONTAINER_PORT = "6081";
const WEBUI_CONTAINER_PORT = "5099";
const endpointIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const containerPrefixPattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

export type SnowlumaProgress = Pick<CommandProgressRequest, "phase" | "percent" | "message">;
export type SnowlumaApplyResult = {
  state: "running" | "stopped";
  observations?: Parameters<AgentCommandTransport["result"]>[0]["observations"];
  metadata?: JsonObject;
};
export type SnowlumaSnapshot = {
  endpointId: string;
  generation: number;
  runtime: "ready" | "stopped" | "failed" | "unknown";
  provider: "available" | "unavailable" | "unknown" | "degraded";
  protocol: "connected" | "disconnected" | "connecting" | "unknown";
  convergence: "converged" | "failed" | "reconciling" | "unknown" | "conflicted";
  metadata: JsonObject;
};

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500) || "Runtime execution failed";
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
export function snowlumaResourceLimits(requested: { cpuMillis: number; memoryMiB: number }): { cpuMillis: number; memoryMiB: number; memorySwapMiB: number } {
  const cpuMillis = Math.max(1000, requested.cpuMillis), memoryMiB = Math.max(1024, requested.memoryMiB);
  return { cpuMillis, memoryMiB, memorySwapMiB: memoryMiB + 512 };
}
/** Deterministic per-endpoint host port offset so parallel endpoints rarely collide. */
export function snowlumaLoginPorts(endpointId: string): { novncPort: number; webuiPort: number } {
  const offset = Number.parseInt(endpointId.slice(0, 4), 16) % 400;
  return { novncPort: 6081 + offset, webuiPort: 5099 + offset };
}
const isJsonObject = (value: JsonValue | undefined): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const asJsonObject = (value: JsonValue | undefined): JsonObject => isJsonObject(value) ? value : {};
const asJsonList = (value: JsonValue | undefined): JsonObject[] => Array.isArray(value) ? value.filter(isJsonObject) : [];
const requireEntry = (raw: unknown): JsonObject => {
  if (!isJsonObject(raw as JsonValue)) throw new Error("OneBot websocket entry is invalid");
  return raw as JsonObject;
};
const requireName = (value: JsonObject): string => {
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("OneBot websocket entry name is required");
  return value.name;
};
const preservedToken = (value: JsonObject, previous: JsonObject | undefined): string => {
  if (typeof value.token === "string" && value.token) return value.token;
  return typeof previous?.accessToken === "string" ? previous.accessToken : "";
};
const redactLogs = (text: string) => text
  .replace(/([?&](?:token|password|secret|key)=)[^&\s]+/gi, "$1[REDACTED]")
  .replace(/((?:authorization|cookie)\s*:\s*)(?:bearer\s+)?[^\r\n]+/gi, "$1[REDACTED]")
  .replace(/((?:token|password|secret|key|credential|session)\s*[=:]\s*)["']?[^\s,"'}]+["']?/gi, "$1[REDACTED]")
  .replace(/("(?:token|password|secret|key|credential|session)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2");

export class SnowLumaRuntime {
  private readonly networkMode: string;
  private readonly containerPrefix: string;
  private readonly fetcher: FetchLike;
  private readonly commands = new Map<string, RuntimeCommand>();
  private readonly snapshotCache = new Map<string, { at: number; value: SnowlumaSnapshot }>();
  private readonly trafficAccumulators = new Map<string, NapCatTrafficAccumulator>();
  private readonly trafficCache = new Map<string, { at: number; summary: JsonObject }>();
  private readonly trafficLastSuccessAt = new Map<string, number>();
  private commandsLoaded = false;
  private executionQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: {
    docker: DockerClient;
    stateDirectory: string;
    hostStateDirectory?: string;
    containerPrefix?: string;
    networkMode?: string;
    onebotAccessToken?: string;
    fetcher?: FetchLike;
    signal?: AbortSignal;
    operationTimeoutMs?: number;
  }) {
    this.networkMode = options.networkMode ?? process.env.SNOWLUMA_DOCKER_NETWORK ?? "bridge";
    this.containerPrefix = options.containerPrefix ?? "botroost-snowluma";
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(this.networkMode) || this.networkMode === "host" || this.networkMode.startsWith("container:")) throw new Error("SnowLuma docker network is invalid");
    if (!containerPrefixPattern.test(this.containerPrefix)) throw new Error("container prefix is invalid");
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }
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
  private endpointRoot(endpointId: string) {
    if (!endpointIdPattern.test(endpointId)) throw new Error("endpoint identifier is invalid");
    const root = resolve(this.options.stateDirectory);
    const path = resolve(root, endpointId);
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
    const image = typeof command.metadata.image === "string" ? command.metadata.image : "";
    if (image !== SNOWLUMA_IMAGE || command.runtimeRequest.approvedArtifactId !== SNOWLUMA_ARTIFACT)
      throw new Error("SnowLuma image is not allowlisted");
  }
  private ownsContainer(container: Pick<DockerInspectResult, "labels">, command: RuntimeCommand) {
    return container.labels["botroost.workspace_id"] === command.workspaceId && container.labels["botroost.endpoint_id"] === command.endpointId && container.labels["botroost.provider"] === "snowluma";
  }
  apply(effectId: string, command: RuntimeCommand, onProgress: (progress: SnowlumaProgress) => Promise<void> = async () => undefined, signal?: AbortSignal) {
    const pending = this.executionQueue.then(() => {
      const deadline = AbortSignal.any([AbortSignal.timeout(this.options.operationTimeoutMs ?? 120_000), ...(signal ? [signal] : []), ...(this.options.signal ? [this.options.signal] : [])]);
      return this.applySerial(effectId, command, async progress => { deadline.throwIfAborted(); await onProgress(progress); deadline.throwIfAborted(); });
    });
    this.executionQueue = pending.catch(() => undefined);
    return pending;
  }
  private async applySerial(_effectId: string, command: RuntimeCommand, onProgress: (progress: SnowlumaProgress) => Promise<void>): Promise<SnowlumaApplyResult> {
    this.assertAllowed(command);
    await onProgress({ phase: "inspecting-runtime", percent: 20, message: "Authorizing runtime command" });
    await this.loadCommands();
    const previousCommand = this.commands.get(command.endpointId);
    if (previousCommand && previousCommand.generation > command.generation) throw new Error("runtime generation fence rejected");
    const name = this.containerName(command.endpointId);
    const docker = this.options.docker;
    await onProgress({ phase: "inspecting-runtime", percent: 22, message: "Inspecting container ownership" });
    const existing = await docker.inspect(name);
    if (existing && !this.ownsContainer(existing, command)) throw new Error("SnowLuma container is not owned by this endpoint");
    if (command.action === "delete") {
      await onProgress({ phase: "removing-runtime", percent: 55, message: "Removing container and persisted runtime data" });
      if (existing) await docker.remove(name);
      await onProgress({ phase: "removing-runtime", percent: 62, message: "Removing persisted host runtime data" });
      await docker.removeHostEndpoint(resolve(this.options.hostStateDirectory ?? this.options.stateDirectory), command.endpointId, SNOWLUMA_IMAGE);
      await onProgress({ phase: "removing-runtime", percent: 70, message: "Removing agent runtime state" });
      await rm(this.endpointRoot(command.endpointId), { recursive: true, force: true });
      await onProgress({ phase: "removing-runtime", percent: 78, message: "Finalizing agent runtime deletion" });
      this.commands.delete(command.endpointId);
      await this.persistCommands();
      this.snapshotCache.delete(command.endpointId);
      await onProgress({ phase: "removing-runtime", percent: 95, message: "Runtime deletion complete" });
      return { state: "stopped", observations: { node: "online", runtime: "stopped", provider: "unavailable", protocol: "disconnected", convergence: "converged" }, metadata: { deleted: true } };
    }
    if (command.action === "read-container-logs") {
      await onProgress({ phase: "probing-provider", percent: 75, message: "Reading runtime diagnostics" });
      if (!existing || existing.labels["botroost.workspace_id"] !== command.workspaceId || existing.labels["botroost.endpoint_id"] !== command.endpointId || existing.labels["botroost.provider"] !== "snowluma") throw new Error("SnowLuma container ownership check failed");
      const tail = Number(command.metadata.logTail), sinceSeconds = Number(command.metadata.logSinceSeconds);
      if (!Number.isInteger(tail) || tail < 1 || tail > 1000 || !Number.isInteger(sinceSeconds) || sinceSeconds < 60 || sinceSeconds > 86400) throw new Error("SnowLuma log bounds are invalid");
      const text = redactLogs(await docker.logs(name, { tail, sinceSeconds }));
      await onProgress({ phase: "probing-provider", percent: 95, message: "Runtime diagnostics ready" });
      return { state: existing.state === "running" ? "running" : "stopped", metadata: { logs: { text, tail, sinceSeconds } } };
    }
    if (command.action === "refresh-login-qr")
      throw new Error("action is not supported for SnowLuma endpoints; complete login through the container remote desktop");
    if (command.action === "update-onebot-websockets") {
      await onProgress({ phase: "applying-configuration", percent: 60, message: "Applying OneBot WebSocket configuration" });
      if (!existing || existing.state !== "running") throw new Error("SnowLuma container is not running");
      const clients = command.metadata.websocketClients, servers = command.metadata.websocketServers;
      if (!Array.isArray(clients) || clients.length > 20 || !Array.isArray(servers) || servers.length > 20) throw new Error("OneBot websocket configuration is invalid");
      const found = await this.findOneBotConfig(command.endpointId);
      if (!found) throw new Error("SnowLuma OneBot configuration appears after QQ login; scan the login QR first");
      this.commands.set(command.endpointId, command);
      await this.persistCommands();
      // Preferred path: SnowLuma's own WebUI API applies the change live (no restart, the
      // QQ login survives). Fall back to writing the config file and reloading the service
      // when the WebUI is unreachable or its password was rotated.
      let appliedVia = "file";
      const credentials = await this.webuiCredentials(command.endpointId);
      if (credentials.webuiPassword && existing.ipAddress) {
        try {
          await onProgress({ phase: "applying-configuration", percent: 70, message: "Applying the configuration through the SnowLuma WebUI API" });
          await this.applyOneBotWebsocketsViaWebui(command.endpointId, existing.ipAddress, found.qq, credentials.webuiPassword, clients, servers);
          appliedVia = "webui";
        } catch (error) { console.error(`snowluma webui apply failed, falling back to file reload: ${safeError(error)}`); }
      }
      if (appliedVia === "file") {
        await onProgress({ phase: "applying-configuration", percent: 70, message: "Writing OneBot WebSocket configuration" });
        await this.writeOneBotWebsockets(found.path, found.config, clients, servers);
        await onProgress({ phase: "applying-configuration", percent: 80, message: "Reloading the SnowLuma OneBot service" });
        // Restart only the OneBot service process; QQ keeps running so the login session survives.
        await docker.exec(name, ["supervisorctl", "restart", "snowluma"]);
      }
      this.snapshotCache.delete(command.endpointId);
      await onProgress({ phase: "probing-provider", percent: 90, message: "Verifying OneBot configuration" });
      await new Promise(resolve => setTimeout(resolve, 3000));
      const snapshot = await this.snapshot(command).catch(error => ({
        endpointId: command.endpointId, generation: command.generation, runtime: "ready" as const, provider: "degraded" as const, protocol: "disconnected" as const, convergence: "reconciling" as const, metadata: { error: safeError(error) },
      }));
      await onProgress({ phase: "probing-provider", percent: 95, message: "OneBot configuration verified" });
      return { state: "running", observations: { node: "online", runtime: snapshot.runtime, provider: snapshot.provider, protocol: snapshot.protocol, convergence: snapshot.convergence }, metadata: snapshot.metadata };
    }
    if (command.action === "update-endpoint-proxy" && existing && existing.state !== "running") {
      this.commands.set(command.endpointId, command);
      await this.persistCommands();
      return { state: "stopped", observations: { node: "online", runtime: "stopped", provider: "unavailable", protocol: "disconnected", convergence: "converged" } };
    }
    const desiredResources = snowlumaResourceLimits(command.runtimeRequest.resources);
    const storedConfiguration = (command.metadata.configuration as Record<string, unknown> | undefined) ?? {};
    const proxyEnvironment = applyProxyEnvironment(storedConfiguration.proxy ?? null);
    const resourceDrift = existing?.resources && (existing.resources.cpuMillis !== desiredResources.cpuMillis || existing.resources.memoryMiB !== desiredResources.memoryMiB || existing.resources.memorySwapMiB !== desiredResources.memorySwapMiB);
    const proxyDrift = existing !== null && ((proxyEnvironment?.HTTP_PROXY ?? null) !== (existing.proxyEnvironment?.HTTP_PROXY ?? null));
    if (command.action !== "stop" && (!existing || existing.image !== SNOWLUMA_IMAGE || resourceDrift || proxyDrift)) {
      if (existing) { await onProgress({ phase: "preparing-runtime", percent: 35, message: "Replacing outdated SnowLuma container" }); await docker.remove(name); }
      await onProgress({ phase: "preparing-runtime", percent: 40, message: "Preparing runtime image and storage" });
      const hostQq = this.hostEndpointDirectory(command.endpointId, "qq");
      const hostConfig = this.hostEndpointDirectory(command.endpointId, "config");
      await mkdir(hostQq, { recursive: true, mode: 0o777 });
      await onProgress({ phase: "preparing-runtime", percent: 45, message: "Preparing SnowLuma configuration storage" });
      await mkdir(join(hostConfig, "config"), { recursive: true, mode: 0o777 });
      // The SnowLuma image runs its main process as an unprivileged user (uid SNOWLUMA_UID,
      // default 1000) with cwd /app/snowluma-data, while its entrypoint writes config/runtime.json
      // as root. Bind-mount host directories world-writable and pre-seed runtime.json with mode
      // 0o666 so the entrypoint's root-owned overwrite keeps it writable by the main process.
      await chmod(hostQq, 0o777).catch(() => {});
      await chmod(hostConfig, 0o777).catch(() => {});
      await chmod(join(hostConfig, "config"), 0o777).catch(() => {});
      const runtimeConfigPath = join(hostConfig, "config", "runtime.json");
      try {
        await writeFile(runtimeConfigPath, `${JSON.stringify({ webuiPort: WEBUI_CONTAINER_PORT }, null, 2)}\n`, { flag: "a+" , mode: 0o666 });
        await chmod(runtimeConfigPath, 0o666).catch(() => {});
      } catch { /* pre-seeding runtime.json is best-effort; the container entrypoint recreates it */ }
      await onProgress({ phase: "creating-container", percent: 55, message: "Creating SnowLuma container" });
      const ports = snowlumaLoginPorts(command.endpointId);
      await docker.create({
        name,
        image: SNOWLUMA_IMAGE,
        labels: {
          "botroost.provider": "snowluma",
          "botroost.workspace_id": command.workspaceId,
          "botroost.endpoint_id": command.endpointId,
          "botroost.generation": String(command.generation),
        },
        environment: { ...(proxyEnvironment ?? {}) },
        mounts: [
          { type: "bind", source: hostQq, target: "/app/.config" },
          { type: "bind", source: hostConfig, target: "/app/snowluma-data" },
        ],
        hostConfig: { networkMode: this.networkMode, portBindings: {} },
        resources: desiredResources,
        capAdd: ["SYS_PTRACE"],
        securityOpt: ["seccomp=unconfined"],
        shmBytes: 1024 * 1024 * 1024,
        publishedPorts: [
          { hostPort: String(ports.novncPort), containerPort: NOVNC_CONTAINER_PORT },
          { hostPort: String(ports.webuiPort), containerPort: WEBUI_CONTAINER_PORT },
        ],
      });
    }
    if (command.action === "stop" && existing) { await onProgress({ phase: "stopping-container", percent: 70, message: "Stopping SnowLuma container" }); await docker.stop(name); }
    else if (command.action === "force-restart") {
      if (!existing) throw new Error("SnowLuma container not found");
      if (!docker.kill) throw new Error("Runtime driver does not support force restart");
      this.snapshotCache.delete(command.endpointId);
      if (existing.state === "running") { await onProgress({ phase: "stopping-container", percent: 55, message: "Force killing owned SnowLuma container (data preserved)" }); await docker.kill(existing.id); }
      await onProgress({ phase: "starting-container", percent: 75, message: "Starting preserved SnowLuma container" });
      await docker.start(existing.id);
    }
    else if (command.action === "restart" || command.action === "update-endpoint-proxy") { this.snapshotCache.delete(command.endpointId); await docker.restart(name); }
    else if (command.action !== "stop") { await onProgress({ phase: "starting-container", percent: 70, message: "Starting SnowLuma container" }); await docker.start(name); }
    this.commands.set(command.endpointId, command);
    await this.persistCommands();
    if (command.action === "stop") {
      return { state: "stopped", observations: { node: "online", runtime: "stopped", provider: "unavailable", protocol: "disconnected", convergence: "converged" } };
    }
    await onProgress({ phase: "probing-provider", percent: 85, message: "Waiting for SnowLuma runtime readiness" });
    const snapshot = await this.snapshot(command).catch(error => ({
      endpointId: command.endpointId, generation: command.generation, runtime: "unknown" as const, provider: "degraded" as const, protocol: "disconnected" as const, convergence: "reconciling" as const, metadata: { error: safeError(error) },
    }));
    await onProgress({ phase: "probing-provider", percent: 95, message: "SnowLuma runtime observation ready" });
    return {
      state: "running",
      observations: { node: "online", runtime: snapshot.runtime, provider: snapshot.provider, protocol: snapshot.protocol, convergence: snapshot.convergence },
      metadata: snapshot.metadata,
    };
  }
  async snapshot(command: RuntimeCommand) {
    this.assertAllowed(command);
    return this.snapshotWithContainer(command, await this.options.docker.inspect(this.containerName(command.endpointId)));
  }
  private async oneBotGet(base: URL, action: string, token: string | undefined, timeoutMs = 10_000): Promise<{ data: JsonValue; probe: { ok: boolean; durationMs: number; error: string | null } }> {
    const started = Date.now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout;
    try {
      const response = await this.fetcher(new URL(`/${action}`, base), {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal,
      });
      if (!response.ok) throw new Error(`OneBot ${action} failed: ${response.status}`);
      const payload = await response.json() as JsonObject;
      return { data: oneBotActionData(payload), probe: { ok: true, durationMs: Date.now() - started, error: null } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(message), { probe: { ok: false, durationMs: Date.now() - started, error: message } });
    }
  }
  private async webuiCredentials(endpointId: string): Promise<{ webuiUsername?: string; webuiPassword?: string }> {
    // The agent takes over the WebUI password on first use (see applyOneBotWebsocketsViaWebui):
    // SnowLuma would otherwise regenerate the initial password on every restart, which also
    // blocks its WebUI API. Once a managed password exists, surface it to the console.
    const stored = await this.storedWebuiPassword(endpointId);
    if (stored) return { webuiUsername: "admin", webuiPassword: stored };
    // SnowLuma prints its initial WebUI credentials ("initial credentials: user=… password=…")
    // to the container log on every start until the password is changed. Surface the latest
    // pair so operators can log into the WebUI from the console. The banner sits near the
    // beginning of the log, so read generously and keep the newest match.
    try {
      const logs = await this.options.docker.logs(this.containerName(endpointId), { tail: 5000, sinceSeconds: 86_400 });
      const matches = [...logs.matchAll(/initial credentials: user=(\S+) password=(\S+)/g)];
      const last = matches.at(-1);
      if (last) return { webuiUsername: last[1] ?? "", webuiPassword: last[2] ?? "" };
    } catch { /* logs unavailable; credentials are simply not surfaced */ }
    return {};
  }
  private webuiCredentialsPath() { return join(this.options.stateDirectory, "snowluma-webui-credentials.json"); }
  private async storedWebuiPassword(endpointId: string): Promise<string | undefined> {
    try {
      const all = asJsonObject(JSON.parse(await readFile(this.webuiCredentialsPath(), "utf8")) as JsonValue);
      const entry = asJsonObject(all[endpointId]);
      const password = entry.password;
      return typeof password === "string" && password ? password : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  }
  private async storeWebuiPassword(endpointId: string, password: string) {
    await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
    let all: JsonObject = {};
    try { all = asJsonObject(JSON.parse(await readFile(this.webuiCredentialsPath(), "utf8")) as JsonValue); } catch { /* first entry */ }
    all[endpointId] = { password, updatedAt: new Date().toISOString() };
    await writeFile(this.webuiCredentialsPath(), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  }
  private async readOneBotToken(endpointId: string): Promise<string | undefined> {
    // SnowLuma generates its own OneBot access tokens on first start and stores them in
    // onebot_<qq>.json.
    try {
      const found = await this.findOneBotConfig(endpointId);
      const networks = found ? asJsonObject(found.config.networks) : {};
      for (const server of asJsonList(networks.httpServers)) {
        const token = server.accessToken;
        if (typeof token === "string" && token.length > 0) return token;
      }
    } catch { /* token file not present yet (e.g. before QQ login) */ }
    return undefined;
  }
  private async findOneBotConfig(endpointId: string): Promise<{ path: string; qq: string; config: JsonObject } | null> {
    // The config directory is bind-mounted at /app/snowluma-data and SnowLuma keeps its
    // files under a "config" subdirectory, so scan both locations.
    const mountDirectory = this.hostEndpointDirectory(endpointId, "config");
    for (const directory of [join(mountDirectory, "config"), mountDirectory]) {
      for (const entry of await readdir(directory)) {
        const match = /^onebot_(.+)\.json$/.exec(entry);
        if (!match?.[1]) continue;
        const path = join(directory, entry);
        const config = asJsonObject(JSON.parse(await readFile(path, "utf8")) as JsonValue);
        return { path, qq: match[1], config };
      }
    }
    return null;
  }
  /** Map the console editor payload (NapCat-shaped websocketClients/websocketServers) onto
   *  SnowLuma's native wsClients/wsServers entries, preserving existing access tokens for
   *  entries that keep their name (the editor never echoes tokens back). */
  private mapOneBotWebsockets(config: JsonObject, clients: unknown[], servers: unknown[]): JsonObject {
    const networks = asJsonObject(config.networks);
    const previousServers = asJsonList(networks.wsServers);
    const previousClients = asJsonList(networks.wsClients);
    const mappedServers = servers.map(raw => {
      const value = requireEntry(raw), name = requireName(value);
      const previous = previousServers.find(entry => entry.name === name);
      return {
        name,
        ...(value.enable === false ? { enabled: false } : {}),
        accessToken: preservedToken(value, previous),
        messageFormat: value.messagePostFormat === "string" ? "string" : "array",
        reportSelfMessage: value.reportSelfMessage === true,
        host: typeof value.host === "string" && value.host ? value.host : "0.0.0.0",
        port: typeof value.port === "number" && Number.isInteger(value.port) && value.port > 0 ? value.port : 3001,
        path: typeof previous?.path === "string" && previous.path ? previous.path : "/",
        role: typeof previous?.role === "string" && previous.role ? previous.role : "Universal",
      } satisfies JsonObject;
    });
    const mappedClients = clients.map(raw => {
      const value = requireEntry(raw), name = requireName(value);
      const previous = previousClients.find(entry => entry.name === name);
      if (typeof value.url !== "string" || !value.url) throw new Error("OneBot websocket client url is required");
      return {
        name,
        ...(value.enable === false ? { enabled: false } : {}),
        accessToken: preservedToken(value, previous),
        messageFormat: value.messagePostFormat === "string" ? "string" : "array",
        reportSelfMessage: value.reportSelfMessage === true,
        url: value.url,
        role: typeof previous?.role === "string" && previous.role ? previous.role : "Universal",
        reconnectIntervalMs: typeof value.reconnectInterval === "number" && Number.isFinite(value.reconnectInterval) ? Math.max(1000, Math.trunc(value.reconnectInterval)) : 5000,
      } satisfies JsonObject;
    });
    return { ...config, networks: { ...networks, wsServers: mappedServers, wsClients: mappedClients } };
  }
  private async writeOneBotWebsockets(path: string, config: JsonObject, clients: unknown[], servers: unknown[]) {
    const merged = this.mapOneBotWebsockets(config, clients, servers);
    await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  }
  /** Apply the OneBot websocket configuration through SnowLuma's own WebUI API so the running
   *  service picks the change up live — no supervisor restart and the QQ login stays untouched. */
  private async applyOneBotWebsocketsViaWebui(endpointId: string, ipAddress: string, qq: string, password: string, clients: unknown[], servers: unknown[]) {
    const base = `http://${ipAddress}:${WEBUI_CONTAINER_PORT}`;
    const login = await this.webuiLogin(endpointId, base, password);
    let token = typeof login.body.token === "string" ? login.body.token : null;
    if (!token) throw new Error("SnowLuma WebUI login did not return a token");
    // Take over the WebUI password while the initial banner credentials are still valid:
    // SnowLuma regenerates that password on every restart and blocks its API until the
    // password is changed, so the agent rotates it to a stable managed secret once.
    if (login.body.mustChangePassword === true) {
      // SnowLuma's strength rules require lower+upper+special and at least 10 chars.
      const generated = `Bt!${randomBytes(12).toString("base64url")}`;
      // The auth middleware requires the bearer token on every endpoint except /api/login.
      await this.webuiFetch(`${base}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ oldPassword: login.password, newPassword: generated }) });
      await this.storeWebuiPassword(endpointId, generated);
      // Changing the password invalidates every session token (including ours) and restarts
      // the service, so log back in with the managed password once it is back up.
      const again = await this.webuiLogin(endpointId, base, generated, 5);
      token = typeof again.body.token === "string" ? again.body.token : token;
    }
    const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
    // The WebUI blocks every API until the EULA/privacy consent is recorded; consent is a
    // one-time flag on this managed container, so record it automatically when required.
    const agreements = await this.webuiFetch(`${base}/api/agreements`, { headers });
    if (agreements !== null && typeof agreements === "object" && !Array.isArray(agreements) && (agreements as JsonObject).consentRequired === true) {
      const version = (agreements as JsonObject).version;
      if (typeof version !== "string" || !version) throw new Error("SnowLuma WebUI agreement version is unavailable");
      await this.webuiFetch(`${base}/api/agreements/record-consent`, { method: "POST", headers, body: JSON.stringify({ version }) });
    }
    const configUrl = `${base}/api/config/${encodeURIComponent(qq)}`;
    const current = await this.webuiFetch(configUrl, { headers });
    // The endpoint answers with the stored config either raw or wrapped as {config: …}.
    const existingConfig = asJsonObject(current !== null && typeof current === "object" && !Array.isArray(current) && "config" in current ? (current as JsonObject).config : current);
    const merged = this.mapOneBotWebsockets(existingConfig, clients, servers);
    await this.webuiFetch(configUrl, { method: "POST", headers, body: JSON.stringify(merged) });
  }
  /** Log into the SnowLuma WebUI. The managed password is tried first, then the most recent
   *  "initial credentials" banners — SnowLuma rotates that banner password on every restart,
   *  so the newest log entries win while the password is still in its initial state. */
  private async webuiLogin(endpointId: string, base: string, password: string, attempts = 1): Promise<{ password: string; body: JsonObject }> {
    const candidates = [password, ...(await this.bannerWebuiPasswords(endpointId))].filter((value, index, all) => value && all.indexOf(value) === index);
    let lastError: unknown = new Error("SnowLuma WebUI has no usable credentials");
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 2_500));
      for (const candidate of candidates) {
        try {
          const body = await this.webuiFetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: candidate }) });
          if (isJsonObject(body) && typeof body.token === "string" && body.token) return { password: candidate, body };
          lastError = new Error("SnowLuma WebUI login did not return a token");
        } catch (error) { lastError = error; }
      }
    }
    throw lastError;
  }
  private async bannerWebuiPasswords(endpointId: string): Promise<string[]> {
    try {
      const logs = await this.options.docker.logs(this.containerName(endpointId), { tail: 5000, sinceSeconds: 86_400 });
      const matches = [...logs.matchAll(/initial credentials: user=(\S+) password=(\S+)/g)];
      return matches.slice(-3).map(match => match[2] ?? "").reverse().filter(value => value);
    } catch { return []; }
  }
  private async webuiFetch(url: string, init: RequestInit): Promise<JsonValue> {
    const response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(5_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`SnowLuma WebUI API returned ${response.status} for ${new URL(url).pathname}`);
    try { return JSON.parse(text) as JsonValue; } catch { return text; }
  }
  /** Editor-shaped snapshot of the OneBot websocket configuration (NapCat field names so the
   *  console editor renders unchanged); only present once QQ login created onebot_<qq>.json. */
  private async oneBotEditorConfig(endpointId: string): Promise<JsonObject> {
    try {
      const found = await this.findOneBotConfig(endpointId);
      if (!found) return {};
      const networks = asJsonObject(found.config.networks);
      return {
        websocketClients: asJsonList(networks.wsClients).map(entry => ({
          name: typeof entry.name === "string" ? entry.name : "ws",
          enable: entry.enabled !== false,
          url: typeof entry.url === "string" ? entry.url : "",
          messagePostFormat: entry.messageFormat === "string" ? "string" : "array",
          reportSelfMessage: entry.reportSelfMessage === true,
          debug: false,
          heartInterval: 30000,
          reconnectInterval: typeof entry.reconnectIntervalMs === "number" ? entry.reconnectIntervalMs : 5000,
          tokenConfigured: typeof entry.accessToken === "string" && entry.accessToken.length > 0,
        })),
        websocketServers: asJsonList(networks.wsServers).map(entry => ({
          name: typeof entry.name === "string" ? entry.name : "ws",
          enable: entry.enabled !== false,
          host: typeof entry.host === "string" ? entry.host : "0.0.0.0",
          port: typeof entry.port === "number" ? entry.port : 3001,
          messagePostFormat: entry.messageFormat === "string" ? "string" : "array",
          reportSelfMessage: entry.reportSelfMessage === true,
          debug: false,
          heartInterval: 30000,
          enableForcePushEvent: true,
          tokenConfigured: typeof entry.accessToken === "string" && entry.accessToken.length > 0,
        })),
      };
    } catch { /* config file unreadable; render an empty editor */ }
    return {};
  }
  private async snapshotWithContainer(command: RuntimeCommand, inspected: DockerInspectResult | null): Promise<SnowlumaSnapshot> {
    this.assertAllowed(command);
    if (!inspected || inspected.state !== "running" || !inspected.ipAddress) {
      return { endpointId: command.endpointId, generation: command.generation, runtime: "stopped", provider: "unknown", protocol: "disconnected", convergence: "reconciling", metadata: {} };
    }
    const base = new URL(`http://${inspected.ipAddress}:${ONEBOT_HTTP_PORT}`);
    const configuredToken = (this.options.onebotAccessToken ?? process.env.SNOWLUMA_ONEBOT_ACCESS_TOKEN ?? "").trim() || undefined;
    const token = configuredToken ?? await this.readOneBotToken(command.endpointId);
    const [statusSettled, loginSettled, versionSettled] = await Promise.allSettled([
      this.oneBotGet(base, "get_status", token),
      this.oneBotGet(base, "get_login_info", token),
      this.oneBotGet(base, "get_version_info", token),
    ]);
    const ports = snowlumaLoginPorts(command.endpointId);
    const webui = await this.webuiCredentials(command.endpointId);
    const loginGuide = { novncPort: ports.novncPort, webuiPort: ports.webuiPort, ...webui };
    if (statusSettled.status === "rejected") {
      // SnowLuma only starts its OneBot HTTP server (container port 3000) after QQ
      // logs in, so an unreachable provider while the container is running means
      // "waiting for the QQ scan login" rather than a runtime failure. NapCat keeps
      // the driver probe available in the same situation, so report available with a
      // disconnected protocol; the console then renders the login-required state.
      const reason = statusSettled.reason as Error & { probe?: { ok: boolean; durationMs: number; error: string | null } };
      return {
        endpointId: command.endpointId, generation: command.generation, runtime: "ready", provider: "available",
        protocol: "disconnected", convergence: "reconciling",
        metadata: {
          qq: { online: false }, login: {},
          onebot: { status: {}, loginInfo: {}, version: null, probes: { get_status: reason?.probe ?? { ok: false, durationMs: 0, error: safeError(reason) } } },
          loginGuide,
          error: safeError(reason),
        },
      };
    }
    const statusResult = statusSettled.value;
    const loginResult = loginSettled.status === "fulfilled" ? loginSettled.value : null;
    const versionResult = versionSettled.status === "fulfilled" ? versionSettled.value : null;
    const probes: Record<string, { ok: boolean; durationMs: number; error: string | null }> = {
      get_status: statusResult.probe,
      get_login_info: loginResult ? loginResult.probe : (loginSettled as PromiseRejectedResult).reason?.probe ?? { ok: false, durationMs: 0, error: "get_login_info failed" },
      ...(versionResult ? { get_version_info: versionResult.probe } : {}),
    };
    const asObject = (value: JsonValue): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
    const status = asObject(statusResult.data);
    const loginInfo = loginResult ? asObject(loginResult.data) : {};
    const online = typeof status.online === "boolean" ? status.online && Object.keys(loginInfo).length > 0 : Object.keys(loginInfo).length > 0 ? true : null;
    if (online !== true) {
      return {
        endpointId: command.endpointId, generation: command.generation, runtime: "ready", provider: "available",
        protocol: "disconnected", convergence: "reconciling",
        metadata: { qq: { online }, login: loginInfo, onebot: { status, loginInfo, version: versionResult ? asObject(versionResult.data) : null, probes, config: await this.oneBotEditorConfig(command.endpointId) }, loginGuide },
      };
    }
    // Directory probing (friends/groups) — standard OneBot v11 actions available after login.
    const [friendsSettled, groupsSettled] = await Promise.allSettled([
      this.oneBotGet(base, "get_friend_list", token),
      this.oneBotGet(base, "get_group_list", token),
    ]);
    const directoryCollection = (settled: PromiseSettledResult<{ data: JsonValue; probe: { ok: boolean; durationMs: number; error: string | null } }>) => {
      if (settled.status === "rejected") {
        const reason = settled.reason as Error & { probe?: { ok: boolean; durationMs: number; error: string | null } };
        return { count: 0, items: [] as JsonObject[], truncated: false, observedAt: null, probe: reason?.probe ?? { ok: false, durationMs: 0, error: safeError(reason) } };
      }
      const list = Array.isArray(settled.value.data) ? settled.value.data.filter((item): item is JsonObject => item !== null && typeof item === "object") : [];
      const truncated = list.length > 500;
      return { count: list.length, items: truncated ? list.slice(0, 500) : list, truncated, observedAt: new Date().toISOString(), probe: settled.value.probe };
    };
    const friends = directoryCollection(friendsSettled);
    const groups = directoryCollection(groupsSettled);
    probes.get_friend_list = friends.probe;
    probes.get_group_list = groups.probe;
    const websocketConfig = await this.oneBotEditorConfig(command.endpointId);
    // SnowLuma aggregates no traffic itself; the container log lines carry per-event
    // OneBot traffic that we parse into the same envelope the console expects.
    const traffic = await this.protocolTraffic(command.endpointId);
    return {
      endpointId: command.endpointId, generation: command.generation, runtime: "ready", provider: "available",
      protocol: "connected", convergence: "converged",
      metadata: { qq: { online, ...loginInfo }, onebot: { status, loginInfo, version: versionResult ? asObject(versionResult.data) : null, probes, directory: { friends, groups }, config: websocketConfig }, traffic, loginGuide },
    };
  }
  /** Aggregate per-event traffic from the SnowLuma container log into the console envelope. */
  private async protocolTraffic(endpointId: string): Promise<JsonObject> {
    const now = Date.now();
    const cached = this.trafficCache.get(endpointId);
    if (cached && now - cached.at < 5_000) return cached.summary;
    let accumulator = this.trafficAccumulators.get(endpointId);
    if (!accumulator) {
      accumulator = new NapCatTrafficAccumulator(parseSnowlumaTrafficLine, parseSnowlumaConnectionLine, "snowluma.container_logs");
      this.trafficAccumulators.set(endpointId, accumulator);
    }
    const lastSuccessAt = this.trafficLastSuccessAt.get(endpointId);
    const sinceSeconds = lastSuccessAt === undefined
      ? 300
      : Math.min(300, Math.max(15, Math.ceil((now - lastSuccessAt) / 1000) + 5));
    const maxBytes = 4 * 1024 * 1024;
    let status: "ok" | "partial" | "unavailable" = "ok";
    let complete = true;
    try {
      const logs = await this.options.docker.logs(this.containerName(endpointId), { tail: 5000, sinceSeconds, timestamps: true, maxBytes });
      const lines = logs.split(/\r?\n/).filter(Boolean);
      accumulator.ingest(lines, now);
      complete = lines.length < 5000 && Buffer.byteLength(logs) < maxBytes;
      status = complete ? "ok" : "partial";
      this.trafficLastSuccessAt.set(endpointId, now);
    } catch {
      status = "unavailable";
      complete = false;
    }
    const summary = {
      ...accumulator.summary(now),
      status,
      complete,
      sampleIntervalSeconds: 5,
      ...(status === "unavailable" ? { error: "Container log telemetry unavailable" } : {}),
      ...(status === "partial" ? { error: "High log volume truncated the latest sample; displayed rates are lower bounds" } : {}),
    } as unknown as JsonObject;
    this.trafficCache.set(endpointId, { at: now, summary });
    return summary;
  }
  async observations(): Promise<NonNullable<Parameters<AgentCommandTransport["heartbeat"]>[0]>> {
    await this.loadCommands();
    const commands = [...this.commands.values()];
    return Promise.all(commands.map(async command => {
      try {
        this.assertAllowed(command);
        const inspected = await this.options.docker.inspect(this.containerName(command.endpointId));
        if (inspected && !this.ownsContainer(inspected, command)) throw new Error("SnowLuma container is not owned by this endpoint");
        const cached = this.snapshotCache.get(command.endpointId);
        if (cached && Date.now() - cached.at < 15_000 && inspected?.state === "running" && inspected.ipAddress) return cached.value;
        const value = await this.snapshotWithContainer(command, inspected);
        this.snapshotCache.set(command.endpointId, { at: Date.now(), value });
        return value;
      } catch (error) {
        this.snapshotCache.delete(command.endpointId);
        return { endpointId: command.endpointId, generation: command.generation, runtime: "unknown", provider: "degraded", protocol: "unknown", convergence: "reconciling", metadata: { error: safeError(error) } };
      }
    }));
  }
}
