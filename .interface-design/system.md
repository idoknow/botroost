# Botroost interface system

## Product character
Botroost is an operations control plane: calm, exact, and low-noise. The interface should privilege status, provenance, and safe action over decoration.

## Foundations
- **Canvas:** `#07090c`; **navigation:** `#0d1117`; **surface:** `#111720`; **raised surface:** `#161e28`.
- **Borders:** `#202a35` default and `#2c3947` strong. Borders—not shadows—define hierarchy.
- **Text:** `#edf3f7` primary, `#8795a5` muted.
- **Accent:** electric cyan `#09aeda`, reserved for focus, active navigation, links, and primary actions.
- **Status colors:** semantic red, amber, green only. Do not use them decoratively.
- **Spacing:** 4 px base grid; primary rhythm 8 / 12 / 16 / 24 / 32 px.
- **Radius:** 4 px micro, 6 px controls, 10 px panels. Avoid pills unless the data is genuinely a compact status.
- **Type:** system sans for interface language; system monospace for identifiers, data, overlines, and technical metadata.

## Global layout
- Desktop uses a fixed 224 px sidebar and 56 px top bar.
- Content is fluid up to 1440 px, with 32 px desktop and 12–16 px mobile gutters.
- Mobile navigation becomes a drawer below the `sm` breakpoint.
- Interactive controls must provide at least a 44 px touch target on mobile.

## Components
- Navigation entries are quiet by default; active state uses a cyan-tinted surface and border.
- Panels use one surface tone and a 1 px border. Never use gradients or ornamental shadows.
- Inputs are 44 px tall with a clear cyan focus border.
- Empty, loading, error, unavailable, and 404 states share compact centered composition and plain language.
- Primary actions are cyan; secondary actions are subtle or bordered.

## Voice
Use concise operational language: name the resource, state, and next action. Avoid marketing copy, jokes, and anthropomorphic AI language.

## Avoid
Huge cards, gradient fills, purple “AI” styling, excessive rounding, decorative glow, redundant labels, and low-value dashboard chrome.
