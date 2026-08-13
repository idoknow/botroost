import { describe, expect, it } from "vitest";
import {
  asEndpointId,
  asOperationId,
  EndpointDesiredStateSchema,
  EndpointIdSchema,
  LayeredStatusSchema,
  OperationIdSchema,
  OperationSchema,
  type EndpointId,
  type OperationId,
} from "../src/index.js";
describe("neutral contracts", () => {
  it("parses branded nonempty IDs with Zod", () => {
    expect(EndpointIdSchema.parse("ep-1")).toBe("ep-1");
    expect(OperationIdSchema.parse("op-1")).toBe("op-1");
    expect(() => asEndpointId("")).toThrow();
  });
  it("prevents ID interchange at compile time", () => {
    const endpointId: EndpointId = asEndpointId("ep");
    const operationId: OperationId = asOperationId("op");
    // @ts-expect-error OperationId must not be assignable to EndpointId.
    const invalidEndpoint: EndpointId = operationId;
    // @ts-expect-error EndpointId must not be assignable to OperationId.
    const invalidOperation: OperationId = endpointId;
    expect([invalidEndpoint, invalidOperation]).toEqual(["op", "ep"]);
  });
  it("validates five status layers", () =>
    expect(
      LayeredStatusSchema.parse({
        node: "online",
        runtime: "ready",
        provider: "available",
        protocol: "connected",
        convergence: "converged",
      }).convergence,
    ).toBe("converged"));
  it("binds desired state to an active operation", () =>
    expect(
      EndpointDesiredStateSchema.parse({
        enabled: true,
        generation: 2,
        activeOperationId: "op-2",
        configuration: {},
      }).activeOperationId,
    ).toBe("op-2"));
  it("models operations with branded boundary IDs", () => {
    const operation = OperationSchema.parse({
      id: "op",
      endpointId: "ep",
      generation: 1,
      state: "pending",
    });
    const endpointId: EndpointId = operation.endpointId;
    const operationId: OperationId = operation.id;
    expect([endpointId, operationId]).toEqual(["ep", "op"]);
  });
});
