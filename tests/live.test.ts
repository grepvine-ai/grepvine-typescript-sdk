import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { GrepvineClient, NotFoundError } from "../src/index.js";

const endpoint = process.env.GREPVINE_SDK_TEST_ENDPOINT;
const apiKey = process.env.GREPVINE_SDK_TEST_API_KEY;
const organization = process.env.GREPVINE_SDK_TEST_ORGANIZATION;

const collect = async <T>(items: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
};

it.skipIf(!endpoint || !apiKey || !organization)(
  "stores, reads, lists and searches documents against a live service",
  async () => {
    const client = new GrepvineClient({ endpoint, apiKey });
    const index = await client.indexes.create(
      `${organization}/sdk-ts-${randomUUID().slice(0, 8)}`,
      { tags: { suite: "live" }, wait: true },
    );
    try {
      const key = "sdk/café %.txt";
      const stored = await index.documents.put(key, new Blob(["hello world"]), {
        metadata: { flag: true },
      });
      expect(stored.revision).toBeTruthy();
      const batch = await index.documents.put([
        {
          key: "sdk/b.txt",
          content: "hello again",
          metadata: { kind: "guide" },
        },
        {
          key: "sdk/c.txt",
          content: "hello third",
          metadata: { kind: "note" },
        },
      ]);
      expect(batch.every((result) => result.ok && result.revision)).toBe(true);

      const head = await index.documents.fetch(key, { range: [0, 4] });
      expect(head.text()).toBe("hello");
      expect(head.revision).toBe(stored.revision);
      expect(head.content_range?.total).toBe(11);

      const pages = await collect(
        index.documents.list({ prefix: "sdk/", pageSize: 1 }).pages(),
      );
      expect(
        pages.flatMap((page) => page.results).map((doc) => doc.key),
      ).toHaveLength(3);

      const hits = await collect(
        index.search("hello", { regex: false, pageSize: 1 }),
      );
      expect(hits.map((hit) => hit.key).sort()).toEqual([
        key,
        "sdk/b.txt",
        "sdk/c.txt",
      ]);
      const flagged = await collect(
        index.search("hello", { filter: "flag = true" }),
      );
      expect(flagged.map((hit) => hit.key)).toEqual([key]);
      const guides = await collect(
        index.search("hello", {
          filters: ["path STARTSWITH 'sdk/'", "kind = 'guide'"],
        }),
      );
      expect(guides.map((hit) => hit.key)).toEqual(["sdk/b.txt"]);

      await expect(index.documents.get("missing")).rejects.toBeInstanceOf(
        NotFoundError,
      );
      const deleted = await index.documents.delete(["sdk/b.txt", "missing"]);
      expect(deleted.map((result) => result.ok)).toEqual([true, false]);
    } finally {
      await index.delete();
    }
  },
  60_000,
);
