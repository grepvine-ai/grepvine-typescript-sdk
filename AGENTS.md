# Agent notes

- Generated code under `src/generated` is never edited by hand; change the
  generator configuration and run `npm run generate`.
- `sdk-operations.json` names every method and is identical in
  `grepvine-ai/grepvine-python-sdk`; change both together.
- Before changing anything under `docs/theme`, read `docs/theme/README.md`.
- Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before changing the client: the
  client and its resources are generated from `sdk-operations.json`,
  hand-written code is limited to the client options, retries, errors,
  `paginate` and the resource helpers, and user-facing text never mentions how
  the SDK is built.
