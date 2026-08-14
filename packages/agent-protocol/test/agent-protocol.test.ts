import { describe, expect, it } from "vitest";
import {
  AgentHeartbeatRequestSchema,
  RuntimeCommandSchema,
  redactTransportSecrets,
} from "../src/index.js";

const command = {
  commandId: "cmd-1",
  operationId: "op-1",
  workspaceId: "1f22ef8c-58c2-4822-b0f2-d6115f0d13db",
  nodeId: "3b2f7a0e-7047-460e-a124-153b26dbec3e",
  endpointId: "ep-1",
  generation: 2,
  connectionEpoch: 4,
  action: "start" as const,
  runtimeRequest: {
    approvedArtifactId: "artifact:fake:v1",
    approvedEgressProfile: "egress:none",
    resources: { cpuMillis: 100, memoryMiB: 64 },
    storage: { kind: "ephemeral" as const, sizeMiB: 16 },
  },
  metadata: { labels: { role: "test" } },
};

describe("agent protocol", () => {
  it("strictly accepts only the heartbeat allowlist", () => {
    expect(
      AgentHeartbeatRequestSchema.parse({
        status: "online",
        observedAt: "2026-08-13T00:00:00.000Z",
        agentVersion: "1.2.3",
        os: "linux",
        arch: "x64",
        capacity: { cpuMillis: 2000, memoryMiB: 4096 },
        runtimes: [],
      }),
    ).toMatchObject({ status: "online" });

    expect(() =>
      AgentHeartbeatRequestSchema.parse({
        status: "online",
        observedAt: "2026-08-13T00:00:00.000Z",
        runtimes: [],
        token: "must-not-be-accepted",
      }),
    ).toThrow();

    expect(() =>
      AgentHeartbeatRequestSchema.parse({
        status: "online",
        observedAt: "2026-08-13T00:00:00.000Z",
        runtimes: [{
          endpointId: "ep-1",
          generation: 1,
          runtime: "ready",
          provider: "available",
          protocol: "connected",
          convergence: "converged",
          metadata: { login: { qrcode: "safe-observation" } },
          secret: "must-not-be-accepted",
        }],
      }),
    ).toThrow();
  });

  it("keeps runtime commands declarative", () => {
    expect(RuntimeCommandSchema.parse(command)).toEqual(command);
    expect(() =>
      RuntimeCommandSchema.parse({
        ...command,
        runtimeRequest: { ...command.runtimeRequest, command: ["sh"] },
      }),
    ).toThrow();
  });

  it("redacts bearer, enrollment token, and URL credentials from logs", () => {
    const output = redactTransportSecrets({
      authorization: "Bearer node-secret",
      enrollmentToken: "enroll-secret",
      controlPlaneUrl: "https://user:pass@example.test/path?token=secret&ok=1",
      nested: { url: "postgres://u:p@db.test/app?password=pw" },
    });

    expect(JSON.stringify(output)).not.toContain("node-secret");
    expect(JSON.stringify(output)).not.toContain("enroll-secret");
    expect(JSON.stringify(output)).not.toContain("pass@example");
    expect(JSON.stringify(output)).not.toContain("password=pw");
  });
});
