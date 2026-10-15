import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  GrepvineClient,
  InvalidRequestError,
  MutationResult,
  PartialBatchError,
  RateLimitedError,
  RetryPolicy,
  ServerError,
  TransportError,
} from "../src/index.js";
import { mapError } from "../src/errors.js";
import { retryAfterDelay } from "../src/retry.js";
import {
  API_KEY,
  ENDPOINT,
  FakeGrepvine,
  internals,
  setup,
} from "./helpers.js";

/** A client whose clock stands still unless the test moves it. */
function stillClock(retry?: RetryPolicy) {
  const context = setup({ retry });
  const runtime = internals(context.client);
  let clock = 100_000;
  const sleeps: number[] = [];
  runtime.now = () => clock;
  runtime.random = () => 0.5; // no jitter
  runtime.sleep = async (ms) => {
    if (ms > 0) sleeps.push(ms);
  };
  return { ...context, sleeps, move: (ms: number) => (clock += ms) };
}

describe("retry policy", () => {
  it("computes the 429 pause with bounds and jitter", () => {
    const policy = new RetryPolicy();
    const headers = (value?: string) =>
      new Headers(value === undefined ? {} : { "Retry-After": value });
    expect(retryAfterDelay(headers("2"), policy, () => 0.5)).toBe(2000);
    expect(retryAfterDelay(headers(), policy, () => 0.5)).toBe(1000);
    expect(retryAfterDelay(headers("0"), policy, () => 0.5)).toBe(1000);
    expect(retryAfterDelay(headers("soon"), policy, () => 0.5)).toBe(1000);
    expect(retryAfterDelay(headers("3600"), policy, () => 0.5)).toBe(60_000);
    expect(retryAfterDelay(headers("4"), policy, () => 1)).toBe(5000);
    expect(retryAfterDelay(headers("4"), policy, () => 0)).toBe(3000);
  });

  it("validates its settings", () => {
    expect(() => new RetryPolicy({ maxAttempts: 0 })).toThrow("maxAttempts");
    expect(() => new RetryPolicy({ retryAfterJitter: 1 })).toThrow(
      "retryAfterJitter",
    );
    expect(() => new RetryPolicy({ backoff: [-1] })).toThrow("durations");
    const policy = new RetryPolicy({ backoff: [10, 20] });
    expect([1, 2, 3].map((n) => policy.backoffFor(n))).toEqual([10, 20, 20]);
    expect(new RetryPolicy({ backoff: [] }).backoffFor(1)).toBe(0);
  });
});

describe("retries", () => {
  it("retries server errors with the same idempotency key", async () => {
    const { fake, client, sleeps } = stillClock();
    fake.addIndex("acme/docs");
    const index = await client.indexes.get("acme/docs");
    fake.log.length = 0;
    fake.failNext(503, { times: 2 });
    const result = await index.documents.put("a.txt", "x");
    expect(result).toBeInstanceOf(MutationResult);
    expect(fake.log.map((r) => r.method)).toEqual(["PUT", "PUT", "PUT"]);
    expect(
      new Set(fake.log.map((r) => r.headers.get("idempotency-key"))).size,
    ).toBe(1);
    expect(
      new Set(fake.log.map((r) => String(r.form!.get("metadata")))).size,
    ).toBe(1);
    expect(sleeps).toEqual([100, 200]);
  });

  it("throws ServerError once attempts are exhausted", async () => {
    const { fake, client, sleeps } = stillClock();
    fake.addOrganization("acme");
    fake.failNext(500, { times: 3 });
    const error = await client.organizations.get("acme").catch((e) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect(error.statusCode).toBe(500);
    expect(fake.log).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("retries transport failures and then throws TransportError", async () => {
    const { fake, client } = stillClock();
    fake.addOrganization("acme");
    fake.throwNext(new TypeError("fetch failed"));
    expect((await client.organizations.get("acme")).name).toBe("acme");
    expect(fake.log).toHaveLength(2);
    const cause = new TypeError("connection refused");
    fake.throwNext(cause, { times: 3 });
    const error = await client.organizations.get("acme").catch((e) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error.cause).toBe(cause);
  });

  it("does not retry client errors", async () => {
    const { fake, client } = stillClock();
    fake.addOrganization("acme");
    fake.failNext(400, { code: "invalid_request", message: "bad", times: 3 });
    await expect(client.organizations.get("acme")).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    expect(fake.log).toHaveLength(1);
  });

  it("pauses every request of the client after a 429", async () => {
    const { fake, client, sleeps, move } = stillClock();
    fake.addOrganization("acme");
    fake.failNext(429, { code: "write_backlog", retryAfter: 2 });
    expect((await client.organizations.get("acme")).name).toBe("acme");
    expect(sleeps).toEqual([2000]);
    expect(fake.log).toHaveLength(2);
    // The pause stays in force for the next request until the clock moves on.
    await client.organizations.get("acme");
    expect(sleeps).toEqual([2000, 2000]);
    move(5000);
    await client.organizations.get("acme");
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("gives up on 429s after the wait budget", async () => {
    const { fake, client, sleeps } = stillClock(
      new RetryPolicy({ maxThrottledWait: 2500 }),
    );
    fake.addOrganization("acme");
    fake.failNext(429, { code: "capacity_exhausted", times: 3 });
    const error = await client.organizations.get("acme").catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(sleeps).toEqual([1000, 1000]);
    expect(error.retryAfter).toBeUndefined();
    expect(error.code).toBe("capacity_exhausted");
    expect(error.message).toContain("slowed down for 2s without success");
  });

  it("wraps a rate limit in PartialBatchError part-way through a write", async () => {
    const { fake, client } = stillClock(
      new RetryPolicy({ maxThrottledWait: 500 }),
    );
    fake.addIndex("acme/docs");
    const index = await client.indexes.get("acme/docs");
    let posts = 0;
    const original = fake.handle.bind(fake);
    fake.handle = async (request) => {
      if (request.method === "PUT" && ++posts >= 2) {
        return Response.json(
          { code: "write_backlog", reason: "capacity", error: "slow down" },
          { status: 429, headers: { "Retry-After": "1" } },
        );
      }
      return original(request);
    };
    const error = await index.documents
      .put([
        { key: "a", content: new Uint8Array([0xff]) },
        { key: "b", content: new Uint8Array([0xfe]) },
      ])
      .catch((e) => e);
    expect(error).toBeInstanceOf(PartialBatchError);
    expect(error.cause).toBeInstanceOf(RateLimitedError);
  });

  it("limits each attempt with the timeout and propagates cancellation", async () => {
    const fake = new FakeGrepvine();
    fake.addOrganization("acme");
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
      })) as typeof fetch;
    const client = new GrepvineClient({
      apiKey: API_KEY,
      endpoint: ENDPOINT,
      env: {},
      fetch: slow,
      timeout: 20,
      retry: new RetryPolicy({ maxAttempts: 2, backoff: [1] }),
    });
    const error = await client.organizations.get("acme").catch((e) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error.message).toContain("timed out after 20 ms");
    const controller = new AbortController();
    const pending = client.organizations.get("acme", {
      signal: controller.signal,
    });
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("requires an API key for authenticated operations", async () => {
    const fake = new FakeGrepvine();
    const client = new GrepvineClient({
      endpoint: ENDPOINT,
      env: {},
      fetch: fake.fetch,
      configPath: "/nonexistent/config.yaml",
    });
    const error = await client.organizations
      .list()
      .first()
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toContain("gv login");
    expect(fake.log).toHaveLength(0);
  });
});

describe("error mapping", () => {
  it("maps statuses and bodies to classes", () => {
    const headers = new Headers({
      "X-Request-ID": "req-1",
      "Retry-After": "7",
    });
    const cases: [number, unknown, string][] = [
      [
        400,
        { code: "invalid_page", reason: "pagination", error: "bad page" },
        "InvalidPageError",
      ],
      [
        400,
        { code: "invalid_request", reason: "validation", error: "bad" },
        "InvalidRequestError",
      ],
      [401, {}, "AuthenticationError"],
      [403, {}, "PermissionDeniedError"],
      [404, {}, "NotFoundError"],
      [409, {}, "ConflictError"],
      [412, {}, "PreconditionFailedError"],
      [413, {}, "PayloadTooLargeError"],
      [416, {}, "RangeNotSatisfiableError"],
      [429, {}, "RateLimitedError"],
      [502, "not json", "ServerError"],
      [418, null, "APIError"],
    ];
    for (const [status, body, name] of cases) {
      const error = mapError(status, headers, body);
      expect(error.name).toBe(name);
      expect(error.statusCode).toBe(status);
      expect(error.requestId).toBe("req-1");
      expect(error.retryAfter).toBe(7);
    }
    const bare = mapError(500, new Headers(), undefined);
    expect([bare.code, bare.reason, bare.message]).toEqual([
      "request_failed",
      "http",
      "HTTP 500",
    ]);
    expect(
      String(mapError(404, headers, { code: "not_found", error: "gone" })),
    ).toBe("NotFoundError: gone (not_found; request req-1)");
  });
});
