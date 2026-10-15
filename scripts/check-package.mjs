import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "grepvine-sdk-npm-"));
try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", directory], {
      encoding: "utf8",
    }),
  )[0];
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      directory,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      join(directory, packed.filename),
    ],
    { stdio: "inherit" },
  );
  const script = join(directory, "check.mjs");
  writeFileSync(
    script,
    `
import assert from "node:assert/strict";
import * as sdk from "@grepvine/sdk";
import { GrepvineClient, NotFoundError, PartialBatchError, RetryPolicy, paginate } from "@grepvine/sdk";

for (const name of ["createClient", "createConfig", "client", "putObjects", "queryIndex", "listOrganizations"]) {
  assert.equal(name in sdk, false, name + " must not be exported");
}

const client = new GrepvineClient({
  apiKey: "gvk",
  endpoint: "http://grepvine.test",
  retry: new RetryPolicy({ backoff: [1] }),
  fetch: async (request, init) => {
    request = new Request(request, init);
    assert.equal(request.headers.get("Authorization"), "Bearer gvk");
    assert.equal(request.headers.get("Cookie"), null);
    const url = new URL(request.url);
    if (url.pathname === "/v1/organizations/acme/indexes/docs") {
      return Response.json({ id: "i", organization: "acme", name: "docs", canonical_id: "i", description: "", tags: {}, state: "ready", document_count: 0, content_bytes: 0, created_at: "2026-01-01T00:00:00Z" });
    }
    if (url.pathname.endsWith("objects:batch")) {
      assert.equal(request.headers.get("Content-Type"), "application/x-ndjson");
      assert.match(request.headers.get("Idempotency-Key"), /^[0-9a-f]{32}$/);
      const record = JSON.parse((await request.text()).trim());
      assert.deepEqual(record.metadata.kind, { type: "string", value: "guide" });
      assert.deepEqual(record.metadata.path, { type: "string", value: "a" });
      return Response.json({ results: [{ key: "a", revision: "r1" }] });
    }
    if (url.pathname.endsWith("/query")) {
      assert.deepEqual(await request.json(), { pattern: "hello" });
      if (!url.searchParams.get("page")) {
        return Response.json({ results: [], pagination: { has_next: true, next_page_id: "p2" } });
      }
      return Response.json({ results: [{ key: "a", revision: "r1", line_number: 1, last_line_number: 1, line_start_offset: 0, line_end_offset: 5, text_start_offset: 0, text_line_number: 1, text: "hello", matches: [{ offset: 0, length: 5 }], text_truncated: false, matches_truncated: false }], pagination: { has_next: false, next_page_id: "" } });
    }
    return Response.json({ code: "not_found", reason: "resource", error: "missing" }, { status: 404, headers: { "X-Request-ID": "req-1" } });
  },
});
const where = { organization: "acme", index: "docs" };
const index = await client.indexes.waitUntilReady(where);
assert.equal(index.state, "ready");
const [stored] = await client.documents.putMany({ ...where, documents: [{ key: "a", content: "hello", metadata: { kind: "guide" } }] });
assert.equal(stored.revision, "r1");
const hits = [];
for await (const hit of paginate(client.search.query, { ...where, pattern: "hello" })) hits.push(hit.text);
assert.deepEqual(hits, ["hello"]);
const error = await client.organizations.get({ organization: "none" }).catch((e) => e);
assert.ok(error instanceof NotFoundError);
assert.equal(error.requestId, "req-1");
assert.equal(typeof PartialBatchError, "function");
assert.equal(typeof client.deviceLogin.authorize, "function");
console.log("Installed npm package requests passed");
`,
  );
  execFileSync(process.execPath, [script], {
    cwd: directory,
    stdio: "inherit",
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
