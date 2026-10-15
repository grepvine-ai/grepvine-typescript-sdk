import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MutationResult,
  NotFoundError,
  PartialBatchError,
  PreconditionFailedError,
  RangeNotSatisfiableError,
  ServerError,
} from "../src/index.js";
import { collect, setup } from "./helpers.js";

async function withIndex() {
  const context = setup();
  context.fake.addIndex("acme/docs");
  const index = await context.client.indexes.get("acme/docs");
  context.fake.log.length = 0;
  return { ...context, documents: index.documents };
}

const stored = (fake: ReturnType<typeof setup>["fake"], key: string) =>
  fake.indexes.get("acme/docs")!.documents.get(key);

describe("documents.put", () => {
  it("uploads bytes as multipart with path and size metadata", async () => {
    const { fake, documents } = await withIndex();
    const result = await documents.put(
      "notes/today.md",
      new Uint8Array([35, 32, 84]),
    );
    expect(result).toBeInstanceOf(MutationResult);
    expect(result.ok).toBe(true);
    expect(result.revision).toMatch(/^rev-/);
    const request = fake.log[0];
    expect(request.method).toBe("PUT");
    expect(request.form!.get("key")).toBe("notes/today.md");
    expect(JSON.parse(String(request.form!.get("metadata")))).toEqual({
      path: { type: "string", value: "notes/today.md" },
      size: { type: "integer", value: 3 },
    });
    expect(request.headers.get("idempotency-key")).toMatch(/^[0-9a-f]{32}$/);
    expect(stored(fake, "notes/today.md")!.content).toEqual(
      new Uint8Array([35, 32, 84]),
    );
  });

  it("stores text, ArrayBuffer and Blob content with user metadata", async () => {
    const { fake, documents } = await withIndex();
    const when = new Date("2026-09-01T10:00:00Z");
    await documents.put("a.txt", "héllo", {
      metadata: {
        team: "sales",
        words: 1,
        ratio: 0.5,
        draft: false,
        when,
        size: 99,
      },
    });
    const metadata = JSON.parse(String(fake.log[0].form!.get("metadata")));
    expect(metadata).toEqual({
      path: { type: "string", value: "a.txt" },
      size: { type: "integer", value: 99 },
      team: { type: "string", value: "sales" },
      words: { type: "integer", value: 1 },
      ratio: { type: "number", value: 0.5 },
      draft: { type: "boolean", value: false },
      when: { type: "timestamp", value: "2026-09-01T10:00:00.000Z" },
    });
    await documents.put("b.bin", new Uint8Array([1, 2]).buffer);
    await documents.put("c.bin", new Blob(["xyz"]));
    expect(stored(fake, "b.bin")!.content).toEqual(new Uint8Array([1, 2]));
    expect(new TextDecoder().decode(stored(fake, "c.bin")!.content)).toBe(
      "xyz",
    );
  });

  it("uploads a file: URL and records its mtime", async () => {
    const { fake, documents } = await withIndex();
    const directory = mkdtempSync(join(tmpdir(), "grepvine-test-"));
    try {
      const file = join(directory, "report.txt");
      writeFileSync(file, "report body");
      utimesSync(
        file,
        new Date("2026-01-02T03:04:05Z"),
        new Date("2026-01-02T03:04:05Z"),
      );
      await documents.put("report.txt", pathToFileURL(file));
      const metadata = JSON.parse(String(fake.log[0].form!.get("metadata")));
      expect(metadata.size).toEqual({ type: "integer", value: 11 });
      expect(metadata.mtime).toEqual({
        type: "timestamp",
        value: "2026-01-02T03:04:05.000Z",
      });
      expect(
        new TextDecoder().decode(stored(fake, "report.txt")!.content),
      ).toBe("report body");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects unusable content and metadata before the network", async () => {
    const { fake, documents } = await withIndex();
    await expect(documents.put("a", 5 as never)).rejects.toThrow(TypeError);
    await expect(
      documents.put("a", new URL("https://example.com/x")),
    ).rejects.toThrow("file: URL");
    await expect(
      documents.put("a", "x", { metadata: { n: Number.NaN } }),
    ).rejects.toThrow("finite");
    await expect(
      documents.put("a", "x", { metadata: { n: 2 ** 60 } }),
    ).rejects.toThrow("safe");
    await expect(
      documents.put("a", "x", { metadata: { n: {} as never } }),
    ).rejects.toThrow("tagged");
    await expect(documents.put("", "x")).rejects.toThrow("key");
    await expect(
      documents.put("a", "x", { idempotencyKey: "short" }),
    ).rejects.toThrow("16 to 128");
    await expect(
      documents.put("a", "x", { ifMatch: "r", ifNoneMatch: true }),
    ).rejects.toThrow("cannot be combined");
    const many = Object.fromEntries(
      Array.from({ length: 63 }, (_, i) => [`f${i}`, i]),
    );
    await expect(documents.put("a", "x", { metadata: many })).rejects.toThrow(
      "at most 64",
    );
    expect(fake.log).toHaveLength(0);
  });

  it("sends preconditions and throws PreconditionFailedError", async () => {
    const { fake, documents } = await withIndex();
    const first = await documents.put("a.txt", "one", { ifNoneMatch: true });
    expect(fake.log[0].headers.get("if-none-match")).toBe("*");
    await expect(
      documents.put("a.txt", "two", { ifNoneMatch: true }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    const second = await documents.put("a.txt", "two", {
      ifMatch: first.revision,
    });
    expect(fake.log.at(-1)!.headers.get("if-match")).toBe(first.revision);
    expect(second.revision).not.toBe(first.revision);
    await expect(
      documents.put("a.txt", "three", { ifMatch: first.revision }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  it("uses a given idempotency key", async () => {
    const { fake, documents } = await withIndex();
    await documents.put("a.txt", "one", {
      idempotencyKey: "my-key-0123456789",
    });
    expect(fake.log[0].headers.get("idempotency-key")).toBe(
      "my-key-0123456789",
    );
  });

  it("batches text and uploads binary documents alone, in order", async () => {
    const { fake, documents } = await withIndex();
    const results = await documents.put([
      { key: "a.txt", content: "alpha" },
      {
        key: "b.txt",
        content: new TextEncoder().encode("beta"),
        metadata: { lang: "el" },
      },
      { key: "c.bin", content: new Uint8Array([0xff, 0xfe]) },
      { key: "d.blob", content: new Blob(["blob"]) },
      { key: "e.txt", content: "epsilon" },
    ]);
    expect(results.map((r) => r.key)).toEqual([
      "a.txt",
      "b.txt",
      "c.bin",
      "d.blob",
      "e.txt",
    ]);
    expect(results.every((r) => r.ok && r.revision)).toBe(true);
    expect(
      fake.log.map((r) => `${r.method} ${r.path.split("/").pop()}`),
    ).toEqual([
      "POST objects:batch",
      "PUT objects",
      "PUT objects",
      "POST objects:batch",
    ]);
    expect(fake.log[0].headers.get("content-type")).toBe(
      "application/x-ndjson",
    );
    const lines = fake.log[0].body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      {
        key: "a.txt",
        content: "alpha",
        metadata: {
          path: { type: "string", value: "a.txt" },
          size: { type: "integer", value: 5 },
        },
      },
      {
        key: "b.txt",
        content: "beta",
        metadata: {
          path: { type: "string", value: "b.txt" },
          size: { type: "integer", value: 4 },
          lang: { type: "string", value: "el" },
        },
      },
    ]);
  });

  it("carries preconditions inside the records", async () => {
    const { fake, documents } = await withIndex();
    const existing = fake.addDocument("acme/docs", "b.txt", "old");
    await documents.put([
      { key: "a.txt", content: "alpha", ifNoneMatch: true },
      { key: "b.txt", content: "beta", ifMatch: existing.revision },
    ]);
    const lines = fake.log[0].body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0].if_none_match).toBe("*");
    expect(lines[1].if_match).toBe(existing.revision);
  });

  it("reports each document that was left unchanged", async () => {
    const { fake, documents } = await withIndex();
    fake.addDocument("acme/docs", "a.txt", "old");
    fake.addDocument("acme/docs", "c.bin", new Uint8Array([0xff]));
    const results = await documents.put([
      { key: "a.txt", content: "alpha", ifNoneMatch: true },
      { key: "b.txt", content: "beta" },
      { key: "c.bin", content: new Uint8Array([0xfe]), ifNoneMatch: true },
    ]);
    expect(results.map((r) => r.ok)).toEqual([false, true, false]);
    expect(results[0].revision).toBeUndefined();
    expect(results[0].error!.code).toBe("precondition_failed");
    expect(results[2].error!.code).toBe("precondition_failed");
    expect(String(results[0].error)).toContain("precondition_failed");
  });

  it("sends nothing for an empty array", async () => {
    const { fake, documents } = await withIndex();
    expect(await documents.put([])).toEqual([]);
    expect(fake.log).toHaveLength(0);
  });

  it("splits batches by record count", async () => {
    const { fake, documents } = await withIndex();
    const records = Array.from({ length: 2049 }, (_, i) => ({
      key: `k${i}`,
      content: "x",
    }));
    const results = await documents.put(records, {
      idempotencyKey: "batch-key-0123456789",
    });
    expect(results).toHaveLength(2049);
    expect(fake.log.map((r) => r.body.trim().split("\n").length)).toEqual([
      2048, 1,
    ]);
    expect(fake.log.map((r) => r.headers.get("idempotency-key"))).toEqual([
      "batch-key-0123456789-0",
      "batch-key-0123456789-1",
    ]);
  });

  it("splits batches by content bytes", async () => {
    const { fake, documents } = await withIndex();
    const big = "x".repeat(6 * 1024 * 1024);
    await documents.put([
      { key: "a", content: big },
      { key: "b", content: big },
      { key: "c", content: big },
    ]);
    expect(fake.log.map((r) => r.body.trim().split("\n").length)).toEqual([
      2, 1,
    ]);
  });

  it("throws PartialBatchError when a later request fails", async () => {
    const { fake, documents } = await withIndex();
    fake.addDocument("acme/docs", "a0", "old");
    const records = [
      ...Array.from({ length: 2048 }, (_, i) => ({
        key: `a${i}`,
        content: "x",
        ifNoneMatch: true,
      })),
      { key: "b", content: "x" },
      { key: "c", content: new Uint8Array([0xff]) },
    ];
    let calls = 0;
    const original = fake.handle.bind(fake);
    fake.handle = async (request) => {
      if (++calls >= 2) {
        return Response.json(
          { code: "internal_error", reason: "server", error: "failed" },
          { status: 500 },
        );
      }
      return original(request);
    };
    const error = await documents.put(records).catch((e) => e);
    expect(error).toBeInstanceOf(PartialBatchError);
    expect(error.committed).toHaveLength(2048);
    expect(error.committed[0].ok).toBe(false);
    expect(error.failedKeys).toEqual(["b"]);
    expect(error.pendingKeys).toEqual(["c"]);
    expect(error.cause).toBeInstanceOf(ServerError);
    expect(error.message).toBe(
      "1 document(s) failed after 2047 were written, 1 were left unchanged, and 1 were not attempted: failed",
    );
  });

  it("throws the first failure unwrapped", async () => {
    const { fake, documents } = await withIndex();
    fake.failNext(500, { times: 3 });
    const error = await documents
      .put([{ key: "a", content: "x" }])
      .catch((e) => e);
    expect(error).toBeInstanceOf(ServerError);
  });

  it("validates records before the network", async () => {
    const { fake, documents } = await withIndex();
    await expect(documents.put([{ key: "", content: "x" }])).rejects.toThrow(
      "documents[0]",
    );
    await expect(documents.put([{ key: "a" } as never])).rejects.toThrow(
      "needs content",
    );
    await expect(
      documents.put([{ key: "a", content: "x", extra: 1 } as never]),
    ).rejects.toThrow("unknown field(s): extra");
    await expect(
      documents.put([
        { key: "a", content: "x", ifMatch: "r", ifNoneMatch: true },
      ]),
    ).rejects.toThrow("cannot be combined");
    await expect(
      documents.put([{ key: "a", content: "x" }], { idempotencyKey: "x" }),
    ).rejects.toThrow("16 to 128");
    expect(fake.log).toHaveLength(0);
  });
});

describe("documents.get and fetch", () => {
  it("returns bytes or text", async () => {
    const { fake, documents } = await withIndex();
    fake.addDocument("acme/docs", "notes/today.md", "# Today\n");
    expect(await documents.get("notes/today.md")).toEqual(
      new TextEncoder().encode("# Today\n"),
    );
    expect(await documents.get("notes/today.md", { mode: "text" })).toBe(
      "# Today\n",
    );
    expect(fake.log[0].path).toBe(
      "/organizations/acme/indexes/docs/objects/notes/today.md",
    );
    expect(fake.log[0].headers.get("accept")).toBe("application/octet-stream");
    await expect(documents.get("missing")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("returns the revision, metadata and range", async () => {
    const { fake, documents } = await withIndex();
    fake.quoteEtag = true;
    const added = fake.addDocument("acme/docs", "a.txt", "0123456789", {
      team: { type: "string", value: "sales" },
      when: { type: "timestamp", value: "2026-01-02T03:04:05Z" },
    });
    const document = await documents.fetch("a.txt");
    expect(document.revision).toBe(added.revision);
    expect(document.metadata).toEqual({
      team: "sales",
      when: new Date("2026-01-02T03:04:05Z"),
    });
    expect(document.size).toBe(10);
    expect(document.content_range).toBeUndefined();
    const head = await documents.fetch("a.txt", { range: [2, 4] });
    expect(fake.log.at(-1)!.headers.get("range")).toBe("bytes=2-4");
    expect(head.text()).toBe("234");
    expect(head.content_range).toEqual({ start: 2, end: 4, total: 10 });
    expect(head.size).toBe(10);
    expect(
      await documents.get("a.txt", { range: [undefined, 3], mode: "text" }),
    ).toBe("789");
    expect(fake.log.at(-1)!.headers.get("range")).toBe("bytes=-3");
    expect(await documents.get("a.txt", { range: [8], mode: "text" })).toBe(
      "89",
    );
    await expect(
      documents.get("a.txt", { range: [50] }),
    ).rejects.toBeInstanceOf(RangeNotSatisfiableError);
    await expect(documents.get("a.txt", { range: [5, 2] })).rejects.toThrow(
      "precede",
    );
  });
});

describe("documents.list", () => {
  it("lists documents and folds prefixes", async () => {
    const { fake, documents } = await withIndex();
    fake.addDocument("acme/docs", "notes/a.md", "a", {
      team: { type: "string", value: "x" },
    });
    fake.addDocument("acme/docs", "notes/sub/b.md", "bb");
    fake.addDocument("acme/docs", "top.bin", new Uint8Array([0xff]));
    const all = await collect(documents.list());
    expect(all.map((d) => [d.key, d.size, d.searchable])).toEqual([
      ["notes/a.md", 1, true],
      ["notes/sub/b.md", 2, true],
      ["top.bin", 1, false],
    ]);
    expect(all[0].metadata).toEqual({ team: "x" });
    const pages = await collect(
      documents.list({ prefix: "notes/", delimiter: "/" }).pages(),
    );
    expect(pages[0].results.map((d) => d.key)).toEqual(["notes/a.md"]);
    expect(pages[0].common_prefixes).toEqual(["notes/sub/"]);
    expect(fake.log.at(-1)!.query.get("prefix")).toBe("notes/");
    expect(fake.log.at(-1)!.query.get("delimiter")).toBe("/");
    expect(() => documents.list({ delimiter: "x".repeat(17) })).toThrow(
      "1 to 16",
    );
  });
});

describe("documents.delete", () => {
  it("deletes one document", async () => {
    const { fake, documents } = await withIndex();
    const added = fake.addDocument("acme/docs", "a.txt", "alpha");
    await expect(
      documents.delete("a.txt", { ifMatch: "rev-other" }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    const result = await documents.delete("a.txt", { ifMatch: added.revision });
    expect(result.ok).toBe(true);
    expect(fake.log.at(-1)!.headers.get("idempotency-key")).toMatch(
      /^[0-9a-f]{32}$/,
    );
    await expect(documents.delete("a.txt")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("deletes many and reports missing documents", async () => {
    const { fake, documents } = await withIndex();
    const b = fake.addDocument("acme/docs", "b.txt", "beta");
    fake.addDocument("acme/docs", "a.txt", "alpha");
    const results = await documents.delete([
      "a.txt",
      "gone.txt",
      { key: "b.txt", ifMatch: b.revision },
    ]);
    expect(results.map((r) => [r.key, r.ok, r.error?.code])).toEqual([
      ["a.txt", true, undefined],
      ["gone.txt", false, "not_found"],
      ["b.txt", true, undefined],
    ]);
    expect(JSON.parse(fake.log[0].body)).toEqual({
      objects: [
        { key: "a.txt" },
        { key: "gone.txt" },
        { key: "b.txt", if_match: b.revision },
      ],
    });
    expect(await documents.delete([])).toEqual([]);
  });

  it("throws PartialBatchError when a later chunk fails", async () => {
    const { fake, documents } = await withIndex();
    const keys = Array.from({ length: 2050 }, (_, i) => `k${i}`);
    let calls = 0;
    const original = fake.handle.bind(fake);
    fake.handle = async (request) =>
      ++calls >= 2
        ? Response.json(
            { code: "internal_error", reason: "server", error: "failed" },
            { status: 500 },
          )
        : original(request);
    const error = await documents
      .delete(keys, { idempotencyKey: "delete-key-0123456789" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(PartialBatchError);
    expect(error.committed).toHaveLength(2048);
    expect(error.failedKeys).toEqual(["k2048", "k2049"]);
    expect(error.pendingKeys).toEqual([]);
    expect(fake.log[0].headers.get("idempotency-key")).toBe(
      "delete-key-0123456789-0",
    );
  });

  it("validates input before the network", async () => {
    const { fake, documents } = await withIndex();
    await expect(documents.delete([""])).rejects.toThrow("keys[0]");
    await expect(
      documents.delete([{ key: "a", other: 1 } as never]),
    ).rejects.toThrow("unknown field(s)");
    await expect(documents.delete([5 as never])).rejects.toThrow("keys[0]");
    await expect(
      documents.delete(["a"], { ifMatch: "r" } as never),
    ).rejects.toThrow("inside each");
    expect(fake.log).toHaveLength(0);
  });
});
