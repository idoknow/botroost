# Threat model

## Assets and boundaries
Credentials, desired state, operation ordering, provider observations, and agent effects cross controller/provider/runtime boundaries. Provider input and journal contents are untrusted after a crash.

## Threats and controls
- **Privilege escape:** `RuntimeRequestSchema` accepts only opaque artifact/egress references and bounded resources, not commands, mounts, images, host networking, privileged mode, or Docker socket access. The control plane resolves references through injected approval lookups before a future driver may execute them.
- **Credential disclosure:** provider schemas MUST mark secret fields and pass them only through the explicit `CredentialEnvelope`/`SecretRef` invocation parameter. `CredentialEnvelope` is an in-process opaque capability registered by the local factory; it is not a cross-realm or cross-process authenticity promise. Across process boundaries, transmit only a `SecretRef`, then use the receiving process's local factory. Ordinary configuration is never classified by field-name guessing. `credentialTransport: none` rejects every credentials envelope, while `provider-api` passes it only to the provider API boundary. Recursive key/URL redaction remains defense in depth; do not log raw configuration.
- **Replay/out-of-order execution:** receipt/effect IDs deduplicate; command leases carry attempts/deadlines; operation, generation, node, and connection-epoch fences reject stale/late results.
- **Agent transport disclosure:** enrollment tokens are one-use, hashed at rest, sent only in request bodies, and exchanged for hashed bearer node credentials. Agent credential files are forced to `0600`; transport redaction removes bearer, enrollment token, URL username/password, and secret query parameters.
- **Revocation and workspace binding:** node bearer authentication ignores revoked nodes; command claim, receipt, and result are bound to the authenticated node and its workspace.
- **Cross-endpoint interference:** conflict state belongs to one endpoint reducer.
- **Torn writes:** any final bytes without a newline are truncated and excluded from replay, even when they happen to form valid JSON. Only newline-terminated, fsynced records recover.
- **Provider compromise:** capability manifests are declarative and least privilege. Providers expose only an untrusted `RuntimeRequest`; neither runtime-sdk nor provider-sdk exports a validation/branding function or returns an executable spec. `@botroost/control-plane-policy` resolves requests using control-plane-injected artifact and egress lookups and returns a `ResolvedRuntimeSpec`. This type records that the resolver ran; it is not an unforgeable JavaScript security boundary. Future runtime-driver APIs must accept only resolved specs and still enforce runtime isolation.

Not yet covered: TLS termination configuration, sandbox implementation beyond declarative request boundaries, OS keychain/HSM storage, real provider protocol validation, journal compaction and automated stale-lock recovery. Journal writers are mutually excluded by an atomic lock directory; crash recovery is deliberately manual after confirming the owner is dead.
