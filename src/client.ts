import { Account, ApiKeys, DeviceLogin } from "./resources/account.js";
import { Indexes } from "./resources/indexes.js";
import { Organizations } from "./resources/organizations.js";
import type { RetryPolicy } from "./retry.js";
import { Runtime, type ClientConfig } from "./runtime.js";

/**
 * Options of {@link GrepvineClient}. Every one is optional.
 *
 * @category Client
 */
export interface GrepvineClientOptions {
  /** The API key. */
  apiKey?: string;
  /** The API endpoint, with or without `/v1`. Default `https://api.grepvine.ai`. */
  endpoint?: string;
  /** The time limit of each attempt of a request, in milliseconds. Default 60,000. */
  timeout?: number;
  /** How failed requests are retried. */
  retry?: RetryPolicy;
  /** The `fetch` to send requests with. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Another configuration file to read instead of `~/.grepvine/config.yaml` (Node.js). */
  configPath?: string;
  /** Environment variables to read instead of `process.env` (Node.js). */
  env?: Record<string, string | undefined>;
}

/**
 * Sends a request to the Grepvine API with the client's endpoint,
 * authentication and retries, and returns the answer as it is, whatever its
 * status. `path`, such as `"/organizations"`, is relative to the endpoint and
 * may carry a query string.
 *
 * @category Client
 */
export type HttpFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * A Grepvine client.
 *
 * In Node.js, the endpoint and API key are found the way the `gv`
 * command-line client finds them: the `GREPVINE_API_ENDPOINT` (or
 * `GREPVINE_ENDPOINT`) and `GREPVINE_API_KEY` environment variables, then
 * `~/.grepvine/config.yaml` as written by `gv login`, then the default
 * endpoint. Explicit options win. In a browser, only the options apply.
 * Nothing is read until the first request.
 *
 * ```ts
 * import { GrepvineClient } from "@grepvine/sdk";
 *
 * const client = new GrepvineClient();
 * for await (const org of client.organizations.list()) {
 *   console.log(org.name, org.role);
 * }
 * ```
 *
 * @category Client
 */
export class GrepvineClient {
  /** Organizations and their members. */
  readonly organizations: Organizations;
  /** Indexes, their documents and search. */
  readonly indexes: Indexes;
  /** The API keys of the caller's account. */
  readonly apiKeys: ApiKeys;
  /** Accounts and sessions. */
  readonly account: Account;
  /** Logging in devices by approval. */
  readonly deviceLogin: DeviceLogin;
  /**
   * Send any request to the API with this client's endpoint, authentication
   * and retries, for anything the methods above do not cover.
   *
   * ```ts
   * const response = await client.http("/organizations");
   * console.log(response.status, await response.json());
   * ```
   */
  readonly http: HttpFetch;
  private readonly runtime: Runtime;

  constructor(options: GrepvineClientOptions = {}) {
    this.runtime = new Runtime(options);
    this.organizations = new Organizations(this.runtime);
    this.indexes = new Indexes(this.runtime);
    this.apiKeys = new ApiKeys(this.runtime);
    this.account = new Account(this.runtime);
    this.deviceLogin = new DeviceLogin(this.runtime);
    this.http = async (path, init) => {
      const { endpoint } = await this.runtime.resolve();
      if (!path.startsWith("/")) {
        // Credentials go only to the client's own endpoint.
        throw new TypeError(
          'the path must start with "/", such as "/organizations"',
        );
      }
      const url = endpoint + path;
      return this.runtime.send(new Request(url, init));
    };
  }

  /** The settings the client resolved; resolving reads the environment and the configuration file. */
  config(): Promise<ClientConfig> {
    return this.runtime.config();
  }
}
