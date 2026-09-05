export type ResourceLimits = { cpuLimitMillis: number | null; memoryLimitBytes: number | null };
export type DockerResourceSample = { cpuPercent: number; memoryBytes: number };
export type ResourceUsage = ResourceLimits & {
  source: "docker.stats";
  status: "ok" | "unavailable" | "stopped";
  observedAt: string | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
};
export type ResourceTarget = ResourceLimits & { endpointId: string; containerId: string | null; state: string };
export type DockerStatsReader = (ids: string[], signal?: AbortSignal) => Promise<Map<string, DockerResourceSample>>;
export const RESOURCE_SAMPLE_INTERVAL_MS = 5000;
export const RESOURCE_SAMPLE_TIMEOUT_MS = 3000;
const positive = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

// Keep this separate from lifecycle resource matching: telemetry needs exact bytes
// and NanoCpus, and must never change a container's desired configuration.
export function inspectedResourceLimits(config?: Record<string, unknown>): ResourceLimits {
  const nano = positive(config?.NanoCpus), quota = positive(config?.CpuQuota);
  return {
    cpuLimitMillis: nano !== null ? nano / 1_000_000 : quota !== null ? quota / (positive(config?.CpuPeriod) ?? 100000) * 1000 : null,
    memoryLimitBytes: positive(config?.Memory),
  };
}

function memoryBytes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^([\d]+(?:\.\d+)?)\s*(B|kB|KB|MB|GB|TB|PB|KiB|MiB|GiB|TiB|PiB)\s*\//.exec(value);
  if (!match) return null;
  const units: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4, PiB: 1024 ** 5 };
  const bytes = Math.round(Number(match[1]) * units[match[2]!]!);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

// Docker CLI reports Linux working-set memory (subtracting inactive file cache).
// Only allowlisted IDs and the two aggregate metrics leave this parser.
export function parseDockerStats(stdout: string, ids: string[]): Map<string, DockerResourceSample> {
  const allowed = new Set(ids), result = new Map<string, DockerResourceSample>();
  for (const line of stdout.split("\n")) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (!row || typeof row.ID !== "string" || !allowed.has(row.ID) || typeof row.CPUPerc !== "string" || !/^\d+(?:\.\d+)?%$/.test(row.CPUPerc)) continue;
      const cpuPercent = Number(row.CPUPerc.slice(0, -1)), memory = memoryBytes(row.MemUsage);
      if (!Number.isFinite(cpuPercent) || memory === null) continue;
      result.set(row.ID, { cpuPercent, memoryBytes: memory });
    } catch { /* One malformed/disappearing container must not erase other rows. */ }
  }
  return result;
}

export class ResourceUsageSampler {
  private lastAttempt = -Infinity;
  private inFlight: Promise<void> | undefined;
  private samples = new Map<string, DockerResourceSample & { observedAt: string }>();
  constructor(private readonly read: DockerStatsReader, private readonly signal?: AbortSignal) {}

  private async collect(ids: string[]) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.signal?.addEventListener("abort", abort, { once: true });
    if (this.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, RESOURCE_SAMPLE_TIMEOUT_MS);
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        if (controller.signal.aborted) reject(new Error("stats cancelled"));
        else controller.signal.addEventListener("abort", () => reject(new Error("stats cancelled")), { once: true });
      });
      const samples = await Promise.race([cancelled, controller.signal.aborted ? Promise.resolve(new Map<string, DockerResourceSample>()) : this.read(ids, controller.signal)]);
      const observedAt = new Date(Date.now()).toISOString();
      this.samples.clear();
      for (const id of ids) {
        const sample = samples.get(id);
        if (sample && Number.isFinite(sample.cpuPercent) && sample.cpuPercent >= 0 && Number.isSafeInteger(sample.memoryBytes) && sample.memoryBytes >= 0)
          this.samples.set(id, { cpuPercent: sample.cpuPercent, memoryBytes: sample.memoryBytes, observedAt });
      }
    } catch {
      // A failed attempt invalidates old success; never manufacture a fresh zero.
      this.samples.clear();
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", abort);
    }
  }

  async sample(targets: ResourceTarget[]): Promise<Map<string, ResourceUsage>> {
    const ids = [...new Set(targets.filter(target => target.state === "running" && target.containerId).map(target => target.containerId!))];
    const active = new Set(ids);
    for (const id of this.samples.keys()) if (!active.has(id)) this.samples.delete(id);
    if (!this.inFlight && ids.length && Date.now() - this.lastAttempt >= RESOURCE_SAMPLE_INTERVAL_MS) {
      this.lastAttempt = Date.now();
      this.inFlight = this.collect(ids).finally(() => { this.inFlight = undefined; });
    }
    await this.inFlight;
    return new Map(targets.map(target => {
      const sample = target.state === "running" && target.containerId ? this.samples.get(target.containerId) : undefined;
      return [target.endpointId, {
        source: "docker.stats", status: sample ? "ok" : target.containerId && (target.state === "exited" || target.state === "created") ? "stopped" : "unavailable",
        observedAt: sample?.observedAt ?? null, cpuPercent: sample?.cpuPercent ?? null, memoryBytes: sample?.memoryBytes ?? null,
        cpuLimitMillis: target.cpuLimitMillis, memoryLimitBytes: target.memoryLimitBytes,
      }];
    }));
  }
}
