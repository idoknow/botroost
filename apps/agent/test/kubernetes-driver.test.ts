import { describe, it, expect, vi } from 'vitest';
import { KubeConfig, KubernetesObjectApi } from '@kubernetes/client-node';
import { KubernetesRuntimeDriver } from '../src/runtime/kubernetes.js';

function fixture() {
  const config = new KubeConfig();
  config.loadFromOptions({ clusters: [{ name: 'test', server: 'https://example.invalid' }], users: [{ name: 'test' }], contexts: [{ name: 'test', cluster: 'test', user: 'test' }], currentContext: 'test' });
  const labels = { 'botroost.endpoint_id': 'endpoint', 'botroost.workspace_id': 'workspace', 'botroost.provider': 'napcat' };
  const workload = { apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name: 'test', uid: 'workload-uid', resourceVersion: '1', labels }, spec: { replicas: 1, template: { spec: { containers: [{ image: 'example/image' }] } } } };
  return { config, workload, labels };
}
describe('Kubernetes API lifecycle safety', () => {
  it('does not wait for an identically named replacement pod to disappear', async () => {
    const { config, workload, labels } = fixture();
    let removed = false;
    const read = vi.spyOn(KubernetesObjectApi.prototype, 'read').mockImplementation(async object => {
      if (object.kind === 'StatefulSet') return workload;
      return { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'test-0', uid: removed ? 'replacement' : 'original', resourceVersion: '2', labels, annotations: removed ? { 'botroost.io/restart-operation': 'op' } : {} }, status: { containerStatuses: [{ name: 'protocol', state: { running: {} } }] } };
    });
    const patch = vi.spyOn(KubernetesObjectApi.prototype, 'patch').mockResolvedValue(workload);
    const remove = vi.spyOn(KubernetesObjectApi.prototype, 'delete').mockImplementation(async () => { removed = true; return {}; });
    try {
      await new KubernetesRuntimeDriver({ namespace: 'test', volumeSize: '2Gi' }, undefined, config).restart('test', 'op');
      expect(remove).toHaveBeenCalledOnce();
      for (const call of patch.mock.calls) expect(call[4]).toBeUndefined();
      expect(remove.mock.calls[0]?.[6]).toEqual({ preconditions: { uid: 'original', resourceVersion: '2' } });
    } finally { read.mockRestore(); patch.mockRestore(); remove.mockRestore(); }
  }, 2000);
  it('maps pod-metric UIDs to resource samples and tolerates unknown quantities', async () => {
    const { config } = fixture();
    const driver = new KubernetesRuntimeDriver({ namespace: 'test', volumeSize: '2Gi' }, undefined, config);
    const metrics = await import('@kubernetes/client-node');
    // @ts-expect-error: Metrics is constructed with the config; substitute a stub.
    driver['metricsApi'] = { getPodMetrics: async () => ({
      kind: 'PodMetricsList', apiVersion: 'metrics.k8s.io/v1beta1', metadata: {},
      items: [
        { metadata: { name: 'pod-a', namespace: 'test', uid: 'uid-a', creationTimestamp: '' }, timestamp: '', window: '30s', containers: [{ name: 'protocol', usage: { cpu: '8073539n', memory: '258980Ki' } }] },
        { metadata: { name: 'pod-b', namespace: 'test', uid: 'uid-b', creationTimestamp: '' }, timestamp: '', window: '30s', containers: [{ name: 'protocol', usage: { cpu: '1000000n', memory: '2Mi' } }, { name: 'sidecar', usage: { cpu: '500000n', memory: '1Mi' } }] },
        { metadata: { name: 'pod-c', namespace: 'test', uid: 'uid-c', creationTimestamp: '' }, timestamp: '', window: '30s', containers: [{ name: 'protocol', usage: { cpu: 'bogus', memory: '' } }] },
      ],
    } as never) };
    const result = await driver.stats(['uid-a', 'uid-b', 'uid-other']);
    expect(result.get('uid-a')).toEqual({ cpuPercent: 0.8073539, memoryBytes: 258980 * 1024 });
    // Multi-container pods sum to a pod-level sample.
    expect(result.get('uid-b')).toEqual({ cpuPercent: 0.15, memoryBytes: 3 * 1024 * 1024 });
    // Malformed quantities contribute zero; zero-only pods are omitted.
    expect(result.has('uid-c')).toBe(false);
    expect(result.has('uid-other')).toBe(false);
    expect(metrics).toBeTruthy();
  });
});
