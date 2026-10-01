import type { DockerInspectResult, DockerClient } from '../index.js';
export interface RuntimeSpec {
  name: string;
  image: string;
  labels: Record<string,string>;
  environment: Record<string,string>;
  volumes: { name: 'qq' | 'config'; target: string }[];
  resources: { cpuMillis: number; memoryMiB: number };
}
/** Infrastructure boundary; protocol HTTP and OneBot remain in the provider. */
export interface RuntimeDriver {
  readonly backend: 'docker' | 'kubernetes';
  inspect(name: string): Promise<DockerInspectResult | null>;
  ensure(spec: RuntimeSpec): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  restart(name: string, operationId: string): Promise<void>;
  forceRestart(name: string, operationId: string): Promise<void>;
  delete(name: string): Promise<void>;
  logs: DockerClient['logs'];
  stats?: DockerClient['stats'];
}
