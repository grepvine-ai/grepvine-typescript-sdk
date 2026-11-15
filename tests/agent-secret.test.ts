import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  ConfigurationError,
  GrepvineClient,
} from "../src/index.js";
import { apiError, fakeClient, json } from "./fake.js";

const SECRET = "gvs_0123456789abcdefghij";
const organization = { id: "o1", name: "acme", role: "owner" };

afterEach(() => {
  vi.useRealTimers();
});

/** A service that exchanges SECRET for numbered tokens and answers other requests. */
function agent() {
  const state = { tokens: 0, refuse: "" };
  const { client, requests } = fakeClient(
    async (request) => {
      if (new URL(request.url).pathname === "/oauth/token") {
        expect(
          Object.fromEntries(new URLSearchParams(await request.text())),
        ).toEqual({ grant_type: "client_credentials", client_secret: SECRET });
        state.tokens += 1;
        return json({
          access_token: `gvt_${state.tokens}`,
          token_type: "Bearer",
          expires_in: 900,
          scope: "search read",
        });
      }
      if (request.headers.get("Authorization") === state.refuse) {
        return apiError(401, "unauthenticated");
      }
      return json(organization);
    },
    { apiKey: undefined, agentSecret: SECRET },
  );
  /** The bearer each data request carried; the secret never leaves the token endpoint. */
  const bearers = async () => {
    const data = requests.filter((r) => !r.url.endsWith("/oauth/token"));
    for (const request of data) {
      const seen = `${request.url} ${JSON.stringify([...request.headers])} ${await request.clone().text()}`;
      expect(seen).not.toContain(SECRET);
    }
    return data.map((r) => r.headers.get("Authorization"));
  };
  const get = () => client.indexes.get({ organization: "acme", index: "docs" });
  return { state, client, requests, bearers, get };
}

it("exchanges once and renews shortly before expiry", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { state, requests, bearers, get } = agent();
  await get();
  await get();
  vi.advanceTimersByTime(839_000);
  await get();
  vi.advanceTimersByTime(1_000);
  await get();
  expect(requests[0].url).toBe("http://grepvine.test/oauth/token");
  expect(requests[0].headers.has("Authorization")).toBe(false);
  expect(state.tokens).toBe(2);
  expect(await bearers()).toEqual([
    ...Array(3).fill("Bearer gvt_1"),
    "Bearer gvt_2",
  ]);
});

it("exchanges a refused token again", async () => {
  const { state, bearers, get } = agent();
  await get();
  state.refuse = "Bearer gvt_1";
  await expect(get()).rejects.toThrow(AuthenticationError);
  await get();
  expect(await bearers()).toEqual([
    "Bearer gvt_1",
    "Bearer gvt_1",
    "Bearer gvt_2",
  ]);
});

it("makes an invalid secret an authentication error", async () => {
  const { client } = fakeClient(
    () =>
      json(
        {
          error: "invalid_client",
          error_description: "the agent secret is not valid",
        },
        { status: 401 },
      ),
    { apiKey: undefined, agentSecret: SECRET },
  );
  const error = await client.organizations
    .get({ organization: "acme" })
    .catch((e) => e);
  expect(error).toBeInstanceOf(AuthenticationError);
  expect([error.code, error.message]).toEqual([
    "invalid_client",
    "the agent secret is not valid",
  ]);
});

it("lets concurrent requests share one exchange", async () => {
  const { state, bearers, get } = agent();
  await Promise.all(Array.from({ length: 8 }, get));
  expect(state.tokens).toBe(1);
  expect(await bearers()).toEqual(Array(8).fill("Bearer gvt_1"));
});

it("takes the secret from the environment over a key in the file", () => {
  const path = join(homedir(), ".grepvine/config.yaml");
  mkdirSync(join(homedir(), ".grepvine"));
  writeFileSync(path, "api_key: gvk_file\n");
  chmodSync(path, 0o600);
  vi.stubEnv("GREPVINE_AGENT_SECRET", SECRET);
  const { settings } = new GrepvineClient();
  expect([settings.apiKey, settings.agentSecret]).toEqual([undefined, SECRET]);
  expect(JSON.stringify(settings)).not.toContain(SECRET);
});

it("refuses a source that sets both an API key and an agent secret", () => {
  expect(
    () => new GrepvineClient({ apiKey: "gvk_x", agentSecret: SECRET }),
  ).toThrow(/not both/);
  const path = join(homedir(), "both.yaml");
  writeFileSync(path, `api_key: gvk_file\nagent_secret: ${SECRET}\n`);
  chmodSync(path, 0o600);
  expect(() => GrepvineClient.fromConfig(path)).toThrow(ConfigurationError);
});
