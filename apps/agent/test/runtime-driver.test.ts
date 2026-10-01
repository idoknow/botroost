import { describe, expect, it } from 'vitest';
import { resolveRuntimeBackend } from '../src/runtime/config.js';
import { kubernetesResources } from '../src/runtime/kubernetes-resources.js';

describe('runtime backend', () => {
  it('defaults to Docker and rejects typos rather than falling back', () => {
    expect(resolveRuntimeBackend(undefined)).toBe('docker');
    expect(resolveRuntimeBackend('kubernetes')).toBe('kubernetes');
    expect(() => resolveRuntimeBackend('kubernets')).toThrow();
  });
});
const input: import('../src/runtime/types.js').RuntimeSpec = {
  name: 'botroost-napcat-12345678-1234-4123-8123-123456789abc',
  image: 'example/image@sha256:' + 'a'.repeat(64),
  labels: { 'botroost.endpoint_id': '12345678-1234-4123-8123-123456789abc', 'botroost.workspace_id': 'ws-1', 'botroost.provider': 'napcat' },
  environment: { NAPCAT_WEBUI_SECRET_KEY: 'private-value' },
  volumes: [{ name: 'qq', target: '/app/.config/QQ' }, { name: 'config', target: '/app/napcat/config' }],
  resources: { cpuMillis: 1000, memoryMiB: 1024 },
};
describe('Kubernetes resource contract', () => {
  it('keeps secrets out of workload spec and creates persistent storage with no owner GC', () => {
    const r = kubernetesResources(input, { namespace: 'test-pool', storageClass: 'local-path', volumeSize: '2Gi' });
    expect(r.secret.stringData).toMatchObject(input.environment);
    expect(JSON.stringify(r.workload)).not.toContain('private-value');
    expect(('ownerReferences' in r.pvc.metadata ? r.pvc.metadata.ownerReferences : undefined)).toBeUndefined();
    expect(r.workload.spec.replicas).toBe(0);
    expect(r.workload.spec.updateStrategy.type).toBe('OnDelete');
    expect(r.workload.spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(JSON.stringify(r)).not.toContain('hostPath');
    expect(r.service.spec.type).toBe('ClusterIP');
    expect(r.workload.spec.template.spec.containers[0]!.volumeMounts).toHaveLength(2);
  });
  it('clears removed proxy keys instead of merge-retaining old Secret data', () => {
    const r = kubernetesResources(input, { namespace: 'test', volumeSize: '2Gi' });
    expect(r.secret.stringData).toHaveProperty('HTTP_PROXY', '');
    expect(r.secret.stringData).toHaveProperty('HTTPS_PROXY', '');
    expect(r.secret.stringData).toHaveProperty('ALL_PROXY', '');
  });
  it('rejects unsafe resource names', () => {
    expect(() => kubernetesResources({ ...input, name: '../../bad' }, { namespace: 'test', volumeSize: '2Gi' })).toThrow();
  });
});
