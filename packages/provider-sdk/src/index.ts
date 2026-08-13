import { z } from "zod";
import { ProviderIdSchema, type EndpointId } from "@botroost/contracts";
import type { RuntimeRequest } from "@botroost/runtime-sdk";
export const ProviderCapabilityManifestSchema = z.strictObject({
  id: ProviderIdSchema,
  displayName: z.string().min(1),
  capabilities: z.array(z.enum(["setup", "configure", "observe", "events"])),
  credentialTransport: z.enum(["none", "provider-api"]),
  runtimeRequirements: z.array(z.string()),
});
export type ProviderCapabilityManifest = z.infer<typeof ProviderCapabilityManifestSchema>;
export type ProviderCapability = ProviderCapabilityManifest["capabilities"][number];
export interface SecretRef { readonly ref: string }
class ExplicitCredentialEnvelope {
  constructor(readonly value: Readonly<Record<string, unknown>> | SecretRef) {}
}
const credentialEnvelopes = new WeakSet<ExplicitCredentialEnvelope>();
export type CredentialEnvelope = ExplicitCredentialEnvelope;
export const credentialEnvelope = (
  value: Readonly<Record<string, unknown>> | SecretRef,
): CredentialEnvelope => {
  const envelope = new ExplicitCredentialEnvelope(value);
  credentialEnvelopes.add(envelope);
  return envelope;
};
export interface ProviderInvocation<TConfig = unknown> {
  config: TConfig;
  credentials?: CredentialEnvelope;
}
export interface ProviderAdapter {
  readonly manifest: ProviderCapabilityManifest;
  runtimeRequest: RuntimeRequest | null;
  setup(config: unknown, credentials?: CredentialEnvelope): Promise<void>;
  configure(
    endpointId: EndpointId,
    config: Record<string, unknown>,
    credentials?: CredentialEnvelope,
  ): Promise<void>;
  observe(endpointId: EndpointId): Promise<unknown>;
  redact(config: Record<string, unknown>): unknown;
  runtimeRequirements(): readonly string[];
}
const secretKey =
  /^(?:key|access[_-]?key|bearer|cookie|session)$|(?:token|secret|password|passwd|api[_-]?key|authorization|credential|private[_-]?key|client[_-]?secret)/i;
const redactUrl = (text: string): string => {
  try {
    const url = new URL(text);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    for (const key of [...url.searchParams.keys()])
      if (secretKey.test(key)) url.searchParams.set(key, "[REDACTED]");
    return url.toString();
  } catch {
    return text;
  }
};
export function redactSecrets(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (current: unknown, key?: string): unknown => {
    if (key && secretKey.test(key)) return "[REDACTED]";
    if (typeof current === "string") return redactUrl(current);
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) throw new Error("cyclic secret input");
    seen.add(current);
    if (Array.isArray(current)) return current.map((item) => walk(item));
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>).map(([name, item]) => [
        name,
        walk(item, name),
      ]),
    );
  };
  try { return walk(value); } catch { return "[REDACTED]"; }
}
const validateInvocation = <T>(
  provider: ProviderAdapter,
  invocation: ProviderInvocation<T>,
): ProviderInvocation<T> => {
  if (!(invocation && typeof invocation === "object" && "config" in invocation))
    throw new Error("provider invocation must separate config and credentials");
  if (invocation.credentials !== undefined) {
    if (!credentialEnvelopes.has(invocation.credentials))
      throw new Error("invalid credential envelope");
    if (provider.manifest.credentialTransport === "none")
      throw new Error("credential transport does not permit credentials");
  }
  return invocation;
};
export async function invokeProvider(
  provider: ProviderAdapter, capability: "setup", invocation: ProviderInvocation,
): Promise<void>;
export async function invokeProvider(
  provider: ProviderAdapter, capability: "configure", endpointId: EndpointId,
  invocation: ProviderInvocation<Record<string, unknown>>,
): Promise<void>;
export async function invokeProvider(
  provider: ProviderAdapter, capability: "observe", endpointId: EndpointId,
): Promise<unknown>;
export async function invokeProvider(
  provider: ProviderAdapter, capability: "setup" | "configure" | "observe",
  ...args: unknown[]
): Promise<unknown> {
  ProviderCapabilityManifestSchema.parse(provider.manifest);
  if (!provider.manifest.capabilities.includes(capability))
    throw new Error(`undeclared capability: ${capability}`);
  if (capability === "setup") {
    const invocation = validateInvocation(provider, args[0] as ProviderInvocation);
    return provider.setup(invocation.config, invocation.credentials);
  }
  if (capability === "configure") {
    const invocation = validateInvocation(
      provider, args[1] as ProviderInvocation<Record<string, unknown>>,
    );
    return provider.configure(
      args[0] as EndpointId, invocation.config, invocation.credentials,
    );
  }
  return provider.observe(args[0] as EndpointId);
}
export interface ContractHarness {
  test(name: string, fn: () => void | Promise<void>): void;
  assert(value: unknown): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    not: { toBe(expected: unknown): void };
  };
}
export function runProviderContractSuite(
  factory: () => ProviderAdapter,
  harness: ContractHarness,
): void {
  harness.test("has a valid manifest", () =>
    harness.assert(ProviderCapabilityManifestSchema.safeParse(factory().manifest).success).toBe(true),
  );
  harness.test("redacts credential-like values recursively", () =>
    harness.assert(factory().redact({ nested: [{ token: "secret" }] })).toEqual(
      { nested: [{ token: "[REDACTED]" }] },
    ),
  );
  harness.test("exposes only an untrusted runtime request", () => {
    const provider = factory();
    harness.assert(provider.runtimeRequest === null || typeof provider.runtimeRequest === "object").toBe(true);
  });
  harness.test("declares runtime requirements consistently", () => {
    const provider = factory();
    harness.assert(provider.runtimeRequirements()).toEqual(provider.manifest.runtimeRequirements);
  });
  harness.test("executes setup configure observe lifecycle", async () => {
    const provider = factory();
    const endpointId = "contract-endpoint" as EndpointId;
    await invokeProvider(provider, "setup", { config: {} });
    await invokeProvider(provider, "configure", endpointId, { config: { mode: "contract" } });
    harness.assert(await invokeProvider(provider, "observe", endpointId)).not.toBe(undefined);
  });
  harness.test("rejects undeclared capabilities", async () => {
    const provider = factory();
    const candidate = (["setup", "configure", "observe"] as const).find(
      (capability) => !provider.manifest.capabilities.includes(capability),
    );
    if (!candidate) return;
    let rejected = false;
    try {
      if (candidate === "setup") await invokeProvider(provider, candidate, { config: {} });
      else if (candidate === "configure")
        await invokeProvider(provider, candidate, "ep" as EndpointId, { config: {} });
      else await invokeProvider(provider, candidate, "ep" as EndpointId);
    } catch { rejected = true; }
    harness.assert(rejected).toBe(true);
  });
}
