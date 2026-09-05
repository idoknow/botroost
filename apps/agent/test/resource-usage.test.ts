import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerCliClient } from "../src/index.js";
import { parseDockerStats, inspectedResourceLimits, ResourceUsageSampler, type DockerStatsReader } from "../src/resource-usage.js";
const limits = { cpuLimitMillis: 1500, memoryLimitBytes: 1073741824 };
const running = { endpointId: "endpoint-a", containerId: "owned-a", state: "running", ...limits };
const sample = { cpuPercent: 125.5, memoryBytes: 134217728 };
afterEach(() => vi.useRealTimers());
describe("Docker resource telemetry", () => {
  it("parses working-set units and multicore CPU, excluding foreign and invalid rows", () => {
    const row = (ID: string, CPUPerc: string, MemUsage: string) => JSON.stringify({ ID, CPUPerc, MemUsage, Secret: "never-forward" });
    expect(parseDockerStats([row("owned-a", "125.50%", "128MiB / 1GiB"), row("owned-b", "0.00%", "0B / 8GiB"), row("foreign", "90%", "1GiB / 8GiB"), row("bad", "NaN%", "1MiB / 1GiB"), row("bad-memory", "2%", "unknown / 1GiB"), "not JSON"].join("\n"), ["owned-a", "owned-b", "bad", "bad-memory"])).toEqual(new Map([["owned-a", sample], ["owned-b", { cpuPercent: 0, memoryBytes: 0 }]]));
    expect(parseDockerStats(row("a", "1%", "1.25kB / 1GB"), ["a"]).get("a")?.memoryBytes).toBe(1250);
    for (const cpu of ["-1%", "1%junk", "Infinity%"])
      expect(parseDockerStats(row("a", cpu, "1MiB / 1GiB"), ["a"]).size).toBe(0);
  });
  it("reads exact actual limits with default period and NanoCpus, never host memory", () => {
    expect(inspectedResourceLimits({ CpuQuota: 75000, CpuPeriod: 50000, Memory: 123456789 })).toEqual({ cpuLimitMillis: 1500, memoryLimitBytes: 123456789 });
    expect(inspectedResourceLimits({ CpuQuota: 100000, CpuPeriod: 0, Memory: 1073741824 })).toEqual({ cpuLimitMillis: 1000, memoryLimitBytes: 1073741824 });
    expect(inspectedResourceLimits({ NanoCpus: 250000000, CpuQuota: 0, Memory: 0 })).toEqual({ cpuLimitMillis: 250, memoryLimitBytes: null });
    for (const config of [undefined, { CpuQuota: -1, Memory: 0 }]) expect(inspectedResourceLimits(config)).toEqual({ cpuLimitMillis: null, memoryLimitBytes: null });
  });
  it("uses one bounded explicit-ID CLI batch and never runs empty host-wide stats", async () => {
    const docker = new DockerCliClient();
    const execute = vi.spyOn(docker as unknown as { docker: (...args: unknown[]) => Promise<{ stdout: string; stderr: string }> }, "docker").mockResolvedValue({ stdout: JSON.stringify({ ID: "owned-a", CPUPerc: "125.5%", MemUsage: "128MiB / 1GiB" }), stderr: "" });
    expect(await docker.stats([])).toEqual(new Map()); expect(execute).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    expect(await docker.stats(["owned-a", "owned-a"], signal)).toEqual(new Map([["owned-a", sample]]));
    expect(execute).toHaveBeenCalledExactlyOnceWith(["stats", "--no-stream", "--no-trunc", "--format", "{{json .}}", "owned-a"], 1024 * 1024, { timeout: 3000, killSignal: "SIGKILL", signal });
  });
  it("batches targets with a five-second throttle without refreshing cached sample time", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const stats = vi.fn<DockerStatsReader>(async () => new Map([["owned-a", sample], ["owned-b", sample]]));
    const sampler = new ResourceUsageSampler(stats);
    const targets = [running, { ...running, endpointId: "endpoint-b", containerId: "owned-b" }];
    const first = await sampler.sample(targets);
    expect(stats).toHaveBeenCalledTimes(1); expect(stats.mock.calls[0]?.[0]).toEqual(["owned-a", "owned-b"]);
    expect(first.get("endpoint-a")).toEqual({ source: "docker.stats", status: "ok", observedAt: "2026-09-05T00:00:00.000Z", ...sample, ...limits });
    await vi.advanceTimersByTimeAsync(4999);
    expect((await sampler.sample(targets)).get("endpoint-a")).toEqual(first.get("endpoint-a")); expect(stats).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await sampler.sample(targets)).get("endpoint-a")?.observedAt).toBe("2026-09-05T00:00:05.000Z"); expect(stats).toHaveBeenCalledTimes(2);
  });
  it("invalidates on stop, disappearance, replacement and failure, retaining actual limits", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const stats = vi.fn(async () => new Map([["owned-a", sample]])); const sampler = new ResourceUsageSampler(stats);
    await sampler.sample([running]);
    const empty = { source: "docker.stats", observedAt: null, cpuPercent: null, memoryBytes: null, ...limits };
    expect((await sampler.sample([{ ...running, state: "exited" }])).get("endpoint-a")).toEqual({ ...empty, status: "stopped" });
    expect((await sampler.sample([running])).get("endpoint-a")?.status).toBe("unavailable");
    expect((await sampler.sample([{ ...running, containerId: "replacement" }])).get("endpoint-a")?.status).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(5000); await sampler.sample([running]);
    stats.mockRejectedValueOnce(new Error("private daemon failure")); await vi.advanceTimersByTimeAsync(5000);
    expect((await sampler.sample([running])).get("endpoint-a")).toEqual({ ...empty, status: "unavailable" });
    expect((await sampler.sample([{ ...running, containerId: null, state: "unknown", cpuLimitMillis: null, memoryLimitBytes: null }])).get("endpoint-a")).toEqual({ ...empty, status: "unavailable", cpuLimitMillis: null, memoryLimitBytes: null });
  });
  it("bounds hanging stats, coalesces in-flight collection and discards late completion", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    let resolve!: (value: Map<string, typeof sample>) => void; let signal: AbortSignal | undefined;
    const stats = vi.fn((_ids: string[], supplied?: AbortSignal) => { signal = supplied; return new Promise<Map<string, typeof sample>>(done => { resolve = done; }); });
    const sampler = new ResourceUsageSampler(stats); const first = sampler.sample([running]); const second = sampler.sample([running]);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await first).get("endpoint-a")?.status).toBe("unavailable"); expect((await second).get("endpoint-a")?.status).toBe("unavailable");
    expect(stats).toHaveBeenCalledTimes(1); expect(signal?.aborted).toBe(true);
    resolve(new Map([["owned-a", sample]])); await Promise.resolve();
    expect((await sampler.sample([running])).get("endpoint-a")?.observedAt).toBeNull();
  });
});
