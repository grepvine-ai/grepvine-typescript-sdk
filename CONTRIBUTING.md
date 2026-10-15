# Contributing

This guide is for people working on `@grepvine/sdk` itself. To use the SDK,
read [`README.md`](README.md).

## Layout

| Path                   | Contents                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `spec/openapi.json`    | The full public API contract exported by Grepvine. Never edit it here.                    |
| `spec/source.json`     | The source repository, commit, operation list and checksum of the snapshot.               |
| `sdk-operations.json`  | Where each operation lives on the client. Shared, identical, with the Python SDK.         |
| `openapi-ts.config.ts` | Generator configuration.                                                                  |
| `src/generated`        | Generated client, resource classes, models and transport. Never edit it; regenerate it.   |
| `src/client.ts`        | `GrepvineClient`: endpoint, authentication, the session, idempotency keys, error mapping. |
| `src/retry.ts`         | `RetryPolicy` and the retrying `fetch`.                                                   |
| `src/paginate.ts`      | `paginate`.                                                                               |
| `src/resources.ts`     | `Indexes`, `Documents` and `DeviceLogin`: the generated classes plus their helpers.       |
| `src/errors.ts`        | The error hierarchy and status mapping.                                                   |
| `tests`                | Vitest suites against a fake `fetch` (`tests/fake.ts`), and optional live tests.          |
| `docs`                 | The TypeDoc guide page (`docs/index.md`) and theme (`docs/theme`).                        |
| `examples`             | Runnable examples.                                                                        |

## Design rules

- The SDK is mostly generated. Hey API generates one class, `GrepvineApi`,
  with a property per resource and a method per operation, from
  `sdk-operations.json`; the models and per-operation types, with their doc
  comments from the spec; and the transport. Methods take one object of the
  API's parameters (`paramsStructure: "flat"`) and return the answer's data,
  throwing on an error answer.
- Hand-written code is limited to what a generator cannot express: the client
  options, bearer authentication and the login session, retries with stable
  idempotency keys, typed errors, `paginate`, and three helpers on the
  resources they belong to (`indexes.waitUntilReady`,
  `deviceLogin.authorize`, `documents.putMany`). Anything else a caller needs
  is a generated method. Helper names match the Python SDK (`paginate`,
  `wait_until_ready`, `authorize`, `put_many`).
- The generator configuration presents the spec to the generator without
  changing `spec/openapi.json`: request bodies are inlined so their fields
  become method parameters, the CSRF header is left to the client, and
  `Idempotency-Key` is optional because the client sets one. Operation-based
  type names (`ListIndexesData`) are kept by expressing the map as a custom
  `strategy` rather than `nesting`.
- `tests/coverage.test.ts` checks that `sdk-operations.json` covers every
  operation in `spec/source.json`, and that each mapped method sends its
  operation's request, so a new API operation fails CI until it has an entry.
- `src/index.ts` exports the client, the resource classes, the helpers, the
  errors and every API type under its API name; never the generated
  transport (`createClient`, `client`) or `GrepvineApi`.
- User-facing text (README, `docs/index.md`, doc comments, error messages)
  never mentions how the SDK is built, and never mentions service internals
  such as storage, caches or background maintenance. Errors say what the
  caller can do.
- Loading configuration (environment variables, a configuration file) is
  deferred: the client uses only the options it is given.
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
source contract in Grepvine rather than editing the snapshot, and give a new
operation its place in `sdk-operations.json` (in both SDK repositories). The
client, models and transport are generated with `@hey-api/openapi-ts@0.99.0`
(types, SDK and Fetch plugins); generation dependencies are development-only.

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

The ingest example creates a uniquely named index, waits until it is ready,
stores three documents in one batch, searches with and without a metadata filter (three
matches, then two), and requests deletion of its index unless
`--keep-index` is given. The organization must exist, and the key needs
permission to create and delete indexes.

## Documentation site

TypeDoc builds the guide and reference from `src/index.ts`, with
`docs/index.md` as the landing page. The resource classes and models come
with the spec's descriptions. `docs/theme/plugin.mjs` sorts the reference into
Client, Organizations, Indexes, Documents, Search, API keys, Account, Device
login, Errors and Models: a resource class and the request and response types
of its operations go under its resource from `sdk-operations.json`, and a
`@category` tag wins over the source file. It also hides the resources'
constructors. Warnings, including broken links and symbols referenced but not
exported, fail the build; the transport types that public signatures mention
are listed in `typedoc.json` under `intentionallyNotExported`.

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
