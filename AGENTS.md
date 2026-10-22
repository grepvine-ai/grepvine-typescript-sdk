# Agent notes

- Generated code under `src/generated` is never edited by hand; change the
  generator configuration and run `npm run generate`.
- The documentation site's theme follows the Grepvine design system in
  the Grepvine design-system repository (private).
  Before changing anything under `docs/theme`, read `docs/theme/README.md` and
  the design system's `README.md`.
- Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before changing the client: the
  client and its resources are generated from `sdk-operations.json`,
  hand-written code is limited to the client options, retries, errors,
  `paginate` and the resource helpers, and user-facing text never mentions how
  the SDK is built.
