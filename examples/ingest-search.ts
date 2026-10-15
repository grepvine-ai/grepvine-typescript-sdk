/**
 * Store documents, search them with and without a metadata filter, and clean
 * up the demo index. Run with Node.js 22.18+ after building the SDK.
 *
 * Reads the API key from GREPVINE_API_KEY and, for a service other than the
 * default, the endpoint from GREPVINE_API_ENDPOINT.
 */
import { randomUUID } from "node:crypto";
import { GrepvineClient, type Index } from "@grepvine/sdk";

async function count(index: Index, filter?: string): Promise<number> {
  let matches = 0;
  // A page size of 1 shows the paginator fetching page after page.
  for await (const result of index.search("hello", {
    regex: false,
    filter,
    pageSize: 1,
  })) {
    console.log(`  ${result.key}:${result.line_number}: ${result.text}`);
    matches++;
  }
  return matches;
}

async function main() {
  const organization = process.env.GREPVINE_ORGANIZATION;
  if (!organization) throw new Error("Set GREPVINE_ORGANIZATION");
  const keepIndex = process.argv.includes("--keep-index");

  const apiKey = process.env.GREPVINE_API_KEY;
  if (!apiKey) throw new Error("Set GREPVINE_API_KEY");
  const client = new GrepvineClient({
    apiKey,
    endpoint: process.env.GREPVINE_API_ENDPOINT,
  });
  const index = await client.indexes.create(
    `${organization}/example-ts-${randomUUID().slice(0, 8)}`,
    {
      description: "Documents stored by the TypeScript SDK example.",
      wait: true,
    },
  );
  console.log(`Created index ${index.ref}`);
  try {
    // One document on its own; binary content and files are stored this way too.
    await index.documents.put(
      "docs/welcome.txt",
      "hello from the TypeScript SDK\n",
      {
        metadata: { kind: "guide" },
      },
    );

    // Several documents at once: text travels in batches, with one result each.
    const results = await index.documents.put([
      {
        key: "docs/reference.txt",
        content: "hello from the reference guide\n",
        metadata: { kind: "guide" },
      },
      {
        key: "notes/todo.txt",
        content: "hello from a personal note\n",
        metadata: { kind: "note" },
      },
    ]);
    for (const result of results) {
      if (!result.ok)
        throw new Error(`${result.key} was not stored: ${result.error}`);
    }
    console.log(`Stored ${1 + results.length} documents`);

    console.log('Search: literal "hello"');
    const matches = await count(index);
    console.log(`Found ${matches} matches`);
    console.log("Search: literal \"hello\", filtered by kind = 'guide'");
    const filtered = await count(index, "kind = 'guide'");
    console.log(`Found ${filtered} filtered matches`);
    if (matches !== 3 || filtered !== 2) {
      throw new Error(
        `Expected 3 matches and 2 filtered matches, got ${matches} and ${filtered}`,
      );
    }
  } finally {
    if (keepIndex) {
      console.log(`Kept index ${index.ref}`);
    } else {
      await index.delete();
      console.log(`Deletion requested for ${index.ref}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
