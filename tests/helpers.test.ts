import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GrepvineError,
  InvalidRequestError,
  PartialBatchError,
  paginate,
  type DocumentInput,
  type PutObjectRecord,
} from "../src/index.js";
import { apiError, fakeClient, json, page, sequence } from "./fake.js";

afterEach(() => {
  vi.useRealTimers();
});

const collect = async <T>(items: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
};

describe("paginate", () => {
  it("follows next_page_id through empty pages", async () => {
    const { client, requests } = fakeClient(
      sequence(
        json(page([{ key: "a" }], "p2")),
        json(page([], "p3")),
        json(page([{ key: "b" }, { key: "c" }])),
      ),
    );
    const hits = await collect(
      paginate(client.search.query, {
        organization: "acme",
        index: "docs",
        pattern: "x",
        amount: 2,
      }),
    );
    expect(hits.map((hit) => hit.key)).toEqual(["a", "b", "c"]);
    const pages = requests.map((r) => new URL(r.url).searchParams);
    expect(pages.map((p) => p.get("page"))).toEqual([null, "p2", "p3"]);
    expect(pages.every((p) => p.get("amount") === "2")).toBe(true);
    for (const request of requests) {
      expect(await request.json()).toEqual({ pattern: "x" });
    }
  });

  it("works with nested resources and methods without parameters", async () => {
    const { client, requests } = fakeClient(
      sequence(json(page([{ role: "admin" }])), json(page([{ name: "o" }]))),
    );
    const members = await collect(
      paginate(client.organizations.members.list, { organization: "acme" }),
    );
    const orgs = await collect(paginate(client.organizations.list, {}));
    expect([members.length, orgs.length]).toEqual([1, 1]);
    expect(new URL(requests[0].url).pathname).toBe(
      "/v1/organizations/acme/members",
    );
  });

  it("fetches pages only as the loop needs them", async () => {
    const { client, requests } = fakeClient(() =>
      json(page([{ name: "i" }], "more")),
    );
    for await (const index of paginate(client.indexes.list, {
      organization: "acme",
      page: "start",
    })) {
      expect(index.name).toBe("i");
      break;
    }
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).searchParams.get("page")).toBe("start");
  });
});

describe("indexes.waitUntilReady", () => {
  const index = (state: string) => json({ name: "docs", state });

  it("returns the index once it is ready", async () => {
    vi.useFakeTimers();
    const { client, requests } = fakeClient(
      sequence(index("creating"), index("creating"), index("ready")),
    );
    const done = client.indexes.waitUntilReady({
      organization: "acme",
      index: "docs",
      interval: 100,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect((await done).state).toBe("ready");
    expect(requests).toHaveLength(3);
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    const { client } = fakeClient(() => index("creating"));
    const done = client.indexes
      .waitUntilReady({ organization: "acme", index: "docs", timeout: 1_000 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(String(await done)).toContain("was not ready within 1000 ms");
  });

  it("fails at once for an index being deleted", async () => {
    const { client } = fakeClient(() => index("deleting"));
    await expect(
      client.indexes.waitUntilReady({ organization: "acme", index: "docs" }),
    ).rejects.toThrow("cannot become ready: it is deleting");
  });
});

describe("deviceLogin.authorize", () => {
  const authorization = {
    device_code: "dev",
    user_code: "ABCD-EFGH",
    verification_uri: "https://grepvine.test/device",
    verification_uri_complete: "https://grepvine.test/device?code=ABCD-EFGH",
    expires_in: 600,
    interval: 5,
  };

  it("polls at the service's interval and slows down when asked", async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    const start = Date.now();
    const { client, requests } = fakeClient(
      sequence(
        json(authorization),
        () => (
          times.push(Date.now() - start),
          apiError(400, "authorization_pending")
        ),
        () => (times.push(Date.now() - start), apiError(400, "slow_down")),
        () => (
          times.push(Date.now() - start),
          json({ id: "k", key: "gvk_new" })
        ),
      ),
    );
    const codes: string[] = [];
    const done = client.deviceLogin.authorize({
      apiKeyName: "ci",
      onCode: (login) => void codes.push(login.user_code),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await done).toMatchObject({ key: "gvk_new" });
    expect(codes).toEqual(["ABCD-EFGH"]);
    expect(times).toEqual([5_000, 10_000, 20_000]);
    expect(await requests[0].json()).toEqual({ api_key_name: "ci" });
    expect(await requests[1].json()).toEqual({ device_code: "dev" });
  });

  it("throws when the login is denied", async () => {
    vi.useFakeTimers();
    const { client } = fakeClient(
      sequence(json(authorization), apiError(400, "access_denied")),
    );
    const done = client.deviceLogin
      .authorize({ apiKeyName: "ci", onCode: () => {} })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await done).toBeInstanceOf(InvalidRequestError);
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    const { client } = fakeClient((request) =>
      request.url.endsWith("/authorizations")
        ? json(authorization)
        : apiError(400, "authorization_pending"),
    );
    const done = client.deviceLogin
      .authorize({ apiKeyName: "ci", onCode: () => {}, timeout: 12_000 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(12_000);
    const error = await done;
    expect(error).toBeInstanceOf(GrepvineError);
    expect(String(error)).toContain("not approved within 12000 ms");
  });
});

describe("documents.putMany", () => {
  const where = { organization: "acme", index: "docs" };

  /** Answer batches with one revision per record, and single puts likewise. */
  const store = (request: Request) =>
    request.url.endsWith("objects:batch")
      ? request.text().then((body) =>
          json({
            results: body
              .trim()
              .split("\n")
              .map((line) => ({ key: JSON.parse(line).key, revision: "r" })),
          }),
        )
      : request
          .formData()
          .then((form) => json({ key: form.get("key"), revision: "r" }));

  const records = async (request: Request): Promise<PutObjectRecord[]> =>
    (await request.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

  it("sends text as NDJSON with tagged metadata", async () => {
    const { client, requests } = fakeClient(store);
    const when = new Date("2026-01-02T03:04:05Z");
    const results = await client.documents.putMany({
      ...where,
      documents: [
        {
          key: "a.md",
          content: "héllo",
          metadata: { kind: "guide", n: 2, ratio: 0.5, ok: true, when },
        },
        {
          key: "b.md",
          content: new TextEncoder().encode("bytes"),
          ifMatch: "r0",
        },
        { key: "c.md", content: "c", ifNoneMatch: true, metadata: { size: 1 } },
      ],
    });
    expect(results).toEqual([
      { key: "a.md", revision: "r" },
      { key: "b.md", revision: "r" },
      { key: "c.md", revision: "r" },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get("Content-Type")).toBe(
      "application/x-ndjson",
    );
    const [a, b, c] = await records(requests[0]);
    expect(a).toEqual({
      key: "a.md",
      content: "héllo",
      metadata: {
        path: { type: "string", value: "a.md" },
        size: { type: "integer", value: 6 },
        kind: { type: "string", value: "guide" },
        n: { type: "integer", value: 2 },
        ratio: { type: "number", value: 0.5 },
        ok: { type: "boolean", value: true },
        when: { type: "timestamp", value: "2026-01-02T03:04:05.000Z" },
      },
    });
    expect(b).toMatchObject({ content: "bytes", if_match: "r0" });
    expect(c).toMatchObject({ if_none_match: "*" });
    expect(c.metadata?.size).toEqual({ type: "integer", value: 1 });
  });

  it("splits batches at 2,048 documents and 16 MiB", async () => {
    const { client, requests } = fakeClient(store);
    const many = Array.from({ length: 2_049 }, (_, i) => ({
      key: `k${i}`,
      content: "x",
    }));
    const large = "y".repeat(9 * 1024 * 1024);
    const results = await client.documents.putMany({
      ...where,
      documents: [
        ...many,
        { key: "l1", content: large },
        { key: "l2", content: large },
      ],
    });
    expect(results).toHaveLength(2_051);
    const sizes = await Promise.all(
      requests.map(async (r) => (await records(r)).length),
    );
    expect(sizes).toEqual([2_048, 2, 1]);
  });

  it("stores binary content on its own, in input order", async () => {
    const { client, requests } = fakeClient(store);
    const documents: DocumentInput[] = [
      { key: "a", content: "text" },
      { key: "img", content: new Uint8Array([0xff, 0xfe]), ifNoneMatch: true },
      { key: "b", content: "more" },
    ];
    const results = await client.documents.putMany({ ...where, documents });
    expect(results.map((r) => r.key)).toEqual(["a", "img", "b"]);
    expect(requests.map((r) => r.method)).toEqual(["POST", "PUT", "POST"]);
    const form = await requests[1].formData();
    expect(requests[1].headers.get("If-None-Match")).toBe("*");
    expect(JSON.parse(String(form.get("metadata")))).toEqual({
      path: { type: "string", value: "img" },
      size: { type: "integer", value: 2 },
    });
    expect(
      new Uint8Array(await (form.get("content") as Blob).arrayBuffer()),
    ).toEqual(new Uint8Array([0xff, 0xfe]));
  });

  it("reports a failed condition of a single document in its result", async () => {
    const { client } = fakeClient(() => apiError(412, "precondition_failed"));
    const results = await client.documents.putMany({
      ...where,
      documents: [{ key: "img", content: new Blob(["x"]), ifMatch: "old" }],
    });
    expect(results).toEqual([
      {
        key: "img",
        error: {
          code: "precondition_failed",
          reason: "test",
          error: "failed with precondition_failed",
        },
      },
    ]);
  });

  it("numbers the caller's idempotency key per request", async () => {
    const { client, requests } = fakeClient(store);
    await client.documents.putMany({
      ...where,
      idempotencyKey: "import-2026-01-01",
      documents: [
        { key: "a", content: "a" },
        { key: "img", content: new Blob(["x"]) },
      ],
    });
    expect(requests.map((r) => r.headers.get("Idempotency-Key"))).toEqual([
      "import-2026-01-01-0",
      "import-2026-01-01-1",
    ]);
  });

  it("throws PartialBatchError after part of the documents were stored", async () => {
    const { client } = fakeClient(
      sequence(
        json({ results: [{ key: "a", revision: "r" }] }),
        apiError(413, "too_large"),
        apiError(413, "too_large"),
      ),
    );
    const error = await client.documents
      .putMany({
        ...where,
        documents: [
          { key: "a", content: "a" },
          { key: "img", content: new Blob(["x"]) },
          { key: "c", content: "c" },
        ],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartialBatchError);
    expect(error).toMatchObject({
      committed: [{ key: "a", revision: "r" }],
      failedKeys: ["img"],
      pendingKeys: ["c"],
    });
  });

  it("checks the documents before sending anything", async () => {
    const { client, requests } = fakeClient(store);
    await expect(
      client.documents.putMany({
        ...where,
        documents: [
          { key: "a", content: "a", ifMatch: "r", ifNoneMatch: true },
        ],
      }),
    ).rejects.toThrow("cannot be combined");
    expect(requests).toHaveLength(0);
    expect(await client.documents.putMany({ ...where, documents: [] })).toEqual(
      [],
    );
  });
});
