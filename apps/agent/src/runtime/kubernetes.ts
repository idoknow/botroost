import { CoreV1Api, KubeConfig, KubernetesObjectApi, PatchStrategy, Metrics, type KubernetesObject } from '@kubernetes/client-node';
import type { DockerInspectResult } from '../index.js';
import type { DockerResourceSample } from '../resource-usage.js';
import type { RuntimeDriver, RuntimeSpec } from './types.js';
import { kubernetesResources, type KubernetesProfile } from './kubernetes-resources.js';
// Dynamic discovery API spans several resource schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ObjectState = KubernetesObject & { spec?: any; status?: { containerStatuses?: { name: string; state?: { running?: object } }[] }; data?: Record<string,string> };
/** Namespace-scoped API driver. Never executes in a pod or force-deletes a lost node's pod. */
export class KubernetesRuntimeDriver implements RuntimeDriver {
  readonly backend = 'kubernetes' as const;
  private objects: KubernetesObjectApi;
  private core: CoreV1Api;
  private metricsApi?: Metrics;
  constructor(private profile: KubernetesProfile, private signal?: AbortSignal, config?: KubeConfig) {
    const kc = config ?? new KubeConfig();
    if (!config) kc.loadFromCluster();
    this.objects = KubernetesObjectApi.makeApiClient(kc);
    this.core = kc.makeApiClient(CoreV1Api);
    this.metricsApi = new Metrics(kc);
  }
  private ref(kind: string, name: string) {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 63) throw new Error('Invalid runtime name');
    return { apiVersion: kind === 'StatefulSet' ? 'apps/v1' : 'v1', kind, metadata: { name, namespace: this.profile.namespace } };
  }
  private async read(kind: string, name: string): Promise<ObjectState | null> {
    this.signal?.throwIfAborted();
    try { return await this.objects.read(this.ref(kind, name)) as ObjectState; }
    catch (error) { if ((error as {code?:number}).code === 404) return null; throw error; }
  }
  private owned(object: ObjectState, labels: Record<string,string>) {
    for (const key of ['botroost.endpoint_id', 'botroost.workspace_id', 'botroost.provider']) if (!labels[key] || object.metadata?.labels?.[key] !== labels[key]) throw new Error('Runtime resource ownership mismatch');
  }
  private async put(object: ObjectState) {
    this.signal?.throwIfAborted();
    const old = await this.read(object.kind!, object.metadata!.name!);
    if (!old) return this.objects.create(object);
    this.owned(old, object.metadata!.labels!);
    if (object.kind === 'PersistentVolumeClaim') return old;
    if (object.kind === 'StatefulSet') object.spec.replicas = old.spec.replicas;
    return this.objects.patch({ ...object, metadata: { ...object.metadata, resourceVersion: old.metadata!.resourceVersion! } }, undefined, undefined, 'botroost-agent', undefined, PatchStrategy.MergePatch);
  }
  async ensure(spec: RuntimeSpec) {
    const resources = kubernetesResources(spec, this.profile);
    for (const object of [resources.secret, resources.pvc, resources.service, resources.governing, resources.workload]) await this.put(object);
  }
  async inspect(name: string): Promise<DockerInspectResult | null> {
    const workload = await this.read('StatefulSet', name);
    if (!workload) return null;
    const pod = await this.read('Pod', `${name}-0`);
    const container = workload.spec.template.spec.containers[0];
    const running = workload.spec.replicas === 1 && !pod?.metadata?.deletionTimestamp && !!pod?.status?.containerStatuses?.some(c => c.name === 'protocol' && c.state?.running);
    return { id: pod?.metadata?.uid ?? workload.metadata!.uid!, name, image: container.image,
      state: running ? 'running' : workload.spec.replicas === 0 ? 'exited' : 'created',
      ipAddress: running ? `${name}.${this.profile.namespace}.svc` : null,
      labels: workload.metadata!.labels ?? {},
    };
  }
  private async wait(check: () => Promise<boolean>) {
    const end = Date.now() + 110_000;
    do {
      this.signal?.throwIfAborted();
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < end);
    throw new Error('Runtime convergence timed out; old pod is not forcibly removed');
  }
  private async scale(name: string, replicas: number) {
    const old = await this.read('StatefulSet', name);
    if (!old) throw new Error('Runtime not found');
    this.signal?.throwIfAborted();
    await this.objects.patch({ ...this.ref('StatefulSet', name), metadata: { ...old.metadata }, spec: { replicas } } as ObjectState, undefined, undefined, 'botroost-agent', undefined, PatchStrategy.MergePatch);
  }
  async start(name: string) { await this.scale(name, 1); await this.wait(async () => (await this.inspect(name))?.state === 'running'); }
  async stop(name: string) { await this.scale(name, 0); await this.wait(async () => !(await this.read('Pod', `${name}-0`))); }
  private async remove(object: ObjectState) {
    this.signal?.throwIfAborted();
    await this.objects.delete(object, undefined, undefined, undefined, undefined, 'Foreground', { preconditions: { uid: object.metadata!.uid!, resourceVersion: object.metadata!.resourceVersion! } });
    await this.wait(async () => {
      const current = await this.read(object.kind!, object.metadata!.name!);
      return !current || current.metadata?.uid !== object.metadata!.uid;
    });
  }
  async restart(name: string, operation: string) {
    const workload = await this.read('StatefulSet', name);
    if (!workload) throw new Error('Runtime not found');
    // Durable template marker makes replay after pod deletion idempotent.
    const pod = await this.read('Pod', `${name}-0`);
    const marker = 'botroost.io/restart-operation';
    await this.objects.patch({ ...this.ref('StatefulSet', name), metadata: workload.metadata, spec: { template: { metadata: { annotations: { [marker]: operation } } } } } as ObjectState, undefined, undefined, 'botroost-agent', undefined, PatchStrategy.MergePatch);
    if (pod && pod.metadata?.annotations?.[marker] !== operation) { this.owned(pod, workload.metadata!.labels!); await this.remove(pod); }
    await this.start(name);
  }
  forceRestart(name: string, operation: string) { return this.restart(name, operation); }
  async delete(name: string) {
    const workload = await this.read('StatefulSet', name);
    if (!workload) throw new Error('Runtime ownership unavailable; retained resources require operator review');
    await this.stop(name);
    // Workload removed last so interrupted cleanup retains ownership evidence.
    for (const [kind, resourceName] of [['Service', name], ['Service', `${name}-head`], ['Secret', name], ['PersistentVolumeClaim', name], ['StatefulSet', name]]) {
      const object = await this.read(kind!, resourceName!);
      if (object) { this.owned(object, workload.metadata!.labels!); await this.remove(object); }
    }
  }
  async logs(name: string, options: { tail: number; sinceSeconds: number; timestamps?: boolean; maxBytes?: number }) {
    const text = await this.core.readNamespacedPodLog({ name: `${name}-0`, namespace: this.profile.namespace, container: 'protocol', tailLines: options.tail, sinceSeconds: options.sinceSeconds, timestamps: options.timestamps ?? false, limitBytes: options.maxBytes ?? 1048576 });
    return text;
  }
  // Resource telemetry via metrics.k8s.io: keys are pod UIDs, matching inspect()'s `id`.
  async stats(podUids: string[], signal?: AbortSignal) {
    const ids = [...new Set(podUids)];
    if (!ids.length || !this.metricsApi) return new Map();
    const wanted = new Set(ids);
    const list = await this.metricsApi.getPodMetrics(this.profile.namespace);
    signal?.throwIfAborted();
    const result = new Map<string, DockerResourceSample>();
    for (const pod of list.items) {
      // client-node's PodMetric type omits `uid`, but metrics-server always sends it.
      const uid = (pod.metadata as { uid?: string } | undefined)?.uid;
      if (!uid || !wanted.has(uid)) continue;
      let nanoCpus = 0, memoryBytes = 0;
      for (const container of pod.containers) {
        nanoCpus += parseKubernetesQuantity(container.usage?.cpu);
        memoryBytes += parseKubernetesQuantity(container.usage?.memory);
      }
      if (nanoCpus > 0 || memoryBytes > 0) result.set(uid, { cpuPercent: nanoCpus / 10_000_000, memoryBytes: Math.round(memoryBytes) });
    }
    return result;
  }
}
// Parses Kubernetes resource quantities ("8073539n", "258980Ki", "2G") into base units (nanocores, bytes).
function parseKubernetesQuantity(value: string | undefined): number {
  if (!value) return 0;
  const match = /^(\d+(?:\.\d+)?)(m|u|n|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/.exec(value.trim());
  if (!match) return 0;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return 0;
  switch (match[2]) {
    case undefined: return base;
    case 'n': return base;
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
