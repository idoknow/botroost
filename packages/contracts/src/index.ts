import { z } from "zod";
export const NodeIdSchema = z.string().trim().min(1).brand<"NodeId">();
export type NodeId = z.infer<typeof NodeIdSchema>;
export const RuntimeIdSchema = z.string().trim().min(1).brand<"RuntimeId">();
export type RuntimeId = z.infer<typeof RuntimeIdSchema>;
export const ProviderIdSchema = z.string().trim().min(1).brand<"ProviderId">();
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export const EndpointIdSchema = z.string().trim().min(1).brand<"EndpointId">();
export type EndpointId = z.infer<typeof EndpointIdSchema>;
export const OperationIdSchema = z
  .string()
  .trim()
  .min(1)
  .brand<"OperationId">();
export type OperationId = z.infer<typeof OperationIdSchema>;
export const asNodeId = (value: string): NodeId => NodeIdSchema.parse(value);
export const asRuntimeId = (value: string): RuntimeId =>
  RuntimeIdSchema.parse(value);
export const asProviderId = (value: string): ProviderId =>
  ProviderIdSchema.parse(value);
export const asEndpointId = (value: string): EndpointId =>
  EndpointIdSchema.parse(value);
export const asOperationId = (value: string): OperationId =>
  OperationIdSchema.parse(value);
export const NodeStateSchema = z.enum(["unknown", "offline", "online"]);
export const RuntimeStateSchema = z.enum([
  "unknown",
  "stopped",
  "starting",
  "ready",
  "failed",
]);
export const ProviderStateSchema = z.enum([
  "unknown",
  "unavailable",
  "available",
  "degraded",
]);
export const ProtocolStateSchema = z.enum([
  "unknown",
  "disconnected",
  "connecting",
  "connected",
]);
export const ConvergenceStateSchema = z.enum([
  "unknown",
  "reconciling",
  "converged",
  "conflicted",
  "failed",
]);
export const LayeredStatusSchema = z.strictObject({
  node: NodeStateSchema,
  runtime: RuntimeStateSchema,
  provider: ProviderStateSchema,
  protocol: ProtocolStateSchema,
  convergence: ConvergenceStateSchema,
});
export const EndpointDesiredStateSchema = z.strictObject({
  enabled: z.boolean(),
  generation: z.number().int().nonnegative(),
  activeOperationId: OperationIdSchema,
  configuration: z.record(z.string(), z.unknown()),
});
export type EndpointDesiredState = z.infer<typeof EndpointDesiredStateSchema>;
export const OperationSchema = z.strictObject({
  id: OperationIdSchema,
  endpointId: EndpointIdSchema,
  generation: z.number().int().nonnegative(),
  state: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
  error: z.string().optional(),
});
export type Operation = z.infer<typeof OperationSchema>;
