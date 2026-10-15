import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { GrepvineClient, NotFoundError, paginate } from "../src/index.js";

const endpoint = process.env.GREPVINE_SDK_TEST_ENDPOINT;
const apiKey = process.env.GREPVINE_SDK_TEST_API_KEY;
const organization = process.env.GREPVINE_SDK_TEST_ORGANIZATION ?? "";

const collect = async <T>(items: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
};

it.skipIf(!endpoint || !apiKey || !organization)(
  "stores, reads, lists and searches documents against a live service",
  async () => {
    const client = new GrepvineClient({ endpoint, apiKey });
    const index = `sdk-ts-${randomUUID().slice(0, 8)}`;
    const where = { organization, index };
    await client.indexes.create({
      organization,
      name: index,
      tags: { suite: "live" },
    });
    try {
      await client.indexes.waitUntilReady(where);
      const results = await client.documents.putMany({
        ...where,
        documents: [
          {
            key: "sdk/a.txt",
            content: "hello world",
            metadata: { flag: true },
          },
          {
            key: "sdk/b.txt",
            content: "hello again",
            metadata: { kind: "guide" },
          },
          { key: "sdk/c.bin", content: new Uint8Array([0xff, 0x00]) },
        ],
      });
      expect(results.every((result) => result.revision && !result.error)).toBe(
        true,
      );

      const head = await client.documents.get(
        { ...where, key: "sdk/a.txt", Range: "bytes=0-4" },
        { parseAs: "text" },
      );
      expect(head).toBe("hello");

      const listed = await collect(
        paginate(client.documents.list, {
          ...where,
          prefix: "sdk/",
          amount: 1,
        }),
      );
      expect(listed.map((doc) => doc.key)).toHaveLength(3);

      const hits = await collect(
        paginate(client.search.query, {
          ...where,
          pattern: "hello",
          mode: "literal",
        }),
      );
      expect(hits.map((hit) => hit.key).sort()).toEqual([
        "sdk/a.txt",
        "sdk/b.txt",
      ]);
      const flagged = await collect(
        paginate(client.search.query, {
          ...where,
          pattern: "hello",
          filter: "flag = true",
        }),
      );
      expect(flagged.map((hit) => hit.key)).toEqual(["sdk/a.txt"]);

      await expect(
        client.documents.get({ ...where, key: "missing" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      const deleted = await client.documents.deleteBatch({
        ...where,
        objects: [{ key: "sdk/b.txt" }, { key: "missing" }],
      });
      expect(deleted.results.map((result) => !result.error)).toEqual([
        true,
        false,
      ]);
    } finally {
      await client.indexes.delete(where);
    }
  },
  60_000,
);
