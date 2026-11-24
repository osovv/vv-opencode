# DESIGN.md: the project design system

DESIGN.md is the project-owned record of its design decisions. The skill's audit checks choices against it before falling back to generic taste rules. It is plain markdown, edited by humans and agents together.

## Discovery

Look for the file in this order and stop at the first hit:

1. `DESIGN.md` at the project root.
2. `DESIGN.md` in the nearest directory above the code you are editing (monorepo packages often own their own file).
3. `docs/DESIGN.md` or `.design/DESIGN.md` as fallbacks.

If several files exist at the same level with overlapping scope, ask the user which one governs instead of guessing. If none exists, follow the missing-file procedure below.

## What the file documents

A useful DESIGN.md stays short — roughly 40 to 80 lines — and contains only decisions that shipped or are about to ship:

- **Voice** — three sentences on how the product talks: tone, formality, what it never says.
- **Typefaces** — each family, its role (display, body, mono, data), and its fallback stack.
- **Palette** — 4 to 8 named colors as hex values with roles (surface, text, muted, accent, success, warning, danger), plus any state variants.
- **Type scale** — the allowed sizes and weights, with the role of each step.
- **Radii** — the allowed corner radii and which element types use them.
- **Spacing** — the scale, and the gap conventions between elements and sections.
- **Borders and elevation** — the border widths and the shadow set, or an explicit "no shadows" decision.
- **Motion** — durations, easing, and which moments are allowed to animate.
- **Imagery** — what kind of images belong (product screenshots, photography, illustration) and what is forbidden.
- **Do-nots** — product-specific traps, for example "never purple gradients; our brand accent is X" or "numbers are always tabular".

## Validating against it

During the plan and audit phases, compare every choice to DESIGN.md:

- A font family, color value, type size, radius, shadow, or duration outside the documented system is a finding, even if it looks good.
- Report the deviation as `chosen value → documented value or proposed addition`, and either fix it or ask for the system to be extended.
- Never silently add a token to the file to justify a choice. Additions are proposed, with a reason, and confirmed.
- A documented decision wins over the skill's generic preferences. If DESIGN.md says "Inter everywhere", Inter is correct; the audit does not relitigate it.
- If a documented decision contradicts the brief, surface the conflict in one sentence and let the user decide.

## When it is missing: propose creating it

Do not invent a design system on the fly, and do not write the file without asking.

1. Finish the token plan for the current work first: named palette, typefaces and roles, layout intent, signature element.
2. Propose creating DESIGN.md seeded from that plan, with the section skeleton above filled only with the tokens this build actually uses.
3. Show the draft (or its outline plus key values) and ask for confirmation; on approval, write it and mention the path in the report.
4. If the user declines, proceed with the brief alone and record in the audit report that DESIGN.md is absent and the choices are unanchored.

A proposal that claims more than the project has decided is worse than no file: leave unknown sections out rather than filling them with defaults.

## Precedence

1. The brief's explicit instructions (colors, fonts, or a named direction the user asked for).
2. DESIGN.md, where it covers the decision.
3. This skill's generic rules and defaults.

The skill never overrides an explicit brief ask to satisfy a generic preference. Where DESIGN.md and the brief disagree, the brief decides for that piece of work, and the file is updated afterwards if the decision is meant to persist.

## Keeping it current

After the build, list the decisions that actually shipped — new tokens, changed radii, a new motion rule — and propose appending them. Stale files teach the next audit the wrong rules; an out-of-date DESIGN.md is a finding in its own right.
