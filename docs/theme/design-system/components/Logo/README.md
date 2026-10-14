# Logo

The mark and the word `grepvine` set side by side, used in the nav and the footer and nowhere
else on the page.

The mark is inline SVG on a 32 viewBox: eight square blocks in four rows, flush left, each row
shorter than the one above it. It reads as a paragraph of text with one run highlighted — grep's
own output — and as a bunch hanging off the full-width first line. The blocks are `lime` except
the second block of row two, which is `pink`: that is the match. A second
`<g class="logo-edge">` draws the same eight rects in `black` underneath at `stroke-width: 1.2`;
it is hidden in dark mode and shown in light, where it gives the neon an edge against the pale
ground. The group pokes past the viewBox, so the mark needs `overflow: visible`.

The word is live type, not artwork: `display` at `wordmark` size, lowercase, `paper`, 8px from
the mark. Never set it in anything else and never letterspace it open.

**You provide:** the link and an `aria-label` ("Grepvine home"); the SVG gets `aria-hidden`.

**Sizes:** 26px mark in the nav and footer. Scale the mark and the word together and keep the
gap proportional. The gaps between blocks are 2 units on the 32 grid, so they hold down to about
16px; below that the rows close into bars and the mark stops reading.

**Don't:** recolour it, box it, round it, change the row widths to even them up, add a tagline
inside the lockup, or use the plain mark on a light ground without the edge group. Flat-file
copies of all three forms are in `assets/Logos/`.
