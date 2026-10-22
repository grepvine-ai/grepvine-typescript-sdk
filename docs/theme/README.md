# Documentation theme

The documentation site is styled with the Grepvine design system, which the
Grepvine team maintains. The files below are copies of its tokens, components
and assets.

This directory holds only what the TypeDoc build needs, so building the docs
never reads the design-system repository.

## Files

| File             | Role                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens.css`     | The design system's `tokens.css`: colour, type, spacing and shadow tokens for both themes. First in the cascade.                                          |
| `components.css` | The design system's `components/bundle.css`: Logo, ThemeToggle, Markdown, Button and CodeBlock rules, and the Google Fonts import. Second in the cascade. |
| `favicon.svg`    | The design system's `assets/Logos/grepvine-favicon.svg`.                                                                                                  |
| `grepvine.css`   | TypeDoc's `customCss`: maps TypeDoc's variables and classes onto the tokens; last in the cascade.                                                         |
| `grepvine.js`    | TypeDoc's `customJs`: adds the Logo with the lowercase wordmark and the ThemeToggle, using the design system's markup.                                    |
| `plugin.mjs`     | Local TypeDoc plugin: groups the reference, copies `tokens.css` and `components.css` into the site, and recolours code to the CodeBlock palette.          |

## Changing the theme

- Follow the design system's rules rather than inventing new styles: its
  tokens for every colour, size and shadow, square corners, 2px rules, hard
  offset shadows, Tektur for headings and Martian Mono for everything else,
  lime as the one primary accent, and readable contrast in both themes.
- Keep `tokens.css`, `components.css` and `favicon.svg` identical to the
  design system's files. To adopt a newer design system, copy those files
  again from the paths in the table above, then rebuild and check both themes.
- Put docs-specific rules in `grepvine.css`, mapped onto the tokens, never as
  literal colours.
- Build with `npm run docs` and check the pages in both themes at desktop and
  phone width.
