import type { RuntimeSpec } from './types.js';
export interface KubernetesProfile { namespace: string; storageClass?: string; volumeSize: string; nodeSelector?: Record<string,string> }
export function kubernetesResources(input: RuntimeSpec, profile: KubernetesProfile) {
  for (const name of [input.name, profile.namespace]) if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 63) throw new Error('Invalid Kubernetes resource name');
  const metadata = { name: input.name, namespace: profile.namespace, labels: input.labels };
  const selector = { 'botroost.endpoint_id': input.labels['botroost.endpoint_id']! };
  const secret = { apiVersion: 'v1', kind: 'Secret', metadata, type: 'Opaque', stringData: { HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '', no_proxy: '', ...input.environment } };
  const pvc = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { ...metadata }, spec: { accessModes: ['ReadWriteOnce'], ...(profile.storageClass ? { storageClassName: profile.storageClass } : {}), resources: { requests: { storage: profile.volumeSize } } } };
  const service = { apiVersion: 'v1', kind: 'Service', metadata, spec: { type: 'ClusterIP', selector, ports: [{ name: 'management', port: 6099, targetPort: 6099 }] } };
  const governing = { ...service, metadata: { ...metadata, name: `${input.name}-head` }, spec: { ...service.spec, clusterIP: 'None' } };
  const resources = { requests: { cpu: `${input.resources.cpuMillis}m`, memory: `${input.resources.memoryMiB}Mi` }, limits: { cpu: `${input.resources.cpuMillis}m`, memory: `${input.resources.memoryMiB}Mi` } };
  const workload = { apiVersion: 'apps/v1', kind: 'StatefulSet', metadata, spec: {
    replicas: 0, serviceName: governing.metadata.name, selector: { matchLabels: selector }, updateStrategy: { type: 'OnDelete' },
    template: { metadata: { labels: input.labels }, spec: {
      automountServiceAccountToken: false, terminationGracePeriodSeconds: 30,
      ...(profile.nodeSelector ? { nodeSelector: profile.nodeSelector } : {}),
      securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
      initContainers: [{ name: 'storage', image: input.image, command: ['/bin/sh', '-ec', `
        mkdir -p /data/qq /data/config
        # Self-heal WebUI token drift: the PVC's webui.json persists the token from the
        # FIRST boot, so a rotated agent NAPCAT_TOKEN would be rejected forever. Rewrite
        # the persisted config from the (authoritative) Secret on every start.
        if [ -n "$NAPCAT_WEBUI_SECRET_KEY" ]; then
          mkdir -p /data/config
          if [ -f /data/config/webui.json ]; then
            sed -i "s/^\\([[:space:]]*\\"token\\"[[:space:]]*:[[:space:]]*\\)[^,}]*/\\1\\"$NAPCAT_WEBUI_SECRET_KEY\\"/" /data/config/webui.json
          else
            printf '{"host":"::","port":6099,"token":"%s"}\\n' "$NAPCAT_WEBUI_SECRET_KEY" > /data/config/webui.json
          fi
        fi
      `], securityContext: { allowPrivilegeEscalation: false }, resources, volumeMounts: [{ name: 'data', mountPath: '/data' }] }],
      containers: [{ name: 'protocol', image: input.image, envFrom: [{ secretRef: { name: input.name } }], resources,
        securityContext: { allowPrivilegeEscalation: false },
        ports: [{ name: 'management', containerPort: 6099 }],
        startupProbe: { tcpSocket: { port: 6099 }, periodSeconds: 5, failureThreshold: 60 },
        readinessProbe: { tcpSocket: { port: 6099 }, periodSeconds: 10 },
        volumeMounts: input.volumes.map(volume => ({ name: 'data', mountPath: volume.target, subPath: volume.name })) }],
      volumes: [{ name: 'data', persistentVolumeClaim: { claimName: input.name } }],
    } },
  } };
  return { secret, pvc, service, governing, workload };
}
