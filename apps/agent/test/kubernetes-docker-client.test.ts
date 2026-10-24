import { describe, it, expect, vi } from 'vitest';
import { CoreV1Api, KubeConfig, KubernetesObjectApi } from '@kubernetes/client-node';
import { KubernetesDockerClient } from '../src/runtime/kubernetes-docker.js';
import { PodRuntimeStorage, LocalRuntimeStorage, StorageFileMissing } from '../src/runtime/storage.js';
import type { RuntimeDriver, RuntimeSpec } from '../src/runtime/types.js';
import { SnowLumaRuntime } from '../src/snowluma-runtime.js';
import { LLBotRuntime } from '../src/llbot-runtime.js';

/** Minimal RuntimeDriver that records what the adapter asks it to do. */
function fakeDriver(overrides: Partial<RuntimeDriver> = {}) {
  const ensured: RuntimeSpec[] = [];
  const driver: RuntimeDriver = {
    backend: 'kubernetes',
    inspect: vi.fn(async () => ({ id: 'pod-uid-1', state: 'running' }) as never),
    ensure: vi.fn(async (spec: RuntimeSpec) => { ensured.push(spec); }),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    forceRestart: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    logs: vi.fn(async () => 'log line') as never,
    ...overrides,
  };
  return { driver, ensured };
}

function kubeConfig() {
  const config = new KubeConfig();
  config.loadFromOptions({
    clusters: [{ name: 'test', server: 'https://example.invalid' }],
    users: [{ name: 'test' }],
    contexts: [{ name: 'test', cluster: 'test', user: 'test' }],
    currentContext: 'test',
  });
  return config;
}

describe('KubernetesDockerClient', () => {
  it('translates a Docker create into a StatefulSet spec: bind mounts become PVC subPaths', async () => {
    const { driver, ensured } = fakeDriver();
    const client = new KubernetesDockerClient(driver, { namespace: 'rt', volumeSize: '2Gi' }, undefined, kubeConfig());

    await client.create({
      name: 'snowluma-e1',
      image: 'example/snowluma:1',
      labels: { 'botroost.provider': 'snowluma' },
      environment: { TZ: 'Asia/Shanghai', DROPPED: 42 as never },
      // Provider passes host directories; the adapter keys the subPath off the last segment.
      mounts: [
        { type: 'bind', source: '/var/lib/agent/e1/qq', target: '/app/.config' },
        { type: 'bind', source: '/var/lib/agent/e1/config', target: '/app/snowluma-data' },
      ],
      hostConfig: { networkMode: 'bridge', portBindings: {} },
      resources: { cpuMillis: 1000, memoryMiB: 2048 },
      publishedPorts: [{ hostPort: '12345', containerPort: '6081' }],
      capAdd: ['SYS_PTRACE'],
      securityOpt: ['seccomp=unconfined'],
      shmBytes: 1024 ** 3,
    } as never);

    expect(ensured).toHaveLength(1);
    const spec = ensured[0]!;
    expect(spec.name).toBe('snowluma-e1');
    expect(spec.volumes).toEqual([
      { name: 'qq', target: '/app/.config' },
      { name: 'config', target: '/app/snowluma-data' },
    ]);
    // Host ports have no Kubernetes equivalent; the container port moves to the Service.
    expect(spec.ports).toEqual([{ name: 'port-6081', port: 6081 }]);
    expect(spec.capAdd).toEqual(['SYS_PTRACE']);
    expect(spec.securityOpt).toEqual(['seccomp=unconfined']);
    expect(spec.shmBytes).toBe(1024 ** 3);
    // Non-string environment values are dropped rather than stringified into nonsense.
    expect(spec.environment).toEqual({ TZ: 'Asia/Shanghai' });
  });

  it('returns the pod UID from inspect so providers can pass it back as a container id', async () => {
    const { driver } = fakeDriver();
    const client = new KubernetesDockerClient(driver, { namespace: 'rt', volumeSize: '2Gi' }, undefined, kubeConfig());
    const created = await client.create({
      name: 'llbot-e2', image: 'example/llbot:1', labels: {}, environment: {},
      mounts: [{ type: 'bind', source: '/var/lib/agent/e2/data', target: '/app/llbot/data' }],
      hostConfig: { networkMode: 'bridge', portBindings: {} },
      resources: { cpuMillis: 500, memoryMiB: 1024 },
    } as never);
    expect(created.id).toBe('pod-uid-1');
  });

  it('maps a hidden bind source like .config onto a legal subPath instead of failing', async () => {
    const { driver, ensured } = fakeDriver();
    const client = new KubernetesDockerClient(driver, { namespace: 'rt', volumeSize: '2Gi' }, undefined, kubeConfig());
    // SnowLuma's Kubernetes mount target is /app/.config; `.config` is not a legal subPath,
    // so the adapter derives the name from the target. Failing here aborted every create.
    await client.create({
      name: 'snowluma-e3', image: 'x', labels: {}, environment: {},
      mounts: [{ type: 'bind', source: '/app/.config', target: '/app/.config' }],
      hostConfig: { networkMode: 'bridge', portBindings: {} },
      resources: { cpuMillis: 1, memoryMiB: 1 },
    } as never);
    expect(ensured[0]!.volumes).toEqual([{ name: 'config', target: '/app/.config' }]);
  });

  it('rejects a mount whose target yields no legal subPath at all', async () => {
    const { driver } = fakeDriver();
    const client = new KubernetesDockerClient(driver, { namespace: 'rt', volumeSize: '2Gi' }, undefined, kubeConfig());
    await expect(client.create({
      name: 'bad', image: 'x', labels: {}, environment: {},
      mounts: [{ type: 'bind', source: '/var/lib/agent/e3/___', target: '/__' }],
      hostConfig: { networkMode: 'bridge', portBindings: {} },
      resources: { cpuMillis: 1, memoryMiB: 1 },
    } as never)).rejects.toThrow(/Cannot derive a volume subPath/);
  });

  it('routes every port the provider talks to, including unpublished OneBot', async () => {
    const { driver, ensured } = fakeDriver();
    const client = new KubernetesDockerClient(driver, { namespace: 'rt', volumeSize: '2Gi' }, undefined, kubeConfig());
    await client.create({
      name: 'llbot-e4', image: 'x', labels: {}, environment: {},
      mounts: [{ type: 'bind', source: '/app/llbot/data', target: '/app/llbot/data' }],
      hostConfig: { networkMode: 'bridge', portBindings: {} },
      resources: { cpuMillis: 1, memoryMiB: 1 },
      publishedPorts: [{ hostPort: '3380', containerPort: '3080' }],
      // OneBot HTTP is never published on Docker, but a Service only routes declared ports.
      exposePorts: [3000],
    } as never);
    expect(ensured[0]!.ports).toEqual([{ name: 'port-3080', port: 3080 }, { name: 'port-3000', port: 3000 }]);
  });

  it('keeps the claim when a workload is replaced and drops it on explicit deletion', async () => {
    const deletes: string[] = [];
    const { driver } = fakeDriver({
      delete: vi.fn(async (name: string) => { deletes.push(`workload:${name}`); }),
      deleteData: vi.fn(async (name: string) => { deletes.push(`data:${name}`); }),
    });
    const client = new KubernetesDockerClient(driver, { namespace: 'rt', volumeSize: '2Gi' }, undefined, kubeConfig());
    await client.remove('snowluma-e5');
    expect(deletes).toEqual(['workload:snowluma-e5']);
    await client.remove('snowluma-e5', { discardData: true });
    expect(deletes).toEqual(['workload:snowluma-e5', 'workload:snowluma-e5', 'data:snowluma-e5']);
  });

  it('verifies a replacement image with a throwaway pod and cleans it up', async () => {
    const { driver } = fakeDriver();
    const client = new KubernetesDockerClient(driver, { namespace: 'rt', volumeSize: '2Gi' }, undefined, kubeConfig());
    const created: unknown[] = [];
    const create = vi.spyOn(KubernetesObjectApi.prototype, 'create').mockImplementation(async object => { created.push(object); return object as never; });
    const read = vi.spyOn(CoreV1Api.prototype, 'readNamespacedPod').mockResolvedValue({
      status: { phase: 'Running', containerStatuses: [{ name: 'verify', state: { running: {} } }] },
    } as never);
    const remove = vi.spyOn(KubernetesObjectApi.prototype, 'delete').mockResolvedValue({} as never);
    try {
      await client.pull('example/snowluma@sha256:f75698eeaa06a3aed6b42e88975fff6b0313a960f7e7093b2329455310fd6eee');
      expect(created[0]).toMatchObject({ kind: 'Pod', metadata: { namespace: 'rt' } });
      expect((created[0] as { spec?: { containers?: { image?: string; resources?: object }[] } }).spec?.containers?.[0]?.image).toContain('@sha256:');
      expect(remove).toHaveBeenCalledOnce();
    } finally { create.mockRestore(); read.mockRestore(); remove.mockRestore(); }
  });

  it('blocks the replacement while the registry reports the image unpullable', async () => {
    const { driver } = fakeDriver();
    const client = new KubernetesDockerClient(driver, { namespace: 'rt', volumeSize: '2Gi' }, undefined, kubeConfig());
    const create = vi.spyOn(KubernetesObjectApi.prototype, 'create').mockResolvedValue({} as never);
    const read = vi.spyOn(CoreV1Api.prototype, 'readNamespacedPod').mockResolvedValue({
      status: { phase: 'Pending', containerStatuses: [{ name: 'verify', state: { waiting: { reason: 'ErrImagePull' } } }] },
    } as never);
    const remove = vi.spyOn(KubernetesObjectApi.prototype, 'delete').mockResolvedValue({} as never);
    try {
      await expect(client.pull('example/snowluma:v1.14.22')).rejects.toThrow(/registry does not currently serve/);
      // The verify pod is always cleaned up, including on the failure path.
      expect(remove).toHaveBeenCalledOnce();
    } finally { create.mockRestore(); read.mockRestore(); remove.mockRestore(); }
  });

  it('fails open when the verification pod cannot run at all', async () => {
    const { driver } = fakeDriver();
    const client = new KubernetesDockerClient(driver, { namespace: 'rt', volumeSize: '2Gi' }, undefined, kubeConfig());
    const create = vi.spyOn(KubernetesObjectApi.prototype, 'create').mockRejectedValue(new Error('quota exceeded'));
    try {
      // The checker is best-effort: a broken check must not become a second way to lose the runtime.
      await expect(client.pull('example/snowluma:v1.14.22')).resolves.toBeUndefined();
    } finally { create.mockRestore(); }
  });
});

describe('PodRuntimeStorage', () => {
  it('reads and writes endpoint files through the protocol container', async () => {
    const calls: { name: string; args: string[]; stdin?: string }[] = [];
    const runtime = {
      exec: vi.fn(async (name: string, args: string[], stdin?: string) => {
        calls.push({ name, args, ...(stdin === undefined ? {} : { stdin }) });
        // args is ['/bin/sh', '-c', <script>]. The mock refuses any path it does not expect,
        // so a wrong read or listing path fails here instead of passing on identical output.
        const script = args[2] ?? '';
        if (script === "cat '/app/snowluma-data/config/onebot11.json'") return { stdout: '{"token":"secret"}\n', stderr: '' };
        if (script === "ls -1A '/app/snowluma-data/config'") return { stdout: 'onebot11.json\nconfig\n', stderr: '' };
        if (script.startsWith('base64 -d > ')) return { stdout: '', stderr: '' };
        throw new Error(`unexpected exec: ${script}`);
      }),
    };
    const storage = new PodRuntimeStorage(runtime).for('snowluma-e1');

    expect(await storage.readdir('/app/snowluma-data/config')).toEqual(['onebot11.json', 'config']);
    expect(await storage.readFile('/app/snowluma-data/config/onebot11.json')).toBe('{"token":"secret"}\n');
    expect(calls.map(call => call.args[2])).toEqual([
      "ls -1A '/app/snowluma-data/config'",
      "cat '/app/snowluma-data/config/onebot11.json'",
    ]);

    // File content travels on stdin, never on the command line: an OneBot access token in the
    // config must not be visible in the exec request or the container's process list.
    await storage.writeFile('/app/snowluma-data/config/onebot11.json', '{"a":"it\'s "quoted"\n"}');
    const write = calls.at(-1)!;
    expect(write.args[2]).toBe("base64 -d > '/app/snowluma-data/config/onebot11.json'");
    expect(write.stdin).toBe(Buffer.from('{"a":"it\'s "quoted"\n"}', 'utf8').toString('base64'));
    expect(write.args[2]).not.toContain(write.stdin);

    // Every call is addressed at the workload the scope was created for.
    expect(calls.every(call => call.name === 'snowluma-e1')).toBe(true);
  });

  it('reports a missing file as StorageFileMissing instead of an opaque exec failure', async () => {
    const runtime = { exec: vi.fn(async () => { throw new Error('command terminated with exit code 1: cat: /app/x.json: No such file or directory'); }) };
    const storage = new PodRuntimeStorage(runtime).for('llbot-e1');
    await expect(storage.readFile('/app/x.json')).rejects.toBeInstanceOf(StorageFileMissing);
    // A readdir of an absent directory is an empty listing, matching the local backend.
    expect(await storage.readdir('/app/absent')).toEqual([]);
  });

  it('propagates exec failures that are not a missing path', async () => {
    // A pod that is restarting or an API server that is unreachable must not be mistaken for
    // "the endpoint has no configuration yet".
    const runtime = { exec: vi.fn(async () => { throw new Error('exec failed (exit 137): pod is terminating'); }) };
    const storage = new PodRuntimeStorage(runtime).for('llbot-e1');
    await expect(storage.readFile('/app/x.json')).rejects.toThrow(/pod is terminating/);
    await expect(storage.readdir('/app/config')).rejects.toThrow(/pod is terminating/);
  });

  it('creates directories world-writable so the image user can write them', async () => {
    const calls: Array<{ name: string; args: string[] }> = [];
    const exec = vi.fn(async (name: string, args: string[]) => { calls.push({ name, args }); return { stdout: '', stderr: '' }; });
    await new PodRuntimeStorage({ exec }).for('napcat-e1').ensureDirectory('/data/qq');
    expect(calls[0]!.name).toBe('napcat-e1');
    expect(calls[0]!.args).toEqual(['/bin/sh', '-c', "mkdir -p '/data/qq' && chmod 777 '/data/qq'"]);
  });
});

describe('LocalRuntimeStorage', () => {
  it('is the default backend and distinguishes missing from empty', async () => {
    const storage = new LocalRuntimeStorage();
    expect(storage.kind).toBe('local');
    // A directory that does not exist yet is a normal first-run condition.
    expect(await storage.for().readdir('/nonexistent/botroost-test-dir')).toEqual([]);
    await expect(storage.for().readFile('/nonexistent/botroost-test-dir/x.json')).rejects.toBeInstanceOf(StorageFileMissing);
  });

  it('is what the providers use when no storage option is supplied', async () => {
    // Constructing the real providers is the only way to catch a regression in their default:
    // a docker-backed agent must keep reading the host filesystem directly.
    const docker = { inspect: vi.fn(async () => null) } as never;
    const snowluma = new SnowLumaRuntime({ docker, stateDirectory: '/nonexistent/botroost-test', networkMode: 'bridge' });
    const llbot = new LLBotRuntime({ docker, stateDirectory: '/nonexistent/botroost-test', networkMode: 'bridge' });
    expect((snowluma as unknown as { storage: { kind: string } }).storage.kind).toBe('local');
    expect((llbot as unknown as { storage: { kind: string } }).storage.kind).toBe('local');
  });
});
