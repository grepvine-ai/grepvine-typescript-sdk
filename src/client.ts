import { createClient } from "./generated/client/index.js";
import { GrepvineApi } from "./generated/sdk.gen.js";
import { ConfigurationError, mapError } from "./errors.js";
import { DeviceLogin, Documents, Indexes } from "./resources.js";
import { RetryPolicy, retryingFetch } from "./retry.js";

/**
 * Options of {@link GrepvineClient}. Every one is optional.
 */
export interface GrepvineClientOptions {
  /** The API key, sent as a bearer token. */
  apiKey?: string;
  /** The API endpoint, with or without `/v1`. Default `https://api.grepvine.ai`. */
  endpoint?: string;
  /** The time limit of each attempt of a request, in milliseconds. Default 60,000. */
  timeout?: number;
  /** How failed requests are retried. */
  retry?: RetryPolicy;
  /** The `fetch` to send requests with. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

const DEFAULT_ENDPOINT = "https://api.grepvine.ai";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DOCUMENTS = "/organizations/{organization}/indexes/{index}/objects";

function normalizeEndpoint(raw: string): string {
  const endpoint = raw.trim().replace(/\/+$/, "");
  const url = URL.parse(endpoint);
  if (!url || !/^https?:$/.test(url.protocol) || /[?#]/.test(endpoint)) {
    throw new ConfigurationError(
      `endpoint ${JSON.stringify(raw)} must be an http or https URL without a query, such as ${DEFAULT_ENDPOINT}`,
    );
  }
  return endpoint.endsWith("/v1") ? endpoint : `${endpoint}/v1`;
}

/**
 * Give every method its own `this`, so that a method can be passed on, as in
 * `paginate(client.indexes.list, ...)`. Nested resources are bound when
 * first read.
 */
function bindMethods<T extends object>(target: T): T {
  const seen = new Set(Object.getOwnPropertyNames(target));
  for (
    let proto = Object.getPrototypeOf(target);
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const [name, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(proto),
    )) {
      if (name === "constructor" || seen.has(name)) continue;
      seen.add(name);
      const { value, get } = descriptor;
      if (typeof value === "function") {
        Object.defineProperty(target, name, { value: value.bind(target) });
      } else if (get) {
        let resource: object | undefined;
        Object.defineProperty(target, name, {
          get: () => (resource ??= bindMethods(get.call(target))),
        });
      }
    }
  }
  return target;
}

/**
 * A Grepvine client: every API operation is a method of one of its
 * resources.
 *
 * `apiKey` authenticates requests and `endpoint` defaults to
 * `https://api.grepvine.ai`. The client reads no environment variables or
 * configuration files. Failed requests are retried according to `retry`, and
 * an error answer is thrown as an {@link APIError} subclass.
 *
 * ```ts
 * import { GrepvineClient, paginate } from "@grepvine/sdk";
 *
 * const client = new GrepvineClient({ apiKey: "gvk_..." });
 * for await (const org of paginate(client.organizations.list, {})) {
 *   console.log(org.name, org.role);
 * }
 * ```
 *
 * After {@link Account.login}, the client sends the session's cookie (in
 * Node.js) and CSRF token instead of the API key until
 * {@link Account.logout}.
 */
export class GrepvineClient extends GrepvineApi {
  /** The API endpoint requests go to, ending in `/v1`. */
  readonly endpoint: string;
  #indexes?: Indexes;
  #documents?: Documents;
  #deviceLogin?: DeviceLogin;

  constructor(options: GrepvineClientOptions = {}) {
    const endpoint = normalizeEndpoint(options.endpoint || DEFAULT_ENDPOINT);
    const timeout = options.timeout ?? 60_000;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new RangeError("timeout must be a positive number of milliseconds");
    }
    const session = { cookies: [] as string[], csrfToken: "" };
    const client = createClient({
      baseUrl: endpoint,
      throwOnError: true,
      responseStyle: "data",
      fetch: retryingFetch(
        options.fetch ?? globalThis.fetch,
        options.retry ?? new RetryPolicy(),
        timeout,
      ) as typeof fetch,
      // In a browser without an API key, the browser keeps the session cookie.
      credentials: options.apiKey ? undefined : "include",
      auth: (auth) =>
        auth.scheme === "bearer" && !session.cookies.length
          ? options.apiKey || undefined
          : undefined,
      // A string body (NDJSON) is sent as it is; anything else as JSON.
      bodySerializer: (body) =>
        typeof body === "string" ? body : JSON.stringify(body),
    });

    client.interceptors.request.use((request, opts) => {
      if (session.cookies.length) {
        request.headers.set("Cookie", session.cookies.join("; "));
      }
      if (SAFE_METHODS.has(request.method)) return request;
      if (session.csrfToken) {
        request.headers.set("X-Csrf-Token", session.csrfToken);
      }
      // Document writes take an idempotency key, set once here so that every
      // retry carries the same one. Other routes do not accept the header.
      if (
        opts.url.startsWith(DOCUMENTS) &&
        !request.headers.has("Idempotency-Key")
      ) {
        request.headers.set(
          "Idempotency-Key",
          crypto.randomUUID().replaceAll("-", ""),
        );
      }
      return request;
    });

    client.interceptors.response.use((response, _request, opts) => {
      if (response.ok && opts.url === "/auth/login") {
        session.csrfToken = response.headers.get("x-csrf-token") ?? "";
        session.cookies = response.headers
          .getSetCookie()
          .map((cookie) => cookie.split(";", 1)[0].trim())
          .filter(Boolean);
      } else if (response.ok && opts.url === "/auth/logout") {
        session.cookies = [];
        session.csrfToken = "";
      }
      return response;
    });

    client.interceptors.error.use((error, response) =>
      response && !response.ok
        ? mapError(response.status, response.headers, error)
        : error,
    );

    super({ client });
    this.endpoint = endpoint;
    bindMethods(this);
  }

  /** Indexes of an organization. */
  override get indexes(): Indexes {
    return (this.#indexes ??= new Indexes({ client: this.client }));
  }

  /** The documents of an index. */
  override get documents(): Documents {
    return (this.#documents ??= new Documents({ client: this.client }));
  }

  /** Logging in devices by approval. */
  override get deviceLogin(): DeviceLogin {
    return (this.#deviceLogin ??= new DeviceLogin({ client: this.client }));
  }
}
