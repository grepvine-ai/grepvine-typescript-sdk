import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigurationError,
  GrepvineClient,
  InvalidPageError,
  NotFoundError,
  RateLimitedError,
  RetryPolicy,
  ServerError,
  TransportError,
} from "../src/index.js";
import { apiError, fakeClient, json, page, sequence } from "./fake.js";

const organization = {
  id: "o1",
  name: "acme",
  role: "owner",
  created_at: "2026-01-01T00:00:00Z",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("appends /v1 to the endpoint once", async () => {
    for (const endpoint of [
      "http://grepvine.test",
      "http://grepvine.test/",
      "http://grepvine.test/v1",
    ]) {
      const { client, requests } = fakeClient(() => json(organization), {
        endpoint,
      });
      await client.organizations.get({ organization: "acme" });
      expect(requests[0].url).toBe(
        "http://grepvine.test/v1/organizations/acme",
      );
    }
  });

  it("defaults to the public endpoint", () => {
    expect(new GrepvineClient().endpoint).toBe("https://api.grepvine.ai/v1");
  });

  it("rejects an unusable endpoint", () => {
    expect(() => new GrepvineClient({ endpoint: "ftp://x" })).toThrow(
      ConfigurationError,
    );
    expect(() => new GrepvineClient({ endpoint: "http://x?a=1" })).toThrow(
      ConfigurationError,
    );
    expect(() => new GrepvineClient({ timeout: 0 })).toThrow(RangeError);
  });

  it("sends the API key as a bearer token and no cookie", async () => {
    const { client, requests } = fakeClient(() => json(organization));
    expect(await client.organizations.get({ organization: "acme" })).toEqual(
      organization,
    );
    expect(requests[0].headers.get("Authorization")).toBe("Bearer gvk_test");
    expect(requests[0].headers.get("Cookie")).toBeNull();
  });

  it("sends no Authorization header without an API key", async () => {
    const { client, requests } = fakeClient(() => json(page([])), {
      apiKey: undefined,
    });
    await client.organizations.list();
    expect(requests[0].headers.get("Authorization")).toBeNull();
  });

  it("sends a method's body fields as JSON", async () => {
    const { client, requests } = fakeClient(() => json({}, { status: 201 }));
    await client.indexes.create({
      organization: "acme",
      name: "docs",
      tags: { team: "a" },
    });
    expect(requests[0].headers.get("Content-Type")).toBe("application/json");
    expect(await requests[0].json()).toEqual({
      name: "docs",
      tags: { team: "a" },
    });
  });

  it("sends NDJSON unchanged", async () => {
    const { client, requests } = fakeClient(() => json({ results: [] }));
    const body = '{"key":"a","content":"x"}\n';
    await client.documents.putBatch({ organization: "acme", index: "d", body });
    expect(requests[0].headers.get("Content-Type")).toBe(
      "application/x-ndjson",
    );
    expect(await requests[0].text()).toBe(body);
  });
});

describe("session", () => {
  it("uses the session of account.login until account.logout", async () => {
    const { client, requests } = fakeClient(
      sequence(
        json(
          { id: "u", name: "ann", email: "a@x", created_at: "" },
          {
            headers: [
              ["X-Csrf-Token", "csrf-token-0123456789"],
              ["Set-Cookie", "__Host-grepvine-session=s1; Path=/; HttpOnly"],
            ],
          },
        ),
        json({}, { status: 201 }),
        new Response(null, { status: 204 }),
        json(page([])),
      ),
      { apiKey: undefined },
    );
    await client.account.login({ identifier: "ann", password: "secret" });
    await client.organizations.create({ name: "acme" });
    await client.account.logout();
    await client.organizations.list();
    const [login, create, logout, list] = requests;
    expect(login.headers.get("Cookie")).toBeNull();
    expect(create.headers.get("Cookie")).toBe("__Host-grepvine-session=s1");
    expect(create.headers.get("X-Csrf-Token")).toBe("csrf-token-0123456789");
    expect(create.headers.get("Authorization")).toBeNull();
    expect(logout.headers.get("X-Csrf-Token")).toBe("csrf-token-0123456789");
    expect(list.headers.get("Cookie")).toBeNull();
    expect(list.headers.get("X-Csrf-Token")).toBeNull();
  });
});

describe("errors", () => {
  it("throws the matching error with the answer's fields", async () => {
    const { client } = fakeClient(() =>
      apiError(404, "not_found", { "X-Request-ID": "req-1" }),
    );
    const error = await client.indexes
      .get({ organization: "acme", index: "none" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({
      statusCode: 404,
      code: "not_found",
      reason: "test",
      message: "failed with not_found",
      requestId: "req-1",
      retryAfter: undefined,
    });
    expect(String(error)).toBe(
      "NotFoundError: failed with not_found (not_found; request req-1)",
    );
  });

  it("tells an expired page token apart", async () => {
    const { client } = fakeClient(() => apiError(400, "invalid_page"));
    await expect(
      client.indexes.list({ organization: "acme", page: "old" }),
    ).rejects.toBeInstanceOf(InvalidPageError);
  });

  it("describes an answer that is not an API error", async () => {
    const { client } = fakeClient(() => new Response("bad", { status: 418 }));
    await expect(client.account.me()).rejects.toMatchObject({
      statusCode: 418,
      code: "request_failed",
      message: "HTTP 418",
    });
  });
});

describe("retries", () => {
  it("retries a 5xx with the same idempotency key, then gives up", async () => {
    const { client, requests } = fakeClient(() => apiError(503, "unavailable"));
    await expect(
      client.documents.delete({ organization: "acme", index: "d", key: "a" }),
    ).rejects.toBeInstanceOf(ServerError);
    expect(requests).toHaveLength(3);
    const keys = requests.map((r) => r.headers.get("Idempotency-Key"));
    expect(keys[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(keys).size).toBe(1);
  });

  it("gives each write its own key and keeps a caller's key", async () => {
    const { client, requests } = fakeClient(() => json({ key: "a" }));
    const where = { organization: "acme", index: "d", key: "a" };
    await client.documents.delete(where);
    await client.documents.delete(where);
    await client.documents.delete({
      ...where,
      "Idempotency-Key": "k".repeat(16),
    });
    await client.documents.list({ organization: "acme", index: "d" });
    const keys = requests.map((r) => r.headers.get("Idempotency-Key"));
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe("k".repeat(16));
    expect(keys[3]).toBeNull();
  });

  it("retries a connection failure, then throws TransportError", async () => {
    let calls = 0;
    const { client } = fakeClient(() => {
      calls++;
      throw new TypeError("connection refused");
    });
    const error = await client.account.me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).toBe("connection refused");
    expect(calls).toBe(3);
  });

  it("recovers when a retry succeeds", async () => {
    const { client } = fakeClient(
      sequence(
        () => {
          throw new TypeError("reset");
        },
        apiError(502, "bad_gateway"),
        json(organization),
      ),
    );
    expect(await client.organizations.get({ organization: "acme" })).toEqual(
      organization,
    );
  });

  it("waits for Retry-After, with jitter, before trying again", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1); // +25%
    const { client, requests } = fakeClient(
      sequence(
        apiError(429, "rate_limited", { "Retry-After": "2" }),
        json(organization),
      ),
    );
    const done = client.organizations.get({ organization: "acme" });
    await vi.advanceTimersByTimeAsync(2_499);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await done).toEqual(organization);
    expect(requests).toHaveLength(2);
  });

  it("bounds the wait of a 429", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter
    const { client } = fakeClient(
      apiErrorEvery(429, { "Retry-After": "120" }),
      {
        retry: new RetryPolicy({
          maxRetryAfter: 1_000,
          maxThrottledWait: 2_500,
        }),
      },
    );
    const done = client.account.me().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    const error = await done;
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ retryAfter: 120 });
    expect((error as Error).message).toContain("slowed down for 2s");
  });

  it("stops at once when the signal aborts", async () => {
    const controller = new AbortController();
    const { client } = fakeClient(() => {
      controller.abort(new Error("stop"));
      throw new TypeError("aborted");
    });
    await expect(
      client.account.me({ signal: controller.signal }),
    ).rejects.toThrow("stop");
  });
});

function apiErrorEvery(status: number, headers: Record<string, string>) {
  return () => apiError(status, "rate_limited", headers);
}
