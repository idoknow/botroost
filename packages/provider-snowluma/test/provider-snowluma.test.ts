import { describe, expect, it } from "vitest";
import { ProviderCapabilityManifestSchema } from "@botroost/provider-sdk";
import {
  snowlumaAvailability,
  snowlumaManifest,
  SnowLumaConfigurationSchema,
  SnowLumaCredentialsSchema,
  redactSnowlumaConfiguration,
} from "../src/index.js";

describe("SnowLuma adapter", () => {
  it("has a valid manifest", () => {
    expect(ProviderCapabilityManifestSchema.safeParse(snowlumaManifest).success).toBe(true);
  });

  it("declares configure and observe capabilities", () => {
    expect(snowlumaManifest.capabilities).toEqual(["configure", "observe"]);
    expect(snowlumaManifest.credentialTransport).toBe("provider-api");
    expect(snowlumaManifest.id).toBe("snowluma");
    expect(snowlumaManifest.displayName).toBe("SnowLuma");
  });

  it("is unavailable until licensing and verified artifact policy are configured", () => {
    expect(snowlumaAvailability.available).toBe(false);
    expect(snowlumaAvailability.runtimeRequest).toBeNull();
    expect(snowlumaAvailability.requirements).toEqual(
      expect.arrayContaining([
        "snowluma-license-accepted",
        "verified-artifact-policy",
      ]),
    );
  });

  it("does not expose a runnable image reference", async () => {
    const module = await import("../src/index.js");
    expect(JSON.stringify(module)).not.toMatch(/sha256|snowluma:v/);
  });

  it("separates credential schema from ordinary configuration", () => {
    expect(() =>
      SnowLumaConfigurationSchema.parse({
        endpointUrl: "http://provider.invalid",
        accessToken: "secret",
      }),
    ).toThrow();
    expect(SnowLumaCredentialsSchema.parse({ accessToken: "secret" })).toEqual({ accessToken: "secret" });
    expect(redactSnowlumaConfiguration({ endpointUrl: "http://provider.invalid" })).toEqual({ endpointUrl: "http://provider.invalid/" });
  });

  it("redacts credential-like values recursively", () => {
    expect(redactSnowlumaConfiguration({ endpointUrl: "http://u:p@host/x?token=abc" } as never)).toEqual({ endpointUrl: "http://host/x?token=%5BREDACTED%5D" });
  });
});
