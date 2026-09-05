# Product Design Guidelines

## Product Feel

Botroost should feel like a quiet internal operating tool for a cloud-native OneBot endpoint cluster—not a marketing site, a generic SaaS dashboard, or a container administration console.

The interface is compact, legible, calm, and designed for repeated operational use. Prefer clarity and density over visual drama. Every screen should help operators scan endpoint state, identify the responsible entity, make a safe change, and continue working without being overwhelmed.

## Domain Hierarchy

Use these terms consistently:

```text
Workspace
├── Agent nodes
│   └── Protocol endpoints
│       ├── Runtime driver and container
│       ├── QQ account identity
│       ├── OneBot 11 protocol service
│       └── WebSocket transport configuration
└── Unified activity, members, and per-endpoint alert subscriptions
```

- **Protocol endpoint** is the primary managed resource.
- **Agent node** is the machine running the outbound Botroost agent.
- **Runtime driver** is an implementation adapter such as NapCat, not a running instance.
- **Container** is the endpoint runtime on its assigned node.
- **QQ account** is the observed login identity inside a NapCat endpoint.
- **OneBot 11** is the protocol service exposed by that runtime.
- **WebSocket clients and servers** are transport configuration, not proof of a live peer connection.
- Never use an ambiguous status such as “OneBot connecting.” Name the subject and measured condition.

## Layout

- Use a light gray page canvas with centered content; dark mode uses the same surface hierarchy.
- Desktop uses a compact 190 px sidebar, 56 px header, and a centered content column no wider than 980 px.
- Mobile uses a compact header and fixed bottom navigation; do not use a large drawer as the primary navigation.
- Keep global chrome compact: logo, workspace, account, appearance, and session controls are utilities—not hero content.
- Primary navigation is small, pill-like, and understated. Active state is clear but not loud.
- Use white/dark-card surfaces only for real information groups.
- Avoid nested cards, decorative section containers, oversized hero blocks, and marketing split layouts inside the signed-in product.
- Preserve whitespace around major blocks while keeping repeated rows dense enough to scan.
- Tab lists size to their content and align left. Do not stretch tabs to full width.

## Typography

- Use the system sans stack (`PingFang SC`, `Microsoft YaHei`, system UI) for interface language and monospace only for IDs, logs, and technical values.
- Keep typography small and purposeful: body 14 px, metadata 12 px, page titles 20 px, inner headings 14–16 px.
- Use short, direct operational copy.
- Avoid explanatory marketing text inside the signed-in product.
- Use muted text for time, IDs, role, driver, node, and other secondary context.
- Avoid viewport-scaled typography, negative letter spacing, and repeated uppercase overlines.

## Color

- Light mode: white surfaces, pale gray canvas, soft borders, near-black primary text.
- Dark mode: deep neutral canvas, slightly lighter surfaces, soft borders, near-white primary text.
- Blue is the interaction color, not decoration.
- Green, amber, red, gray, and violet are reserved for small semantic status signals.
- Avoid dominant gradients, decorative grids, large color fields, glows, and colored card rails.
- Prefer subtle hover and active states: a light background tint, border change, or text weight is enough.

## Core Surfaces

### Login

- Center one narrow login card on a plain gray canvas.
- Keep it quiet and trust-oriented; do not add decorative grids, blobs, or marketing copy.
- The primary sign-in action is full-width.
- Errors stay local to the card.

### Header And Navigation

- Keep the wordmark small and precise.
- Utility controls are compact, horizontally grouped, and share one centerline and control height.
- Icon-only controls require clear accessible labels.
- Important recurring actions are easy to find but do not dominate the page.

### System Status

- `/system-status` is the single operational status destination, with a compact cluster summary and tabs for endpoint resources, agent nodes, and runtime integrations.
- Keep real CPU/memory usage separate from inspected limits; show missing, stale, stopped, and failed sampling explicitly.
- Show node details inline and preserve permission-gated enrollment. Legacy `/`, `/nodes`, `/nodes/:id`, and `/providers` redirect here; do not restore separate pages.

### Dense Lists

- Treat endpoint, node, change, audit, and member lists as operating boards.
- Keep filters, summary count, and primary action near the top when present.
- Expose enough context for scanning without requiring immediate drill-down.
- Prefer small status marks over banners.
- Tables have only horizontal separators; avoid zebra striping and uppercase column labels.

### Endpoint Detail

- The endpoint is the page subject. Keep its assigned node, driver, ID, and five measured health layers near the top.
- Use progressive disclosure for QQ identity, directory, OneBot service, transport configuration, diagnostics, and settings.
- Clearly separate observed identity, protocol availability, transport configuration, and desired-state convergence.
- Avoid turning every field or sub-item into a decorative card.

### Settings

- Settings are administrative and quiet, not dashboard-like.
- Put operational impact near the top.
- Separate destructive or high-impact actions and require clear confirmation.
- Saved, loading, and error states are explicit but low-noise.

## Interaction

- Prefer tabs, accordions, dialogs, popovers, and drawers for progressive disclosure.
- Do not expand every secondary section when only one needs attention.
- Buttons use short, concrete verbs.
- Low-frequency actions use quiet secondary styling.
- Hover, active, badge, and loading changes must not shift layout.
- Empty, loading, unavailable, error, and saved states are plain, actionable, and consistent.
- Delivery-provider credentials and sender identity come from worker environment variables and are never exposed in the console.
- Named notification targets can be selected independently for offline and recovery alerts on each endpoint; workspace defaults are copied to new endpoints.

## Components

- Use accessible behavior primitives for tabs, dialogs, menus, selects, tooltips, switches, accordions, and collapsible sections.
- Botroost owns visual styling through local Tailwind tokens and shadcn/Radix primitives.
- Repeated primitives should be wrapped as small product-styled components.
- Product-specific compositions stay near the feature that owns them.
- Use one consistent icon set; do not mix platform glyphs.

## Responsive Behavior

- Desktop remains the primary working layout.
- Narrow screens collapse the same hierarchy into one column.
- Primary mobile navigation contains System status, Endpoints, Activity, and More.
- Dense controls may scroll horizontally only where comparison genuinely requires it.
- Text wraps, truncates, or intentionally reduces density; it never overlaps controls.
- Fixed-format controls keep stable dimensions.
- At 320 px and wider, the document must not overflow horizontally.

## Implementation Checklist

- Does the screen feel like a compact internal workbench?
- Is the primary entity and every displayed status subject explicit?
- Is color carrying status or interaction rather than decoration?
- Are secondary sections progressively disclosed instead of all expanded?
- Are domain labels consistent with the hierarchy above?
- Does the page avoid nested cards, oversized hero sections, repeated overlines, and full-width tabs?
- Are repeated rows dense enough to scan without feeling cramped?
- Are loading, empty, unavailable, error, and saved states calm and actionable?
- Do light, dark, desktop, and mobile modes preserve the same hierarchy?
- Are there no secrets, ambiguous connection claims, or page-level horizontal overflow?
