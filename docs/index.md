The TypeScript SDK for Grepvine, a search service for large collections of
text: regular-expression and literal search over every line of every
document, with metadata filters and paged results.

```sh
npm install @grepvine/sdk
```

Node.js 22.18 or later, or a modern browser. The package is ESM only and
ships TypeScript declarations; import everything from the package root.

Data the SDK returns keeps the API's field names, such as `created_at` and
`line_number`. Methods and options use camelCase, such as `pageSize`.

## Authentication

In Node.js the SDK finds its endpoint and API key the way the `gv`
command-line client does, so a machine where `gv login` has run needs no
configuration:

1. `GREPVINE_API_ENDPOINT` (or `GREPVINE_ENDPOINT`) and `GREPVINE_API_KEY` in
   the environment.
2. `endpoint` and `api_key` in `~/.grepvine/config.yaml`, the file `gv login`
   writes. The file must be readable by its owner only (mode `0600`).
3. The default endpoint, `https://api.grepvine.ai`.

```ts
import { GrepvineClient } from "@grepvine/sdk";

const client = new GrepvineClient();
```

Options win over the environment and the file:

```ts
const client = new GrepvineClient({
  apiKey: "gvk_...",
  endpoint: "https://grepvine.example.com",
});
```

In a browser only the options apply. Nothing is read until the first
request. A `GrepvineClient` also takes `timeout` (the time limit of each
attempt, in milliseconds; default 60,000), `retry` (a `RetryPolicy`), `fetch`
(another `fetch` to send requests with), and `configPath` (another
configuration file). A missing API key throws `ConfigurationError` on the
first request that needs one. `await client.config()` reports the resolved
settings.

Every method takes a `signal` option, an `AbortSignal` that cancels it.

## Organizations

```ts
for await (const org of client.organizations.list()) {
  console.log(org.name, org.role);
}

const org = await client.organizations.get("my-org");
```

`create(name)` creates an organization, `delete(name)` starts deleting one,
and `transferOwnership(organization, user)` makes another account its owner.
Members are managed through `members(organization)`:

```ts
const members = client.organizations.members("my-org");
await members.add("alice", { role: "developer" });
await members.update("alice", { role: "admin" });
for await (const member of members.list()) {
  console.log(member.user.name, member.role);
}
await members.remove("alice");
```

## Indexes

Indexes are referenced as `"organization/index"`.

```ts
let index = await client.indexes.create("my-org/my-index", {
  description: "# Product docs\n\nEvery guide we publish.", // Markdown, optional
  tags: { team: "search", commit: "3f9c2a1" }, // key/value labels, optional
  existOk: true,
  wait: true, // return once the index is ready
});
index = await client.indexes.get("my-org/my-index");
console.log(index.state, index.document_count);
console.log(index.description);
console.log(index.tags.commit);

for await (const index of client.indexes.list("my-org")) {
  console.log(`${index.name}: ${index.document_count} documents`);
}
const docsIndexes = await client.indexes
  .list("my-org", { prefix: "docs-" })
  .toArray();

index = await index.update({
  description: "Guides, runbooks and the API reference.",
});
index = await index.update({ tags: { team: "platform", commit: null } }); // set one, remove one
index = await index.setTags({ commit: "8b1d0e4" });
index = await index.removeTags("team");
await index.exists();
await index.delete(); // deletion completes in the background
```

`document_count` and the other fields are a snapshot from when the handle was
fetched; `index.refresh()` returns a new handle. `index.waitUntilReady({
timeout })` waits until a new index is ready and returns a fresh handle. An
index's `description` is Markdown, at most 16,384 characters, and empty when
none was set; `update({ description })` replaces it (an empty string clears
it) and returns a new handle. An index's `tags` are a read-only object of
key/value labels, empty when none was set. `update({ tags })` merges into
them: every key given is set, a key given as `null` is removed, and keys left
out stay as they are; `setTags(...)` and `removeTags(...)` are shorthands for
those two cases. `update` sends only the fields you pass, so changing the
description leaves the tags alone and the other way round. Changing a
description or tags needs the admin or owner role.

## Search

```ts
const index = await client.indexes.get("my-org/my-index");

for await (const result of index.search("TODO|FIXME")) {
  console.log(`${result.key}:${result.line_number}: ${result.text}`);
}

for await (const result of index.search("hello world", {
  regex: false, // literal text instead of a regular expression
  caseSensitive: false,
  wholeWord: true, // literal mode only
  multiline: false, // true lets a match span lines
  filters: ["path STARTSWITH 'src/'", "size < 100000"],
  linesBefore: 2,
  linesAfter: 2,
})) {
  for (const line of result.lines_before) {
    console.log(`${result.key}-${line.line_number}-${line.text}`);
  }
  console.log(`${result.key}:${result.line_number}:${result.text}`);
  console.log(result.matchTexts());
}
```

A `SearchResult` carries the covered `text`, its `line_number`, and the
`matches` as byte offsets within the document, which is what the API reports.
`result.matchSpans()` converts them to positions within `text`, ready for
`text.slice(start, end)`, and `result.matchTexts()` returns the matched
strings.

Filters are expressions over document metadata, such as
`path STARTSWITH 'docs/' AND mtime >= (CURRENT_DATE - INTERVAL '3 days')`.
Several `filters` are joined with `AND`; a single expression can be passed as
`filter`. The SDK records `path` and `size` metadata on every document it
stores, so filters on those fields work without extra effort.

## Documents

```ts
const documents = index.documents;

// Store one document: text, bytes, a Blob or File, or a file: URL in Node.js.
await documents.put("notes/today.md", "# Today\n");
await documents.put("report.pdf", new URL("file:///home/me/report.pdf"), {
  metadata: { team: "sales" },
});

// Store several at once.
await documents.put([
  { key: "a.txt", content: "alpha" },
  {
    key: "b.txt",
    content: new TextEncoder().encode("beta"),
    metadata: { lang: "el" },
  },
]);

// Read.
const data = await documents.get("notes/today.md"); // Uint8Array
const text = await documents.get("notes/today.md", { mode: "text" }); // string
const head = await documents.get("report.pdf", { range: [0, 1023] });
const document = await documents.fetch("notes/today.md"); // content, revision, metadata

// List.
for await (const doc of documents.list({ prefix: "notes/" })) {
  console.log(doc.key, doc.size, doc.searchable);
}
for await (const page of documents.list({ delimiter: "/" }).pages()) {
  console.log(page.common_prefixes);
}

// Delete.
await documents.delete("notes/today.md");
await documents.delete(["a.txt", "b.txt"]);
```

Metadata values may be strings, numbers, booleans or `Date`s; the SDK tags
them for the API and untags them on the way back. Whole numbers are stored as
integers and must be safe JavaScript integers. Documents may carry up to 64
metadata fields, two of which the SDK uses for `path` and `size` (and a
third, `mtime`, when the content is a file). Your fields override those.

Documents can be up to 1 GiB. Content that is valid UTF-8 and at most 100 MiB
is searchable; anything else is stored and served but never matched by a
search. `DocumentSummary.searchable` reports which applies.

Preconditions are available on every write: `ifMatch: revision` applies the
change only if the document still has that revision, and `ifNoneMatch: true`
only if the document does not exist. A single-document write whose
precondition fails throws `PreconditionFailedError`. In the array forms, put
these inside each object; a document whose precondition fails is reported in
its result instead, as described below.

### Results of array writes

The array forms of `put` and `delete` return one `MutationResult` per
document, in input order. Each document is written on its own. A document
whose `ifMatch` or `ifNoneMatch` condition fails is left unchanged and the
others are written; an array `delete` does the same with a key that does not
exist. The result of a written document has its new `revision`. The result of
an unchanged document has no revision, `ok` is `false`, and `error` says why:
its `code` is `"precondition_failed"` or `"not_found"`, and its `message` is
the service's explanation.

```ts
const results = await documents.put([
  { key: "a.txt", content: "alpha", ifNoneMatch: true },
  { key: "b.txt", content: "beta", ifMatch: revision },
]);
for (const result of results) {
  if (result.error)
    console.log(`${result.key} was not stored: ${result.error.message}`);
}

const missing = (await documents.delete(["a.txt", "gone.txt"]))
  .filter((result) => !result.ok)
  .map((result) => result.key);
```

Text documents travel in batches of up to 2,048 documents and 16 MiB, and
binary or larger documents travel one at a time. If a request fails after
earlier requests got an answer, for example because the service failed on
every attempt, the SDK throws `PartialBatchError`. It has `committed` (the
results so far, unchanged documents included), `failedKeys` (the documents of
the failed request; the service may have written some of them), and
`pendingKeys` (the documents that were never sent). If the first request
fails, the SDK throws the underlying error unchanged. To finish an
interrupted write safely, give it an `idempotencyKey` and repeat it with the
same key and the same documents: the service does not write a document twice.

## Pagination

Every `list` and `search` returns a `Paginator`. Iterating it with
`for await` yields every result, fetching pages as needed:

```ts
for await (const doc of documents.list()) {
  // ...
}
```

`limit` caps the number of results yielded. `pageSize` (1 to 200) sets how
many results each request asks for. `first()` returns the first result and
`toArray()` collects them all. `pages()` yields `Page` objects, and a page's
`next_page_id` lets a later call continue from it:

```ts
const pages = documents.list({ pageSize: 100 }).pages();
const { value: page } = await pages.next();
const later = documents.list({
  page: page!.next_page_id,
  pageSize: page!.page_size,
});
```

A continuation is valid for 15 minutes and only with the same arguments,
including `pageSize`; otherwise the service answers with `InvalidPageError`.
A search page may be empty while more results follow; the paginator keeps
going until the service reports the end.

## Errors

Every error is a `GrepvineError`. Errors from the service are `APIError`
subclasses with `statusCode`, `code`, `message` and `requestId`:

| Error                      | When                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `InvalidRequestError`      | The request was rejected; fix the input. `InvalidPageError` for a bad page token.               |
| `AuthenticationError`      | The API key or session is missing or not valid.                                                 |
| `PermissionDeniedError`    | The caller may not perform the action.                                                          |
| `NotFoundError`            | The resource does not exist or is not visible.                                                  |
| `ConflictError`            | The request conflicts with the current state, such as creating an index that exists.            |
| `PreconditionFailedError`  | An `ifMatch` or `ifNoneMatch` condition failed on a single-document write.                      |
| `PayloadTooLargeError`     | A document or batch is over its size limit.                                                     |
| `RangeNotSatisfiableError` | A byte range does not overlap the document.                                                     |
| `RateLimitedError`         | The service kept asking the client to slow down for longer than the client was willing to wait. |
| `ServerError`              | The service failed on every attempt.                                                            |

`ConfigurationError` means the client has no API key or an unusable endpoint
or configuration file. `TransportError` means the request could not be
delivered, or an attempt outlasted `timeout`. `PartialBatchError` is
described above. A cancelled `signal` throws its reason unchanged.

The SDK retries on its own: a `429` pauses every request of the client for
the interval the service asks for (with jitter, up to a minute at a time and
ten minutes in total per request), and a `5xx` answer or a connection failure
is retried twice more with a short backoff. Every write carries an
idempotency key that stays the same across retries, so a retried write is
applied once. Pass `retry: new RetryPolicy({ ... })` to change these bounds;
its durations are in milliseconds.

## Concurrency and cancellation

Every network method returns a `Promise`, and paginators are async iterables.
A client may be shared by any number of concurrent calls; a `429` pauses all
of them. Each iteration of a paginator starts over from the beginning.

Pass `signal` to cancel a call, or `AbortSignal.timeout(ms)` to bound one in
total:

```ts
const index = await client.indexes.get("my-org/my-index", {
  signal: AbortSignal.timeout(5_000),
});
```

## API keys

```ts
const created = await client.apiKeys.create("ci");
console.log(created.key); // shown only this once

for await (const key of client.apiKeys.list()) {
  console.log(key.name, key.prefix, key.revoked_at ?? "active");
}

await client.apiKeys.revoke(created.id);
```

## Account

An API key authenticates every call except `register`, `usernameAvailable`
and `login`, which need no credentials.

```ts
if (await client.account.usernameAvailable("alice")) {
  await client.account.register({
    name: "alice",
    email: "alice@example.com",
    password,
  });
}

const me = await client.account.me();
await client.account.changePassword({ currentPassword, newPassword });
```

`login` starts a session and keeps it on the client, so later calls use it
instead of an API key until `logout`. In Node.js the client keeps the session
cookie and its CSRF token itself; in a browser the browser keeps the cookie,
requests are sent with `credentials: "include"`, and the service must allow
the page's origin.

```ts
const client = new GrepvineClient({ endpoint: "https://grepvine.example.com" });
await client.account.login({ identifier: "alice", password });
const key = await client.apiKeys.create("laptop");
await client.account.logout();
```

Without a session, `logout` revokes the API key the client uses.

## Device login

A device such as a command-line tool or an agent can get an API key of its
own by having a person approve it. `authorize` starts a login, reports the
code to show through `onCode`, and polls at the service's interval until the
key is issued:

```ts
const device = new GrepvineClient();
const key = await device.deviceLogin.authorize({
  apiKeyName: "build agent",
  onCode: ({ verification_uri_complete, user_code }) =>
    console.log(`Open ${verification_uri_complete} and enter ${user_code}`),
  timeout: 5 * 60_000, // optional; by default, until the login expires
});
const client = new GrepvineClient({ apiKey: key.key });
```

A denied login throws `InvalidRequestError` with code `"access_denied"`; one
that expires, or outlasts `timeout`, throws `GrepvineError`. The steps are
also available one at a time: `start({ apiKeyName })`, then
`poll(deviceCode)` until it returns `{ status: "issued", apiKey }`. The
person approving uses a client with a session or an API key:

```ts
await approver.deviceLogin.approve("ABCD-EFGH"); // or deny(...)
```

## Other requests

`client.http(path, init)` sends any request to the API with the client's
endpoint, authentication and retries, and returns the `Response` as it is,
whatever its status:

```ts
const response = await client.http("/organizations?amount=10");
console.log(response.status, await response.json());
```

## Limits worth knowing

- One document: at most 1 GiB, and a single upload must finish within the
  service's request deadline of 35 seconds.
- One batch: at most 2,048 documents and 16 MiB of text.
- Keys: 1 to 1,024 characters. Organization and index names: letters, digits,
  and hyphens, starting with a letter. A name keeps the case it was created
  with, and any spelling that differs only in case refers to the same
  organization or index.
- `linesBefore` and `linesAfter`: at most 20 each.
- Tags: at most 64 per index. A key is 1 to 128 characters without whitespace
  or control characters; a value is at most 1,024 characters without control
  characters.

## Reference

The reference is organized by resource: {@link GrepvineClient} and
{@link Paginator} under _Client_, then {@link Organizations},
{@link Indexes} and {@link Index}, {@link Documents}, search with
{@link SearchResult}, {@link ApiKeys}, {@link Account}, {@link DeviceLogin},
the _Errors_ starting at {@link GrepvineError}, and the _Models_ the API
returns.

## License

Proprietary. See `LICENSE`.
