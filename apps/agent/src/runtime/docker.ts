import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DockerClient } from '../index.js';
import type { RuntimeDriver, RuntimeSpec } from './types.js';
export class DockerRuntimeDriver implements RuntimeDriver {
  readonly backend = 'docker' as const;
  constructor(private client: DockerClient, private directory: string, private hostDirectory = directory, private network = 'bridge') {}
  inspect(name: string) { return this.client.inspect(name); }
  async ensure(spec: RuntimeSpec) {
    const id = spec.labels['botroost.endpoint_id']!;
    const old = await this.inspect(spec.name);
    const swap = spec.resources.memoryMiB + 512;
    if (old && old.image === spec.image && (!old.resources || (old.resources.cpuMillis === spec.resources.cpuMillis && old.resources.memoryMiB === spec.resources.memoryMiB && old.resources.memorySwapMiB === swap)) && (old.proxyEnvironment?.HTTP_PROXY ?? null) === (spec.environment.HTTP_PROXY ?? null)) return;
    if (old) await this.client.remove(spec.name);
    for (const volume of spec.volumes) await mkdir(join(this.directory, id, volume.name), { recursive: true, mode: 0o700 });
    await this.client.create({ ...spec, mounts: spec.volumes.map(v => ({ type: 'bind' as const, source: join(this.hostDirectory, id, v.name), target: v.target })), hostConfig: { networkMode: this.network, portBindings: {} }, resources: { ...spec.resources, memorySwapMiB: swap } });
  }
  start(name: string) { return this.client.start(name); }
  stop(name: string) { return this.client.stop(name); }
  restart(name: string) { return this.client.restart(name); }
  async forceRestart(name: string) {
    const old = await this.inspect(name);
    if (!old || !this.client.kill) throw new Error('Force restart unavailable');
    if (old.state === 'running') await this.client.kill(old.id);
    await this.client.start(old.id);
    const current = await this.inspect(old.id);
    if (!current || current.id !== old.id || current.state !== 'running') throw new Error('Force restart verification failed');
  }
  async delete(name: string) {
    const old = await this.inspect(name);
    if (!old) return;
    await this.client.remove(name);
    await this.client.removeHostEndpoint(this.hostDirectory, old.labels['botroost.endpoint_id']!, old.image);
  }
  logs: DockerClient['logs'] = (name, options) => this.client.logs(name, options);
  stats: NonNullable<DockerClient['stats']> = (ids, signal) => this.client.stats?.(ids, signal) ?? Promise.resolve(new Map());
}
