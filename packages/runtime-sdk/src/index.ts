import { z } from "zod";
const opaqueReference = z
  .string()
  .regex(/^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9:._-]*$/i);
export const RuntimeRequestSchema = z.strictObject({
  approvedArtifactId: opaqueReference,
  approvedEgressProfile: opaqueReference,
  resources: z.strictObject({
    cpuMillis: z.number().int().min(50).max(4000),
    memoryMiB: z.number().int().min(32).max(4096),
  }),
  storage: z.strictObject({
    kind: z.enum(["none", "ephemeral"]),
    sizeMiB: z.number().int().min(0).max(1024),
  }),
});
export type RuntimeRequest = z.infer<typeof RuntimeRequestSchema>;
