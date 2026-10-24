import { CoreV1Api, Exec, KubeConfig, KubernetesObjectApi, Metrics, type KubernetesObject, type V1Status } from '@kubernetes/client-node';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { DockerClient, DockerCreateInput, DockerInspectResult } from '../index.js';
import type { DockerResourceSample } from '../resource-usage.js';
import type { RuntimeOwner } from './types.js';
import type { RuntimeDriver, RuntimeSpec, RuntimeVolume } from './types.js';
import { type KubernetesProfile } from './kubernetes-resources.js';

/**
 * Kubernetes-backed DockerClient.
 *
 * SnowLuma and LLBot are written against the Docker API surface rather than the
 * RuntimeDriver boundary NapCat was migrated to. This adapter presents that same surface
 * on top of Kubernetes primitives, so both providers run unchanged on
 * AGENT_RUNTIME=kubernetes without a Docker daemon and without host networking:
 *
 *   docker.create(host bind + published port) -> StatefulSet + PVC subPath + Service ports
 *   docker.exec                              -> pods/exec on the protocol container
 *   inspect().ipAddress                      -> <name>.<namespace>.svc (Service DNS)
 *   docker.removeHostEndpoint                -> PVC retained, host state untouched
 *
 * It composes an existing RuntimeDriver for lifecycle work (inspect/start/stop/restart/
 * logs/stats) so the ownership checks, convergence waits and template-marker idempotency
 * that NapCat already relies on are shared instead of duplicated.
 */
/** Upper bound for a single exec round trip; provider commands are serial and must not hang. */
const EXEC_TIMEOUT_MS = 60_000;
export class KubernetesDockerClient implements DockerClient {
  private core: CoreV1Api;
  private execClient: Exec;
  private objects: KubernetesObjectApi;
  private metricsApi?: Metrics;
  private volumes = new Map<string, RuntimeVolume[]>();
  private kc: KubeConfig;
  constructor(private driver: RuntimeDriver, private profile: KubernetesProfile, private signal?: AbortSignal, config?: KubeConfig) {
    const kc = config ?? new KubeConfig();
    if (!config) kc.loadFromCluster();
    this.kc = kc;
    this.core = kc.makeApiClient(CoreV1Api);
    this.execClient = new Exec(kc);
    this.objects = KubernetesObjectApi.makeApiClient(kc);
    this.metricsApi = new Metrics(kc);
  }
  // ---- registry of a created workload's volumes -------------------------------------
  // Docker's exec/logs only need a name, but Kubernetes needs to know which subPath each
  // mount came from to keep the same layout across restarts. The bind source is the
  // per-endpoint directory, and its basename is the subPath the claim stores it under.
  private remember(name: string, mounts: DockerCreateInput['mounts']) {
    this.volumes.set(name, mounts.map(mount => ({ name: this.subPathFor(mount.source, mount.target), target: mount.target })));
  }
  // The bind source on Docker is a directory the agent owns, and its basename is the subPath
  // on Kubernetes -- except for hidden directories like `.config`, which are not valid
  // subPaths. Those fall back to the mount target instead, so the mapping stays deterministic
  // and the reclaiming adapter derives the same subPaths from the live StatefulSet.
  private subPathFor(source: string, target?: string) {
    const base = source.replace(/\/+$/, '').split('/').pop() ?? '';
    if (/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(base)) return base as RuntimeVolume['name'];
    const derived = (target ?? '').replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? '';
    const normalized = derived.replace(/^\.+/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!normalized) throw new Error(`Cannot derive a volume subPath from ${source} (${target ?? 'no target'})`);
    return normalized as RuntimeVolume['name'];
  }
  // Previous runs of this adapter (and the provider's own mount list) agree on these
  // targets; recovering the mapping from the live StatefulSet keeps restarts working even
  // when the process that created the workload is gone.
  private async volumesFor(name: string): Promise<RuntimeVolume[]> {
    const remembered = this.volumes.get(name);
    if (remembered) return remembered;
    const workload = await this.readWorkload(name);
    const mounts: { mountPath: string; subPath?: string }[] = workload?.spec?.template?.spec?.containers?.[0]?.volumeMounts ?? [];
    const discovered = mounts.filter(mount => mount.subPath).map(mount => ({ name: mount.subPath as RuntimeVolume['name'], target: mount.mountPath }));
    if (discovered.length) { this.volumes.set(name, discovered); return discovered; }
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async readWorkload(name: string): Promise<any | null> {
    this.signal?.throwIfAborted();
    try {
      return await this.objects.read({ apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name, namespace: this.profile.namespace } });
    } catch (error) { if ((error as { code?: number }).code === 404) return null; throw error; }
  }
  // ---- DockerClient surface ---------------------------------------------------------
  async create(input: DockerCreateInput): Promise<{ id: string }> {
    this.signal?.throwIfAborted();
    this.remember(input.name, input.mounts);
    // Docker publishes host ports; Kubernetes routes the same container ports through the
    // Service, which is why the provider can reach them at the inspect() address. Ports the
    // provider reaches over the container network (OneBot's HTTP API) are not published on
    // Docker, but they still have to be Service ports or the provider cannot reach them.
    const servicePorts = [...new Set([
      ...(input.publishedPorts ?? []).map(port => Number(port.containerPort)),
      ...(input.exposePorts ?? []),
    ])].filter(port => Number.isInteger(port) && port > 0 && port < 65536);
    const ports = servicePorts.map(port => ({ name: `port-${port}`, port }));
    const spec: RuntimeSpec = {
      name: input.name,
      image: input.image,
      labels: input.labels,
      environment: Object.fromEntries(Object.entries(input.environment ?? {}).filter(([, value]) => typeof value === 'string')),
      volumes: this.volumes.get(input.name)!,
      resources: { cpuMillis: input.resources.cpuMillis, memoryMiB: input.resources.memoryMiB },
      ...(ports.length ? { ports } : {}),
      ...(input.capAdd ? { capAdd: input.capAdd } : {}),
      ...(input.securityOpt ? { securityOpt: input.securityOpt } : {}),
      ...(input.shmBytes ? { shmBytes: input.shmBytes } : {}),
    };
    await this.driver.ensure(spec);
    const inspected = await this.driver.inspect(input.name);
    return { id: inspected?.id ?? input.name };
  }
  /** Verifies the registry actually serves `image` before the caller removes the workload it
   *  replaces: with the old StatefulSet already gone, a node-side pull failure would leave the
   *  endpoint down for the whole outage. Runs a throwaway pod with the same placement as the
   *  runtimes and only treats a definitive image-pull failure as evidence; every other check
   *  problem fails open, because the checker must never become a second way to lose the runtime. */
  async pull(image: string, timeoutMs = 90_000): Promise<void> {
    this.signal?.throwIfAborted();
    const name = `pull-verify-${randomUUID().slice(0, 8)}`;
    const pod = {
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name, namespace: this.profile.namespace },
      spec: {
        restartPolicy: 'Never',
        ...(this.profile.nodeSelector ? { nodeSelector: this.profile.nodeSelector } : {}),
        containers: [{ name: 'verify', image, command: ['/bin/sh', '-c', 'exit 0'], resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '100m', memory: '64Mi' } } }],
      },
    } as KubernetesObject;
    try { await this.objects.create(pod); } catch { return; }
    const deadline = Date.now() + timeoutMs;
    let pullFailed = false;
    try {
      while (Date.now() < deadline) {
        this.signal?.throwIfAborted();
        const current = await this.core.readNamespacedPod({ name, namespace: this.profile.namespace }).catch(() => null);
        const state = (current?.status?.containerStatuses as { name: string; state?: { running?: object; terminated?: object; waiting?: { reason?: string } } }[] | undefined)?.find(entry => entry.name === 'verify')?.state;
        // The container ran (or ran to completion): the node has the image.
        if (state?.running || state?.terminated || current?.status?.phase === 'Succeeded') return;
        if (state?.waiting?.reason === 'ErrImagePull' || state?.waiting?.reason === 'ImagePullBackOff') { pullFailed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } finally {
      await this.objects.delete({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: this.profile.namespace } }).catch(() => undefined);
    }
    if (pullFailed) throw new Error(`the registry does not currently serve ${image}; the existing runtime keeps serving until it does`);
  }
  inspect(name: string): Promise<DockerInspectResult | null> { return this.driver.inspect(name); }
  // Providers legitimately call lifecycle methods with either the container name or the id
  // returned by create()/inspect(). Docker accepts both; Kubernetes only knows names, so
  // resolve a pod UID back to the workload that owns it.
  private async resolveName(reference: string): Promise<string> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference)) return reference;
    // A UID is either a pod's (create()/inspect() return the live pod) or a StatefulSet's
    // (inspect() falls back to it while the workload is stopped or its pod is being
    // replaced). Both are resolved, because a stopped workload legitimately has no pod.
    const workload = await this.findWorkloadByUid(reference);
    if (workload) return workload;
    // Not a workload UID: find the owning Pod. A direct read covers the case where a provider
    // passed a pod name; the label scan covers ids handed back by inspect().
    const read = await this.core.readNamespacedPod({ name: reference, namespace: this.profile.namespace }).then(pod => pod.metadata).catch(() => null);
    const metadata = read ?? await this.core.listNamespacedPod({ namespace: this.profile.namespace })
      .then(list => list.items.find(item => item.metadata?.uid === reference)?.metadata)
      .catch(() => undefined);
    const owner = metadata?.ownerReferences?.find(entry => entry.kind === 'StatefulSet')?.name;
    // Only resolve when a StatefulSet really owns the pod; otherwise the reference is not ours.
    if (!owner) throw new Error(`No Kubernetes workload owns container ${reference}`);
    return owner;
  }
  /** Ownership check for ids that outlived their pod: only workloads this agent labelled count. */
  private async findWorkloadByUid(uid: string): Promise<string | null> {
    const list = await this.objects.list('apps/v1', 'StatefulSet', this.profile.namespace).catch(() => null);
    const match = list?.items?.find(item => item.metadata?.uid === uid && item.metadata?.labels?.['botroost.endpoint_id']);
    return match?.metadata?.name ?? null;
  }
  async start(name: string): Promise<void> { return this.driver.start(await this.resolveName(name)); }
  async stop(name: string): Promise<void> { return this.driver.stop(await this.resolveName(name)); }
  async restart(name: string): Promise<void> { return this.driver.restart(await this.resolveName(name), `docker-restart-${Date.now()}`); }
  async kill(name: string): Promise<void> { return this.driver.forceRestart(await this.resolveName(name), `docker-kill-${Date.now()}`); }
  async remove(name: string, options?: { discardData?: boolean; owner?: RuntimeOwner }): Promise<void> {
    const workload = await this.resolveName(name);
    // Replacing a workload for a new image/resources must not cost the user their QQ login,
    // so the claim is only dropped when the endpoint itself is being deleted.
    await this.driver.delete(workload);
    if (!options?.discardData) return;
    // Claim last: the pod still mounts it until the workload is gone. A backend that cannot
    // drop the claim must fail loudly rather than report a deletion that kept its data.
    if (!this.driver.deleteData) throw new Error('Runtime driver cannot discard endpoint data');
    await this.driver.deleteData(workload, options.owner);
  }
  // Docker deletes the endpoint's host directory. On Kubernetes the claim is the equivalent
  // durable state and is removed by remove(..., { discardData: true }) above.
  async removeHostEndpoint(): Promise<void> { /* claim removal is handled by remove() */ }
  logs(name: string, options: { tail: number; sinceSeconds: number; timestamps?: boolean; maxBytes?: number }) { return this.driver.logs(name, options); }
  async exec(name: string, args: string[], stdin?: string): Promise<{ stdout: string; stderr: string }> {
    this.signal?.throwIfAborted();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = '', err = '';
    stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    // File content travels over the exec stream, never the command line: PVC writes would
    // otherwise have to survive shell quoting for arbitrary JSON.
    let input: PassThrough | null = null;
    if (stdin !== undefined) { input = new PassThrough(); input.end(stdin); }
    let exitCode: number | null = null;
    const socket = await this.execClient.exec(
      this.profile.namespace, `${name}-0`, 'protocol',
      Array.isArray(args) && args.length ? args : ['/bin/sh'],
      stdout, stderr, input, false,
      (status: V1Status) => {
        // A non-zero exit arrives as a Status object; the code lives in `reason`/`details`.
        const details = status.details as { causes?: { reason?: string; message?: string }[] } | undefined;
        const cause = details?.causes?.find(entry => entry.reason === 'ExitCode');
        if (cause?.message) exitCode = Number(cause.message);
      },
    );
    await this.awaitClose(socket);
    if (exitCode !== null && Number.isFinite(exitCode) && exitCode !== 0) throw new Error(`exec failed (exit ${exitCode}): ${(err || out).trim()}`);
    return { stdout: out, stderr: err };
  }
  /** A wedged exec (API server or network stall) must not hold the provider's serial command
   *  queue forever: the wait races an abort-aware deadline and destroys the socket on expiry. */
  private awaitClose(socket: { on(event: 'close', handler: () => void): unknown; on(event: 'error', handler: (error: Error) => void): unknown; terminate(): void }) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.signal?.removeEventListener('abort', abort);
        if (error) { socket.terminate(); reject(error); } else resolve();
      };
      const abort = () => finish(new Error('exec aborted'));
      const timer = setTimeout(() => finish(new Error(`exec timed out after ${EXEC_TIMEOUT_MS}ms`)), EXEC_TIMEOUT_MS);
      if (this.signal?.aborted) { finish(new Error('exec aborted')); return; }
      this.signal?.addEventListener('abort', abort, { once: true });
      socket.on('close', () => finish());
      socket.on('error', (error: Error) => finish(error));
    });
  }
  // Resource telemetry via metrics.k8s.io, keyed by pod UID to match inspect().id.
  async stats(podUids: string[]): Promise<Map<string, DockerResourceSample>> {
    const ids = [...new Set(podUids)];
    if (!ids.length || !this.metricsApi) return new Map();
    const wanted = new Set(ids);
    const list = await this.metricsApi.getPodMetrics(this.profile.namespace);
    const result = new Map<string, DockerResourceSample>();
    for (const pod of list.items) {
      const uid = (pod.metadata as { uid?: string } | undefined)?.uid;
      if (!uid || !wanted.has(uid)) continue;
      let nanoCpus = 0, memoryBytes = 0;
      for (const container of pod.containers) {
        nanoCpus += parseQuantity(container.usage?.cpu);
        memoryBytes += parseQuantity(container.usage?.memory);
      }
      if (nanoCpus > 0 || memoryBytes > 0) result.set(uid, { cpuPercent: nanoCpus / 10_000_000, memoryBytes: Math.round(memoryBytes) });
    }
    return result;
  }
  /** Prime the volume map for a workload that already exists (agent restart). */
  async adopt(name: string) { await this.volumesFor(name); }
}
// Parses Kubernetes resource quantities ("8073539n", "258980Ki", "2G") into base units.
function parseQuantity(value: string | undefined): number {
  if (!value) return 0;
  const match = /^(\d+(?:\.\d+)?)(m|u|n|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/.exec(value.trim());
  if (!match) return 0;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return 0;
  switch (match[2]) {
    case undefined: case 'n': return base;
    case 'u': return base * 1_000;
    case 'm': return base * 1_000_000;
    case 'k': return base * 1e3;
    case 'M': return base * 1e6;
    case 'G': return base * 1e9;
    case 'T': return base * 1e12;
    case 'P': return base * 1e15;
    case 'E': return base * 1e18;
    case 'Ki': return base * 1024;
    case 'Mi': return base * 1024 ** 2;
    case 'Gi': return base * 1024 ** 3;
    case 'Ti': return base * 1024 ** 4;
    case 'Pi': return base * 1024 ** 5;
    case 'Ei': return base * 1024 ** 6;
    default: return 0;
  }
}
