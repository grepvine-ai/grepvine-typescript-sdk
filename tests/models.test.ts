import { describe, expect, it } from "vitest";
import { DocumentError, MutationResult, SearchResult } from "../src/index.js";
import {
  Paginator,
  resolvePageSize,
  validatePageToken,
} from "../src/paginator.js";
import { documentMetadata, tag, tagValue, untag } from "../src/metadata.js";

function result(
  text: string,
  matches: { offset: number; length: number }[],
  start = 100,
) {
  return new SearchResult({
    key: "k",
    revision: "r",
    line_number: 3,
    last_line_number: 3,
    line_start_offset: start,
    line_end_offset: start + new TextEncoder().encode(text).byteLength,
    text_start_offset: start,
    text_line_number: 3,
    text,
    matches,
    text_truncated: false,
    matches_truncated: false,
  });
}

describe("search results", () => {
  it("convert byte offsets to positions in multibyte text", () => {
    // "naïve 😀 café": ï is 2 bytes, 😀 is 4 bytes (two UTF-16 units), é is 2 bytes.
    const r = result("naïve 😀 café", [
      { offset: 100 + 2, length: 2 },
      { offset: 100 + 7, length: 4 },
      { offset: 100 + 12, length: 5 },
    ]);
    expect(r.matchTexts()).toEqual(["ï", "😀", "café"]);
    expect(r.matchSpans()).toEqual([
      { start: 2, end: 3 },
      { start: 6, end: 8 },
      { start: 9, end: 13 },
    ]);
  });

  it("clip a match that runs past the text", () => {
    const r = result("abc", [{ offset: 101, length: 3 }]);
    expect(r.matchByteSpans()).toEqual([{ start: 1, end: 3 }]);
    expect(r.matchTexts()).toEqual(["bc"]);
  });

  it("split lines", () => {
    const r = result("one\ntwo", []);
    expect(r.lines).toEqual(["one", "two"]);
    expect(r.numberedLines()).toEqual([
      [3, "one"],
      [3 + 1, "two"],
    ]);
    expect(r.textBytes).toEqual(new TextEncoder().encode("one\ntwo"));
  });
});

describe("mutation results", () => {
  it("carry a revision or an error", () => {
    const stored = MutationResult.fromJSON({ key: "a", revision: "r1" });
    expect([stored.ok, stored.revision, stored.error]).toEqual([
      true,
      "r1",
      undefined,
    ]);
    const failed = MutationResult.fromJSON({
      key: "b",
      error: {
        code: "precondition_failed",
        reason: "precondition",
        error: "nope",
      },
    });
    expect(failed.ok).toBe(false);
    expect(failed.revision).toBeUndefined();
    expect(failed.error).toEqual(
      new DocumentError({
        code: "precondition_failed",
        reason: "precondition",
        message: "nope",
      }),
    );
    expect(DocumentError.fromJSON({})!.message).toBe(
      "the document was not changed",
    );
  });
});

describe("metadata", () => {
  it("infers tags", () => {
    expect(
      tag({
        s: "x",
        b: true,
        i: 3,
        f: 1.5,
        t: new Date("2026-01-01T00:00:00Z"),
      }),
    ).toEqual({
      s: { type: "string", value: "x" },
      b: { type: "boolean", value: true },
      i: { type: "integer", value: 3 },
      f: { type: "number", value: 1.5 },
      t: { type: "timestamp", value: "2026-01-01T00:00:00.000Z" },
    });
  });

  it("passes tagged values through and rejects others", () => {
    expect(tagValue({ type: "number", value: 2 })).toEqual({
      type: "number",
      value: 2,
    });
    expect(() => tagValue({ type: "map", value: 1 })).toThrow("tagged");
    expect(() => tagValue(null)).toThrow("metadata values");
    expect(() => tagValue(new Date("bad"))).toThrow("valid date");
    expect(() => tagValue(Infinity)).toThrow("finite");
    expect(() => tag({ "": 1 })).toThrow("must not be empty");
  });

  it("untags values", () => {
    expect(
      untag({
        s: { type: "string", value: "x" },
        t: { type: "timestamp", value: "2026-01-01T00:00:00Z" },
        bad: { type: "timestamp", value: "never" },
        raw: 5,
      }),
    ).toEqual({
      s: "x",
      t: new Date("2026-01-01T00:00:00Z"),
      bad: "never",
      raw: 5,
    });
    expect(untag(undefined)).toEqual({});
  });

  it("merges defaults under the caller's fields", () => {
    expect(
      documentMetadata(
        "a.txt",
        5,
        { path: "override", team: "x" },
        new Date(0),
      ),
    ).toEqual({
      path: { type: "string", value: "override" },
      size: { type: "integer", value: 5 },
      mtime: { type: "timestamp", value: "1970-01-01T00:00:00.000Z" },
      team: { type: "string", value: "x" },
    });
  });
});

describe("pagination", () => {
  it("chooses page sizes", () => {
    expect(resolvePageSize()).toBe(200);
    expect(resolvePageSize(undefined, 5)).toBe(5);
    expect(resolvePageSize(undefined, 500)).toBe(200);
    expect(resolvePageSize(undefined, 0)).toBe(200);
    expect(resolvePageSize(10, 5)).toBe(10);
    expect(() => resolvePageSize(201)).toThrow("pageSize");
    expect(() => resolvePageSize(1.5)).toThrow("pageSize");
    expect(() => resolvePageSize(undefined, -1)).toThrow("limit");
  });

  it("validates page tokens", () => {
    expect(validatePageToken("")).toBeUndefined();
    expect(validatePageToken("abc")).toBe("abc");
    expect(() => validatePageToken("x".repeat(4097))).toThrow("too long");
  });

  function scripted(pages: { results: number[]; next?: string }[]) {
    const calls: [string | undefined, number][] = [];
    const paginator = (options = {}) =>
      new Paginator<number>(
        async (token, amount) => {
          calls.push([token, amount]);
          const page = pages[calls.length - 1];
          return {
            results: page.results,
            pagination: {
              has_next: page.next !== undefined,
              next_page_id: page.next ?? "",
            },
          };
        },
        (n: number) => n * 10,
        options,
      );
    return { calls, paginator };
  }

  it("follows tokens with a constant amount", async () => {
    const { calls, paginator } = scripted([
      { results: [1, 2], next: "t1" },
      { results: [], next: "t2" },
      { results: [3] },
    ]);
    expect(await paginator({ pageSize: 2 }).toArray()).toEqual([10, 20, 30]);
    expect(calls).toEqual([
      [undefined, 2],
      ["t1", 2],
      ["t2", 2],
    ]);
  });

  it("clips to the limit and stops", async () => {
    const { calls, paginator } = scripted([
      { results: [1, 2, 3], next: "t1" },
      { results: [4] },
    ]);
    const pages = [];
    for await (const page of paginator({ limit: 2, pageSize: 3 }).pages())
      pages.push(page);
    expect(pages).toHaveLength(1);
    expect(pages[0].results).toEqual([10, 20]);
    expect(pages[0].next_page_id).toBe("t1");
    expect(calls).toHaveLength(1);
  });

  it("sends nothing with a zero limit and starts at a given token", async () => {
    const zero = scripted([{ results: [1] }]);
    expect(await zero.paginator({ limit: 0 }).toArray()).toEqual([]);
    expect(zero.calls).toEqual([]);
    const resumed = scripted([{ results: [1] }]);
    await resumed.paginator({ page: "start" }).toArray();
    expect(resumed.calls).toEqual([["start", 200]]);
  });

  it("rejects a page that does not advance", async () => {
    const { paginator } = scripted([
      { results: [1], next: "same" },
      { results: [2], next: "same" },
    ]);
    await expect(paginator().toArray()).rejects.toThrow("did not advance");
  });
});
