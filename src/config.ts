import { parse } from "yaml";
import { ConfigurationError } from "./errors.js";

export const DEFAULT_ENDPOINT = "https://api.grepvine.ai";
const DEFAULT_CONFIG_FILE = "~/.grepvine/config.yaml";

/** Each setting with its environment variable and its name in the configuration file. */
const SETTINGS = {
  endpoint: ["GREPVINE_API_ENDPOINT", "endpoint"],
  apiKey: ["GREPVINE_API_KEY", "api_key"],
  organization: ["GREPVINE_ORGANIZATION", "organization"],
  agentSecret: ["GREPVINE_AGENT_SECRET", "agent_secret"],
} as const;

type Name = keyof typeof SETTINGS;
/** Settings given by one source: options, the environment, or a file. */
export type Layer = { [name in Name]?: string };

// Node.js modules, loaded only where they exist, so the SDK still runs in a browser.
const node = globalThis.process?.getBuiltinModule?.bind(globalThis.process);

/**
 * The settings a client uses. The API key and the agent secret are not
 * printed with the rest.
 *
 * @category Client
 */
export class Settings {
  /** The service URL as configured, with or without `/v1`. */
  readonly endpoint: string;
  /** The default organization. */
  readonly organization?: string;
  readonly #apiKey?: string;
  readonly #agentSecret?: string;

  /** @internal */
  constructor(layer: Layer) {
    this.endpoint = layer.endpoint || DEFAULT_ENDPOINT;
    if (layer.organization) this.organization = layer.organization;
    this.#apiKey = layer.apiKey || undefined;
    this.#agentSecret = layer.agentSecret || undefined;
  }

  /** The API key. */
  get apiKey(): string | undefined {
    return this.#apiKey;
  }

  /** The agent secret. */
  get agentSecret(): string | undefined {
    return this.#agentSecret;
  }
}

/** The settings the `GREPVINE_*` environment variables give. */
export function environment(): Layer {
  const env = globalThis.process?.env ?? {};
  const layer: Layer = {};
  for (const [name, [variable]] of Object.entries(SETTINGS)) {
    if (env[variable]) layer[name as Name] = env[variable];
  }
  return layer;
}

/** The settings in a configuration file as `gv` writes it; other entries are ignored. */
export function readFile(path: string): Layer {
  if (!node) {
    throw new ConfigurationError(
      "a configuration file can be read only in Node.js",
    );
  }
  const fs = node("node:fs");
  const os = node("node:os");
  const chosen = path.replace(/^~(?=$|[/\\])/, os.homedir());
  const stat = fs.statSync(chosen, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    throw new ConfigurationError(
      `the configuration file ${JSON.stringify(chosen)} does not exist`,
    );
  }
  if (process.platform !== "win32" && stat.mode & 0o077) {
    throw new ConfigurationError(
      `other users can read ${JSON.stringify(chosen)}; run chmod 600 on it`,
    );
  }
  let data: unknown;
  try {
    data = parse(fs.readFileSync(chosen, "utf8")) ?? {};
  } catch (error) {
    throw new ConfigurationError(
      `${JSON.stringify(chosen)} is not valid YAML: ${(error as Error).message}`,
    );
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new ConfigurationError(
      `${JSON.stringify(chosen)} must map setting names to values`,
    );
  }
  const values = data as Record<string, unknown>;
  const layer: Layer = {};
  for (const [name, [, key]] of Object.entries(SETTINGS)) {
    const value = values[key];
    if (value !== null && value !== undefined && value !== "") {
      layer[name as Name] = String(value);
    }
  }
  return layer;
}

/** The settings in `$GREPVINE_CONFIG`, else in `~/.grepvine/config.yaml` when it exists. */
function defaultFile(): Layer {
  const named = globalThis.process?.env?.GREPVINE_CONFIG;
  if (named) return readFile(named);
  if (!node) return {};
  const path = DEFAULT_CONFIG_FILE.replace("~", node("node:os").homedir());
  return node("node:fs").existsSync(path) ? readFile(path) : {};
}

/**
 * Each setting from the options, else, with `trustEnv`, its environment
 * variable, else the configuration file, else its default. The API key and
 * the agent secret are one credential: both come from the first of those
 * sources that sets either, and a source that sets both is an error.
 */
export function resolve(options: Layer, trustEnv: boolean): Settings {
  const layers = [options];
  if (trustEnv) layers.push(environment(), defaultFile());
  const first = (name: Name) => layers.find((layer) => layer[name])?.[name];
  const credential =
    layers.find((layer) => layer.apiKey || layer.agentSecret) ?? {};
  if (credential.apiKey && credential.agentSecret) {
    throw new ConfigurationError("set an API key or an agent secret, not both");
  }
  return new Settings({
    endpoint: first("endpoint"),
    organization: first("organization"),
    apiKey: credential.apiKey,
    agentSecret: credential.agentSecret,
  });
}
