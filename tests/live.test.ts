import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  createGrepvineClient,
  GrepvineClient,
  createIndex,
  deleteIndex,
  getIndex,
  putDocument,
  putObjects,
  getDocument,
  listDocuments,
  queryIndex,
} from "../src/index.js";

const baseUrl = process.env.GREPVINE_SDK_TEST_ENDPOINT;
const apiKey = process.env.GREPVINE_SDK_TEST_API_KEY;
const organization = process.env.GREPVINE_SDK_TEST_ORGANIZATION;

it.skipIf(!baseUrl || !apiKey || !organization)(
  "uploads, reads, lists, and searches against a live service",
  async () => {
    const client = createGrepvineClient({ baseUrl, apiKey });
    const index = "sdk-ts-" + randomUUID().slice(0, 8);
    const path = { organization: organization!, index };
    const created = await createIndex({
      client,
      path: { organization: organization! },
      body: { name: index },
    });
    expect(created.response?.status).toBe(201);
    try {
      const deadline = Date.now() + 30_000;
      while ((await getIndex({ client, path })).data?.state !== "ready") {
        if (Date.now() > deadline)
          throw new Error("Index did not become ready");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const key = "sdk/café %.txt";
      const uploaded = await putDocument({
        client,
        path,
        headers: { "Idempotency-Key": randomUUID() },
        body: {
          key,
          content: new Blob(["hello world"]),
          metadata: JSON.stringify({ flag: { type: "boolean", value: true } }),
        },
      });
      expect(uploaded.data?.revision).toBeTruthy();
      const batch = await putObjects({
        client,
        path,
        headers: { "Idempotency-Key": randomUUID() },
        body: '{"key":"sdk/b.txt","content":"hello again"}\n{"key":"sdk/c.txt","content":"hello third"}\n',
      });
      expect(batch.data?.results).toHaveLength(2);
      expect(
        batch.data?.results.every((result) => result.revision && !result.error),
      ).toBe(true);
      const downloaded = await getDocument({
        client,
        path: { ...path, key },
        headers: { Range: "bytes=0-4" },
      });
      expect(downloaded.response?.status).toBe(206);
      expect(await downloaded.data?.text()).toBe("hello");
      expect(downloaded.response?.headers.get("ETag")).toBe(
        uploaded.data?.revision,
      );
      const listed = await listDocuments({
        client,
        path,
        query: { prefix: "sdk/", amount: 1 },
      });
      expect(listed.data?.results).toHaveLength(1);
      expect(listed.data?.pagination.has_next).toBe(true);
      const continued = await listDocuments({
        client,
        path,
        query: {
          prefix: "sdk/",
          amount: 1,
          page: listed.data!.pagination.next_page_id,
        },
      });
      expect(continued.data?.results[0].key).not.toBe(
        listed.data?.results[0].key,
      );
      const searched = await queryIndex({
        client,
        path,
        query: { amount: 1 },
        body: { pattern: "hello", mode: "literal" },
      });
      expect(searched.data?.results).toHaveLength(1);
      expect(searched.data?.pagination.has_next).toBe(true);
      const next = await queryIndex({
        client,
        path,
        query: { amount: 1, page: searched.data!.pagination.next_page_id },
        body: { pattern: "hello", mode: "literal" },
      });
      expect(next.data?.results[0].key).not.toBe(searched.data?.results[0].key);
      const filtered = await queryIndex({
        client,
        path,
        body: { pattern: "hello", filter: "flag = true" },
      });
      expect(filtered.data?.results.map((result) => result.key)).toEqual([key]);
      const missing = await getDocument({
        client,
        path: { ...path, key: "missing" },
      });
      expect(missing.response?.status).toBe(404);
      expect(missing.error?.code).toBe("not_found");
    } finally {
      expect((await deleteIndex({ client, path })).response?.status).toBe(202);
    }
  },
  60_000,
);

it.skipIf(!baseUrl || !apiKey || !organization)(
  "convenience uploads and async search against a live service",
  async () => {
    const client = new GrepvineClient({ apiKey: apiKey!, baseUrl });
    const index = await client.indexes.create(
      organization! + "/sdk-convenience-" + randomUUID().slice(0, 8),
    );
    try {
      await index.waitReady();
      await index.documents.put("a", "hello one", {
        metadata: { kind: "guide" },
      });
      await index.documents.putMany([
        { key: "b", content: "hello two", metadata: { kind: "guide" } },
        { key: "c", content: "hello three", metadata: { kind: "note" } },
      ]);
      const hits = [];
      for await (const hit of index.search("hello", {
        literal: true,
        amount: 1,
      }))
        hits.push(hit.key);
      expect(hits.sort()).toEqual(["a", "b", "c"]);
      const filtered = [];
      for await (const hit of index.search("hello", {
        filter: "kind = 'guide'",
        amount: 1,
      }))
        filtered.push(hit.key);
      expect(filtered.sort()).toEqual(["a", "b"]);
    } finally {
      await index.delete();
    }
  },
  60_000,
);
