# Botroost interface system

The normative product design guidance is [`../DESIGN.md`](../DESIGN.md). This file records implementation tokens and must not contradict it.

## Foundations

- Light canvas `#f8fafc`, surface `#ffffff`, muted surface `#f1f5f9`, text `#0f172a`, border `#e2e8f0`.
- Dark canvas `#0f172a`, surface `#111827`, muted surface `#1e293b`, text `#f8fafc`, border `#273449`.
- Blue is reserved for links, focus, active navigation, and primary action.
- Green, amber, red, gray, and violet are small semantic signals only.
- System sans is used for interface language; monospace only for IDs, logs, and technical values.
- Primary spacing rhythm: 8 / 12 / 16 / 24 px. Product surfaces use an 8 px radius and 1 px border.

## Global layout

- Desktop: 190 px sidebar, 56 px header, centered 980 px content column with 16 px gutters.
- Mobile: 56 px header and 64 px bottom navigation with Cluster, Endpoints, Nodes, Changes, and More.
- Main page title is 20 px. Inner headings are 14–16 px. Body is 14 px; metadata is 12 px.
- Surfaces represent real information groups. Do not nest decorative cards or add colored side rails.
- Tabs are natural-width, left-aligned progressive-disclosure controls.

## Product semantics

- Endpoint is the primary managed OneBot protocol service.
- Node hosts endpoint runtimes through an outbound agent connection.
- NapCat is a runtime driver and OneBot implementation, not the protocol itself.
- QQ account is observed identity; OneBot 11 is protocol availability; WebSocket entries are transport configuration.
- Every status label names its subject. Never claim a live peer connection without telemetry.

## Voice

Use concise operational language. Name the resource, measured state, and next action. Avoid product pitches inside authenticated pages, redundant headings, anthropomorphism, and ambiguous connection language.
