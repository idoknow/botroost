import { asProviderId, type EndpointId } from "@botroost/contracts";
import {
  redactSecrets,
  type ProviderAdapter,
  type ProviderCapabilityManifest,
} from "@botroost/provider-sdk";
export class FakeProviderAdapter implements ProviderAdapter {
  readonly manifest: ProviderCapabilityManifest = {
    id: asProviderId("fake"),
    displayName: "Deterministic Fake",
    capabilities: ["setup", "configure", "observe"],
    credentialTransport: "none",
    runtimeRequirements: [],
  };
  runtimeRequest = null;
  private ready = false;
  private readonly configs = new Map<EndpointId, Record<string, unknown>>();
  async setup(config?: unknown): Promise<void> {
    void config;
    this.ready = true;
  }
  async configure(
    id: EndpointId,
    config: Record<string, unknown>,
  ): Promise<void> {
    if (!this.ready) throw new Error("provider not setup");
    this.configs.set(id, structuredClone(config));
  }
  async observe(id: EndpointId): Promise<unknown> {
    const config = this.configs.get(id);
    return {
      configured: Boolean(config),
      configuration: config ? this.redact(config) : undefined,
    };
  }
  redact(config: Record<string, unknown>): unknown {
    return redactSecrets(config);
  }
  runtimeRequirements(): readonly string[] {
    return this.manifest.runtimeRequirements;
  }
}
