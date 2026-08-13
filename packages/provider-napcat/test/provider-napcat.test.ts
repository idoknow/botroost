import { describe, expect, it } from "vitest";
import {
  napcatAvailability,
  napcatManifest,
  NapCatConfigurationSchema,
  NapCatCredentialsSchema,
  redactNapCatConfiguration,
} from "../src/index.js";
describe("NapCat skeleton", () => {
  it("is unavailable until licensing and verified artifact policy are configured", () => {
    expect(napcatAvailability.available).toBe(false);
    expect(napcatAvailability.runtimeRequest).toBeNull();
    expect(napcatAvailability.requirements).toEqual(
      expect.arrayContaining([
        "napcat-license-accepted",
        "verified-artifact-policy",
      ]),
    );
  });
  it("does not expose a runnable image or WebUI secret", async () => {
    const module = await import("../src/index.js");
    expect(JSON.stringify(module)).not.toMatch(
      /sha256|NAPCAT_WEBUI_SECRET_KEY/,
    );
  });
  it("gates capabilities and credentials", () => {
    expect(napcatManifest.capabilities).toEqual(["configure", "observe"]);
    expect(napcatManifest.credentialTransport).toBe("provider-api");
  });
  it("separates credential schema from ordinary configuration", () => {
    expect(() =>
      NapCatConfigurationSchema.parse({
        endpointUrl: "https://provider.invalid",
        accessToken: "secret",
      }),
    ).toThrow();
    expect(NapCatCredentialsSchema.parse({ accessToken: "secret" })).toEqual({ accessToken: "secret" });
    expect(redactNapCatConfiguration({ endpointUrl: "https://provider.invalid" })).toEqual({ endpointUrl: "https://provider.invalid" });
  });
});
