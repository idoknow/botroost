import { RuntimeRequestSchema, type RuntimeRequest } from "@botroost/runtime-sdk";
export interface ApprovedArtifact {
  readonly id: string;
  readonly image: string;
}
export interface ApprovedEgress {
  readonly id: string;
  readonly allowedHosts: readonly string[];
}
declare const resolvedRuntimeSpecBrand: unique symbol;
export interface ResolvedRuntimeSpec {
  readonly artifact: ApprovedArtifact;
  readonly egress: ApprovedEgress;
  readonly resources: RuntimeRequest["resources"];
  readonly storage: RuntimeRequest["storage"];
  readonly [resolvedRuntimeSpecBrand]: true;
}
export type LookupApprovedArtifact = (id: string) => ApprovedArtifact | undefined;
export type LookupApprovedEgress = (id: string) => ApprovedEgress | undefined;
export const resolveRuntimeRequest = (
  input: unknown,
  lookupApprovedArtifact: LookupApprovedArtifact,
  lookupApprovedEgress: LookupApprovedEgress,
): ResolvedRuntimeSpec => {
  const request = RuntimeRequestSchema.parse(input);
  const artifact = lookupApprovedArtifact(request.approvedArtifactId);
  if (!artifact)
    throw new Error(`artifact is not approved: ${request.approvedArtifactId}`);
  const egress = lookupApprovedEgress(request.approvedEgressProfile);
  if (!egress)
    throw new Error(`egress profile is not approved: ${request.approvedEgressProfile}`);
  return {
    artifact,
    egress,
    resources: request.resources,
    storage: request.storage,
  } as ResolvedRuntimeSpec;
};
