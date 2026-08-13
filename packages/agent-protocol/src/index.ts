import { RuntimeRequestSchema } from "@botroost/runtime-sdk";
import { z } from "zod";

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);
const jsonObject = z.record(z.string(), jsonValue);
const id = z.string().min(1).max(200);
const isoDate = z.string().datetime();
const layered = z.strictObject({
  node: z.enum(["unknown", "offline", "online"]),
  runtime: z.enum(["unknown", "stopped", "starting", "ready", "failed"]),
  provider: z.enum(["unknown", "unavailable", "available", "degraded"]),
  protocol: z.enum(["unknown", "disconnected", "connecting", "connected"]),
  convergence: z.enum(["unknown", "reconciling", "converged", "conflicted", "failed"]),
});

export const AgentEnrollmentRequestSchema = z.strictObject({
  token: z.string().min(16),
  provider: z.string().min(1).max(80),
  version: z.string().min(1).max(120).optional(),
});
export const AgentHeartbeatRequestSchema = z.strictObject({
  status: z.enum(["online", "draining"]),
  sessionId: id.default("legacy-session"),
  observedAt: isoDate,
  agentVersion: z.string().min(1).max(120).optional(),
  os: z.string().min(1).max(80).optional(),
  arch: z.string().min(1).max(80).optional(),
  capacity: z.strictObject({
    cpuMillis: z.number().int().nonnegative(),
    memoryMiB: z.number().int().nonnegative(),
  }).optional(),
  runtimes: z.array(
    z.strictObject({
      endpointId: id,
      generation: z.number().int().nonnegative(),
      runtime: layered.shape.runtime,
      provider: layered.shape.provider,
      protocol: layered.shape.protocol,
      convergence: layered.shape.convergence,
    }),
  ).max(200),
});
export const ClaimCommandRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(1).default(1),
});
export const RuntimeCommandSchema = z.strictObject({
  commandId: id,
  operationId: id,
  workspaceId: id,
  nodeId: id,
  endpointId: id,
  generation: z.number().int().nonnegative(),
  connectionEpoch: z.number().int().nonnegative(),
  attempt: z.number().int().positive().optional(),
  action: z.enum(["start", "stop", "restart"]),
  runtimeRequest: RuntimeRequestSchema,
  metadata: jsonObject,
});
export const CommandReceiptRequestSchema = z.strictObject({
  operationId: id,
  generation: z.number().int().nonnegative(),
  connectionEpoch: z.number().int().nonnegative(),
});
export const CommandResultRequestSchema = CommandReceiptRequestSchema.extend({
  endpointId: id,
  outcome: z.enum(["succeeded", "failed", "unknown"]),
  error: z.string().min(1).max(2000).optional(),
  observations: layered,
  metadata: jsonObject.optional(),
}).strict();

const secretKey =
  /^(?:authorization|enrollmenttoken|enrollment_token|token|bearer|cookie|session|password|secret|nodeSecret|node_secret)$/i;
const redactUrl = (text: string): string => {
  try {
    const url = new URL(text);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()])
      if (secretKey.test(key)) url.searchParams.set(key, "[REDACTED]");
    return url.toString();
  } catch {
    return text;
  }
};
export function redactTransportSecrets(value: unknown): unknown {
  const walk = (current: unknown, key?: string): unknown => {
    if (key && secretKey.test(key)) return "[REDACTED]";
    if (typeof current === "string") return redactUrl(current);
    if (current === null || typeof current !== "object") return current;
    if (Array.isArray(current)) return current.map((item) => walk(item));
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>).map(([name, item]) => [
        name,
        walk(item, name),
      ]),
    );
  };
  return walk(value);
}

export type AgentEnrollmentRequest = z.infer<typeof AgentEnrollmentRequestSchema>;
export type AgentHeartbeatRequest = z.infer<typeof AgentHeartbeatRequestSchema>;
export type RuntimeCommand = z.infer<typeof RuntimeCommandSchema>;
export type CommandResultRequest = z.infer<typeof CommandResultRequestSchema>;
