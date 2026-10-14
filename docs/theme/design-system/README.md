# Grepvine design system

Grepvine is a search database for AI agents. The brand is brutalist: flat slabs, square
corners, 2px rules, hard offset shadows with no blur, and neon accents on a near-black
ground. The page reads as two things at once — a markdown document and a terminal — and
every surface should keep that doubling.

## Content fundamentals

- **Write for software engineers building agents.** Assume they know what grep, regex and
  recall mean. Don't explain the obvious and don't sell past the fact.
- **Sentence case, full stops, short sentences.** Headings are sentences and end in a
  period: "What agent-native means." "Scales to zero." "Built for agent traffic."
- **Lead with the claim, then the number.** "100% recall. No top-k cutoff, no approximate
  index." Numbers are concrete and checkable (`<100ms`, `$0.50 per GB-month`, `4.6×`), never
  rounded up into marketing.
- **Second person for the reader, third for the product.** "Give your agents exact search."
  "Grepvine answers tens of thousands per second."
- **Tile and label copy is lowercase and one word where it can be**: `literal`, `regex`,
  `complete`, `exact`, `recall`, `precision`, `cost when idle`.
- **No emoji, ever.** No eyebrows, no kickers, no "Introducing". No pulsing dots or "AI"
  decoration. The one call to action is "Start free trial".

## Visual foundations

### Colour

- Set the page on `ink` with `paper` for headings, `text-2` for running copy and `muted` for
  meta. `ink-2` raises an alternating section, `ink-3` insets a bar or a trough.
- `ink` and `paper` swap between the two themes; the four neons do not. So **a neon is only
  ever a fill, with `black` on top** — `lime` on a button, `orange` on a tile head. Where the
  same colour has to be text, a thin line or a focus ring on the page surface, use its
  `-text` form (`lime-text`, `orange-text`, `cyan-text`, `pink-text`), which darkens in light
  mode to stay legible.
- **`lime` leads.** It is the primary action, the closing slab, the highlight and the
  selection colour. `orange`, `cyan` and `pink` code specific things — the demo tasks, the
  four search tiles, the vector-database bill — and appear only where one of those is on
  show. None of them is decoration.
- Text pairs hold 4.5:1 or better in both themes; `muted` is the floor at 4.9:1 on `ink-3`.
  The one knowing exception is `rule-strong`, which is 1.7:1 on `ink` in dark mode: it frames,
  it never carries meaning alone, so a frame that must be read gets a surface change behind
  it as well.
- Only one gradient exists in the whole system — the 1px repeating line that rules the chart
  plot — and it is drawn in `rule`. No glows, no blurred shadows, no colour-mixed fills
  outside the two places the stylesheet already uses them.

### Type

- Two families, no third. `display` (Tektur 700) for h1–h3, the wordmark and every figure;
  `body` (Martian Mono 300–600) for everything else, including code — the mono *is* the body
  face, which is what makes the page read as a terminal.
- Set body text at `font-stretch: 87.5%` and headings at 100%. Martian Mono is a variable
  font; 400 is normal and 500 is the heaviest weight it is used at. Tektur is only ever 700.
- Tracking tightens as size grows: `-0.025em` on `page-title`, `-0.02em` on `section-title`
  and `figure`, `-0.01em` on `card-title` and the wordmark, none on body or mono.
- **Every number is tabular** (`font-variant-numeric: tabular-nums`) so figures don't jitter
  while they count.
- Both faces are loaded from Google Fonts. There are no font files in this system — see
  *Not synced* below.

### Markdown theme

Headings carry their markdown marker as a separate `aria-hidden` span in `lime`:
`# ` on h1, `## ` on h2, `### ` or an ordinal (`1.`, `2.`, `3.`) on h3. From 1360px up the
marker hangs in the left margin so the heading text sits flush on the grid. Bulleted lists
use `*` in `lime-text` as the marker. On a light surface the marker takes a 2px black
text-stroke painted under the fill so the neon keeps an edge; inside a tile or on the slab
it does not, because those carry their own colour.

### Shape, rules and depth

- **Square.** `radius-0` everywhere. The only rounded things in the system are the chat
  bubbles in one illustration, and they are rounded precisely because they are *not* this
  brand.
- `border` (2px) frames a section, a panel or a tile grid; hairlines inside a panel are 1px
  in `rule`, structural ones in `rule-strong`.
- Depth is the **press**, never a blur: `shadow-press` at rest, `shadow-press-hover` on
  hover with a matching 2px translate, nothing on active with a 4px translate. The control
  moves into its own shadow. `shadow-panel` is the same idea at 8px under the hero terminal.
- Tile and panel grids are built by showing `rule-strong` through a `border`-wide gap, not by
  giving each cell a border.

### Motion

One easing, `cubic-bezier(0.2, 0, 0, 1)`, at 150–250ms for state and 400ms+ for a figure
playing itself out. Illustrations play **once** when they scroll into view and then hold their
final state; the fan-out is the only thing that keeps moving, and only while it is on screen.
Everything collapses to 0.01ms under `prefers-reduced-motion`. Nothing loops for decoration.

### Layout

Content sits in `wrap` (1240px) with `gutter` (20px, 40px from 1024px up). Sections are
`section-y` tall, a section head is a 7fr/5fr split from 1024px up, and the vertical rhythm
runs `block` → `stack` → `row` → `tight`. Alternate `ink` and `ink-2` section by section and
close with the `lime` slab.

## Iconography

There is no icon set. The page draws exactly two interface icons — a sun and a moon for the
theme toggle — as inline 24px SVG at `stroke-width: 2` with `stroke-linecap: square` and
`stroke-linejoin: miter`, painted `currentColor`. Any icon added later must match that: square
caps, mitred joins, 2px strokes on a 24px box, no fills, no rounded ends. Everything else that
looks like an icon on the page is an illustration — the terminal minimap, the tile drawings,
the fan-out — drawn in the accent of whatever it illustrates.

Arrows are characters, not icons: `→` inside a button (it slides 3px on hover) and `↗` after an
outbound link.

## Marks

`Logos` holds the Grepvine mark in three forms and the lakeFS mark; `Icons` holds the two
toggle glyphs. Read `assets/Logos/README.md` before placing one — the mark is painted from
tokens in the product and the stored copies carry literal hex so they survive as flat files.

Set the wordmark in `display` at `wordmark` size, lowercase, 8px to the right of the mark.
There is no lockup file: the mark and the word are composed in markup.

## Using this system

- Layer `tokens.css`, then `components/bundle.css`, then your own rules.
- Every preview in this system is a **static rendition**: the markup is written here and the
  styling is the repository's own CSS, lifted out of `styles.css`. There is no component
  library in the repository and none is implied by this system — no React bundle, no props.
  Treat each component as a markup-and-class pattern to copy.
- The terminal, the illustrations and the code block are dark in **both** themes in the
  product: `styles.css` re-declares the dark values on `.term`, `.viz`, `.illo` and `.code`.
  That re-declaration is not in this system's tokens, so those previews follow the theme here.
  Keep it in mind if you rebuild them.

## Not synced

- **Font files.** Tektur and Martian Mono are loaded from Google Fonts by `index.html`; the
  repository commits no font binaries and Google Fonts was not reachable from this session, so
  `type.fonts` is empty and the families are named by stack only. The previews pull the two
  faces from Google Fonts at the top of `bundle.css`; if that is blocked they fall back to
  Arial Narrow and the system mono.
- **Fluid type.** `--text-fig`, `--text-xl` and `--text-2xl` are `clamp()` expressions, which
  a token cannot hold. Each style records the cap and names the full expression in its usage
  note.
- **Spacing scale.** The repository declares no spacing tokens beyond `--gutter` and `--wrap`.
  The other seven entries are the values that actually recur in `styles.css`, named here.
- **`--ease`.** `cubic-bezier(0.2, 0, 0, 1)` has no home in the token format; it is stated
  under *Motion* above instead.
- **Not built as components:** the three scroll-played illustrations (`.app`, `.duo`,
  `.viz-chart`), the storage-amplification bars, the cost chart and the fan-out SVG. They are
  one-off figures with their own animation timing in `main.js`, not reusable patterns.
