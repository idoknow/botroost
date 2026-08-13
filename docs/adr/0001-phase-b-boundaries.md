# ADR 0001: Phase B boundaries

**Status:** Accepted

Use provider-neutral core contracts and put vendor vocabulary only in provider packages. Model Node, Runtime, Provider, Protocol, and Convergence independently. Runtime requests are data validated against a strict allowlist, never command execution requests. Reconciliation is a pure per-endpoint reducer with generation fencing. Agent effects are preceded by durable receipts and followed by durable result records.

Consequences: adapters cannot request privileged/host networking, commands, Docker sockets, arbitrary mounts, or floating images. Real orchestration and NapCat execution remain out of scope.
