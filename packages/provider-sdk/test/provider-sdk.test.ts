import { describe, expect, it } from "vitest";
import { asEndpointId, asProviderId } from "@botroost/contracts";
import {
  credentialEnvelope,
  invokeProvider,
  ProviderCapabilityManifestSchema,
  redactSecrets,
  type ProviderAdapter,
} from "../src/index.js";
const adapter = (
  capabilities: Array<"setup" | "configure" | "observe">,
): ProviderAdapter => ({
  manifest: {
    id: asProviderId("test"),
    displayName: "Test",
    capabilities,
    credentialTransport: "none",
    runtimeRequirements: [],
  },
  runtimeRequest: null,
  async setup() {},
  async configure() {},
  async observe() {
    return { ok: true };
  },
  redact: redactSecrets,
  runtimeRequirements() {
    return [];
  },
});
describe("provider gates and redaction", () => {
  it("validates capability and credential declarations", () =>
    expect(
      ProviderCapabilityManifestSchema.parse({
        id: asProviderId("fake"),
        displayName: "Fake",
        capabilities: ["configure", "observe"],
        credentialTransport: "none",
        runtimeRequirements: [],
      }).credentialTransport,
    ).toBe("none"));
  it("rejects invocation of an undeclared capability", async () =>
    await expect(
      invokeProvider(adapter(["observe"]), "configure", asEndpointId("ep"), { config: {} }),
    ).rejects.toThrow(/undeclared capability/));
  it("does not guess credentials from ordinary configuration fields", async () =>
    await expect(
      invokeProvider(adapter(["setup"]), "setup", {
        config: { accessToken: "ordinary schema-owned value" },
      }),
    ).resolves.toBeUndefined());
  it("rejects a forged credential envelope with a genuine prototype", async () => {
    const provider = adapter(["setup"]);
    provider.manifest.credentialTransport = "provider-api";
    const genuine = credentialEnvelope({ token: "secret" });
    const forged = Object.create(Object.getPrototypeOf(genuine)) as typeof genuine;
    Object.defineProperty(forged, "value", { value: { token: "forged" } });
    await expect(
      invokeProvider(provider, "setup", { config: {}, credentials: forged }),
    ).rejects.toThrow(/invalid credential envelope/);
  });
  it("rejects an explicit credentials envelope when transport is none", async () =>
    await expect(
      invokeProvider(adapter(["setup"]), "setup", {
        config: {},
        credentials: credentialEnvelope({ token: "secret" }),
      }),
    ).rejects.toThrow(/credential transport/));
  it("redacts nested objects, arrays, and common secret keys", () =>
    expect(
      redactSecrets({
        authorization: "Bearer x",
        nested: [{ api_key: "x", safe: true }, { clientSecret: "y" }],
        key: "k",
        access_key: "a",
        bearer: "b",
        cookie: "c",
        session: "s",
        endpoint: "https://user:pass@example.invalid/path?token=x&safe=y",
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      nested: [
        { api_key: "[REDACTED]", safe: true },
        { clientSecret: "[REDACTED]" },
      ],
      key: "[REDACTED]",
      access_key: "[REDACTED]",
      bearer: "[REDACTED]",
      cookie: "[REDACTED]",
      session: "[REDACTED]",
      endpoint: "https://example.invalid/path?token=%5BREDACTED%5D&safe=y",
    }));
  it("exposes only an untrusted runtime request through the provider contract", () => {
    const provider = adapter([]);
    provider.runtimeRequest = {
      approvedArtifactId: "artifact:unknown",
      approvedEgressProfile: "egress:unknown",
      resources: { cpuMillis: 100, memoryMiB: 64 },
      storage: { kind: "none", sizeMiB: 0 },
    };
    expect(provider.runtimeRequest.approvedArtifactId).toBe("artifact:unknown");
    expect("resolveProviderRuntime" in provider).toBe(false);
  });
  it("fails closed on cyclic values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(redactSecrets(cyclic)).toBe("[REDACTED]");
  });
});
