/**
 * Store documents, search them with and without a metadata filter, and clean
 * up the demo index. Run with Node.js 22.18+ after building the SDK.
 *
 * Reads the API key from GREPVINE_API_KEY, the organization from
 * GREPVINE_ORGANIZATION and, for a service other than the default, the
 * endpoint from GREPVINE_API_ENDPOINT.
 */
import { randomUUID } from "node:crypto";
import { GrepvineClient, paginate } from "@grepvine/sdk";

async function main() {
  const organization = process.env.GREPVINE_ORGANIZATION;
  if (!organization) throw new Error("Set GREPVINE_ORGANIZATION");
  const apiKey = process.env.GREPVINE_API_KEY;
  if (!apiKey) throw new Error("Set GREPVINE_API_KEY");
  const keepIndex = process.argv.includes("--keep-index");

  const client = new GrepvineClient({
    apiKey,
    endpoint: process.env.GREPVINE_API_ENDPOINT,
  });
  const index = `example-ts-${randomUUID().slice(0, 8)}`;
  const where = { organization, index };
  await client.indexes.create({
    organization,
    name: index,
    description: "Documents stored by the TypeScript SDK example.",
  });
  await client.indexes.waitUntilReady(where);
  console.log(`Created index ${organization}/${index}`);

  async function count(filter?: string): Promise<number> {
    let matches = 0;
    // An amount of 1 shows paginate fetching page after page.
    for await (const hit of paginate(client.search.query, {
      ...where,
      pattern: "hello",
      mode: "literal",
      filter,
      amount: 1,
    })) {
      console.log(`  ${hit.key}:${hit.line_number}: ${hit.text}`);
      matches++;
    }
    return matches;
  }

  try {
    // Text travels in batches; binary content is stored one document at a time.
    const results = await client.documents.putMany({
      ...where,
      documents: [
        {
          key: "docs/welcome.txt",
          content: "hello from the TypeScript SDK\n",
          metadata: { kind: "guide" },
        },
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
      ],
    });
    for (const result of results) {
      if (result.error) {
        throw new Error(`${result.key} was not stored: ${result.error.error}`);
      }
    }
    console.log(`Stored ${results.length} documents`);

    console.log('Search: literal "hello"');
    const matches = await count();
    console.log(`Found ${matches} matches`);
    console.log("Search: literal \"hello\", filtered by kind = 'guide'");
    const filtered = await count("kind = 'guide'");
    console.log(`Found ${filtered} filtered matches`);
    if (matches !== 3 || filtered !== 2) {
      throw new Error(
        `Expected 3 matches and 2 filtered matches, got ${matches} and ${filtered}`,
      );
    }
  } finally {
    if (keepIndex) {
      console.log(`Kept index ${organization}/${index}`);
    } else {
      await client.indexes.delete(where);
      console.log(`Deletion requested for ${organization}/${index}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
