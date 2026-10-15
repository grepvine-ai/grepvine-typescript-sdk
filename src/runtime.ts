import { createClient, type Client } from "./generated/client/index.js";
import {
  NOT_LOGGED_IN_MESSAGE,
  isNode,
  resolveCredentials,
  type Credentials,
} from "./config.js";
import {
  ConfigurationError,
  GrepvineError,
  TransportError,
  mapError,
} from "./errors.js";
import { RetryPolicy, Throttle, retryAfterDelay } from "./retry.js";

/**
 * The settings a client resolved for its requests.
 *
 * @category Client
 */
export interface ClientConfig {
  /** The API endpoint, ending in `/v1`. */
  readonly endpoint: string;
  /** The API key, when one was found. */
  readonly apiKey: string | undefined;
  /** The time limit of each attempt, in milliseconds. */
  readonly timeout: number;
  readonly retry: RetryPolicy;
}

/** Whether an operation needs credentials. */
export type AuthMode = "required" | "none";

/** What an operation returns before it is checked. */
export interface Outcome<T> {
  data?: T;
  error?: unknown;
  request?: Request;
  response?: Response;
}

export interface RuntimeOptions {
  apiKey?: string;
  endpoint?: string;
  timeout?: number;
  retry?: RetryPolicy;
  fetch?: typeof fetch;
  configPath?: string;
  env?: Record<string, string | undefined>;
}

export const DEFAULT_TIMEOUT = 60_000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function abortableSleep(
  ms: number,
  signal?: AbortSignal | null,
): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Everything the resources share: settings, the session, the transport with
 * its retries, and the client the API operations run on.
 *
 * @internal
 */
export class Runtime {
  readonly options: RuntimeOptions;
  readonly retry: RetryPolicy;
  readonly timeout: number;
  readonly throttle = new Throttle();
  /** Overridable for tests. */
  sleep: (ms: number, signal?: AbortSignal | null) => Promise<void> =
    abortableSleep;
  now: () => number = () => Date.now();
  random: () => number = Math.random;
  newId: () => string = () =>
    globalThis.crypto.randomUUID().replaceAll("-", "");

  /** The session cookies kept after `account.login` in Node.js. */
  sessionCookies: string[] = [];
  /** The CSRF token of the session, sent on every state change. */
  csrfToken: string | undefined;

  private credentials?: Promise<Credentials>;
  private client?: Promise<Client>;

  constructor(options: RuntimeOptions) {
    this.options = { ...options };
    this.retry = options.retry ?? new RetryPolicy();
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    if (!Number.isFinite(this.timeout) || this.timeout <= 0) {
      throw new RangeError("timeout must be a positive number of milliseconds");
    }
  }

  resolve(): Promise<Credentials> {
    this.credentials ??= resolveCredentials(this.options).catch((error) => {
      this.credentials = undefined;
      throw error;
    });
    return this.credentials;
  }

  async config(): Promise<ClientConfig> {
    const { endpoint, apiKey } = await this.resolve();
    return { endpoint, apiKey, timeout: this.timeout, retry: this.retry };
  }

  /** The client the API operations run on, created once the endpoint is known. */
  private apiClient(): Promise<Client> {
    this.client ??= this.resolve().then(({ endpoint }) =>
      createClient({ baseUrl: endpoint }),
    );
    return this.client;
  }

  /** Options for an API operation: its client, transport and signal. */
  async call(signal?: AbortSignal, auth: AuthMode = "required") {
    const client = await this.apiClient();
    const fetch = ((request: Request) =>
      this.send(request, auth)) as typeof globalThis.fetch;
    return { client, fetch, signal };
  }

  get loggedIn(): boolean {
    return this.sessionCookies.length > 0;
  }

  private async authenticate(
    request: Request,
    auth: AuthMode,
  ): Promise<RequestInit> {
    const { apiKey } = await this.resolve();
    const headers = new Headers(request.headers);
    const init: RequestInit = { headers };
    const node = isNode();
    if (this.loggedIn && node) {
      headers.set("Cookie", this.sessionCookies.join("; "));
    } else if (apiKey && auth === "required") {
      headers.set("Authorization", `Bearer ${apiKey}`);
    } else if (!node) {
      // In a browser the session cookie is the browser's to send.
      init.credentials = "include";
    } else if (auth === "required") {
      throw new ConfigurationError(NOT_LOGGED_IN_MESSAGE);
    }
    if (this.csrfToken && !SAFE_METHODS.has(request.method)) {
      headers.set("X-Csrf-Token", this.csrfToken);
    }
    return init;
  }

  /**
   * Send one request, retrying per the policy, and return its final answer.
   *
   * The same request (same body, same `Idempotency-Key`) is sent on every
   * attempt. Every answer is returned except a `429` that exhausted the wait
   * budget, which is thrown as a {@link RateLimitedError}.
   */
  async send(request: Request, auth: AuthMode = "required"): Promise<Response> {
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const init = await this.authenticate(request, auth);
    const signal = request.signal;
    let attempt = 1;
    let throttled = 0;
    while (true) {
      await this.sleep(this.throttle.remaining(this.now()), signal);
      signal.throwIfAborted();
      const timeout = AbortSignal.timeout(this.timeout);
      let outcome: Response | unknown;
      try {
        outcome = await fetchImpl(request.clone(), {
          ...init,
          signal: AbortSignal.any([signal, timeout]),
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof GrepvineError) throw error;
        outcome = error;
      }
      if (!(outcome instanceof Response)) {
        if (attempt >= this.retry.maxAttempts) {
          const message =
            outcome instanceof Error ? outcome.message : String(outcome);
          throw new TransportError(
            timeout.aborted
              ? `the request timed out after ${this.timeout} ms`
              : message,
            { cause: outcome },
          );
        }
        await this.sleep(this.retry.backoffFor(attempt), signal);
        attempt++;
        continue;
      }
      const response = outcome;
      if (response.status === 429) {
        const delay = retryAfterDelay(
          response.headers,
          this.retry,
          this.random,
        );
        if (throttled + delay > this.retry.maxThrottledWait) {
          let body: unknown;
          try {
            body = await response.json();
          } catch {
            body = undefined;
          }
          throw mapError(
            429,
            response.headers,
            body,
            ` (slowed down for ${Math.floor(throttled / 1000)}s without success)`,
          );
        }
        throttled += delay;
        this.throttle.slow(this.now(), delay);
        await response.body?.cancel();
        continue;
      }
      if (response.status >= 500 && attempt < this.retry.maxAttempts) {
        await response.body?.cancel();
        await this.sleep(this.retry.backoffFor(attempt), signal);
        attempt++;
        continue;
      }
      return response;
    }
  }
}

/**
 * Check an operation's outcome and return its answer.
 *
 * Errors thrown while sending (a transport failure, a cancelled signal, a
 * rate limit that outlasted the budget) are rethrown; an error answer becomes
 * the matching {@link APIError}.
 */
export function unwrap<T>(outcome: Outcome<T>): {
  data: T;
  response: Response;
} {
  const { response } = outcome;
  if (!response) {
    const error = outcome.error;
    if (error instanceof Error || error instanceof DOMException) throw error;
    throw new TransportError("the request could not be completed", {
      cause: error,
    });
  }
  if (!response.ok) {
    throw mapError(response.status, response.headers, outcome.error);
  }
  return { data: outcome.data as T, response };
}
