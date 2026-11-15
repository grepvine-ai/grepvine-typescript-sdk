import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { ConfigurationError, GrepvineClient } from "../src/index.js";

function write(path: string, text: string, mode = 0o600): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

const configFile = () =>
  write(
    join(homedir(), ".grepvine/config.yaml"),
    "endpoint: https://file.example\napi_key: gvk_file\norganization: acme\n",
  );

/** The URL and bearer of one request from `client`. */
async function sent(options: ConstructorParameters<typeof GrepvineClient>[0]) {
  const requests: Request[] = [];
  const client = new GrepvineClient({
    ...options,
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ id: "o", name: "acme", role: "owner" });
    },
  });
  await client.organizations.get({ organization: "acme" });
  return [requests[0].url, requests[0].headers.get("Authorization")];
}

const settings = (client: GrepvineClient) => {
  const { endpoint, apiKey, organization, agentSecret } = client.settings;
  return { endpoint, apiKey, organization, agentSecret };
};

it("uses the defaults without configuration", () => {
  expect(settings(new GrepvineClient())).toEqual({
    endpoint: "https://api.grepvine.ai",
  });
});

it("reads the configuration file", async () => {
  configFile();
  expect(await sent({})).toEqual([
    "https://file.example/v1/organizations/acme",
    "Bearer gvk_file",
  ]);
  expect(new GrepvineClient().settings.organization).toBe("acme");
});

it("lets the environment override the file per setting, and options both", async () => {
  configFile();
  vi.stubEnv("GREPVINE_API_KEY", "gvk_env");
  vi.stubEnv("GREPVINE_ORGANIZATION", "env-org");
  expect(await sent({})).toEqual([
    "https://file.example/v1/organizations/acme",
    "Bearer gvk_env",
  ]);
  const client = new GrepvineClient({ apiKey: "gvk_arg", organization: "o" });
  expect(settings(client)).toEqual({
    endpoint: "https://file.example",
    apiKey: "gvk_arg",
    organization: "o",
  });
});

it("reads the file GREPVINE_CONFIG names, which must exist", () => {
  const other = write(join(homedir(), "other.yaml"), "organization: other\n");
  vi.stubEnv("GREPVINE_CONFIG", other);
  expect(new GrepvineClient().settings.organization).toBe("other");
  vi.stubEnv("GREPVINE_CONFIG", join(homedir(), "missing.yaml"));
  expect(() => new GrepvineClient()).toThrow(/does not exist/);
});

it("reads neither the environment nor the file without trustEnv", () => {
  vi.stubEnv("GREPVINE_API_KEY", "gvk_env");
  vi.stubEnv("GREPVINE_CONFIG", configFile());
  expect(settings(new GrepvineClient({ trustEnv: false }))).toEqual({
    endpoint: "https://api.grepvine.ai",
  });
});

it("fromEnv reads only the environment", () => {
  configFile();
  vi.stubEnv("GREPVINE_API_KEY", "gvk_env");
  vi.stubEnv("GREPVINE_ORGANIZATION", "env-org");
  // The endpoint is unset in the environment: its default, not the file's.
  expect(settings(GrepvineClient.fromEnv())).toEqual({
    endpoint: "https://api.grepvine.ai",
    apiKey: "gvk_env",
    organization: "env-org",
  });
});

it("fromConfig reads only that file, from the home directory with ~", () => {
  write(
    join(homedir(), ".grepvine/staging.yaml"),
    "api_key: gvk_stage\norganization: beta\nother: 1\n",
  );
  vi.stubEnv("GREPVINE_API_KEY", "gvk_env");
  vi.stubEnv("GREPVINE_API_ENDPOINT", "https://env.example");
  const client = GrepvineClient.fromConfig("~/.grepvine/staging.yaml");
  expect(settings(client)).toEqual({
    endpoint: "https://api.grepvine.ai",
    apiKey: "gvk_stage",
    organization: "beta",
  });
});

it("refuses a file that is missing, readable by others, or not a mapping", () => {
  const path = configFile();
  expect(() => GrepvineClient.fromConfig(join(homedir(), "no.yaml"))).toThrow(
    ConfigurationError,
  );
  chmodSync(path, 0o644);
  expect(() => new GrepvineClient()).toThrow(/chmod 600/);
  const list = write(join(homedir(), "list.yaml"), "- a\n");
  expect(() => GrepvineClient.fromConfig(list)).toThrow(/must map/);
});

it("does not print the API key or the agent secret", () => {
  const client = new GrepvineClient({ apiKey: "gvk_0123456789abcdef" });
  expect(client.settings.apiKey).toBe("gvk_0123456789abcdef");
  expect(JSON.stringify(client.settings)).not.toContain("gvk_");
});
