import { GrepvineError, TransportError, mapError } from "./errors.js";

/**
 * How a client retries failed requests.
 *
 * `maxAttempts` bounds retries after a `5xx` answer or a connection failure;
 * `backoff` gives the pause after each failed attempt in milliseconds (the
 * last value repeats). A `429` pauses every request of the client for the
 * `Retry-After` interval (`defaultRetryAfter` when the header is missing,
 * never more than `maxRetryAfter`), adjusted at random by up to
 * `retryAfterJitter` of itself in either direction, until one request has
 * waited `maxThrottledWait` in total. A `429` never uses up an attempt.
 *
 * All durations are in milliseconds.
 *
 * ```ts
 * const client = new GrepvineClient({ retry: new RetryPolicy({ maxAttempts: 5 }) });
 * ```
 */
export class RetryPolicy {
  /** Attempts per request for `5xx` answers and connection failures. Default 3. */
  readonly maxAttempts: number;
  /** Pauses after each failed attempt. Default `[100, 200]`. */
  readonly backoff: readonly number[];
  /** The pause after a `429` without `Retry-After`. Default 1,000. */
  readonly defaultRetryAfter: number;
  /** The longest single pause a `429` can impose. Default 60,000. */
  readonly maxRetryAfter: number;
  /** The random adjustment of a pause, as a fraction of it. Default 0.25. */
  readonly retryAfterJitter: number;
  /** The total time one request may spend paused by `429`s. Default 600,000. */
  readonly maxThrottledWait: number;

  constructor(options: Partial<RetryPolicyOptions> = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.backoff = Object.freeze([...(options.backoff ?? [100, 200])]);
    this.defaultRetryAfter = options.defaultRetryAfter ?? 1_000;
    this.maxRetryAfter = options.maxRetryAfter ?? 60_000;
    this.retryAfterJitter = options.retryAfterJitter ?? 0.25;
    this.maxThrottledWait = options.maxThrottledWait ?? 600_000;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new RangeError("maxAttempts must be an integer of at least 1");
    }
    if (!(this.retryAfterJitter >= 0 && this.retryAfterJitter < 1)) {
      throw new RangeError("retryAfterJitter must be in [0, 1)");
    }
    const { defaultRetryAfter, maxRetryAfter, maxThrottledWait } = this;
    const durations = [defaultRetryAfter, maxRetryAfter, maxThrottledWait];
    if (
      [...this.backoff, ...durations].some((v) => !(v >= 0 && v < Infinity))
    ) {
      throw new RangeError("durations must be finite and not negative");
    }
  }

  /** Milliseconds to pause after the given one-based failed attempt. */
  backoffFor(attempt: number): number {
    if (!this.backoff.length) return 0;
    return this.backoff[Math.min(attempt, this.backoff.length) - 1];
  }

  /** The pause a `429` asks for, in milliseconds, bounded and with jitter applied. */
  retryAfterDelay(headers: Headers): number {
    const raw = (headers.get("retry-after") ?? "").trim();
    let delay = this.defaultRetryAfter;
    if (/^\d+$/.test(raw) && Number(raw) > 0) delay = Number(raw) * 1000;
    delay = Math.min(delay, this.maxRetryAfter);
    return delay + (Math.random() * 2 - 1) * this.retryAfterJitter * delay;
  }
}

/** The settings of a {@link RetryPolicy}, as given to its constructor. */
export type RetryPolicyOptions = Omit<
  RetryPolicy,
  "backoffFor" | "retryAfterDelay"
>;

/** Wait `ms` milliseconds, or reject when `signal` aborts first. */
export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
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
 * A `fetch` that sends the same request (same body, same `Idempotency-Key`)
 * until it succeeds or the policy gives up, with a time limit per attempt.
 *
 * Every answer is returned except a `429` that exhausted the wait budget,
 * which is thrown as a {@link RateLimitedError}. A `429` pauses every request
 * sent through the same `fetch`.
 */
export function retryingFetch(
  fetchImpl: typeof fetch,
  policy: RetryPolicy,
  timeout: number,
): (request: Request) => Promise<Response> {
  let pausedUntil = 0;
  return async (request) => {
    const { signal } = request;
    let attempt = 1;
    let throttled = 0;
    while (true) {
      await sleep(pausedUntil - Date.now(), signal);
      signal.throwIfAborted();
      const limit = AbortSignal.timeout(timeout);
      let response: Response;
      try {
        response = await fetchImpl(request.clone(), {
          signal: AbortSignal.any([signal, limit]),
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof GrepvineError) throw error;
        if (attempt >= policy.maxAttempts) {
          throw new TransportError(
            limit.aborted
              ? `the request timed out after ${timeout} ms`
              : error instanceof Error
                ? error.message
                : String(error),
            { cause: error },
          );
        }
        await sleep(policy.backoffFor(attempt++), signal);
        continue;
      }
      if (response.status === 429) {
        const delay = policy.retryAfterDelay(response.headers);
        if (throttled + delay > policy.maxThrottledWait) {
          const body = await response.json().catch(() => undefined);
          throw mapError(
            429,
            response.headers,
            body,
            ` (slowed down for ${Math.floor(throttled / 1000)}s without success)`,
          );
        }
        throttled += delay;
        pausedUntil = Math.max(pausedUntil, Date.now() + delay);
        await response.body?.cancel();
        continue;
      }
      if (response.status >= 500 && attempt < policy.maxAttempts) {
        await response.body?.cancel();
        await sleep(policy.backoffFor(attempt++), signal);
        continue;
      }
      return response;
    }
  };
}
