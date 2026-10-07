import { z } from "zod";
import { asProviderId } from "@botroost/contracts";
import { redactSecrets, type ProviderCapabilityManifest } from "@botroost/provider-sdk";
export const snowlumaManifest: ProviderCapabilityManifest = {
  id: asProviderId("snowluma"),
  displayName: "SnowLuma",
  capabilities: ["configure", "observe"],
  credentialTransport: "provider-api",
  runtimeRequirements: [
    "snowluma-license-accepted",
    "verified-artifact-policy",
    "isolated-network",
    "ephemeral-storage",
  ],
};
export const snowlumaAvailability = {
  available: false as const,
  runtimeRequest: null,
  requirements: snowlumaManifest.runtimeRequirements,
};
export const SnowLumaConfigurationSchema = z.strictObject({
  endpointUrl: z.string().url().startsWith("http://"),
});
export const SnowLumaCredentialsSchema = z.strictObject({
  accessToken: z.string().min(1),
});
export type SnowLumaConfiguration = z.infer<typeof SnowLumaConfigurationSchema>;
export const redactSnowlumaConfiguration = (
  config: SnowLumaConfiguration,
): SnowLumaConfiguration =>
  redactSecrets(config) as SnowLumaConfiguration;
