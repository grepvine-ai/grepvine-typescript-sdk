import { createClient } from "./generated/client/index.js";
import { GrepvineApi } from "./generated/sdk.gen.js";
import {
  DEFAULT_ENDPOINT,
  Settings,
  readFile,
  resolve,
  environment,
} from "./config.js";
import { ConfigurationError, mapError } from "./errors.js";
import { DeviceLogin, Documents, Indexes } from "./resources.js";
import { RetryPolicy, retryingFetch } from "./retry.js";

/**
 * Options of {@link GrepvineClient}. Every one is optional.
 */
export interface GrepvineClientOptions {
  /** The API key, sent as a bearer token. */
  apiKey?: string;
  /**
   * An agent secret (`gvs_...`), for working as an agent alone instead of
   * with an API key. The client exchanges it for a short-lived token, renews
   * the token before it expires, and sends only the token with requests.
   */
  agentSecret?: string;
  /** The API endpoint, with or without `/v1`. Default `https://api.grepvine.ai`. */
  endpoint?: string;
  /** The default organization, kept in {@link GrepvineClient.settings}. */
  organization?: string;
  /**
   * Whether to read the `GREPVINE_*` environment variables and the
   * configuration file for the settings the options leave out. Default `true`.
   */
  trustEnv?: boolean;
  /** The time limit of each attempt of a request, in milliseconds. Default 60,000. */
  timeout?: number;
  /** How failed requests are retried. */
  retry?: RetryPolicy;
  /** The `fetch` to send requests with. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

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
 * A token exchanged for an agent secret, exchanged again shortly before it
 * expires or after the service refused it. The secret goes only to the token
 * endpoint, and concurrent requests wait for one exchange.
 */
function agentToken(
  secret: string,
  endpoint: string,
  send: (request: Request) => Promise<Response>,
) {
  const url = `${endpoint.replace(/\/v1$/, "")}/oauth/token`;
  let token = "";
  let renewAt = 0;
  let pending: Promise<string> | undefined;
  const exchange = async () => {
    const response = await send(
      new Request(url, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_secret: secret,
        }),
      }),
    );
    const body = await response.json().catch(() => undefined);
    if (!response.ok) throw mapError(response.status, response.headers, body);
    const lifetime = Number(body.expires_in);
    token = body.access_token;
    renewAt = Date.now() + Math.max(lifetime - 60, lifetime / 2) * 1000;
    return token;
  };
  return {
    get: (): Promise<string> =>
      Date.now() < renewAt
        ? Promise.resolve(token)
        : (pending ??= exchange().finally(() => (pending = undefined))),
    forget: () => {
      renewAt = 0;
    },
  };
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
 * `new GrepvineClient()` is configured like `gv`: each of `apiKey`,
 * `agentSecret`, `endpoint` and `organization` is taken from its option, else
 * from its environment variable (`GREPVINE_API_KEY`, `GREPVINE_AGENT_SECRET`,
 * `GREPVINE_API_ENDPOINT`, `GREPVINE_ORGANIZATION`), else from the
 * configuration file (`$GREPVINE_CONFIG`, else `~/.grepvine/config.yaml` when
 * it exists), else from its default. The API key and the agent secret both
 * come from the first of those sources that sets either; a source that sets
 * both is an error. {@link GrepvineClient.fromEnv} and
 * {@link GrepvineClient.fromConfig} make a client from one of those sources
 * alone, and `trustEnv: false` one from its options alone. Environment
 * variables and files are read only in Node.js.
 *
 * Failed requests are retried according to `retry`, and an error answer is
 * thrown as an {@link APIError} subclass.
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
 * Node.js) and CSRF token instead of the API key or agent token until
 * {@link Account.logout}.
 */
export class GrepvineClient extends GrepvineApi {
  /** The API endpoint requests go to, ending in `/v1`. */
  readonly endpoint: string;
  /** The settings the client uses. */
  readonly settings: Settings;
  #indexes?: Indexes;
  #documents?: Documents;
  #deviceLogin?: DeviceLogin;

  constructor(options: GrepvineClientOptions = {}) {
    const settings = resolve(
      {
        apiKey: options.apiKey,
        agentSecret: options.agentSecret,
        endpoint: options.endpoint,
        organization: options.organization,
      },
      options.trustEnv ?? true,
    );
    const endpoint = normalizeEndpoint(settings.endpoint);
    const timeout = options.timeout ?? 60_000;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new RangeError("timeout must be a positive number of milliseconds");
    }
    const session = { cookies: [] as string[], csrfToken: "" };
    const send = retryingFetch(
      options.fetch ?? globalThis.fetch,
      options.retry ?? new RetryPolicy(),
      timeout,
    );
    const { apiKey, agentSecret } = settings;
    const agent = agentSecret
      ? agentToken(agentSecret, endpoint, send)
      : undefined;
    const client = createClient({
      baseUrl: endpoint,
      throwOnError: true,
      responseStyle: "data",
      fetch: send as typeof fetch,
      // In a browser without credentials, the browser keeps the session cookie.
      credentials: apiKey || agentSecret ? undefined : "include",
      auth: (auth) =>
        auth.scheme !== "bearer" || session.cookies.length
          ? undefined
          : agent
            ? agent.get()
            : apiKey,
      // A string body (NDJSON) is sent as it is; anything else as JSON.
      bodySerializer: (body) =>
        typeof body === "string" ? body : JSON.stringify(body),
    });

    // An operation that takes a JSON body needs one even when every field is
    // left out; without a field set, the request would otherwise go bodiless.
    for (const method of ["post", "patch"] as const) {
      const call = client[method];
      client[method] = ((opts: Parameters<typeof call>[0]) =>
        call(
          opts.body === undefined &&
            new Headers(opts.headers as HeadersInit).get("Content-Type") ===
              "application/json"
            ? { ...opts, body: {} }
            : opts,
        )) as typeof call;
    }

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
      // A refused agent token is exchanged again on the next request.
      if (response.status === 401) agent?.forget();
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
    this.settings = settings;
    bindMethods(this);
  }

  /**
   * A client whose settings come only from `GREPVINE_API_KEY`,
   * `GREPVINE_AGENT_SECRET`, `GREPVINE_API_ENDPOINT` and
   * `GREPVINE_ORGANIZATION`; no configuration file is read. A variable that
   * is not set leaves its setting at its default.
   */
  static fromEnv(
    options: Pick<GrepvineClientOptions, "timeout" | "retry" | "fetch"> = {},
  ): GrepvineClient {
    return new GrepvineClient({
      ...options,
      ...environment(),
      trustEnv: false,
    });
  }

  /**
   * A client whose settings come only from the configuration file at `path`,
   * in the format `gv` writes (a leading `~` is the home directory); no
   * `GREPVINE_*` variable is read. Node.js only.
   *
   * Throws {@link ConfigurationError} when the file does not exist, other
   * users can read it, it is not a mapping of settings, or it sets both an
   * API key and an agent secret.
   */
  static fromConfig(
    path: string,
    options: Pick<GrepvineClientOptions, "timeout" | "retry" | "fetch"> = {},
  ): GrepvineClient {
    return new GrepvineClient({
      ...options,
      ...readFile(path),
      trustEnv: false,
    });
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
