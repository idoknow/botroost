import { CoreV1Api, KubeConfig, KubernetesObjectApi, PatchStrategy, Metrics, type KubernetesObject } from '@kubernetes/client-node';
import type { DockerInspectResult } from '../index.js';
import type { DockerResourceSample } from '../resource-usage.js';
import type { RuntimeDriver, RuntimeOwner, RuntimeSpec } from './types.js';
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
  /** Pod UID -> pod name. metrics-server omits metadata.uid from PodMetrics, so stats() has to
   *  match on name; inspect() records the pair because it already reads the pod. */
  private podUidToName = new Map<string, string>();
  private kc: KubeConfig;
  constructor(private profile: KubernetesProfile, private signal?: AbortSignal, config?: KubeConfig) {
    const kc = config ?? new KubeConfig();
    if (!config) kc.loadFromCluster();
    this.kc = kc;
    this.objects = KubernetesObjectApi.makeApiClient(kc);
    this.core = kc.makeApiClient(CoreV1Api);
    this.metricsApi = new Metrics(kc);
  }
  /** The kind alone does not determine the group: a NetworkPolicy lives in networking.k8s.io,
   *  and guessing 'v1' made every read and delete of one fail with "Unrecognized API version". */
  private static readonly apiVersions: Record<string, string> = {
    StatefulSet: 'apps/v1', Service: 'v1', Pod: 'v1', PersistentVolumeClaim: 'v1',
    NetworkPolicy: 'networking.k8s.io/v1', Secret: 'v1', ConfigMap: 'v1',
  };
  private ref(kind: string, name: string) {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 63) throw new Error('Invalid runtime name');
    const apiVersion = KubernetesRuntimeDriver.apiVersions[kind];
    if (!apiVersion) throw new Error(`Unsupported runtime kind ${kind}`);
    return { apiVersion, kind, metadata: { name, namespace: this.profile.namespace } };
  }
  private async read(kind: string, name: string): Promise<ObjectState | null> {
    this.signal?.throwIfAborted();
    try { return await this.objects.read(this.ref(kind, name)) as ObjectState; }
    catch (error) { if ((error as {code?:number}).code === 404) return null; throw error; }
  }
  /** Every writer of a runtime object -- the control loop, the kubelet and our own ensure() --
   *  bumps its resourceVersion, so a patch carrying a version read a moment earlier loses the
   *  race with a 409. That conflict is normal, not a failure: re-read and apply again. */
  private static conflicted(error: unknown) {
    const status = error as { code?: number; statusCode?: number; body?: { code?: number } };
    return status.code === 409 || status.statusCode === 409 || status.body?.code === 409;
  }
  private async retryConflict<T>(write: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { return await write(); }
      catch (error) {
        if (!KubernetesRuntimeDriver.conflicted(error)) throw error;
        last = error;
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    throw last;
  }
  private async patch(object: ObjectState) {
    return this.retryConflict(async () => {
      const current = await this.read(object.kind!, object.metadata!.name!);
      if (!current) throw new Error('Runtime resource disappeared before it could be updated');
      return this.objects.patch({ ...object, metadata: { ...object.metadata, resourceVersion: current.metadata!.resourceVersion! } }, undefined, undefined, 'botroost-agent', undefined, PatchStrategy.MergePatch);
    });
  }
  /** Both the agent-wide shutdown signal and the per-command signal fence every destructive
   *  request: a command whose lease was lost must not delete anything. */
  private guard(signal?: AbortSignal) {
    this.signal?.throwIfAborted();
    signal?.throwIfAborted();
  }
  private owned(object: ObjectState, labels: Record<string,string>) {
    for (const key of ['botroost.endpoint_id', 'botroost.workspace_id', 'botroost.provider']) if (!labels[key] || object.metadata?.labels?.[key] !== labels[key]) throw new Error('Runtime resource ownership mismatch');
  }
  private async put(object: ObjectState) {
    this.signal?.throwIfAborted();
    // A create that loses a race to the control loop's own create surfaces as a 409 too.
    return this.retryConflict(async () => {
      const old = await this.read(object.kind!, object.metadata!.name!);
      if (!old) return this.objects.create(object);
      this.owned(old, object.metadata!.labels!);
      if (object.kind === 'PersistentVolumeClaim') return old;
      if (object.kind === 'StatefulSet') object.spec.replicas = old.spec.replicas;
      return this.patch(object);
    });
  }
  async ensure(spec: RuntimeSpec) {
    const resources = kubernetesResources(spec, this.profile);
    for (const object of [resources.secret, resources.pvc, resources.service, resources.governing, resources.networkPolicy, resources.workload].filter(Boolean)) await this.put(object!);
  }
  async inspect(name: string): Promise<DockerInspectResult | null> {
    const workload = await this.read('StatefulSet', name);
    if (!workload) return null;
    // read() is typed for the resources this client writes; a Pod also carries a status.podIP.
    const pod = await this.read('Pod', `${name}-0`) as (ObjectState & { status?: { podIP?: string } }) | null;
    // Keep the UID->name pair for stats(): PodMetrics carries no uid, and this pod is already in
    // hand, so the mapping costs no extra API call. A recreated pod replaces the old entry.
    if (pod?.metadata?.uid && pod.metadata.name) {
      const podName = pod.metadata.name;
      this.podUidToName.forEach((known, uid) => { if (known === podName) this.podUidToName.delete(uid); });
      this.podUidToName.set(pod.metadata.uid, podName);
    }
    const service = await this.read('Service', name) as (ObjectState & { spec?: { clusterIP?: string } }) | null;
    const clusterIP = service?.spec?.clusterIP && service.spec.clusterIP !== 'None' ? service.spec.clusterIP : undefined;
    const template = (workload as { spec: { template: { spec: { containers: { image: string; resources?: { limits?: Record<string, string>; requests?: Record<string, string> }; envFrom?: { secretRef?: { name?: string } }[]; volumeMounts?: { mountPath: string }[] }[] } } } }).spec.template.spec;
    const container = template.containers[0]!;
    const running = workload.spec.replicas === 1 && !pod?.metadata?.deletionTimestamp && !!pod?.status?.containerStatuses?.some(c => c.name === 'protocol' && c.state?.running);
    const envSecret = container.envFrom?.find(source => source.secretRef?.name)?.secretRef?.name;
    return { id: pod?.metadata?.uid ?? workload.metadata!.uid!, name, image: container.image,
      mountTargets: (container.volumeMounts ?? []).map(mount => mount.mountPath).filter(Boolean),
      state: running ? 'running' : workload.spec.replicas === 0 ? 'exited' : 'created',
      // The pod IP is what providers dial from the agent: it needs no cluster DNS, which a
      // cluster without CoreDNS cannot resolve.
      ipAddress: running ? pod?.status?.podIP ?? null : null,
      // What the console's API dials. The ClusterIP needs no cluster DNS (a cluster without
      // CoreDNS cannot resolve Service names), and the Service name is the fallback for a
      // cluster that reports the address late.
      serviceHost: running ? clusterIP ?? `${name}.${this.profile.namespace}.svc` : null,
      labels: workload.metadata!.labels ?? {},
      ...this.reportedResources(container.resources?.limits, container.resources?.requests),
      ...await this.reportedProxy(envSecret),
    };
  }
  /** Providers compare inspect() against the desired configuration to detect drift, so the
   *  limits they asked for have to come back or every reconcile looks like a change. */
  private reportedResources(limits?: Record<string, string>, requests?: Record<string, string>) {
    const cpu = limits?.cpu ?? requests?.cpu;
    const memory = limits?.memory ?? requests?.memory;
    const cpuMillis = cpu === undefined ? undefined : parseKubernetesQuantity(cpu) / 1_000_000;
    const memoryMiB = memory === undefined ? undefined : Math.round(parseKubernetesQuantity(memory) / (1024 * 1024));
    if (cpuMillis === undefined || memoryMiB === undefined) return {};
    // Kubernetes states one memory figure; Docker echoes it as both, so report the same.
    return { resources: { cpuMillis, memoryMiB, memorySwapMiB: memoryMiB } };
  }
  /** Proxy settings are delivered through envFrom (the rendered Secret), which is also where
   *  the provider expects to find them again when it compares for drift. */
  private async reportedProxy(secretName: string | undefined) {
    if (!secretName) return {};
    const object = await this.read('Secret', secretName) as ObjectState | null;
    if (!object?.data) return {};
    const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
    const proxyEnvironment = Object.fromEntries(keys.map(key => {
      const raw = object.data?.[key];
      return [key, raw === undefined ? '' : Buffer.from(raw, 'base64').toString('utf8')];
    }) as [string, string][]);
    // An endpoint with no proxy configured keeps a Secret full of empty strings; reporting
    // those back would look like a configured proxy, so omit the field entirely.
    return Object.values(proxyEnvironment).some(value => value !== '') ? { proxyEnvironment } : {};
  }
  private async settled(check: () => Promise<boolean>, timeoutMs = 110_000) {
    const end = Date.now() + timeoutMs;
    do {
      this.signal?.throwIfAborted();
      if (await check()) return true;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < end);
    return false;
  }
  private async wait(check: () => Promise<boolean>) {
    if (!await this.settled(check)) throw new Error('Runtime convergence timed out; old pod is not forcibly removed');
  }
  private async scale(name: string, replicas: number) {
    const old = await this.read('StatefulSet', name);
    if (!old) throw new Error('Runtime not found');
    this.signal?.throwIfAborted();
    await this.patch({ ...this.ref('StatefulSet', name), metadata: { ...old.metadata }, spec: { replicas } } as ObjectState);
  }
  async start(name: string) { await this.scale(name, 1); await this.wait(async () => (await this.inspect(name))?.state === 'running'); }
  async stop(name: string) { await this.scale(name, 0); await this.wait(async () => !(await this.read('Pod', `${name}-0`))); }
  private async remove(object: ObjectState) {
    this.signal?.throwIfAborted();
    // The uid precondition is what keeps a replacement pod from being deleted by a stale call;
    // the resourceVersion one only added conflicts, since a running pod's version moves with
    // every status update.
    await this.retryConflict(async () => {
      const current = await this.read(object.kind!, object.metadata!.name!);
      if (!current || current.metadata?.uid !== object.metadata!.uid) return;
      await this.objects.delete(current, undefined, undefined, undefined, undefined, 'Foreground', { preconditions: { uid: current.metadata!.uid! } });
    });
    await this.wait(async () => {
      const current = await this.read(object.kind!, object.metadata!.name!);
      return !current || current.metadata?.uid !== object.metadata!.uid;
    });
  }
  async restart(name: string, operation: string) {
    const workload = await this.read('StatefulSet', name);
    if (!workload) throw new Error('Runtime not found');
    // Durable template marker makes replay after pod deletion idempotent.
    // read() is typed for the resources this client writes; a Pod also carries status.podIP.
    const pod = await this.read('Pod', `${name}-0`) as ObjectState | null;
    const marker = 'botroost.io/restart-operation';
    const previousMarker = (workload as { spec?: { template?: { metadata?: { annotations?: Record<string,string> } } } }).spec?.template?.metadata?.annotations?.[marker];
    await this.patch({ ...this.ref('StatefulSet', name), metadata: workload.metadata, spec: { template: { metadata: { annotations: { [marker]: operation } } } } } as ObjectState);
    if (!pod || pod.metadata?.annotations?.[marker] === operation) return this.start(name);
    this.owned(pod, workload.metadata!.labels!);
    // The pod still runs the request it was created with -- a pod's resources are immutable --
    // so it is the record of what to fall back to if the replacement cannot be placed.
    const previous = podResources(pod);
    await this.remove(pod);
    if (await this.waitForReplacement(name, pod.metadata!.uid!)) return;
    // ensure() already wrote a larger request to the template, so the replacement needs more
    // capacity than the pod that just went away. On a node without that headroom it stays
    // Pending: without this fallback the endpoint would simply be down, serving nothing.
    const restored = await this.restore(name, previous, marker, previousMarker);
    throw new Error(restored
      ? 'The replacement workload could not be scheduled; the endpoint is running again on its previous resources'
      : 'The replacement workload could not be scheduled and the previous resources could not be restored; operator review required');
  }
  /** Waits for the pod that replaced `previousUid` to run. Gives up early when the scheduler
   *  has already rejected it: an unschedulable pod does not become runnable by waiting. */
  private async waitForReplacement(name: string, previousUid: string) {
    const end = Date.now() + 110_000;
    do {
      this.signal?.throwIfAborted();
      const pod = await this.read('Pod', `${name}-0`) as (ObjectState & { status?: { conditions?: { type?: string; status?: string; reason?: string }[] } }) | null;
      if (pod && pod.metadata?.uid !== previousUid) {
        if ((await this.inspect(name))?.state === 'running') return true;
        const rejected = pod.status?.conditions?.some(condition => condition.type === 'PodScheduled' && condition.status === 'False' && condition.reason === 'Unschedulable');
        if (rejected) return false;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < end);
    return false;
  }
  /** Rewrites the replaced pod's resources onto the template and waits for a pod of that size,
   *  so a request the cluster cannot satisfy still ends with the endpoint serving. */
  private async restore(name: string, previous: Record<string, unknown>, marker: string, previousMarker: string | undefined) {
    const current = await this.read('StatefulSet', name);
    if (!current) return false;
    const template = (current as { spec?: { template?: { spec?: { initContainers?: { name: string }[]; containers?: { name: string }[] } } } }).spec?.template;
    const sized = (containers: { name: string }[] | undefined) => (containers ?? []).map(container => previous[container.name] === undefined ? container : { ...container, resources: previous[container.name] });
    await this.patch({ ...this.ref('StatefulSet', name), metadata: current.metadata, spec: { template: {
      // Restoring the marker as well lets a retry of the same operation run again instead of
      // being mistaken for a completed rollout.
      metadata: { annotations: { [marker]: previousMarker ?? null } },
      spec: { initContainers: sized(template?.spec?.initContainers), containers: sized(template?.spec?.containers) },
    } } } as ObjectState);
    // The pending replacement was built from the larger request, so it has to go for the
    // controller to create one that fits.
    const stuck = await this.read('Pod', `${name}-0`);
    if (stuck) { this.owned(stuck, current.metadata!.labels!); await this.remove(stuck); }
    return this.settled(async () => (await this.inspect(name))?.state === 'running');
  }
  forceRestart(name: string, operation: string) { return this.restart(name, operation); }
  /** Removes the workload and its supporting objects but keeps the claim: replacement (image,
   *  resources, proxy) must not discard the login state stored on the endpoint's volume. */
  async delete(name: string, signal?: AbortSignal) {
    this.guard(signal);
    const workload = await this.read('StatefulSet', name);
    // A retry after a failed claim cleanup finds no workload: the resources are already gone,
    // so there is nothing left to refuse. Only an unknown owner is an operator problem.
    if (workload) {
      await this.stop(name);
      // Workload removed last so interrupted cleanup retains ownership evidence.
      for (const [kind, resourceName] of [['NetworkPolicy', `${name}-ingress`], ['Service', name], ['Service', `${name}-head`], ['Secret', name], ['StatefulSet', name]]) {
        const object = await this.read(kind!, resourceName!);
        if (object) { this.guard(signal); this.owned(object, workload.metadata!.labels!); await this.remove(object); }
      }
      return;
    }
    const survivors = (await Promise.all([['NetworkPolicy', `${name}-ingress`], ['Service', name], ['Service', `${name}-head`], ['Secret', name]].map(([kind, resourceName]) => this.read(kind!, resourceName!))))
      .filter((object): object is ObjectState => Boolean(object));
    if (survivors.length) throw new Error('Runtime ownership unavailable; retained resources require operator review');
  }
  /** Explicit endpoint deletion, which is the only path allowed to destroy durable data.
   *  `owner` is the identity of the endpoint being deleted: a claim that merely carries labels
   *  identical to itself would let a reused name destroy another endpoint's data. */
  async deleteData(name: string, owner: RuntimeOwner = {}, signal?: AbortSignal) {
    this.guard(signal);
    const claim = await this.read('PersistentVolumeClaim', name);
    if (!claim) return;
    const anonymous = owner.endpointId === undefined && owner.workspaceId === undefined && owner.provider === undefined;
    // No identity supplied: the claim is only allowed to vouch for itself.
    const expected: Record<string, string> = anonymous
      ? claim.metadata!.labels ?? {}
      : { 'botroost.endpoint_id': owner.endpointId!, 'botroost.workspace_id': owner.workspaceId!, 'botroost.provider': owner.provider! };
    this.owned(claim, expected);
    this.guard(signal);
    await this.remove(claim);
  }
  async logs(name: string, options: { tail: number; sinceSeconds: number; timestamps?: boolean; maxBytes?: number }) {
    // read() is typed for the resources this client writes; a Pod also carries a status.podIP.
    const pod = await this.read('Pod', `${name}-0`) as (ObjectState & { status?: { podIP?: string } }) | null;
    // A stopped endpoint has been scaled to zero, which removes the pod and with it the pod
    // log. Report that instead of failing the operator's diagnostic request.
    if (!pod || pod.metadata?.deletionTimestamp) return '';
    try {
      return await this.core.readNamespacedPodLog({ name: `${name}-0`, namespace: this.profile.namespace, container: 'protocol', tailLines: options.tail, sinceSeconds: options.sinceSeconds, timestamps: options.timestamps ?? false, limitBytes: options.maxBytes ?? 1048576 });
    } catch (error) {
      // The pod can disappear between the read and the log request; that is the same answer.
      if ((error as { code?: number }).code === 404) return '';
      throw error;
    }
  }
  // Resource telemetry via metrics.k8s.io: keys are pod UIDs, matching inspect()'s `id`.
  async stats(podUids: string[], signal?: AbortSignal) {
    const ids = [...new Set(podUids)];
    if (!ids.length || !this.metricsApi) return new Map();
    const wanted = new Set(ids);
    // metrics-server omits metadata.uid from PodMetrics (verified against the hk cluster), so
    // fall back to the pod name inspect() recorded for each UID.
    const byName = new Map<string, string>();
    ids.forEach(uid => { const name = this.podUidToName.get(uid); if (name) byName.set(name, uid); });
    const list = await this.metricsApi.getPodMetrics(this.profile.namespace);
    signal?.throwIfAborted();
    const result = new Map<string, DockerResourceSample>();
    for (const pod of list.items) {
      const uid = (pod.metadata as { uid?: string } | undefined)?.uid;
      const name = pod.metadata?.name;
      const key = uid && wanted.has(uid) ? uid : name ? byName.get(name) : undefined;
      if (!key) continue;
      let nanoCpus = 0, memoryBytes = 0;
      for (const container of pod.containers) {
        nanoCpus += parseKubernetesQuantity(container.usage?.cpu);
        memoryBytes += parseKubernetesQuantity(container.usage?.memory);
      }
      if (nanoCpus > 0 || memoryBytes > 0) result.set(key, { cpuPercent: nanoCpus / 10_000_000, memoryBytes: Math.round(memoryBytes) });
    }
    return result;
  }
}
/** The resources a running pod was created with, per container name. A pod cannot be resized in
 *  place, so this is the only surviving record of what the endpoint ran on before an update. */
function podResources(pod: ObjectState): Record<string, unknown> {
  const containers = (pod as { spec?: { initContainers?: { name: string; resources?: unknown }[]; containers?: { name: string; resources?: unknown }[] } }).spec;
  return Object.fromEntries([...(containers?.initContainers ?? []), ...(containers?.containers ?? [])]
    .filter(container => container.resources !== undefined)
    .map(container => [container.name, container.resources]));
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

/** Kubernetes Service name for a workload: RFC 1123 label, at most 63 characters. */
export function dnsLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/g, "");
}
