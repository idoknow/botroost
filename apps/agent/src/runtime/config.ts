export function resolveRuntimeBackend(value: string | undefined): 'docker' | 'kubernetes' {
  if (value === undefined || value === 'docker') return 'docker';
  if (value === 'kubernetes') return value;
  throw new Error('AGENT_RUNTIME must be docker or kubernetes');
}
