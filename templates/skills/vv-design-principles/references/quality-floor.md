# Quality floor

The non-negotiable base every build must clear before any audit of taste. These are measurable; if you cannot state the number, you have not checked it.

## Typography

- Body text starts at 16px. Check the actual rendered size on a phone-width viewport, not just the CSS variable.
- Line height sits near 1.5 for body copy; serif faces and long measures get slightly more. Tight leading below 1.4 makes paragraphs hard to track.
- Measure is 65–75 characters per line (hard ceiling around 80). Serif body may run slightly longer.
- Body text is left-aligned; justified text without hyphenation creates rivers of space.
- Headings: one h1 per page, no skipped levels (h2 under h1, h3 for subsections), and no heading used purely for visual size.
- Use `text-wrap: balance` for headings and `text-wrap: pretty` for paragraphs so a last line is not a single orphaned word.
- Small text below 14px is reserved for non-essential labels; navigation and controls stay readable without zoom.
- Letter spacing stays at the font's default for body text; wide tracking only for short labels.

## Color and contrast

- Body text: at least 4.5:1 against its actual background. Large text (24px+, or 19px+ bold) and essential UI boundaries: at least 3:1.
- Secondary text may be lighter but still passes 4.5:1 when it carries meaning. Lightness is not a hierarchy tool if it makes text unreadable.
- Contrast is checked against the real surface — tinted cards, gradient stops, and images included — not against white.
- Color is never the only signal for state: pair it with text, icon, or shape.
- One accent color carries one meaning across the product; badges and status colors are rare enough to stay meaningful.

## Layout and space

- Grouping is expressed by proximity first: related items close, separate groups clearly apart. A heading gets more space above it than below.
- Spacing follows a small scale (for example 4/8/12/16/24/32/48/64) instead of arbitrary values.
- Content containers keep horizontal padding at every width; body text never touches the viewport edge.
- Nothing overflows its container: no sideways page scroll, no text spilling from cards, no menu or popover clipped by an ancestor's overflow.
- One visual hierarchy per screen: the primary action is unmistakable next to secondary ones.
- Interactions have at least one clear affordance; clickable things do not look identical to static surfaces.

## Interaction and accessibility

- Semantic markup: real buttons for actions, real links for navigation, real lists for lists, landmarks (`header`, `nav`, `main`, `footer`).
- Keyboard: every interactive element is reachable in a sensible order, and focus is always visible (a focus ring with at least 3:1 contrast against its surroundings).
- Touch targets are at least 44px on their smallest side, with spacing between adjacent targets.
- Form fields have visible labels (not placeholder-only), and errors are announced next to the field with a repair instruction.
- Images that carry meaning have descriptive alt text; decorative images use empty alt.
- Dialogs trap focus while open, close on Escape, and return focus to the trigger.

## Motion

- Content is visible by default. Entrance animations are enhancement; with JavaScript disabled or the handler failing, nothing stays at opacity zero.
- Non-user-triggered motion: at most one orchestrated moment per page, under 300ms per element.
- `prefers-reduced-motion` is respected for every animation, including carousels, scroll reveals, and parallax.
- Auto-playing motion longer than 5 seconds can be paused, stopped, or hidden.
- Motion answers an action (open, expand, confirm) or marks a real change; it does not decorate static content.

## Content and states

- Real content: actual product names, real screenshots or photos, sourced numbers. No lorem ipsum, no invented testimonials, no initials-in-a-circle avatars, no grey logo placeholders.
- Buttons and links say what happens: "Save changes", not "Submit"; the action's name stays consistent through the flow ("Publish" → "Published").
- Every list, table, and dashboard has designed empty, loading, and error states that tell the user what to do next.
- Error copy states what happened and how to fix it, in the interface's voice; it does not apologize or blame.
- Written content follows the same minimalism as spacing: each element on the page does one job.

## Responsive and robustness

- Layout holds at 375px wide: no horizontal scroll, no overlapping text, no cut-off controls.
- Text scales without breaking layout; test 200% zoom.
- No uncaught JavaScript errors on load; interactive components work with keyboard only.
- Images have explicit dimensions or aspect ratios so content does not jump while loading.
- The page is usable before fonts finish loading (a matched fallback stack with similar metrics).

## Verification pass

Run these checks explicitly and record the numbers you saw:

1. Contrast of body text and the main CTA against their actual backgrounds (list the ratios).
2. Rendered body font size and line height at 375px and 1440px.
3. Measure of the longest paragraph in characters.
4. Tab through the whole page: order, visible focus, no traps.
5. Toggle reduced motion: nothing essential disappears or becomes unusable.
6. Disable JavaScript: content is still visible.
7. Resize to 375px: no horizontal scroll, no clipped menus.
8. Walk the empty, loading, and error state of every data surface.
