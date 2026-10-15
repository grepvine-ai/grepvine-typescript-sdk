Typed access to the Grepvine API for Node.js 22.18+ and browsers. The package
covers all 34 public API operations — authentication, device login, API keys,
organizations and membership, indexes, objects and search — through two layers:

- the **convenience client**, {@link GrepvineClient}, with index and document
  handles, Promise-based methods and async search iterators;
- the **raw generated API**: one typed function per operation, plus the request
  and response models, generated from the API's OpenAPI contract.

The reference is grouped the same way: _Convenience client_, _Raw client_,
_Operations_ and _API types_.

## Install

```sh
npm install @grepvine/sdk
```

The package is ESM only and ships TypeScript declarations. Import everything
from the package root.

## Authentication

API keys authenticate every operation that supports bearer credentials. Both
layers send the key only as a bearer token, never as a cookie.

```ts
import { GrepvineClient } from "@grepvine/sdk";

const client = new GrepvineClient({ apiKey: process.env.GREPVINE_API_KEY! });
```

Browser-account operations use session authentication instead: create a raw
client without an API key, set `credentials: "include"`, and send
`X-Csrf-Token` on state changes. Standard browser cross-origin rules apply.

## Convenience client

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

- `client.indexes.get("organization/index")` returns an {@link IndexHandle}
  without a request. {@link IndexHandle.info} fetches its state,
  {@link Indexes.create} creates an index, {@link IndexHandle.waitReady} waits
  for readiness and {@link IndexHandle.delete} requests deletion.
- {@link Documents.put} accepts text, a Blob/File, Uint8Array or ArrayBuffer.
  Metadata accepts strings, booleans, finite numbers and Date values; the
  wrapper supplies the type tags. Unsafe JavaScript integers are rejected. Use
  `ifMatch` and `ifNoneMatch: true` for write preconditions.
- {@link Documents.putMany} sends **one batch**: up to 2,048 text documents and
  16 MiB of UTF-8 content, validated before any request. Batches are not split
  or retried. Each write generates an idempotency key unless `idempotencyKey`
  is supplied; keep that key and the data if you retry.
- {@link IndexHandle.search} is regex by default; pass `literal: true` for a
  literal pattern. It fetches pages lazily and follows continuation tokens. See
  {@link SearchOptions} for `filter`, `caseSensitive`, `wholeWord`,
  `multiline`, `linesBefore`, `linesAfter` and `amount` (1–200).
- Every network method and search takes an AbortSignal as `signal`. Requests
  time out after `timeoutMs` (default 30,000).

### Errors

{@link ApiError} carries `status`, `code`, `reason`, `requestId`, `retryAfter`
(seconds, or undefined) and the response headers. {@link BatchError} keeps all
`results`, including successes, plus `failures` and `requestId`. Pass
`raiseOnError: false` to `putMany` to inspect batch results without throwing.
Transport errors and caller cancellation propagate unchanged.

`client.raw` is the generated Fetch client, so any raw operation can be called
with the same configuration.

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

- Pass a client to each operation. {@link createGrepvineClient} defaults to
  `https://api.grepvine.ai/v1`; a custom `baseUrl` must include `/v1`.
- Error results keep the original HTTP response, including `Retry-After`. Pass
  `throwOnError: true` to throw instead.
- Data mutations require an `Idempotency-Key`; reuse the same value and body if
  you retry. The SDK never retries on its own.
- List and search operations return one page at a time. When
  `pagination.has_next` is true, pass `pagination.next_page_id` as
  `query.page` with the original request.
- {@link putObjects} sends its NDJSON string unchanged:

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

- For {@link putDocument}, pass a Blob/File as `body.content`, a string as
  `body.key` and `JSON.stringify(metadata)` as `body.metadata`.
- {@link getDocument} returns content as a Blob. For an incremental download
  set `parseAs: "stream"` and read `result.response.body`.
- Integer values are JavaScript numbers: stay within
  `Number.MIN_SAFE_INTEGER` to `Number.MAX_SAFE_INTEGER` when exact values
  matter.

## Examples

The repository has two runnable examples. Each creates a uniquely named index,
stores documents, searches them and requests deletion of the index when it
finishes. The organization must exist and the key needs permission to create
and delete indexes.

```sh
export GREPVINE_API_ENDPOINT=http://localhost:8080
export GREPVINE_ORGANIZATION=local
export GREPVINE_API_KEY='your-api-key'
npm run example:convenience     # the convenience client
npm run example:ingest-search   # the raw generated API
```

Pass `--keep-index` after `--` to keep the ingest example's documents for
inspection.
