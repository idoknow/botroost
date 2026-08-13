import { describe, expect, it } from "vitest";
import { resolveRuntimeRequest } from "../src/index.js";
const request = {
  approvedArtifactId: "artifact:fake:v1",
  approvedEgressProfile: "egress:provider-api",
  resources: { cpuMillis: 500, memoryMiB: 256 },
  storage: { kind: "ephemeral" as const, sizeMiB: 128 },
};
const artifactLookup = (id: string) =>
  id === "artifact:fake:v1"
    ? { id, image: `ghcr.io/botroost/fake@sha256:${"a".repeat(64)}` }
    : undefined;
const egressLookup = (id: string) =>
  id === "egress:provider-api"
    ? { id, allowedHosts: ["api.example.invalid"] as const }
    : undefined;
describe("control-plane runtime resolution", () => {
  it("resolves approved references into a driver-facing spec", () =>
    expect(resolveRuntimeRequest(request, artifactLookup, egressLookup)).toEqual({
      artifact: artifactLookup(request.approvedArtifactId),
      egress: egressLookup(request.approvedEgressProfile),
      resources: request.resources,
      storage: request.storage,
    }));
  it("rejects an unknown artifact reference", () =>
    expect(() => resolveRuntimeRequest(
      { ...request, approvedArtifactId: "artifact:unknown" },
      artifactLookup,
      egressLookup,
    )).toThrow(/artifact.*not approved/i));
  it("rejects an unknown egress reference", () =>
    expect(() => resolveRuntimeRequest(
      { ...request, approvedEgressProfile: "egress:unknown" },
      artifactLookup,
      egressLookup,
    )).toThrow(/egress.*not approved/i));
});
