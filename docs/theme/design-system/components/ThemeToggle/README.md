# ThemeToggle

A 44px square that switches the page theme and **shows the theme it switches to** — the sun
while you are in dark mode, the moon while you are in light.

Both glyphs live in the button, stacked in one `inline-grid` cell; `[data-theme="light"]`
swaps which is displayed, so there is no icon swap in script and no layout shift. The glyphs
are 20px inside the 44px target, `fill: none`, `stroke: currentColor`, `stroke-width: 2`,
square caps, mitred joins.

Resting state is a transparent square with a `rule-strong` border and a `paper` glyph. Hover
takes the glyph to `lime-text` and the border to `paper`. There is no press offset here — it
is a control, not an action.

**You provide:** the click handler and an `aria-label` that names the destination state
("Switch to light mode"), updated when the theme changes. The page writes the choice to
`localStorage` under `theme`, falls back to `prefers-color-scheme`, applies it to
`document.documentElement.dataset.theme` in a blocking script in `<head>` so there is no
flash, and keeps `<meta name="theme-color">` in step (`#0b0b0e` dark, `#f4f4f7` light).

**Don't** animate the swap, add a track or knob, or put a label beside it.
