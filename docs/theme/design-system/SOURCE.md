# Design system source

These files are copied unchanged from the private repository
[`grepvine-ai/grepvine-design-system`](https://github.com/grepvine-ai/grepvine-design-system)
at commit `abe245372f136f057c6d080dc77f4ae90c7c8a4f`. The docs build reads only
this copy and never checks out the design-system repository.

| File                                   | Used for                                            |
| -------------------------------------- | --------------------------------------------------- |
| `tokens.css`                           | Colour, type, spacing and shadow tokens; layer 1.   |
| `components/bundle.css`                | Logo, ThemeToggle, Markdown and CodeBlock; layer 2. |
| `assets/Logos/grepvine-favicon.svg`    | The site favicon.                                   |
| `assets/Logos/grepvine-mark.svg`       | Reference for the inline header mark (dark).        |
| `assets/Logos/grepvine-mark-edged.svg` | Reference for the inline header mark (light).       |
| `assets/Logos/README.md`               | Rules for placing the mark.                         |
| `assets/Icons/*`                       | The ThemeToggle sun and moon glyphs and rules.      |
| `README.md`, `components/*/README.md`  | The rules the docs theme follows.                   |

`../grepvine.css` is layer 3: it maps TypeDoc's own classes and variables onto
these tokens. `../grepvine.js` draws the header logo and the ThemeToggle.

## Refreshing

```sh
git clone https://github.com/grepvine-ai/grepvine-design-system /tmp/gv-ds
git -C /tmp/gv-ds checkout <commit>
cd docs/theme/design-system
for f in README.md tokens.css components/bundle.css \
  components/{Logo,ThemeToggle,Markdown,CodeBlock}/README.md \
  assets/Logos/{README.md,grepvine-favicon.svg,grepvine-mark.svg,grepvine-mark-edged.svg} \
  assets/Icons/{README.md,icon-sun.svg,icon-moon.svg}; do
  cp "/tmp/gv-ds/$f" "$f"
done
```

Then update the commit above, run `npm run docs` and check both themes. Keep
the files byte-identical to the source; Prettier ignores this directory.
