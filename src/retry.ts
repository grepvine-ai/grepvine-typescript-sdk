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
 *
 * @category Client
 */
export class RetryPolicy {
  readonly maxAttempts: number;
  readonly backoff: readonly number[];
  readonly defaultRetryAfter: number;
  readonly maxRetryAfter: number;
  readonly retryAfterJitter: number;
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
    for (const value of [
      ...this.backoff,
      this.defaultRetryAfter,
      this.maxRetryAfter,
      this.maxThrottledWait,
    ]) {
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError("durations must be finite and not negative");
      }
    }
  }

  /** Milliseconds to pause after the given one-based failed attempt. */
  backoffFor(attempt: number): number {
    if (!this.backoff.length) return 0;
    return this.backoff[Math.min(attempt, this.backoff.length) - 1];
  }
}

/**
 * The settings of a {@link RetryPolicy}; every one is optional.
 *
 * @category Client
 */
export interface RetryPolicyOptions {
  /** Attempts per request for `5xx` answers and connection failures. Default 3. */
  maxAttempts: number;
  /** Pauses after each failed attempt, in milliseconds. Default `[100, 200]`. */
  backoff: readonly number[];
  /** The pause after a `429` without `Retry-After`. Default 1,000. */
  defaultRetryAfter: number;
  /** The longest single pause a `429` can impose. Default 60,000. */
  maxRetryAfter: number;
  /** The random adjustment of a pause, as a fraction of it. Default 0.25. */
  retryAfterJitter: number;
  /** The total time one request may spend paused by `429`s. Default 600,000. */
  maxThrottledWait: number;
}

/** The pause a `429` asks for, in milliseconds, bounded and with jitter applied. */
export function retryAfterDelay(
  headers: Headers,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const raw = (headers.get("retry-after") ?? "").trim();
  let delay = policy.defaultRetryAfter;
  if (/^\d+$/.test(raw) && Number(raw) > 0) delay = Number(raw) * 1000;
  delay = Math.min(delay, policy.maxRetryAfter);
  const jitter = (random() * 2 - 1) * policy.retryAfterJitter * delay;
  return delay + jitter;
}

/** The client-wide pause that a `429` imposes on every request. */
export class Throttle {
  private until = 0;

  /** Extend the pause to at least `now + delay`. */
  slow(now: number, delay: number): void {
    this.until = Math.max(this.until, now + delay);
  }

  /** Milliseconds left in the current pause. */
  remaining(now: number): number {
    return Math.max(0, this.until - now);
  }
}
