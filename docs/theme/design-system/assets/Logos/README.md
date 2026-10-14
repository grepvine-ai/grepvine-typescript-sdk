# Logos

In the product the Grepvine mark is drawn inline and painted from tokens — `lime` blocks with a
single `pink` block for the match. These stored copies carry the same values as literal hex so
they work as flat files; if you are placing the mark in markup you control, copy the inline
version from `components/Logo/preview.html` instead and let it follow the theme.

| File | Ink | Where |
| --- | --- | --- |
| `grepvine-mark.svg` | `lime` `#c4ff3d`, `pink` `#ff4fd8` | The nav and footer mark on a **dark** ground. 26px in the page; never below 16px, where the rows close into bars. |
| `grepvine-mark-edged.svg` | the same, over a `black` `#0b0b0e` under-edge | The same mark on a **light** ground. The black edge is painted first and only its outer half shows, the same trick the markdown markers use. |
| `grepvine-favicon.svg` | the mark on a `#0c0c10` square | Browser tab only. The square ground is baked in, so this one is not a placement mark. |
| `lakefs-logo.svg` | `black` `#0b0b0e` | The partner mark in the team band (300px) and the footer (77 × 18px). In the product it is painted `paper` through `currentColor` and turns `lime-text` on hover; this copy is a flat black for use on a light ground. Not Grepvine's mark — use it only to credit lakeFS, and keep the lakefs.io link on it. |

Rules: never recolour the Grepvine mark outside `lime` and the one `pink` block, never put the
plain mark on a light ground without the edged version, never set it inside a box or give it a
radius, never redraw the rows at even widths, and never redraw the word `grepvine` as artwork —
it is live type in `display`/`wordmark`.
