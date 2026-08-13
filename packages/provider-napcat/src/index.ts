import { z } from "zod";
import { asProviderId } from "@botroost/contracts";
import type { ProviderCapabilityManifest } from "@botroost/provider-sdk";
export const napcatManifest: ProviderCapabilityManifest = {
  id: asProviderId("napcat"),
  displayName: "NapCat (unavailable)",
  capabilities: ["configure", "observe"],
  credentialTransport: "provider-api",
  runtimeRequirements: [
    "napcat-license-accepted",
    "verified-artifact-policy",
    "isolated-network",
    "ephemeral-storage",
  ],
};
export const napcatAvailability = {
  available: false as const,
  runtimeRequest: null,
  requirements: napcatManifest.runtimeRequirements,
};
export const NapCatConfigurationSchema = z.strictObject({
  endpointUrl: z.string().url().startsWith("https://"),
});
export const NapCatCredentialsSchema = z.strictObject({
  accessToken: z.string().min(1),
});
export type NapCatConfiguration = z.infer<typeof NapCatConfigurationSchema>;
export const redactNapCatConfiguration = (
  config: NapCatConfiguration,
): NapCatConfiguration => ({ ...config });
