import { randomUUID } from "node:crypto";
import { GrepvineClient } from "@grepvine/sdk";

const apiKey = process.env.GREPVINE_API_KEY;
const organization = process.env.GREPVINE_ORGANIZATION;
if (!apiKey || !organization)
  throw new Error("Set GREPVINE_API_KEY and GREPVINE_ORGANIZATION");

const client = new GrepvineClient({
  apiKey,
  baseUrl: process.env.GREPVINE_API_ENDPOINT,
});
const ref = `${organization}/convenience-ts-${randomUUID().slice(0, 8)}`;
const index = await client.indexes.create(ref);
console.log(`Created index ${ref}`);
try {
  await index.waitReady();
  await index.documents.put(
    "docs/welcome.txt",
    "hello from the TypeScript SDK\n",
    { metadata: { kind: "guide" } },
  );
  await index.documents.putMany([
    {
      key: "docs/reference.txt",
      content: "hello reference\n",
      metadata: { kind: "guide" },
    },
    {
      key: "notes/todo.txt",
      content: "hello note\n",
      metadata: { kind: "note" },
    },
  ]);
  const hits = [];
  for await (const hit of index.search("hello", { literal: true, amount: 1 }))
    hits.push(hit);
  const filtered = [];
  for await (const hit of index.search("hello", {
    literal: true,
    filter: "kind = 'guide'",
    amount: 1,
  }))
    filtered.push(hit);
  for (const hit of hits)
    console.log(`  ${hit.key}:${hit.line_number}: ${hit.text.trimEnd()}`);
  console.log(
    `Found ${hits.length} matches and ${filtered.length} filtered matches`,
  );
  if (hits.length !== 3 || filtered.length !== 2)
    throw new Error("Unexpected search results");
} finally {
  await index.delete();
  console.log(`Deletion requested for ${ref}`);
}
