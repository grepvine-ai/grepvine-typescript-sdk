import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigurationError,
  GrepvineClient,
  RetryPolicy,
} from "../src/index.js";
import {
  defaultConfigPath,
  normalizeEndpoint,
  parseConfigFile,
  resolveCredentials,
} from "../src/config.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function configFile(text: string, mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), "grepvine-config-"));
  directories.push(directory);
  const path = join(directory, "config.yaml");
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

describe("configuration", () => {
  it("prefers explicit values, then the environment, its alias, the file, the default", async () => {
    const configPath = configFile(
      "endpoint: http://file.test\napi_key: file-key\n",
    );
    const full = {
      GREPVINE_API_ENDPOINT: "http://env.test",
      GREPVINE_ENDPOINT: "http://alias.test",
      GREPVINE_API_KEY: "env-key",
    };
    expect(
      await resolveCredentials({
        endpoint: "http://explicit.test",
        apiKey: "explicit",
        env: full,
        configPath,
      }),
    ).toEqual({
      endpoint: "http://explicit.test/v1",
      apiKey: "explicit",
    });
    expect(await resolveCredentials({ env: full, configPath })).toEqual({
      endpoint: "http://env.test/v1",
      apiKey: "env-key",
    });
    expect(
      await resolveCredentials({
        env: { GREPVINE_ENDPOINT: "http://alias.test" },
        configPath,
      }),
    ).toEqual({
      endpoint: "http://alias.test/v1",
      apiKey: "file-key",
    });
    expect(await resolveCredentials({ env: {}, configPath })).toEqual({
      endpoint: "http://file.test/v1",
      apiKey: "file-key",
    });
    expect(
      await resolveCredentials({
        env: {},
        configPath: join(tmpdir(), "missing-grepvine.yaml"),
      }),
    ).toEqual({
      endpoint: "https://api.grepvine.ai/v1",
      apiKey: undefined,
    });
  });

  it("treats empty values as unset and resolves each value on its own", async () => {
    const configPath = configFile("api_key: file-key\n");
    expect(
      await resolveCredentials({
        endpoint: "",
        apiKey: "",
        env: { GREPVINE_API_ENDPOINT: "", GREPVINE_API_KEY: "" },
        configPath,
      }),
    ).toEqual({ endpoint: "https://api.grepvine.ai/v1", apiKey: "file-key" });
    expect(
      await resolveCredentials({
        env: { GREPVINE_API_ENDPOINT: "http://env.test" },
        configPath,
      }),
    ).toEqual({
      endpoint: "http://env.test/v1",
      apiKey: "file-key",
    });
  });

  it("never reads the file when explicit values cover everything", async () => {
    const configPath = configFile("not: [valid", 0o644);
    expect(
      await resolveCredentials({
        endpoint: "http://x.test",
        apiKey: "k",
        env: {},
        configPath,
      }),
    ).toEqual({
      endpoint: "http://x.test/v1",
      apiKey: "k",
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

  it("parses the configuration file", () => {
    expect(parseConfigFile("", "p")).toEqual({
      endpoint: undefined,
      apiKey: undefined,
    });
    expect(
      parseConfigFile(
        "# comment\n---\napi_key: 'gvk_''x'\nendpoint: \"http://a.test\"  \n",
        "p",
      ),
    ).toEqual({
      endpoint: "http://a.test",
      apiKey: "gvk_'x",
    });
    expect(
      parseConfigFile("api_key: gvk_x # trailing\nendpoint:\n", "p"),
    ).toEqual({ endpoint: undefined, apiKey: "gvk_x" });
    expect(() => parseConfigFile("other: x\n", "p")).toThrow(
      "unknown key(s) other",
    );
    expect(() => parseConfigFile("- a\n", "p")).toThrow("expected a mapping");
    expect(() => parseConfigFile("api_key: [1]\n", "p")).toThrow(
      "must be a string",
    );
    expect(() => parseConfigFile('api_key: "open\n', "p")).toThrow(
      "not a valid string",
    );
  });

  it.skipIf(process.platform === "win32")(
    "requires the file to be readable by its owner only",
    async () => {
      const configPath = configFile("api_key: k\n", 0o644);
      await expect(resolveCredentials({ env: {}, configPath })).rejects.toThrow(
        "must have mode 0600",
      );
    },
  );

  it("finds the file in the home directory", async () => {
    expect(await defaultConfigPath()).toBe(
      join(homedir(), ".grepvine", "config.yaml"),
    );
  });

  it("reports the resolved settings on the client", async () => {
    const retry = new RetryPolicy({ maxAttempts: 5 });
    const client = new GrepvineClient({
      apiKey: "k",
      endpoint: "http://x.test",
      timeout: 1234,
      retry,
      env: {},
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
      env: {},
    });
    await expect(client.organizations.get("x")).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });
});
