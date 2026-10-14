# Icons

The whole interface icon set: two glyphs for the theme toggle, which shows the theme it
switches *to* — the sun while you are in dark mode, the moon while you are in light.

| File | Ink | Where |
| --- | --- | --- |
| `icon-sun.svg` | `black` `#0b0b0e` here; painted `paper` in the product, `lime-text` on hover | The toggle in dark mode. |
| `icon-moon.svg` | `black` `#0b0b0e` here; painted `paper` in the product, `lime-text` on hover | The toggle in light mode. |

Both are 24 × 24 with no fill, `stroke-width: 2`, `stroke-linecap: square` and
`stroke-linejoin: miter`, drawn at 20px inside a 44px target. In markup they are inline SVG
on `currentColor`; these stored copies carry a literal black ink because a file placed with
`<img>` cannot inherit colour.

Any icon added to this system matches that construction exactly: square caps, mitred joins,
2px strokes on a 24px box, no fills, no rounded ends and no second weight.
