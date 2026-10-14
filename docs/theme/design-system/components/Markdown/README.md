# Markdown

The typographic layer that makes the page read as a markdown document: heading markers,
star bullets, inline code and the highlight.

**Heading markers.** Every heading opens with its marker in a separate span —
`<span class="md" aria-hidden="true">##</span>` — followed by a space and the heading text.
`#` on h1, `##` on h2, `###` on a tile or card h3, and an ordinal (`1.` `2.` `3.`) on a
numbered point. The marker is `lime`; inside a tile it takes the tile's accent (`--ct`) and on
the slab it is `black` at 40% opacity. From 1360px up it is absolutely positioned into the left
margin so the heading text sits flush on the grid.

On a light surface `.md` takes a `max(2px, 0.06em)` `black` text-stroke painted *under* the
fill (`paint-order: stroke fill`), so only its outer half shows and the neon keeps an edge.
Inside a tile or on the slab the stroke is removed, because those grounds already carry colour.

**Lists.** `.md-list` is an unstyled list with a `*` marker in `lime-text`, hung in a 2ch
indent, 10px between items. The marker uses the two-value `content` form
(`content: "*" / ""`) so screen readers don't announce it.

**Inline code.** `code.inline` inverts — `ink` on `paper` — at 0.62em with a hair of padding
and a 0.14em lift, so it sits inside display type without changing the line box.

**Highlight.** `.hl` lays `lime` behind a phrase with `black` on top and
`box-decoration-break: clone`, so a wrapped phrase gets a clean block on every line. Hero
headline only; pair it with `.nowrap` if the phrase must not break.

**You provide:** the heading text and the marker that matches its level. Keep markers
`aria-hidden` — they are typography, not content.
