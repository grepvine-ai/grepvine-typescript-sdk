import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigurationError,
  GrepvineClient,
  RetryPolicy,
} from "../src/index.js";
import { normalizeEndpoint, resolveCredentials } from "../src/config.js";

const env = process.env;
afterEach(() => {
  process.env = env;
});

describe("configuration", () => {
  it("uses the given endpoint and API key", async () => {
    expect(
      await resolveCredentials({
        endpoint: "http://explicit.test",
        apiKey: "k",
      }),
    ).toEqual({ endpoint: "http://explicit.test/v1", apiKey: "k" });
  });

  it("falls back to the default endpoint and no key", async () => {
    expect(await resolveCredentials({})).toEqual({
      endpoint: "https://api.grepvine.ai/v1",
      apiKey: undefined,
    });
    expect(await resolveCredentials({ endpoint: "", apiKey: "" })).toEqual({
      endpoint: "https://api.grepvine.ai/v1",
      apiKey: undefined,
    });
  });

  it("reads no environment variables", async () => {
    process.env = {
      ...env,
      GREPVINE_API_KEY: "env-key",
      GREPVINE_API_ENDPOINT: "http://env.test",
      GREPVINE_ENDPOINT: "http://alias.test",
    };
    expect(await new GrepvineClient().config()).toMatchObject({
      endpoint: "https://api.grepvine.ai/v1",
      apiKey: undefined,
    });
  });

  it("normalizes endpoints", () => {
    expect(normalizeEndpoint("https://api.grepvine.ai")).toBe(
      "https://api.grepvine.ai/v1",
    );
    expect(normalizeEndpoint(" https://api.grepvine.ai/v1/ ")).toBe(
      "https://api.grepvine.ai/v1",
    );
    expect(normalizeEndpoint("http://localhost:8080/")).toBe(
      "http://localhost:8080/v1",
    );
    expect(normalizeEndpoint("https://example.com/grepvine")).toBe(
      "https://example.com/grepvine/v1",
    );
    for (const bad of [
      "ftp://x",
      "localhost:8080",
      "not a url",
      "https://x.test/?a=1",
      "https://x.test/#f",
    ]) {
      expect(() => normalizeEndpoint(bad)).toThrow(ConfigurationError);
    }
  });

  it("reports the resolved settings on the client", async () => {
    const retry = new RetryPolicy({ maxAttempts: 5 });
    const client = new GrepvineClient({
      apiKey: "k",
      endpoint: "http://x.test",
      timeout: 1234,
      retry,
    });
    expect(await client.config()).toEqual({
      endpoint: "http://x.test/v1",
      apiKey: "k",
      timeout: 1234,
      retry,
    });
    expect(() => new GrepvineClient({ timeout: 0 })).toThrow("timeout");
  });

  it("reports an unusable endpoint on the first request", async () => {
    const client = new GrepvineClient({
      apiKey: "k",
      endpoint: "nope",
    });
    await expect(client.organizations.get("x")).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });
});
