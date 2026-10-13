/**
 * Ingest documents, search with a metadata filter, and clean up the demo index.
 * Run with Node.js 22.18+ after building the SDK.
 */
import { randomUUID } from "node:crypto";
import {
  createGrepvineClient,
  createIndex,
  deleteIndex,
  getIndex,
  putDocument,
  putObjects,
  queryIndex,
  type Client,
  type QueryRequest,
} from "@grepvine/sdk";

function result<T>(response: {
  data?: T;
  error?: unknown;
  response?: Response;
}): T {
  if (!response.response?.ok || response.data === undefined) {
    throw new Error(
      `HTTP ${response.response?.status ?? "unavailable"}: ${JSON.stringify(response.error)}`,
    );
  }
  return response.data;
}

async function search(
  client: Client,
  path: { organization: string; index: string },
  filter?: string,
) {
  const body: QueryRequest = {
    pattern: "hello",
    mode: "literal",
    ...(filter ? { filter } : {}),
  };
  let count = 0;
  let token: string | undefined;
  // Keep the request unchanged and follow continuation tokens until has_next is false.
  while (true) {
    const response = result(
      await queryIndex({
        client,
        path,
        body,
        query: { amount: 1, ...(token ? { page: token } : {}) },
      }),
    );
    for (const hit of response.results) {
      console.log(`  ${hit.key}:${hit.line_number}: ${hit.text.trimEnd()}`);
      count++;
    }
    if (!response.pagination.has_next) return count;
    token = response.pagination.next_page_id;
  }
}

async function main() {
  const apiKey = process.env.GREPVINE_API_KEY;
  const organization = process.env.GREPVINE_ORGANIZATION;
  if (!apiKey || !organization) {
    throw new Error("Set GREPVINE_API_KEY and GREPVINE_ORGANIZATION");
  }
  const keepIndex = process.argv.includes("--keep-index");
  const endpoint = (
    process.env.GREPVINE_API_ENDPOINT ?? "https://api.grepvine.ai"
  ).replace(/\/+$/, "");
  const baseUrl = endpoint.endsWith("/v1") ? endpoint : endpoint + "/v1";
  const client = createGrepvineClient({ apiKey, baseUrl });
  const path = {
    organization,
    index: "example-ts-" + randomUUID().slice(0, 8),
  };
  result(
    await createIndex({
      client,
      path: { organization },
      body: { name: path.index },
    }),
  );
  console.log(`Created index ${organization}/${path.index}`);
  try {
    const deadline = Date.now() + 30_000;
    while (result(await getIndex({ client, path })).state !== "ready") {
      if (Date.now() >= deadline)
        throw new Error(
          "The demo index did not become ready within 30 seconds",
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // A single document uses multipart content and JSON-encoded typed metadata.
    const single = result(
      await putDocument({
        client,
        path,
        headers: { "Idempotency-Key": randomUUID() },
        body: {
          key: "docs/welcome.txt",
          content: new Blob(["hello from the TypeScript SDK\n"]),
          metadata: JSON.stringify({
            kind: { type: "string", value: "guide" },
          }),
        },
      }),
    );
    if (single.error || !single.revision)
      throw new Error(`Document was not stored: ${JSON.stringify(single)}`);

    // Batch ingestion sends one JSON record per line as raw UTF-8 NDJSON.
    const records = [
      {
        key: "docs/reference.txt",
        content: "hello from the reference guide\n",
        metadata: { kind: { type: "string", value: "guide" } },
      },
      {
        key: "notes/todo.txt",
        content: "hello from a personal note\n",
        metadata: { kind: { type: "string", value: "note" } },
      },
    ];
    const batch = result(
      await putObjects({
        client,
        path,
        headers: { "Idempotency-Key": randomUUID() },
        body: records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      }),
    );
    // A successful HTTP response can still contain failed individual documents.
    for (const item of batch.results) {
      if (item.error || !item.revision)
        throw new Error(`Document was not stored: ${JSON.stringify(item)}`);
    }
    console.log(`Ingested ${1 + batch.results.length} documents`);

    console.log('Search: literal "hello"');
    const matches = await search(client, path);
    console.log(`Found ${matches} matches`);
    console.log("Search: literal \"hello\", filtered by kind = 'guide'");
    const filtered = await search(client, path, "kind = 'guide'");
    console.log(`Found ${filtered} filtered matches`);
    if (matches !== 3 || filtered !== 2) {
      throw new Error(
        `Expected 3 matches and 2 filtered matches, got ${matches} and ${filtered}`,
      );
    }
  } finally {
    if (keepIndex) {
      console.log(`Kept index ${organization}/${path.index}`);
    } else {
      const deleted = await deleteIndex({ client, path });
      if (deleted.response?.status !== 202)
        throw new Error(
          `Could not delete demo index: ${JSON.stringify(deleted.error)}`,
        );
      console.log(`Deletion requested for ${organization}/${path.index}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
