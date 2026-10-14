# CodeBlock

A sample of the API, set as a dark block. It appears once, on the closing `lime` slab, where
it is the only dark thing in the section.

**Two highlight classes, no more.** `.k` is `pink` for keywords, `.s` is `lime` for strings;
everything else stays `paper`. That is the whole grammar — no comment colour, no number
colour, no line numbers, no window chrome, no copy button. Spans are written into the markup
by hand, not produced by a highlighter.

The block is `small` at `line-height: 1.75` with 28px of padding and `overflow-x: auto`.
Selection inside it flips to `lime` on `ink` rather than the page's `lime` on `black`.

**You provide:** the snippet, already marked up, inside `<pre><code>`. Keep it under a dozen
lines and make it a complete, runnable thought — import, index, search, act — because the
point of the sample is that calling the thing is four lines.

**Note:** in the product `.code` re-declares the dark palette on itself so it stays dark on
the light theme's slab. That re-declaration lives in `styles.css` and is not in this system's
tokens, so this preview follows the theme instead.
