import { expect, it } from "vitest";
import { ApiError, BatchError, GrepvineClient } from "../src/index.js";

it("encodes uploads and reports partial failures without losing successful results", async () => {
  const requests: Request[] = [];
  const client = new GrepvineClient({
    apiKey: "gvk_test",
    baseUrl: "https://example.test",
    fetch: async (input) => {
      const request = input as Request;
      requests.push(request.clone());
      if (request.method === "PUT")
        return Response.json({ key: "a.bin", revision: "r1" });
      return Response.json(
        {
          results: [
            { key: "a", revision: "r1" },
            {
              key: "b",
              error: {
                code: "precondition_failed",
                reason: "revision",
                error: "Check revision",
              },
            },
          ],
        },
        { headers: { "X-Request-ID": "req-batch" } },
      );
    },
  });
  const index = client.indexes.get("acme/docs");
  await index.documents.put("a.bin", new Uint8Array([0, 255]), {
    ifNoneMatch: true,
    metadata: {
      kind: "guide",
      flag: true,
      count: 3,
      score: 1.5,
      created: new Date("2026-10-13T00:00:00Z"),
    },
  });
  expect(requests[0].headers.get("Authorization")).toBe("Bearer gvk_test");
  expect(requests[0].headers.get("Idempotency-Key")).toBeTruthy();
  expect(requests[0].headers.get("If-None-Match")).toBe("*");
  const form = await requests[0].formData();
  expect(
    new Uint8Array(await (form.get("content") as Blob).arrayBuffer()),
  ).toEqual(new Uint8Array([0, 255]));
  expect(JSON.parse(form.get("metadata") as string)).toEqual({
    kind: { type: "string", value: "guide" },
    flag: { type: "boolean", value: true },
    count: { type: "integer", value: 3 },
    score: { type: "number", value: 1.5 },
    created: { type: "timestamp", value: "2026-10-13T00:00:00.000Z" },
  });
  const documents = [
    { key: "a", content: "hello\nworld", metadata: { flag: true } },
    { key: "b", content: "bye", ifMatch: "old" },
  ];
  try {
    await index.documents.putMany(documents, {
      idempotencyKey: "stable-operation-123",
    });
    throw new Error("Expected a batch error");
  } catch (error) {
    expect(error).toBeInstanceOf(BatchError);
    const batch = error as BatchError;
    expect(batch.results[0].revision).toBe("r1");
    expect(batch.failures.map((item) => item.key)).toEqual(["b"]);
    expect(batch.requestId).toBe("req-batch");
  }
  expect(
    await index.documents.putMany(documents, {
      idempotencyKey: "stable-operation-123",
      raiseOnError: false,
    }),
  ).toHaveLength(2);
  const first = await requests[1].text();
  expect(await requests[2].text()).toBe(first);
  expect(requests[1].headers.get("Idempotency-Key")).toBe(
    "stable-operation-123",
  );
  expect(requests[2].headers.get("Idempotency-Key")).toBe(
    "stable-operation-123",
  );
  expect(JSON.parse(first.trim().split("\n")[0]).content).toBe("hello\nworld");
});

it("preserves API failure details without automatically retrying", async () => {
  let calls = 0;
  const client = new GrepvineClient({
    apiKey: "gvk",
    fetch: async () => {
      calls++;
      return Response.json(
        { code: "busy", reason: "capacity", error: "Slow down and retry." },
        {
          status: 429,
          headers: { "X-Request-ID": "req-123", "Retry-After": "2" },
        },
      );
    },
  });
  const write = client.indexes.get("acme/docs").documents.put("a", "hello");
  await expect(write).rejects.toBeInstanceOf(ApiError);
  await expect(write).rejects.toMatchObject({
    name: "ApiError",
    status: 429,
    code: "busy",
    requestId: "req-123",
    retryAfter: 2,
  });
  expect(calls).toBe(1);
});

it("follows empty continuations without changing search options", async () => {
  const requests: Request[] = [];
  const client = new GrepvineClient({
    apiKey: "gvk",
    fetch: async (input) => {
      requests.push((input as Request).clone());
      const last = requests.length === 3;
      return Response.json({
        results: [],
        pagination: {
          has_next: !last,
          next_page_id: last ? "" : `token-${requests.length}`,
        },
      });
    },
  });
  const hits = [];
  for await (const hit of client.indexes.get("acme/docs").search("hello", {
    literal: true,
    filter: "kind = 'guide'",
    amount: 1,
    linesBefore: 2,
  }))
    hits.push(hit);
  expect(hits).toEqual([]);
  expect(
    requests.map((request) => new URL(request.url).searchParams.get("page")),
  ).toEqual([null, "token-1", "token-2"]);
  const bodies = await Promise.all(requests.map((request) => request.text()));
  expect(new Set(bodies).size).toBe(1);
  expect(JSON.parse(bodies[0])).toMatchObject({
    filter: "kind = 'guide'",
    lines_before: 2,
  });
});

it("rejects oversized batches and unsafe metadata before sending any requests", async () => {
  let calls = 0;
  const client = new GrepvineClient({
    apiKey: "gvk",
    fetch: async () => {
      calls++;
      throw new Error("Unexpected request");
    },
  });
  const documents = client.indexes.get("acme/docs").documents;
  await expect(
    documents.putMany(
      Array.from({ length: 2049 }, (_, n) => ({
        key: String(n),
        content: "a",
      })),
    ),
  ).rejects.toThrow("2048");
  await expect(
    documents.putMany([{ key: "a", content: "é".repeat(8 * 1024 * 1024 + 1) }]),
  ).rejects.toThrow("16 MiB");
  await expect(
    documents.put("a", "hello", {
      metadata: { count: Number.MAX_SAFE_INTEGER + 1 },
    }),
  ).rejects.toThrow("safe");
  expect(calls).toBe(0);
});

it("bounds readiness polling and supports caller cancellation", async () => {
  const client = new GrepvineClient({
    apiKey: "gvk",
    fetch: async (input) => {
      const request = input as Request;
      request.signal.throwIfAborted();
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        );
      });
    },
  });
  await expect(
    client.indexes.get("acme/docs").waitReady({ timeoutMs: 10 }),
  ).rejects.toThrow();
  const controller = new AbortController();
  const request = client.indexes
    .get("acme/docs")
    .documents.put("a", "hello", { signal: controller.signal });
  controller.abort();
  await expect(request).rejects.toThrow();
});
