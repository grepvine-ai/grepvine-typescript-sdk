import { ConfigurationError } from "./errors.js";

export const DEFAULT_ENDPOINT = "https://api.grepvine.ai";
const API_VERSION_SUFFIX = "/v1";
const CONFIG_FILE_KEYS = new Set(["endpoint", "api_key"]);

export const NOT_LOGGED_IN_MESSAGE =
  "not logged in; run `gv login`, set GREPVINE_API_KEY, or pass apiKey to the client";

/** The two optional keys of `~/.grepvine/config.yaml`. */
export interface FileConfig {
  endpoint?: string;
  apiKey?: string;
}

/** Whether the code runs in Node.js (or a runtime that provides its modules). */
export function isNode(): boolean {
  const versions = (
    globalThis as { process?: { versions?: { node?: string } } }
  ).process?.versions;
  return typeof versions?.node === "string";
}

/** The environment of the Node.js process, or an empty one elsewhere. */
export function processEnv(): Record<string, string | undefined> {
  if (!isNode()) return {};
  return (globalThis as { process: { env: Record<string, string> } }).process
    .env;
}

// Imported lazily so that bundles for browsers never need Node.js modules.
const nodeImport = (name: string): Promise<any> =>
  import(/* webpackIgnore: true */ /* @vite-ignore */ name);

export async function defaultConfigPath(): Promise<string> {
  const os = await nodeImport("node:os");
  const path = await nodeImport("node:path");
  return path.join(os.homedir(), ".grepvine", "config.yaml");
}

function scalar(raw: string, path: string, key: string): string | null {
  let value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Fall through to the error below.
    }
    throw new ConfigurationError(
      `parse configuration ${path}: ${key} is not a valid string`,
    );
  }
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) {
      throw new ConfigurationError(
        `parse configuration ${path}: ${key} is not a valid string`,
      );
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }
  value = value.replace(/\s+#.*$/, "");
  if (value === "" || value === "~" || value === "null") return null;
  if (/^[[{&*!|>%@`]/.test(value)) {
    throw new ConfigurationError(
      `parse configuration ${path}: ${key} must be a string`,
    );
  }
  return value;
}

/**
 * Parse the configuration file, a YAML mapping of at most two string keys.
 *
 * Only the subset of YAML that `gv login` writes is accepted: one
 * `key: value` pair per line, with plain or quoted values and comments.
 */
export function parseConfigFile(text: string, path: string): FileConfig {
  const values: Record<string, string | null> = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line) || line.trim() === "---") continue;
    const match = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*))?$/.exec(line);
    if (!match) {
      throw new ConfigurationError(
        `parse configuration ${path}: expected a mapping of endpoint and api_key`,
      );
    }
    const [, key, raw = ""] = match;
    if (!CONFIG_FILE_KEYS.has(key)) {
      throw new ConfigurationError(
        `parse configuration ${path}: unknown key(s) ${key}`,
      );
    }
    values[key] = scalar(raw, path, key);
  }
  return {
    endpoint: values.endpoint ?? undefined,
    apiKey: values.api_key ?? undefined,
  };
}

/** Read the configuration file; a missing file is an empty configuration. */
export async function loadConfigFile(path: string): Promise<FileConfig> {
  const fs = await nodeImport("node:fs/promises");
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    throw new ConfigurationError(
      `read configuration ${path}: ${(error as Error).message}`,
      { cause: error },
    );
  }
  const platform = (globalThis as { process?: { platform?: string } }).process
    ?.platform;
  if (platform !== "win32") {
    const stat = await fs.stat(path);
    if (stat.mode & 0o077) {
      throw new ConfigurationError(`configuration ${path} must have mode 0600`);
    }
  }
  return parseConfigFile(text, path);
}

/** Trim trailing slashes and make sure the endpoint ends in `/v1`. */
export function normalizeEndpoint(raw: string): string {
  const endpoint = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ConfigurationError(
      `endpoint ${JSON.stringify(raw)} must be an http or https URL such as ${DEFAULT_ENDPOINT}`,
    );
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.host) {
    throw new ConfigurationError(
      `endpoint ${JSON.stringify(raw)} must be an http or https URL such as ${DEFAULT_ENDPOINT}`,
    );
  }
  if (
    url.search ||
    url.hash ||
    endpoint.includes("?") ||
    endpoint.includes("#")
  ) {
    throw new ConfigurationError(
      `endpoint ${JSON.stringify(raw)} must not carry a query or fragment`,
    );
  }
  return endpoint.endsWith(API_VERSION_SUFFIX)
    ? endpoint
    : endpoint + API_VERSION_SUFFIX;
}

/** Where requests go and how they authenticate. */
export interface Credentials {
  endpoint: string;
  apiKey: string | undefined;
}

const present = (value: string | undefined) => (value ? value : undefined);

/**
 * Resolve the endpoint and API key the way the `gv` command-line client does.
 *
 * Explicit values win, then `GREPVINE_API_ENDPOINT`, `GREPVINE_ENDPOINT` and
 * `GREPVINE_API_KEY`, then `~/.grepvine/config.yaml`, then the default
 * endpoint. The file is read only when a value is still missing, and only in
 * Node.js; elsewhere only explicit values apply.
 */
export async function resolveCredentials(options: {
  endpoint?: string;
  apiKey?: string;
  env?: Record<string, string | undefined>;
  configPath?: string;
}): Promise<Credentials> {
  const node = isNode();
  const env = options.env ?? processEnv();
  let file: FileConfig | undefined;
  const fromFile = async (key: keyof FileConfig) => {
    if (!node) return undefined;
    file ??= await loadConfigFile(
      options.configPath ?? (await defaultConfigPath()),
    );
    return present(file[key]);
  };
  const endpoint =
    present(options.endpoint) ??
    present(env.GREPVINE_API_ENDPOINT) ??
    present(env.GREPVINE_ENDPOINT) ??
    (await fromFile("endpoint")) ??
    DEFAULT_ENDPOINT;
  const apiKey =
    present(options.apiKey) ??
    present(env.GREPVINE_API_KEY) ??
    (await fromFile("apiKey"));
  return { endpoint: normalizeEndpoint(endpoint), apiKey };
}
