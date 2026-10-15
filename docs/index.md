The TypeScript SDK for Grepvine, a search service for large collections of
text: regular-expression and literal search over every line of every
document, with metadata filters and paged results.

```sh
npm install @grepvine/sdk
```

Node.js 22.18 or later, or a modern browser. The package is ESM only and
ships TypeScript declarations; import everything from the package root.

Every API operation is a method of a resource on the client, such as
`client.indexes.list` or `client.search.query`. A method takes one object with
the API's parameters, path, query and body fields alike, and returns the API's
answer with the API's field names, such as `created_at` and `line_number`.
Types are exported under their API names: models such as `Index` and
`QueryResult`, and per-operation types such as `ListIndexesData`.

## Authentication

Pass your API key, and the endpoint when you use a service other than
`https://api.grepvine.ai`:

```ts
import { GrepvineClient } from "@grepvine/sdk";

const client = new GrepvineClient({
  apiKey: "gvk_...",
  endpoint: "https://grepvine.example.com",
});
```

The key is sent as a bearer token. The SDK reads no environment variables or
configuration files; pass the values from wherever your application keeps
them. A `GrepvineClient` also takes `timeout` (the time limit of each attempt,
in milliseconds; default 60,000), `retry` (a `RetryPolicy`) and `fetch`
(another `fetch` to send requests with).

Every method takes a second argument of request options, such as `signal`, an
`AbortSignal` that cancels the call.

## Organizations

```ts
import { paginate } from "@grepvine/sdk";

for await (const org of paginate(client.organizations.list, {})) {
  console.log(org.name, org.role);
}

const org = await client.organizations.get({ organization: "my-org" });
await client.organizations.create({ name: "new-org" });
await client.organizations.transferOwnership({
  organization: "new-org",
  user: "alice",
});
await client.organizations.delete({ organization: "new-org" });
```

Members are managed through `client.organizations.members`:

```ts
const where = { organization: "my-org" };
await client.organizations.members.add({
  ...where,
  user: "alice",
  role: "developer",
});
await client.organizations.members.update({
  ...where,
  user: "alice",
  role: "admin",
});
for await (const member of paginate(client.organizations.members.list, where)) {
  console.log(member.user.name, member.role);
}
await client.organizations.members.remove({ ...where, user: "alice" });
```

## Indexes

```ts
await client.indexes.create({
  organization: "my-org",
  name: "my-index",
  description: "# Product docs\n\nEvery guide we publish.", // Markdown, optional
  tags: { team: "search", commit: "3f9c2a1" }, // key/value labels, optional
});
let index = await client.indexes.waitUntilReady({
  organization: "my-org",
  index: "my-index",
  timeout: 60_000, // optional, in milliseconds
});
console.log(index.state, index.document_count, index.tags.commit);

for await (const index of paginate(client.indexes.list, {
  organization: "my-org",
  prefix: "docs-", // optional
})) {
  console.log(`${index.name}: ${index.document_count} documents`);
}

index = await client.indexes.update({
  organization: "my-org",
  index: "my-index",
  tags: { team: "platform", commit: null }, // set one, remove one
});
await client.indexes.delete({ organization: "my-org", index: "my-index" });
```

A new index is `creating` until it is ready; `waitUntilReady` checks it until
it is, and throws `GrepvineError` if it does not become ready in time or is
being deleted. An index's `description` is Markdown, at most 16,384
characters. `update` changes only the fields you pass: `description` replaces
the current one (an empty string clears it), and `tags` is merged into the
current tags, where a key given as `null` is removed. Changing a description
or tags needs the admin or owner role. Deletion completes in the background.

## Search

```ts
const where = { organization: "my-org", index: "my-index" };

for await (const hit of paginate(client.search.query, {
  ...where,
  pattern: "TODO|FIXME",
})) {
  console.log(`${hit.key}:${hit.line_number}: ${hit.text}`);
}

for await (const hit of paginate(client.search.query, {
  ...where,
  pattern: "hello world",
  mode: "literal", // literal text instead of a regular expression
  case_sensitive: false,
  whole_word: true, // literal mode only
  multiline: false, // true lets a match span lines
  filter: "path STARTSWITH 'src/' AND size < 100000",
  lines_before: 2,
  lines_after: 2,
})) {
  for (const line of hit.lines_before ?? []) {
    console.log(`${hit.key}-${line.line_number}-${line.text}`);
  }
  console.log(`${hit.key}:${hit.line_number}:${hit.text}`);
}
```

A result carries the covered `text`, its `line_number`, and the `matches` as
byte offsets within the document. Filters are expressions over document
metadata, such as
`path STARTSWITH 'docs/' AND mtime >= (CURRENT_DATE - INTERVAL '3 days')`.
`documents.putMany` records `path` and `size` metadata on every document it
stores, so filters on those fields work without extra effort.

## Documents

```ts
const where = { organization: "my-org", index: "my-index" };

const results = await client.documents.putMany({
  ...where,
  documents: [
    { key: "notes/today.md", content: "# Today\n", metadata: { team: "docs" } },
    {
      key: "a.txt",
      content: new TextEncoder().encode("alpha"),
      ifNoneMatch: true,
    },
    { key: "logo.png", content: new Blob([png]) },
  ],
});
for (const result of results) {
  if (result.error)
    console.log(`${result.key} was not stored: ${result.error.error}`);
}

const blob = await client.documents.get({ ...where, key: "notes/today.md" });
console.log(await blob.text());
const head = await client.documents.get({
  ...where,
  key: "logo.png",
  Range: "bytes=0-1023",
});

for await (const doc of paginate(client.documents.list, {
  ...where,
  prefix: "notes/",
})) {
  console.log(doc.key, doc.content_bytes, doc.searchable);
}

await client.documents.delete({ ...where, key: "notes/today.md" });
await client.documents.deleteBatch({
  ...where,
  objects: [{ key: "a.txt" }, { key: "logo.png" }],
});
```

`putMany` stores any number of documents and returns one `MutationResult` per
document, in input order. Text (a string, or bytes that are valid UTF-8)
travels as NDJSON in batches of up to 2,048 documents and 16 MiB; other
content, or text over 16 MiB, is stored one document at a time. Metadata
values may be strings, numbers, booleans or `Date`s, or values already tagged
as `{ type, value }`; whole numbers are stored as integers. Every document
also gets `path` (its key) and `size` metadata, which your fields override.
Documents may carry up to 64 metadata fields.

Each document is stored on its own. `ifMatch: revision` stores it only if it
still has that revision, and `ifNoneMatch: true` only if it does not exist; a
document whose condition fails is left unchanged and its result carries an
`error` with code `"precondition_failed"`, while the others are stored.

If a request fails after earlier requests got an answer, `putMany` throws
`PartialBatchError`. It has `committed` (the results so far), `failedKeys`
(the documents of the failed request; the service may have stored some of
them), and `pendingKeys` (the documents that were never sent). If the first
request fails, the underlying error is thrown unchanged. To finish an
interrupted call safely, give it an `idempotencyKey` and repeat it with the
same key and documents: the service does not store a document twice.

`documents.put` stores one document from a `Blob` and takes its `metadata` as
a JSON string; `documents.putBatch` takes an NDJSON body, sent unchanged.
Documents can be up to 1 GiB. Content that is valid UTF-8 and at most 100 MiB
is searchable; anything else is stored and served but never matched by a
search, which a listing's `searchable` reports.

## Pagination

Every list method and `search.query` returns one page: `results` and
`pagination`. `paginate(method, parameters)` iterates every item of every
page, fetching pages as the loop needs them:

```ts
for await (const index of paginate(client.indexes.list, {
  organization: "my-org",
})) {
  // ...
}
```

It follows `pagination.next_page_id` while `pagination.has_next` is true; a
page may be empty while more follow, as a search page that reached the
service's time budget. `amount` (1 to 200) sets how many results each request
asks for, and `page` starts from a page an earlier call returned. A page token
is valid for 15 minutes and only with the same parameters, including
`amount`; otherwise the service answers with `InvalidPageError`. For one page
at a time, call the method itself:

```ts
const { results, pagination } = await client.indexes.list({
  organization: "my-org",
  amount: 50,
});
```

## Errors

Every error is a `GrepvineError`. Errors from the service are `APIError`
subclasses with `statusCode`, `code`, `reason`, `message`, `requestId` and
`retryAfter`:

| Error                      | When                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `InvalidRequestError`      | The request was rejected; fix the input. `InvalidPageError` for a bad page token.               |
| `AuthenticationError`      | The API key or session is missing or not valid.                                                 |
| `PermissionDeniedError`    | The caller may not perform the action.                                                          |
| `NotFoundError`            | The resource does not exist or is not visible.                                                  |
| `ConflictError`            | The request conflicts with the current state, such as creating an index that exists.            |
| `PreconditionFailedError`  | An `If-Match` or `If-None-Match` condition failed.                                              |
| `PayloadTooLargeError`     | A document or batch is over its size limit.                                                     |
| `RangeNotSatisfiableError` | A byte range does not overlap the document.                                                     |
| `RateLimitedError`         | The service kept asking the client to slow down for longer than the client was willing to wait. |
| `ServerError`              | The service failed on every attempt.                                                            |

`ConfigurationError` means the endpoint is not usable. `TransportError` means
the request could not be delivered, or an attempt outlasted `timeout`.
`PartialBatchError` is described above. A cancelled `signal` throws its
reason unchanged.

The SDK retries on its own: a `429` pauses every request of the client for
the interval the service asks for (with jitter, up to a minute at a time and
ten minutes in total per request), and a `5xx` answer or a connection failure
is retried twice more with a short backoff. Every document write carries an
`Idempotency-Key` that stays the same across retries, so a retried write is
applied once; pass your own as the `"Idempotency-Key"` parameter. Pass
`retry: new RetryPolicy({ ... })` to change these bounds; its durations are in
milliseconds.

## Concurrency and cancellation

Every method returns a `Promise`. A client may be shared by any number of
concurrent calls; a `429` pauses all of them. Methods keep their client when
passed on, as `paginate` does. Pass `signal` to cancel a call, or
`AbortSignal.timeout(ms)` to bound one in total:

```ts
const index = await client.indexes.get(
  { organization: "my-org", index: "my-index" },
  { signal: AbortSignal.timeout(5_000) },
);
```

## API keys

```ts
const created = await client.apiKeys.create({ name: "ci" });
console.log(created.key); // shown only this once

for await (const key of paginate(client.apiKeys.list, {})) {
  console.log(key.name, key.prefix, key.revoked_at ?? "active");
}

await client.apiKeys.revoke({ api_key_id: created.id });
```

## Account

An API key authenticates every call except `register`, `usernameAvailability`
and `login`, which need no credentials.

```ts
const { available } = await client.account.usernameAvailability({
  name: "alice",
});
if (available) {
  await client.account.register({
    name: "alice",
    email: "alice@example.com",
    password,
  });
}

const me = await client.account.me();
await client.account.changePassword({ current_password, new_password });
```

`login` starts a session and keeps it on the client, so later calls use it
instead of an API key until `logout`. In Node.js the client keeps the session
cookie and its CSRF token itself; in a browser the browser keeps the cookie,
a client without an API key sends requests with `credentials: "include"`, and
the service must allow the page's origin.

```ts
const client = new GrepvineClient({ endpoint: "https://grepvine.example.com" });
await client.account.login({ identifier: "alice", password });
const key = await client.apiKeys.create({ name: "laptop" });
await client.account.logout();
```

Without a session, `logout` revokes the API key the client uses.

## Device login

A device such as a command-line tool or an agent can get an API key of its
own by having a person approve it. `authorize` starts a login, reports the
code to show through `onCode`, and polls at the service's interval, slowing
down when the service asks, until the key is issued:

```ts
const device = new GrepvineClient(); // no API key needed to start a login
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
also available one at a time: `start({ api_key_name })`, then
`poll({ device_code })` until it returns the key; until then it throws
`InvalidRequestError` with code `"authorization_pending"` or `"slow_down"`.
The person approving uses a client with a session or an API key:

```ts
await approver.deviceLogin.approve({ user_code: "ABCD-EFGH" }); // or deny(...)
```

## Limits worth knowing

- One document: at most 1 GiB, and a single upload must finish within the
  service's request deadline of 35 seconds.
- One batch: at most 2,048 documents and 16 MiB of text.
- Keys: 1 to 1,024 characters. Organization and index names: letters, digits,
  and hyphens, starting with a letter. A name keeps the case it was created
  with, and any spelling that differs only in case refers to the same
  organization or index.
- `lines_before` and `lines_after`: at most 20 each.
- Tags: at most 64 per index. A key is 1 to 128 characters without whitespace
  or control characters; a value is at most 1,024 characters without control
  characters.

## Reference

The reference is organized by resource: {@link GrepvineClient},
{@link paginate} and {@link RetryPolicy} under _Client_, then
{@link Organizations} and {@link Members}, {@link Indexes},
{@link Documents}, {@link Search}, {@link ApiKeys}, {@link Account} and
{@link DeviceLogin}, each with the request and response types of its
methods. The _Errors_ start at {@link GrepvineError}, and the _Models_ are
the types the API sends and receives, such as {@link Index} and
{@link QueryResult}.

## License

Proprietary. See `LICENSE`.
