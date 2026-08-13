import { describe, expect, it } from "vitest";
import { RuntimeRequestSchema } from "../src/index.js";
const request = {
  approvedArtifactId: "artifact:fake:v1",
  approvedEgressProfile: "egress:provider-api",
  resources: { cpuMillis: 500, memoryMiB: 256 },
  storage: { kind: "ephemeral" as const, sizeMiB: 128 },
};
describe("runtime request boundary", () => {
  it("parses declarative untrusted requests", () =>
    expect(RuntimeRequestSchema.parse(request)).toEqual(request));
  it.each([
    ["image", { image: `evil.invalid/pwn@sha256:${"a".repeat(64)}` }],
    ["egress hosts", { egressHosts: ["evil.invalid"] }],
    ["command", { command: ["sh"] }],
    ["privileged", { privileged: true }],
    ["mount", { mounts: [] }],
  ])("rejects executable field %s", (_name, override) =>
    expect(() => RuntimeRequestSchema.parse({ ...request, ...override })).toThrow());
});
