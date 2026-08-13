import type {
  EndpointDesiredState,
  EndpointId,
  OperationId,
} from "@botroost/contracts";
export interface EndpointSimulation {
  endpointId: EndpointId;
  desired?: EndpointDesiredState;
  protocol: "unknown" | "connected" | "disconnected";
  convergence:
    | "unknown"
    | "reconciling"
    | "converged"
    | "failed"
    | "conflicted";
  connectionEpoch: number;
  completedResults: readonly {
    operationId: OperationId;
    generation: number;
    connectionEpoch: number;
  }[];
  conflict?: string;
  lastError?: string;
}
export type Event =
  | { type: "desired"; desired: EndpointDesiredState }
  | {
      type: "operation-result";
      operationId: OperationId;
      generation: number;
      connectionEpoch: number;
      outcome: "succeeded" | "failed";
      error?: string;
    }
  | { type: "disconnected" }
  | { type: "connected" }
  | { type: "conflict"; reason: string };
export const initialEndpoint = (
  endpointId: EndpointId,
): EndpointSimulation => ({
  endpointId,
  protocol: "unknown",
  convergence: "unknown",
  connectionEpoch: 0,
  completedResults: [],
});
const withoutErrors = (state: EndpointSimulation): EndpointSimulation => {
  const clean = { ...state };
  delete clean.conflict;
  delete clean.lastError;
  return clean;
};
export function reduceEndpoint(
  state: EndpointSimulation,
  event: Event,
): EndpointSimulation {
  if (event.type === "desired") {
    if (state.desired && event.desired.generation < state.desired.generation)
      return state;
    if (
      state.desired &&
      event.desired.generation === state.desired.generation &&
      event.desired.activeOperationId === state.desired.activeOperationId
    )
      return state;
    return {
      ...withoutErrors(state),
      desired: event.desired,
      convergence: "reconciling",
    };
  }
  if (event.type === "disconnected") {
    if (state.protocol === "disconnected") return state;
    return {
      ...state,
      protocol: "disconnected",
      convergence: "unknown",
      connectionEpoch: state.connectionEpoch + 1,
    };
  }
  if (event.type === "connected")
    return {
      ...state,
      protocol: "connected",
      convergence: state.desired ? "reconciling" : state.convergence,
    };
  if (event.type === "conflict")
    return { ...state, convergence: "conflicted", conflict: event.reason };
  if (
    state.protocol !== "connected" ||
    !state.desired ||
    event.generation !== state.desired.generation ||
    event.operationId !== state.desired.activeOperationId ||
    event.connectionEpoch !== state.connectionEpoch ||
    state.completedResults.some(
      (completed) =>
        completed.operationId === event.operationId &&
        completed.generation === event.generation &&
        completed.connectionEpoch === event.connectionEpoch,
    )
  )
    return state;
  const next = {
    ...withoutErrors(state),
    completedResults: [
      ...state.completedResults,
      {
        operationId: event.operationId,
        generation: event.generation,
        connectionEpoch: event.connectionEpoch,
      },
    ],
    convergence:
      event.outcome === "succeeded"
        ? ("converged" as const)
        : ("failed" as const),
  };
  return event.outcome === "failed" && event.error
    ? { ...next, lastError: event.error }
    : next;
}
