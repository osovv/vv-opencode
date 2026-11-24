# AI slop tells

A catalog for the subtractive audit. Read it as a set of familiar defaults to notice, not a ban list.

**How to use it**

1. Walk the categories and mark every tell present on the page, per section.
2. Count per section. One tell is a choice; more than two in one section is a pattern to break by removal; more than five on a page is a redesign of those areas.
3. Fix by removing first — merge containers, drop labels, delete decoration. If the fix adds something, it is not a fix.
4. A tell may stay when the brief or subject genuinely calls for it and you can say why in one sentence. Record it as a deliberate keep.
5. Never fix a tell by fleeing to the opposite default. Banning purple gradients yields Instrument Serif and mono captions; the list must not make the decisions for you.

Sources: Charles Liu's "20 More AI Design Slop Indicators", Anthropic's frontend-design defaults, the Impeccable slop catalog, Paralect's 21 signs, and the measured Show HN slop scoring. Each entry states the tell, why it reads machine-made, and the replacement.

## Typography

### One accented word in the headline
*Why it reads machine-made:* italic, bold, or colored single-word emphasis is the universal "premium headline" shortcut; the accented word is rarely the important one, and it silently adds a second font and an accent color.
*Replace with:* one weight and one color for the headline. If a word must be stressed, rewrite the sentence so the emphasis is structural.

### Eyebrow labels above headings
*Why it reads machine-made:* a small uppercase, tracked-out label (often with a dot or trailing rule) above every heading names the section type people can already see. It adds a line to read and nothing to know.
*Replace with:* nothing — the eyebrow is structural noise. If the label carries real information (a date, a filterable category), fold it into the heading or into metadata next to it.

### Italic serif display default
*Why it reads machine-made:* an oversized italic serif (Instrument Serif and relatives) is the current stand-in for editorial character. It appears regardless of subject, and italic display type is one of the first things a trained designer notices as borrowed.
*Replace with:* a typeface whose character comes from the subject. If the brand has no voice, choose a non-italic display setting and let composition carry the page.

### Monospace for labels, buttons, and body
*Why it reads machine-made:* mono signals "technical" cheaply, so it lands on tags, inputs, buttons, and whole paragraphs. It also imports the exact look of every other AI-built developer page.
*Replace with:* mono only for code, tabular numbers, and copyable strings. Everything else uses the text family.

### Overused UI fonts and flat hierarchy
*Why it reads machine-made:* Inter, Geist, and system stacks are the learned average. When headings and body also sit at nearly the same size and weight, the page has no voice and no scannable structure.
*Replace with:* typography chosen for the product's character; then create hierarchy with size, weight, and space before adding a second family.

### Gradient text
*Why it reads machine-made:* color changing across a headline or number is decoration that also reduces contrast, and it is the 2022-era AI-startup signature.
*Replace with:* one solid color; use size or weight for emphasis.

### All-caps body text and extreme tracking
*Why it reads machine-made:* long uppercase passages are hard to read (word shape disappears) and read as labels used as paragraphs; crushed or wide-spread tracking on body text breaks word grouping.
*Replace with:* sentence case for body, caps only for short labels, default tracking for anything longer than a line.

### Oversized hero headline
*Why it reads machine-made:* a long display-size headline that fills the first screen leaves no room to explain the offer or show the product.
*Replace with:* a shorter headline or a smaller size, with the supporting sentence and one real image or action visible.

### Badge or pill above the headline
*Why it reads machine-made:* a small rounded "Introducing / New / Beta" pill above an h1 looks clickable, competes with the message, and repeats what the page already says.
*Replace with:* removal, or real information worked into the headline or supporting text.

## Color and contrast

### Cream and terracotta default
*Why it reads machine-made:* the near-#F4F1EA background with a warm clay accent is the "tasteful AI startup" palette; it arrives on serious B2B products where it says nothing about the subject.
*Replace with:* a palette derived from the product's own world; keep cream only if it belongs there.

### Purple-to-blue gradients
*Why it reads machine-made:* the default look of AI products since 2022 — on buttons, headlines, and backgrounds. It announces "AI startup" before a word is read.
*Replace with:* one solid brand color with a functional accent; gradients only where they carry meaning (depth, state, data).

### Near-black plus one acid accent
*Why it reads machine-made:* tinted near-black (#0B0B0B, #111) with a single electric green or vermilion accent is the second learned default; it is the same page as the purple one with the lights off.
*Replace with:* a dark theme only when the product lives in dark contexts, and then a restrained accent that marks interaction rather than mood.

### Blurry glows, halos, and spotlights
*Why it reads machine-made:* a radial glow behind the hero and a soft spotlight behind content point at everything, so they point at nothing.
*Replace with:* spacing, contrast, and a clear heading to direct attention. Keep one glow only if it marks a real focus area.

### Neon edges and glowing borders
*Why it reads machine-made:* glowing card borders and neon outlines are cyberpunk-by-default decoration that competes with content and floods a dark surface with light.
*Replace with:* a plain border or surface; keep a single neon accent only where it marks the one thing to look at.

### Colored left-border stripes on cards
*Why it reads machine-made:* a thick colored stripe is borrowed from alerts and warnings, then applied to ordinary content so it looks designed. It burns the warning vocabulary.
*Replace with:* reserve colored edges for status. Group content with spacing and headings.

### Gradient washes as decoration
*Why it reads machine-made:* multi-stop washes behind sections fill space and compete with text contrast; they are the cheapest way to make a flat layout look "designed".
*Replace with:* a flat surface, or one meaningful image.

### Low-contrast gray text
*Why it reads machine-made:* secondary text gets lighter and lighter to look "clean"; on a phone in sunlight it disappears, and it fails WCAG AA.
*Replace with:* at least 4.5:1 for body text; keep light gray only for content people can skip.

### Gray text on a colored surface
*Why it reads machine-made:* neutral gray over a saturated background goes muddy and washes out; it signals a palette that was never checked in situ.
*Replace with:* a darker tint of the background or a light text color, verified against the actual surface.

## Layout and space

### Borders around every block
*Why it reads machine-made:* when each section, list, and stat gets its own outline, borders stop saying what belongs together and the screen becomes a grid of lines.
*Replace with:* spacing and headings first; a border only where a block genuinely stands apart (a form, a selection).

### Everything in a card, cards in cards
*Why it reads machine-made:* identical rounded containers around every piece of content add padding and shadows around the same information, and nested cards stack noise instead of hierarchy.
*Replace with:* flat sections separated by space; one container level at most.

### Same radius and shadow on everything
*Why it reads machine-made:* one corner radius and one soft shadow applied to buttons, cards, inputs, and modals erase the difference between what is clickable and what is not.
*Replace with:* different shapes for different roles; most surfaces need no shadow at all.

### Three icon cards in a row, identical grids
*Why it reads machine-made:* the icon-grid feature section gives every point equal weight regardless of the content, and repeats as far as the page goes.
*Replace with:* varied treatment driven by the content — one lead feature, supporting details in a smaller rhythm.

### Icon tile stacked above a heading
*Why it reads machine-made:* an icon in a rounded square above each feature heading is the stock AI feature-card pattern.
*Replace with:* the icon beside the heading, or no icon.

### Numbered sections without a sequence
*Why it reads machine-made:* 01 / 02 / 03 markers imply order and process even when sections are independent — structural devices used as decoration.
*Replace with:* numbering only for genuine sequences (steps, timelines).

### Middle-dot meta strings
*Why it reads machine-made:* "A · B · C" meta strings are template chrome that appears regardless of subject.
*Replace with:* ordinary separators or plain sentences.

### Arrows on every button and link
*Why it reads machine-made:* a trailing "→" appended to every label is a costume for affordance; when everything has one, it means nothing.
*Replace with:* keep the arrow only where direction or progression is the point.

### Hero metric layout
*Why it reads machine-made:* a huge number with a small label plus two supporting stats is the default hero for products that have no image to show.
*Replace with:* lead with a metric only if the metric explains the product, and give it enough context to mean something.

### Overstuffed screens
*Why it reads machine-made:* chips, extra buttons, floating stats, insight banners, and "what's new" boxes each look reasonable alone and together compete for attention.
*Replace with:* ask what the user does with each element; remove anything without an answer. A dashboard answers one or two questions.

### Glassmorphism everywhere
*Why it reads machine-made:* frosted glass belongs where content sits on top of content; on static cards over color blobs it lowers contrast and slows the page.
*Replace with:* a solid surface, or blur only for real layering (menus over content).

### Hairline border plus wide soft shadow
*Why it reads machine-made:* two edges defining the same card is a doubled-outline default that makes surfaces look smudged.
*Replace with:* choose the edge or the shadow, not both.

### Extreme corner radius
*Why it reads machine-made:* small cards rounded into blobs squeeze their content and make every card look alike.
*Replace with:* a radius proportional to the element's size.

### Monotonous spacing
*Why it reads machine-made:* equal gaps everywhere ignore grouping, so nothing reads as more related than anything else.
*Replace with:* related items close, separate groups far apart, consistent scale.

### Dithering and noise overlays
*Why it reads machine-made:* a dot-matrix or grain overlay applied to gradients and images is a current AI-favored texture that imitates print without a print reason.
*Replace with:* a clean surface or a texture native to the brand.

### Decorative grid backgrounds
*Why it reads machine-made:* faint grid lines fill empty space and signal "technical" while giving no measurement.
*Replace with:* whitespace, or a grid where the grid is the tool.

## Motion

### Pulsing status dots
*Why it reads machine-made:* a pulsing green dot next to "Live" or a section label draws attention while nothing changes.
*Replace with:* static status; animate only real activity.

### Blinking cursors outside inputs
*Why it reads machine-made:* a decorative blinking cursor makes static copy look editable or terminal-like.
*Replace with:* a cursor only where typing is possible.

### Sections fading in on scroll
*Why it reads machine-made:* every block fading, sliding, and unblurring as you scroll is the generic entrance kit; fast scrollers see blank space until the script catches up.
*Replace with:* content visible immediately; at most one orchestrated reveal on the page, under 300ms, behind reduced-motion.

### Bounce and elastic easing
*Why it reads machine-made:* overshoot on dialogs and buttons makes routine actions feel fussy.
*Replace with:* quick, settled easing; playfulness only in playful products.

### Auto-scrolling marquees
*Why it reads machine-made:* logos and text scrolling by themselves force the reader's pace and are the default "trusted by" section.
*Replace with:* a static row, or pause controls.

### Content gated behind animation
*Why it reads machine-made:* content that starts at opacity zero and depends on a reveal handler leaves blank space when the script fails.
*Replace with:* visible by default with animation as enhancement.

## Copy

### Reflexive words: quiet, real, seamless, supercharge, world-class
*Why it reads machine-made:* these words promise a feeling without describing the product; "real", "quiet", and "delve" are as recognizable as an em dash.
*Replace with:* plain verbs and concrete outcomes — what the user can do and what changes.

### Made-up statistics
*Why it reads machine-made:* round, unsourced numbers ("10x faster", "99.9%") are filler that invites distrust of every other claim.
*Replace with:* numbers you can source and link, or no numbers.

### Fake social proof
*Why it reads machine-made:* generic logos, round customer counts, and testimonials from a first name and an initial are recognized as invented.
*Replace with:* real names, roles, photos, and links; if there is no proof yet, omit the section.

### Em-dash overuse and "WORD — fragment" labels
*Why it reads machine-made:* a dash in every sentence is the textual twin of the visual fingerprint, and spaced-em-dash label formats ("Launch — today") are template chrome repeated across sections.
*Replace with:* full stops between separate thoughts, and plain labels or sentences instead of the dash format.

### Forced contrast slogans
*Why it reads machine-made:* "Not a feature. A platform." and two-word sentences make every line a slogan, which flattens meaning into cadence.
*Replace with:* explain the distinction when it matters; otherwise state the information.

### Noun-heavy titles and feature lists
*Why it reads machine-made:* titles that read like product categories tell nobody who the page is for or what changes for them.
*Replace with:* short, verb-led titles naming a specific person and outcome.

### Numbers written as words
*Why it reads machine-made:* "three steps" instead of "3 steps" hides the most concrete part of a message and slows scanning.
*Replace with:* digits for quantities.

## Imagery

### Emoji and sparkle icons as interface icons
*Why it reads machine-made:* emoji render differently per device, ignore the palette, and make a product page read like a chat message; ✨ is the signature.
*Replace with:* one icon set, or none.

### Placeholder imagery
*Why it reads machine-made:* initials in colored circles, grey logo boxes, and empty frames mean nobody replaced the placeholders before launch.
*Replace with:* at least one real screenshot or photo on every important page.

### Rough SVG illustrations and labeled metaphors
*Why it reads machine-made:* hand-coded mascots and diagrams that need a written label to make sense add space without adding meaning.
*Replace with:* the real thing — a product screenshot, a photo, or one clear sentence.

### Text demos instead of the product
*Why it reads machine-made:* a "demo" made of paragraphs describes the product because describing is easier than showing; readers skip it.
*Replace with:* a screenshot, short video, or GIF of one real task start to finish, with a caption.

## Template chrome (composites)

### The SaaS kit
*Why it reads machine-made:* hero metric or badge + three icon cards + logo strip + pricing cards + testimonial trio, in that order, on every product.
*Replace with:* a structure derived from this product's story; use sections only where the content needs them.

### The editorial kit
*Why it reads machine-made:* hairline rules, zero radius, dense multi-column broadsheet with a serif display is now as templated as the SaaS kit.
*Replace with:* editorial devices only for editorial content, chosen per section rather than as a costume.

### The "tasteful dark" kit
*Why it reads machine-made:* near-black ground, glowing accent cards, mono captions, and one warm accent signal "considered developer tool" without reference to the actual product.
*Replace with:* light or dark per the product's context, with one accent that marks interaction.

**Closing rule:** after the audit, remove one thing that survived and still does not earn its place. The page should look like one person decided, not like a model satisfied a checklist.
