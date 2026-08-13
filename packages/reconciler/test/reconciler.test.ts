import { describe, expect, it } from "vitest";
import { asEndpointId, asOperationId } from "@botroost/contracts";
import { initialEndpoint, reduceEndpoint } from "../src/index.js";
const desired = (generation: number, operationId: string) => ({
  enabled: true,
  generation,
  activeOperationId: asOperationId(operationId),
  configuration: {},
});
describe("reconciler fencing", () => {
  it("requires generation, operation and connection epoch to converge", () => {
    let state = reduceEndpoint(initialEndpoint(asEndpointId("ep")), {
      type: "desired",
      desired: desired(1, "op-1"),
    });
    state = reduceEndpoint(state, { type: "connected" });
    const accepted = reduceEndpoint(state, {
      type: "operation-result",
      operationId: asOperationId("op-1"),
      generation: 1,
      connectionEpoch: state.connectionEpoch,
      outcome: "succeeded",
    });
    expect(accepted.convergence).toBe("converged");
  });
  it("rejects another operation at the same generation", () => {
    const state = reduceEndpoint(initialEndpoint(asEndpointId("ep")), {
      type: "desired",
      desired: desired(2, "active"),
    });
    expect(
      reduceEndpoint(state, {
        type: "operation-result",
        operationId: asOperationId("other"),
        generation: 2,
        connectionEpoch: 0,
        outcome: "failed",
        error: "must not apply",
      }),
    ).toEqual(state);
  });
  it("increments epoch on disconnect and fences late results", () => {
    let state = reduceEndpoint(initialEndpoint(asEndpointId("ep")), {
      type: "desired",
      desired: desired(1, "op-1"),
    });
    const oldEpoch = state.connectionEpoch;
    state = reduceEndpoint(state, { type: "disconnected" });
    expect(state.connectionEpoch).toBe(oldEpoch + 1);
    expect(
      reduceEndpoint(state, {
        type: "operation-result",
        operationId: asOperationId("op-1"),
        generation: 1,
        connectionEpoch: oldEpoch,
        outcome: "succeeded",
      }),
    ).toEqual(state);
  });
  it("is idempotent for repeated disconnected events", () => {
    const once = reduceEndpoint(initialEndpoint(asEndpointId("ep")), {
      type: "disconnected",
    });
    const twice = reduceEndpoint(once, { type: "disconnected" });
    expect(twice).toEqual(once);
  });
  it("never converges from a result while disconnected, even at the current epoch", () => {
    let state = reduceEndpoint(initialEndpoint(asEndpointId("ep")), {
      type: "desired",
      desired: desired(1, "op-1"),
    });
    state = reduceEndpoint(state, { type: "disconnected" });
    const result = reduceEndpoint(state, {
      type: "operation-result",
      operationId: asOperationId("op-1"),
      generation: 1,
      connectionEpoch: state.connectionEpoch,
      outcome: "succeeded",
    });
    expect(result).toEqual(state);
  });
  it("accepts the same operation identity after reconnect in a new epoch", () => {
    let state = reduceEndpoint(initialEndpoint(asEndpointId("ep")), {
      type: "desired",
      desired: desired(1, "op-1"),
    });
    state = reduceEndpoint(state, { type: "connected" });
    state = reduceEndpoint(state, {
      type: "operation-result",
      operationId: asOperationId("op-1"),
      generation: 1,
      connectionEpoch: 0,
      outcome: "failed",
    });
    state = reduceEndpoint(state, { type: "disconnected" });
    state = reduceEndpoint(state, { type: "connected" });
    state = reduceEndpoint(state, {
      type: "operation-result",
      operationId: asOperationId("op-1"),
      generation: 1,
      connectionEpoch: state.connectionEpoch,
      outcome: "succeeded",
    });
    expect(state.convergence).toBe("converged");
  });
  it("re-enters reconciliation after reconnect at the same generation", () => {
    let state = reduceEndpoint(initialEndpoint(asEndpointId("ep")), {
      type: "desired",
      desired: desired(1, "op-1"),
    });
    state = reduceEndpoint(state, { type: "disconnected" });
    state = reduceEndpoint(state, { type: "connected" });
    expect([state.protocol, state.convergence]).toEqual([
      "connected",
      "reconciling",
    ]);
  });
  it("clears stale errors when a new desired operation arrives or succeeds", () => {
    let state = reduceEndpoint(initialEndpoint(asEndpointId("ep")), {
      type: "desired",
      desired: desired(1, "op-1"),
    });
    state = reduceEndpoint(state, {
      type: "operation-result",
      operationId: asOperationId("op-1"),
      generation: 1,
      connectionEpoch: 0,
      outcome: "failed",
      error: "boom",
    });
    state = reduceEndpoint(state, {
      type: "desired",
      desired: desired(2, "op-2"),
    });
    expect(state.lastError).toBeUndefined();
    state = reduceEndpoint(state, {
      type: "operation-result",
      operationId: asOperationId("op-2"),
      generation: 2,
      connectionEpoch: 0,
      outcome: "succeeded",
    });
    expect(state.lastError).toBeUndefined();
  });
});
