# Grepvine TypeScript SDK

The SDK includes all 34 public API operations: Authentication, Device login,
API keys, Organizations and membership, Indexes, Objects, and Search.
API keys authenticate operations that support bearer credentials; browser-account
operations use the session authentication described by the API contract.

Grepvine exports its full public contract as `spec/openapi.json` without filtering
operations or components. `spec/source.json` records the source repository,
commit, exported operation list, and snapshot checksum.

Typed operations for the Grepvine API, for Node.js 22.18+ and browsers.
This package is separate from the web application's API code.

## Convenience API

`GrepvineClient` provides resource handles, Promise-based network methods, and
async search iterators. It keeps the raw generated operations available.

```ts
import { GrepvineClient } from "@grepvine/sdk";

const client = new GrepvineClient({
  apiKey: process.env.GREPVINE_API_KEY!,
  baseUrl: "http://localhost:8080",
});
const index = client.indexes.get("local/docs");
await index.documents.put("hello.txt", "hello world", {
  metadata: { kind: "guide" },
});
await index.documents.putMany([
  { key: "other.txt", content: "hello again", metadata: { kind: "note" } },
]);
for await (const hit of index.search("hello", {
  literal: true,
  filter: "kind = 'guide'",
})) {
  console.log(hit.key, hit.text);
}
```

`indexes.get("organization/index")` creates a handle synchronously without a
request. `index.info()` fetches its state. `indexes.create(ref, { description,
tags })` creates an index; `index.waitReady({ timeoutMs: 30_000 })` waits for
readiness. `index.delete()` requests deletion.

`put` accepts text, a Blob/File, Uint8Array, or ArrayBuffer. Metadata accepts
strings, booleans, finite numbers, and Date values; the wrapper supplies type
tags. Unsafe JavaScript integers are rejected. Use `ifMatch` and
`ifNoneMatch: true` for write preconditions.

One `putMany` call sends **one batch**, up to 2,048 text documents and 16 MiB
of UTF-8 content. The complete input is validated/encoded before any request.
Calls are not automatically split or retried. Each write generates an
idempotency key unless `idempotencyKey` is supplied; preserve that key and the
data when implementing retries.

`ApiError` exposes `status`, `code`, `reason`, `requestId`, `retryAfter`
(seconds or undefined), and response headers. `BatchError` retains all
`results`, including successes, plus `failures` and `requestId`.
Set `raiseOnError: false` to inspect batch results without throwing on
individual failures. Transport exceptions and caller cancellation propagate.

Search lazily fetches JSON responses and follows continuation tokens, including
empty responses. It is regex by default; use `literal: true`. Options include
`filter`, `caseSensitive`, `wholeWord`, `multiline`, `linesBefore`,
`linesAfter`, and `amount` (1–200). Pass an AbortSignal as `signal` on any
network method or search. The client has a per-request `timeoutMs` setting
(default 30,000); readiness also honors its own deadline.

After setting the environment variables below, run:

```sh
npm run example:convenience
```

`client.raw` exposes the generated Fetch client. The existing
`createGrepvineClient`, `createClient` and generated operation exports remain
available for advanced requests. Network I/O is asynchronous.

## Raw generated API

```ts
import { createGrepvineClient, queryIndex } from "@grepvine/sdk";

const client = createGrepvineClient({ apiKey: process.env.GREPVINE_API_KEY });
const result = await queryIndex({
  client,
  path: { organization: "acme", index: "notes" },
  body: { pattern: "hello", mode: "literal" },
});
if (result.error) {
  console.error(
    result.response?.status,
    result.error,
    result.response?.headers.get("X-Request-ID"),
  );
} else {
  console.log(result.data.results);
}
```

Pass an independent client to each operation. The default URL is
`https://api.grepvine.ai/v1`; custom `baseUrl` values must include `/v1`.
`createGrepvineClient` sends API keys only as bearer credentials.
For browser sessions, omit the API key, set `credentials: "include"`, and
supply `X-Csrf-Token` on state changes. Standard browser cross-origin rules apply.

Operations and wire types are generated from the exported `spec/openapi.json` with
`@hey-api/openapi-ts@0.99.0` (types, SDK, and Fetch plugins).
Generation dependencies are development-only; consumers do not need them.
Use root package exports. `putObjects` has a small adapter to transmit its NDJSON string unchanged:

```ts
import { putObjects } from "@grepvine/sdk";

const batch = await putObjects({
  client,
  path: { organization: "acme", index: "notes" },
  headers: { "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify({ key: "hello.txt", content: "hello" }) + "\n",
});
console.log(batch.data?.results); // inspect each result's error as well
```

For `putDocument`, pass a Blob/File as `body.content`, a string as
`body.key`, and `JSON.stringify(metadata)` as `body.metadata`.
Data mutations require an `Idempotency-Key`; reuse the same value and body
if you choose to retry. The SDK does not retry requests automatically.
Error results retain the original HTTP response, including `Retry-After`.
Use `throwOnError: true` if you prefer errors to be thrown.

List/search operations return one response at a time. When
`pagination.has_next` is true, pass `pagination.next_page_id` as
`query.page`, preserving the original request. Pagination is explicit.
Tagged metadata uses the API's `type` and `value` fields; tag removals use
null while absent tags remain untouched. Integer values use JavaScript
numbers: do not use integers outside `Number.MIN_SAFE_INTEGER` through
`Number.MAX_SAFE_INTEGER` when exact values are required.

`getDocument` returns binary content as a Blob and exposes response headers.
For an incremental download, set `parseAs: "stream"` and consume
`result.response.body` (rather than the generated `data` type, which describes
the default Blob). Pass an AbortSignal to cancel a request or stream.
For request timeouts use `signal: AbortSignal.timeout(milliseconds)`.

The bundled Fetch transport supports SSE, but Grepvine currently exposes
no REST SSE operation. This SDK does not add a streaming search endpoint.
A future SSE operation requires an API/server change and defined event
and reconnection semantics.

## Development

From the SDK repository root:

```sh
npm ci
npm run generate
npm run lint
npm test
npm run build
node scripts/check-package.mjs
```

Generation reads the exported snapshot and needs only Node.js. Consumers need
neither uv nor Python. Change the source contract in Grepvine rather than
editing the snapshot.

Generated output lives in `src/generated`; change the contract or generator
configuration and regenerate it. Helpers, exports, docs, and tests live outside
that directory. The build creates an ESM package with TypeScript declarations.
Package names are provisional until registry availability is checked before release.

Optional live tests create and delete a uniquely named index. Set
`GREPVINE_SDK_TEST_ENDPOINT` (including `/v1`), `GREPVINE_SDK_TEST_API_KEY`,
and `GREPVINE_SDK_TEST_ORGANIZATION`, then run `npm test`.
The ordinary HTTP fixture tests require no running service.

## Runnable ingest and search example

The example creates a uniquely named index, stores one document with multipart
content and two documents in an NDJSON batch, then searches immediately. It
follows continuation tokens and demonstrates a metadata filter, returning
three matches overall and two matching `kind = 'guide'`.

After installing development dependencies, run from the repository root:

```sh
export GREPVINE_API_ENDPOINT=http://localhost:8080
export GREPVINE_ORGANIZATION=local
export GREPVINE_API_KEY='your-api-key'
npm run example:ingest-search
```

The example requests deletion of its own index in a `finally` block. Add
`--keep-index` to keep the documents for inspection (pass it after `--` with npm).
The organization must already exist, and the key needs permission to create
and delete indexes. API endpoints may be supplied with or without `/v1`.

## Repository automation

The `Regenerate and validate SDK` workflow can be triggered manually. It
regenerates from the snapshot, runs tests and builds an installed-package
smoke test, then commits generated changes after the checks pass. Pushes and
pull requests validate reproducibility without committing. These workflows
do not publish packages. Grepvine’s manual `Update SDK snapshots` workflow
updates both repositories and requests regeneration.
