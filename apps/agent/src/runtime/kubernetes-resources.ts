import type { RuntimeSpec } from './types.js';
export interface KubernetesProfile { namespace: string; storageClass?: string; volumeSize: string; nodeSelector?: Record<string,string>; /** Namespace the agent runs in. When set, each runtime Service is fenced off so only the
   *  agent can reach the provider's management/UI ports. */ agentNamespace?: string; /** Extra namespaces allowed to reach the UI ports, e.g. the console API's own namespace: it
   *  proxies the runtime UI, so fencing it out would break every login screen. */ consoleNamespaces?: string[] }
/** Longest workload name the API server accepts here. Not 63: the StatefulSet controller
 *  labels every pod it creates with `controller-revision-hash` = "<workload name>-<10 char
 *  revision>", and a label value over 63 characters makes the pod invalid, so the controller
 *  retries the create forever. 63 - 1 - 10 = 52. */
export const WORKLOAD_NAME_LIMIT = 52;
const namePattern = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
export function kubernetesResources(input: RuntimeSpec, profile: KubernetesProfile) {
  // The namespace is not a workload name: it is capped at 63 like any other label-sized name.
  if (!namePattern.test(profile.namespace) || profile.namespace.length > 63) throw new Error('Invalid Kubernetes namespace');
  if (!namePattern.test(input.name) || input.name.length > WORKLOAD_NAME_LIMIT) throw new Error('Invalid Kubernetes resource name');
  const metadata = { name: input.name, namespace: profile.namespace, labels: input.labels };
  // The Service selector must be unique to this workload. An endpoint id alone matches any
  // other ready pod that carries it (another workspace or provider reusing the id), and the
  // ClusterIP would then route provider traffic to the wrong runtime. The StatefulSet
  // template and the pod labels get `botroost.workload` so the selector stays exact.
  const workloadLabels = { ...input.labels, 'botroost.workload': input.name };
  const selector = Object.fromEntries(Object.entries(workloadLabels).filter(([key]) => key !== 'botroost.generation'));
  const secret = { apiVersion: 'v1', kind: 'Secret', metadata, type: 'Opaque', stringData: { HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '', no_proxy: '', ...input.environment } };
  // Claims are retained on workload deletion/scaling (see whenDeleted below), so a replaced
  // runtime instance reattaches the same login state instead of starting from an empty one.
  const pvc = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { ...metadata }, spec: { accessModes: ['ReadWriteOnce'], ...(profile.storageClass ? { storageClassName: profile.storageClass } : {}), resources: { requests: { storage: profile.volumeSize } } } };
  // Providers address each other by Service name (<name>.<namespace>.svc), so every
  // container port the provider talks to must be a Service port: Docker publishing and
  // Kubernetes Service ports are the same contract from the provider's point of view.
  const ports = input.ports?.length ? input.ports : [{ name: 'management', port: 6099 }];
  const service = { apiVersion: 'v1', kind: 'Service', metadata, spec: { type: 'ClusterIP', selector, ports: ports.map(port => ({ name: port.name, port: port.port, targetPort: port.port })) } };
  const governing = { ...service, metadata: { ...metadata, name: `${input.name}-head` }, spec: { ...service.spec, clusterIP: 'None' } };
  // ClusterIP alone is not isolation: every pod in the cluster can dial the endpoint's UI and
  // remote-desktop ports and bypass the agent's command authorisation. The policy admits only
  // the agent namespace, so the runtime is reachable exactly where it is consumed. It is only
  // rendered when the agent namespace is known, and only a CNI that enforces policy (Calico,
  // Cilium) acts on it -- flannel silently ignores NetworkPolicy.
  const networkPolicy = profile.agentNamespace ? {
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: { ...metadata, name: `${input.name}-ingress` },
    spec: {
      podSelector: { matchLabels: workloadLabels },
      policyTypes: ['Ingress'],
      // The console API dials the UI ports through this proxy, and it usually runs in a
      // namespace of its own: both its namespace and the agent's are allowed, nothing else.
      ingress: [{
        from: [profile.agentNamespace, ...(profile.consoleNamespaces ?? [])]
          .filter((namespace, index, all) => namespace && all.indexOf(namespace) === index)
          .map(namespace => ({ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } } })),
        ports: ports.map(port => ({ protocol: 'TCP', port: port.port })),
      }],
    },
  } : null;
  const resources = { requests: { cpu: `${input.resources.cpuMillis}m`, memory: `${input.resources.memoryMiB}Mi` }, limits: { cpu: `${input.resources.cpuMillis}m`, memory: `${input.resources.memoryMiB}Mi` } };
  // Storage prep must create every subPath the workload mounts; an unset subPath makes
  // the mount fail with no base directory, so derive the list instead of hardcoding.
  // The init container usually runs as root; the protocol process does not. Create each subPath
  // world-writable so the provider can write its state (login token, machine-id) into it.
  const directories = [...new Set(input.volumes.map(volume => volume.name))]
    .map(name => `mkdir -p /data/${name} && chmod 0777 /data/${name}`).join('\n        ');
  const containerSecurity: Record<string, unknown> = { allowPrivilegeEscalation: false };
  // Docker's --cap-add. Kubernetes grants the same capability through the container
  // security context; anything not requested stays out of the pod.
  if (input.capAdd?.length) { containerSecurity.capabilities = { add: input.capAdd }; containerSecurity.allowPrivilegeEscalation = true; }
  // Docker's --security-opt. seccomp=unconfined is expressed as an explicit profile, and
  // the pod-level profile must not then override it back to RuntimeDefault.
  const seccompUnconfined = (input.securityOpt ?? []).some(option => /^seccomp[=:]unconfined$/i.test(option));
  if (seccompUnconfined) containerSecurity.seccompProfile = { type: 'Unconfined' };
  const workload = { apiVersion: 'apps/v1', kind: 'StatefulSet', metadata, spec: {
    replicas: 0, serviceName: governing.metadata.name, updateStrategy: { type: 'OnDelete' },
    // The StatefulSet selector is immutable, so it keeps matching exactly what earlier
    // workloads created; the Service selector (above) uses the full label set instead.
    selector: { matchLabels: { 'botroost.endpoint_id': input.labels['botroost.endpoint_id']! } },
    template: { metadata: { labels: workloadLabels }, spec: {
      automountServiceAccountToken: false, terminationGracePeriodSeconds: 30,
      ...(profile.nodeSelector ? { nodeSelector: profile.nodeSelector } : {}),
      ...(seccompUnconfined ? {} : { securityContext: { seccompProfile: { type: 'RuntimeDefault' } } }),
      initContainers: [{ name: 'storage', image: input.image, command: ['/bin/sh', '-ec', `
        ${directories}
        # Self-heal WebUI token drift: the PVC's webui.json persists the token from the
        # FIRST boot, so a rotated agent NAPCAT_TOKEN would be rejected forever. Rewrite
        # the persisted config from the (authoritative) Secret on every start.
        if [ -n "$NAPCAT_WEBUI_SECRET_KEY" ] && [ -d /data/config ]; then
          mkdir -p /data/config
          if [ -f /data/config/webui.json ]; then
            sed -i "s/^\\([[:space:]]*\\"token\\"[[:space:]]*:[[:space:]]*\\)[^,}]*/\\1\\"$NAPCAT_WEBUI_SECRET_KEY\\"/" /data/config/webui.json
          else
            printf '{"host":"::","port":6099,"token":"%s"}\\n' "$NAPCAT_WEBUI_SECRET_KEY" > /data/config/webui.json
          fi
        fi
      `], securityContext: { allowPrivilegeEscalation: false }, resources, volumeMounts: [{ name: 'data', mountPath: '/data' }] }],
      containers: [{ name: 'protocol', image: input.image, envFrom: [{ secretRef: { name: input.name } }], resources,
        securityContext: containerSecurity,
        ports: ports.map(port => ({ name: port.name, containerPort: port.port })),
        startupProbe: { tcpSocket: { port: ports[0]!.port }, periodSeconds: 5, failureThreshold: 60 },
        readinessProbe: { tcpSocket: { port: ports[0]!.port }, periodSeconds: 10 },
        volumeMounts: [
          ...input.volumes.map(volume => ({ name: 'data', mountPath: volume.target, subPath: volume.name })),
          ...(input.shmBytes ? [{ name: 'shm', mountPath: '/dev/shm' }] : []),
        ] }],
      // Docker's --shm-size. Pods default to 64Mi; providers driving a Chromium-based
      // login flow need the larger shared memory segment or the browser crashes.
      volumes: [
        { name: 'data', persistentVolumeClaim: { claimName: input.name } },
        ...(input.shmBytes ? [{ name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: `${Math.ceil(input.shmBytes / (1024 * 1024))}Mi` } }] : []),
      ],
    } },
  } };
  return { secret, pvc, service, governing, networkPolicy, workload };
}
