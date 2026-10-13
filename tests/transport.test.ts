import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGrepvineClient,
  getDocument,
  putDocument,
  putObjects,
  pollDeviceToken,
  startDeviceAuthorization,
  queryIndex,
  updateIndex,
} from "../src/index.js";

type Recorded = {
  url: string;
  method: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
};
const path = { organization: "acme", index: "notes" };
const pagination = { next_page_id: "", has_next: false };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(reply: (res: ServerResponse, req: Recorded) => void) {
  const requests: Recorded[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const recorded = {
      url: req.url!,
      method: req.method!,
      headers: req.headers,
      body: Buffer.concat(chunks),
    };
    requests.push(recorded);
    reply(res, recorded);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing listening address");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return {
    requests,
    baseUrl,
    client: createGrepvineClient({ baseUrl, apiKey: "gvk_test" }),
  };
}
function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Request-ID": "req-123",
  });
  res.end(JSON.stringify(body));
}

describe("generated SDK over HTTP", () => {
  it("keeps credentials independent, sends bearer without cookies, and preserves query tokens", async () => {
    const f = await fixture((res) => json(res, { results: [], pagination }));
    const second = createGrepvineClient({
      baseUrl: f.baseUrl,
      apiKey: "gvk_second",
    });
    for (const client of [f.client, second]) {
      const result = await queryIndex({
        client,
        path,
        query: { amount: 2, page: "next /+?" },
        body: { pattern: "hello", mode: "literal", filter: "flag = true" },
      });
      expect(result.data).toEqual({ results: [], pagination });
    }
    expect(f.requests.map((r) => r.headers.authorization)).toEqual([
      "Bearer gvk_test",
      "Bearer gvk_second",
    ]);
    expect(f.requests[0].headers.cookie).toBeUndefined();
    const url = new URL(f.requests[0].url, f.baseUrl);
    expect(url.pathname).toBe("/v1/organizations/acme/indexes/notes/query");
    expect(url.searchParams.get("page")).toBe("next /+?");
    expect(JSON.parse(f.requests[0].body.toString())).toEqual({
      pattern: "hello",
      mode: "literal",
      filter: "flag = true",
    });
  });

  it("sends multipart binary content and JSON metadata", async () => {
    const f = await fixture((res) =>
      json(res, { key: "café/a.bin", revision: "rev" }),
    );
    const bytes = new Uint8Array([0, 255, 128, 10]);
    const metadata = JSON.stringify({ count: { type: "integer", value: 123 } });
    const result = await putDocument({
      client: f.client,
      path,
      headers: {
        "Idempotency-Key": "stable-operation-123",
        "If-None-Match": "*",
      },
      body: { key: "café/a.bin", content: new Blob([bytes]), metadata },
    });
    expect(result.data?.revision).toBe("rev");
    const request = f.requests[0];
    const form = await new Response(new Uint8Array(request.body), {
      headers: { "Content-Type": request.headers["content-type"]! },
    }).formData();
    expect(form.get("key")).toBe("café/a.bin");
    expect(form.get("metadata")).toBe(metadata);
    expect(
      new Uint8Array(await (form.get("content") as Blob).arrayBuffer()),
    ).toEqual(bytes);
    expect(request.headers["idempotency-key"]).toBe("stable-operation-123");
    expect(request.headers["if-none-match"]).toBe("*");
  });

  it("sends NDJSON unchanged and exposes individual batch failures", async () => {
    const f = await fixture((res) =>
      json(res, {
        results: [
          { key: "a", revision: "r1" },
          {
            key: "b",
            error: {
              code: "precondition_failed",
              reason: "revision",
              error: "Check the revision.",
            },
          },
        ],
      }),
    );
    const body =
      '{"key":"a","content":"hello\\nworld"}\n{"key":"b","content":"café"}\n';
    const result = await putObjects({
      client: f.client,
      path,
      body,
      headers: { "Idempotency-Key": "stable-operation-123" },
    });
    expect(f.requests[0].body.toString()).toBe(body);
    expect(f.requests[0].headers["content-type"]).toBe("application/x-ndjson");
    expect(result.data?.results[1].error?.code).toBe("precondition_failed");
  });

  it.each([200, 206])(
    "returns binary content and response headers for %i",
    async (status) => {
      const f = await fixture((res) => {
        res.writeHead(status, {
          "Content-Type": "application/octet-stream",
          ETag: "rev",
          "Content-Range": "bytes 0-3/10",
          "X-Grepvine-Metadata": "{}",
        });
        res.end(Buffer.from([0, 255, 128, 10]));
      });
      const result = await getDocument({
        client: f.client,
        path: { ...path, key: "dir/café %?.bin" },
        headers: { Range: "bytes=0-3" },
      });
      expect(f.requests[0].url).toBe(
        "/v1/organizations/acme/indexes/notes/objects/dir%2Fcaf%C3%A9%20%25%3F.bin",
      );
      expect(f.requests[0].headers.range).toBe("bytes=0-3");
      expect(new Uint8Array(await result.data!.arrayBuffer())).toEqual(
        new Uint8Array([0, 255, 128, 10]),
      );
      expect(result.response!.headers.get("ETag")).toBe("rev");
      expect(result.response!.headers.get("X-Grepvine-Metadata")).toBe("{}");
      expect(result.response!.status).toBe(status);
    },
  );

  it("preserves default errors, status, request IDs, and Retry-After", async () => {
    const error = {
      code: "busy",
      reason: "capacity",
      error: "Slow down and retry.",
    };
    const f = await fixture((res) => {
      res.setHeader("Retry-After", "2");
      json(res, error, 429);
    });
    const result = await queryIndex({
      client: f.client,
      path,
      body: { pattern: "hello" },
    });
    expect(result.error).toEqual(error);
    expect(result.response!.status).toBe(429);
    expect(result.response!.headers.get("X-Request-ID")).toBe("req-123");
    expect(result.response!.headers.get("Retry-After")).toBe("2");
    expect(f.requests).toHaveLength(1); // no implicit retries
  });

  it("retains null tag deletions, and supports cookie/CSRF auth without a key", async () => {
    const f = await fixture((res) =>
      json(res, { code: "bad_request", reason: "test", error: "test" }, 400),
    );
    const client = createGrepvineClient({
      baseUrl: f.baseUrl,
      headers: {
        Cookie: "__Host-grepvine-session=session",
        "X-Csrf-Token": "csrf-token",
      },
    });
    await updateIndex({
      client,
      path,
      body: { tags: { old: null, kept: "new" } },
    });
    expect(JSON.parse(f.requests[0].body.toString())).toEqual({
      tags: { old: null, kept: "new" },
    });
    expect(f.requests[0].headers.cookie).toBe(
      "__Host-grepvine-session=session",
    );
    expect(f.requests[0].headers["x-csrf-token"]).toBe("csrf-token");
    expect(f.requests[0].headers.authorization).toBeUndefined();
  });

  it("supports cancellation and incremental download via the response stream", async () => {
    const f = await fixture((res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.write("first");
    });
    const controller = new AbortController();
    const result = await getDocument({
      client: f.client,
      path: { ...path, key: "large" },
      parseAs: "stream",
      signal: controller.signal,
    });
    const reader = result.response!.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
  });

  it("retains native SSE POST capability without inventing a REST streaming operation", async () => {
    const f = await fixture((res, req) => {
      expect(req.method).toBe("POST");
      expect(req.headers.authorization).toBe("Bearer gvk_test");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": heartbeat\r\n\r\nid: 1\r\nevent: result\r\ndata: {\r\n");
      res.end('data: "text": "café"}\r\n\r\n');
    });
    const events: unknown[] = [];
    const result = await f.client.sse.post<{ text: string }>({
      url: "/sse-fixture",
      body: { pattern: "hello" },
      security: [{ type: "http", scheme: "bearer" }],
      sseMaxRetryAttempts: 0,
      onSseEvent: (event) => events.push(event),
    });
    const values = [];
    for await (const value of result.stream) values.push(value);
    expect(values).toEqual([{ text: "café" }]);
    expect(events).toContainEqual(
      expect.objectContaining({ id: "1", event: "result" }),
    );
    expect(f.requests).toHaveLength(1);
  });
});

it("obtains an API key through anonymous device login and uses it for search", async () => {
  let polls = 0;
  const f = await fixture((res, request) => {
    if (request.url === "/v1/device/authorizations") {
      json(res, {
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://example.test/device",
        verification_uri_complete: "https://example.test/device?code=ABCD-EFGH",
        expires_in: 600,
        interval: 5,
      });
    } else if (request.url === "/v1/device/token" && polls++ === 0) {
      json(
        res,
        {
          code: "authorization_pending",
          reason: "authorization",
          error: "Complete authorization in your browser.",
        },
        400,
      );
    } else if (request.url === "/v1/device/token") {
      json(res, {
        id: "00000000-0000-4000-8000-000000000001",
        name: "sdk-test",
        prefix: "gvk_",
        key: "gvk_from_device",
        created_at: "2026-10-13T12:00:00Z",
      });
    } else {
      json(res, { results: [], pagination });
    }
  });
  const anonymous = createGrepvineClient({ baseUrl: f.baseUrl });
  const started = await startDeviceAuthorization({
    client: anonymous,
    body: { api_key_name: "sdk-test" },
  });
  expect(started.data?.device_code).toBe("device-code");
  const pending = await pollDeviceToken({
    client: anonymous,
    body: { device_code: started.data!.device_code },
  });
  expect(pending.error?.code).toBe("authorization_pending");
  const token = await pollDeviceToken({
    client: anonymous,
    body: { device_code: started.data!.device_code },
  });
  expect(token.data?.key).toBe("gvk_from_device");
  expect(
    f.requests.every((request) => request.headers.authorization === undefined),
  ).toBe(true);
  expect(JSON.parse(f.requests[0].body.toString())).toEqual({
    api_key_name: "sdk-test",
  });
  expect(JSON.parse(f.requests[1].body.toString())).toEqual({
    device_code: "device-code",
  });
  const client = createGrepvineClient({
    baseUrl: f.baseUrl,
    apiKey: token.data!.key,
  });
  await queryIndex({ client, path, body: { pattern: "hello" } });
  expect(f.requests[3].headers.authorization).toBe("Bearer gvk_from_device");
});
