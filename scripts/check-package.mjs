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
import { createGrepvineClient, queryIndex, putObjects } from "@grepvine/sdk";
import * as sdk from "@grepvine/sdk";
for (const operation of ["registerUser", "getUsernameAvailability", "login", "logout", "getCurrentUser", "changePassword", "startDeviceAuthorization", "approveDeviceAuthorization", "denyDeviceAuthorization", "pollDeviceToken", "listApiKeys", "createApiKey", "revokeApiKey", "listOrganizations", "createOrganization", "getOrganization", "deleteOrganization", "listOrganizationMembers", "addOrganizationMember", "updateOrganizationMember", "removeOrganizationMember", "transferOrganizationOwnership", "listIndexes", "createIndex", "getIndex", "updateIndex", "deleteIndex", "listDocuments", "putDocument", "getDocument", "deleteDocument", "putObjects", "deleteObjects", "queryIndex"]) {
  assert.equal(typeof sdk[operation], "function");
}
assert.equal(typeof sdk.startDeviceAuthorization, "function");
assert.equal(typeof sdk.pollDeviceToken, "function");
let captured;
const client = createGrepvineClient({ apiKey: "gvk", fetch: async (request) => {
  captured = request;
  return Response.json({ results: [], pagination: { has_next: false, next_page_id: "" } });
}});
assert.equal((await queryIndex({ client, path: { organization: "acme", index: "notes" }, body: { pattern: "hello" } })).data.pagination.has_next, false);
assert.equal(captured.headers.get("Authorization"), "Bearer gvk");
assert.equal(captured.headers.get("Cookie"), null);
await putObjects({ client, path: { organization: "acme", index: "notes" }, body: '{"key":"a","content":"hello"}\\n', headers: { "Idempotency-Key": "stable-operation-123" } });
assert.equal(await captured.text(), '{"key":"a","content":"hello"}\\n');
const convenience = new sdk.GrepvineClient({ apiKey: "gvk", fetch: async (request) => {
  assert.equal(request.headers.get("Authorization"), "Bearer gvk");
  if (request.url.endsWith("objects:batch")) {
    const record = JSON.parse((await request.text()).trim());
    assert.deepEqual(record.metadata.kind, { type: "string", value: "guide" });
    return Response.json({ results: [{ key: "a", revision: "r1" }] });
  }
  return Response.json({ results: [], pagination: { has_next: false, next_page_id: "" } });
}});
const index = convenience.indexes.get("acme/docs");
assert.equal((await index.documents.putMany([{ key: "a", content: "hello", metadata: { kind: "guide" } }]))[0].revision, "r1");
const hits = [];
for await (const hit of index.search("hello")) hits.push(hit);
assert.deepEqual(hits, []);
console.log("Installed npm raw and convenience requests passed");
`,
  );
  execFileSync(process.execPath, [script], {
    cwd: directory,
    stdio: "inherit",
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
