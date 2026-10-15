# Contributing

This guide is for people working on `@grepvine/sdk` itself. To use the SDK,
read [`README.md`](README.md).

## Layout

| Path                   | Contents                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `spec/openapi.json`    | The full public API contract exported by Grepvine. Never edit it here.                    |
| `spec/source.json`     | The source repository, commit, operation list and checksum of the snapshot.               |
| `openapi-ts.config.ts` | Generator configuration.                                                                  |
| `src/generated`        | Generated transport, operations and wire types. Never edit it; regenerate it.             |
| `src/client.ts`        | `GrepvineClient`.                                                                         |
| `src/runtime.ts`       | Configuration, authentication, the session, retries and timeouts shared by the resources. |
| `src/resources`        | One file per resource; each method calls exactly one generated operation.                 |
| `src/config.ts`        | Endpoint and API key lookup, matching `gv`.                                               |
| `src/retry.ts`         | `RetryPolicy` and the client-wide `429` pause.                                            |
| `src/paginator.ts`     | `Paginator`.                                                                              |
| `src/models.ts`        | Models and result classes.                                                                |
| `src/errors.ts`        | The error hierarchy and status mapping.                                                   |
| `tests`                | Vitest suites against an in-memory fake service (`tests/fake-server.ts`).                 |
| `docs`                 | The TypeDoc guide page (`docs/index.md`) and theme (`docs/theme`).                        |
| `examples`             | Runnable examples.                                                                        |

## Design rules

- The SDK offers the same resources, behaviour and error classes as Grepvine's
  Python SDK, with camelCase methods and options. Data the SDK returns keeps
  the API's field names.
- Every resource method calls the generated operation for its endpoint.
  Hand-written code is limited to what a generator cannot know: configuration
  lookup, retries with stable idempotency keys, pagination, batching, waiting
  for state changes, metadata tagging and error mapping. The only request
  adaptation is the NDJSON body of `putObjects`, sent unchanged.
- `tests/coverage.test.ts` checks that every operation in `spec/source.json`
  is called by exactly one client method, so a new API operation fails CI
  until it has a home.
- `src/index.ts` never re-exports `src/generated`. Models the SDK returns are
  written out in `src/models.ts` under their API names, and
  `tests/types.test.ts` checks they stay identical to the generated types.
- User-facing text (README, `docs/index.md`, doc comments, error messages)
  never mentions how the SDK is built, and never mentions service internals
  such as storage, caches or background maintenance. Errors say what the
  caller can do.
- `docs/index.md` is the guide page of the documentation site and mirrors
  `README.md`; change both together.

## Development

From the repository root:

```sh
npm ci
npm run generate
git diff --exit-code -- src/generated
npm run lint
npm test
npm run build
node scripts/check-package.mjs
npm run docs
```

Generation reads the exported snapshot and needs only Node.js. Change the
source contract in Grepvine rather than editing the snapshot. Operations and
wire types are generated with `@hey-api/openapi-ts@0.99.0` (types, SDK and
Fetch plugins); generation dependencies are development-only.

`scripts/check-package.mjs` packs the package, installs it in a temporary
directory and exercises the public interface from the installed copy.

Package names are provisional until registry availability is checked before
release.

### Live tests

Optional live tests create and delete a uniquely named index. Set
`GREPVINE_SDK_TEST_ENDPOINT`, `GREPVINE_SDK_TEST_API_KEY` and
`GREPVINE_SDK_TEST_ORGANIZATION`, then run `npm test`. The other suites need
no running service.

### Examples

```sh
export GREPVINE_API_ENDPOINT=http://localhost:8080
export GREPVINE_ORGANIZATION=local
export GREPVINE_API_KEY='your-api-key'
npm run example:ingest-search            # add -- --keep-index to keep the index
npm run example:device-login
```

The ingest example creates a uniquely named index, stores one document on its
own and two in a batch, searches with and without a metadata filter (three
matches, then two), and requests deletion of its index unless
`--keep-index` is given. The organization must exist, and the key needs
permission to create and delete indexes.

## Documentation site

TypeDoc builds the guide and reference from `src/index.ts`, with
`docs/index.md` as the landing page. `docs/theme/plugin.mjs` sorts the
reference into Client, Organizations, Indexes, Documents, Search, API keys,
Account, Device login, Errors and Models (a `@category` tag wins over the
source file), and fails the build if anything from `src/generated` would be
documented. Warnings, including broken links and symbols referenced but not
exported, fail the build.

```sh
npm run docs
```

Open `docs/_build/index.html`; the directory is git-ignored.

The theme in `docs/theme` follows the Grepvine design system in
[`grepvine-ai/grepvine-design-system`](https://github.com/grepvine-ai/grepvine-design-system).
Read `docs/theme/README.md` and the design system's `README.md` before
changing it.

## Repository automation

The `Regenerate and validate SDK` workflow can be triggered manually. It
regenerates from the snapshot, runs tests and builds an installed-package
smoke test, then commits generated changes after the checks pass. Pushes and
pull requests validate reproducibility without committing. Grepvine's manual
`Update SDK snapshots` workflow updates both repositories and requests
regeneration.

The `Build and publish docs` workflow builds the documentation on every pull
request and push to `main` without deploying it. Publishing a GitHub release
(not a pre-release), or running the workflow manually, also deploys the site
to GitHub Pages, so it always documents the latest release. One-time setup: in
the repository's Settings → Pages, set Source to GitHub Actions. GitHub Pages
on a private repository requires a paid plan, and the published site is
public.

The `Build and publish SDK` workflow runs the same checks, builds the
package, and publishes it to npm. Publishing a GitHub release uploads the
tag's version (`v0.2.0` becomes `0.2.0`) under the `latest` dist-tag, or
`next` for a pre-release. A manual run publishes only a pre-release version
(`0.2.0-rc.1`) under a non-`latest` dist-tag (default `next`), so
`npm install @grepvine/sdk` is unaffected until a final release; install the
candidate with `npm install @grepvine/sdk@next`. Enable `dry_run` to build and
run `npm publish --dry-run` without uploading. Publishing uses npm trusted
publishing from workflow `publish.yml` in the `npm` environment; an
`NPM_TOKEN` secret is used instead when set, for example for the first
publish before a trusted publisher can be configured.
