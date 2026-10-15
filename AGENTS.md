# Agent notes

- Generated code under `src/generated` is never edited by hand; change the
  generator configuration and run `npm run generate`.
- The documentation site's theme follows the Grepvine design system in
  [`grepvine-ai/grepvine-design-system`](https://github.com/grepvine-ai/grepvine-design-system).
  Before changing anything under `docs/theme`, read `docs/theme/README.md` and
  the design system's `README.md`.
- Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before changing the client: every
  resource method calls exactly one generated operation, `src/generated` is
  never exported, and user-facing text never mentions how the SDK is built.
