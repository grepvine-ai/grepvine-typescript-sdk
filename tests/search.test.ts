import { beforeEach, describe, expect, it } from "vitest";
import {
  type Index,
  InvalidPageError,
  InvalidRequestError,
  SearchResult,
} from "../src/index.js";
import { collect, setup, type FakeGrepvine } from "./helpers.js";

let fake: FakeGrepvine;
let index: Index;

beforeEach(async () => {
  const context = setup();
  fake = context.fake;
  fake.addIndex("acme/docs");
  fake.addDocument(
    "acme/docs",
    "a.txt",
    "hello world\nsecond line\nsay Hello again\n",
    {
      path: { type: "string", value: "a.txt" },
      kind: { type: "string", value: "guide" },
    },
  );
  fake.addDocument("acme/docs", "src/b.ts", "const café = 'hello'; // TODO\n", {
    path: { type: "string", value: "src/b.ts" },
    size: { type: "integer", value: 30 },
  });
  index = await context.client.indexes.get("acme/docs");
  fake.log.length = 0;
});

describe("search", () => {
  it("yields regex results with byte offsets and match helpers", async () => {
    const results = await collect(index.search("caf. = '(h)ello'"));
    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result).toBeInstanceOf(SearchResult);
    expect(result.key).toBe("src/b.ts");
    expect(result.line_number).toBe(1);
    expect(result.matches).toEqual([{ offset: 6, length: 15 }]);
    expect(result.matchTexts()).toEqual(["café = 'hello'"]);
    expect(result.matchSpans()).toEqual([{ start: 6, end: 20 }]);
    expect(JSON.parse(fake.log[0].body)).toEqual({
      pattern: "caf. = '(h)ello'",
    });
    expect(fake.log[0].query.get("amount")).toBe("200");
  });

  it("sends literal and case-insensitive options", async () => {
    const results = await collect(
      index.search("HELLO", { regex: false, caseSensitive: false }),
    );
    expect(results.map((r) => [r.key, r.line_number])).toEqual([
      ["a.txt", 1],
      ["a.txt", 3],
      ["src/b.ts", 1],
    ]);
    expect(JSON.parse(fake.log[0].body)).toEqual({
      pattern: "HELLO",
      mode: "literal",
      case_sensitive: false,
    });
  });

  it("needs literal mode for whole words", async () => {
    expect(() => index.search("hello", { wholeWord: true })).toThrow(
      "regex: false",
    );
    const results = await collect(
      index.search("hell", { regex: false, wholeWord: true }),
    );
    expect(results).toEqual([]);
    expect(JSON.parse(fake.log[0].body).whole_word).toBe(true);
  });

  it("restricts results by metadata filters", async () => {
    const one = await collect(
      index.search("hello", { filter: "kind = 'guide'" }),
    );
    expect(one.map((r) => r.key)).toEqual(["a.txt"]);
    const both = await collect(
      index.search("hello", {
        filters: ["path STARTSWITH 'src/'", "size < 100"],
      }),
    );
    expect(both.map((r) => r.key)).toEqual(["src/b.ts"]);
    expect(JSON.parse(fake.log.at(-1)!.body).filter).toBe(
      "(path STARTSWITH 'src/') AND (size < 100)",
    );
    expect(() =>
      index.search("x", { filter: "a = 1", filters: ["b = 2"] }),
    ).toThrow("not both");
    expect(() => index.search("x", { filters: [""] })).toThrow("empty");
  });

  it("returns context lines", async () => {
    const [result] = await collect(
      index.search("second", { linesBefore: 1, linesAfter: 2 }),
    );
    expect(result.lines_before.map((l) => l.text)).toEqual(["hello world"]);
    expect(result.lines_after.map((l) => [l.line_number, l.text])).toEqual([
      [3, "say Hello again"],
      [4, ""],
    ]);
    expect(() => index.search("x", { linesBefore: 21 })).toThrow(
      "between 0 and 20",
    );
    const [plain] = await collect(index.search("second"));
    expect(plain.lines_before).toEqual([]);
  });

  it("lets a multiline match span lines", async () => {
    const [result] = await collect(
      index.search("world\\nsecond", { multiline: true }),
    );
    expect(result.line_number).toBe(1);
    expect(result.last_line_number).toBe(2);
    expect(result.matchTexts()).toEqual(["world\nsecond"]);
    expect(result.numberedLines()).toEqual([
      [1, "hello world"],
      [2, "second line"],
    ]);
  });

  it("resends the same body on every page and survives empty pages", async () => {
    fake.searchTruncateAfter = 1;
    const pages = await collect(
      index.search("hello", { pageSize: 200 }).pages(),
    );
    const results = pages.flatMap((page) => page.results);
    expect(results.map((r) => [r.key, r.line_number])).toEqual([
      ["a.txt", 1],
      ["src/b.ts", 1],
    ]);
    expect(
      pages.some((page) => page.results.length === 0 && page.has_next),
    ).toBe(true);
    expect(pages.at(-1)!.has_next).toBe(false);
    expect(new Set(fake.log.map((r) => r.body)).size).toBe(1);
    expect(new Set(fake.log.map((r) => r.query.get("amount")))).toEqual(
      new Set(["200"]),
    );
  });

  it("honours limit and pageSize", async () => {
    expect(await collect(index.search("hello", { limit: 1 }))).toHaveLength(1);
    expect(fake.log.at(-1)!.query.get("amount")).toBe("1");
    expect(await collect(index.search("hello", { limit: 0 }))).toEqual([]);
    expect(fake.log).toHaveLength(1);
    expect(() => index.search("hello", { pageSize: 0 })).toThrow("pageSize");
    expect(() => index.search("hello", { limit: -1 })).toThrow("limit");
    expect(() => index.search("")).toThrow("pattern");
  });

  it("binds page tokens to the arguments", async () => {
    const [first] = await collect(
      index.search("hello", { pageSize: 1 }).pages(),
    );
    expect(first.has_next).toBe(true);
    const resumed = await collect(
      index.search("hello", { page: first.next_page_id, pageSize: 1 }),
    );
    expect(resumed.map((r) => r.key)).toEqual(["src/b.ts"]);
    const error = await collect(
      index.search("hello", { page: first.next_page_id, pageSize: 2 }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(InvalidPageError);
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect(error.code).toBe("invalid_page");
  });

  it("reports an invalid pattern", async () => {
    const error = await collect(index.search("(unclosed")).catch((e) => e);
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect(error.code).toBe("invalid_pattern");
  });

  it("is lazy and can be iterated again", async () => {
    const paginator = index.search("hello");
    expect(fake.log).toEqual([]);
    expect(paginator.pageSize).toBe(200);
    expect(paginator.limit).toBeUndefined();
    const first = await collect(paginator);
    const second = await paginator.toArray();
    expect(first.map((r) => r.line_number)).toEqual(
      second.map((r) => r.line_number),
    );
    expect((await paginator.first())!.key).toBe("a.txt");
    expect(await index.search("zzz").first()).toBeUndefined();
  });

  it("cancels with a signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      collect(index.search("hello", { signal: controller.signal })),
    ).rejects.toThrow("stop");
  });
});
