import { GrepvineError } from "./errors.js";
import type { Page } from "./models.js";

export const MAX_PAGE_SIZE = 200;
const MAX_PAGE_TOKEN_LENGTH = 4096;

/**
 * Options every `list` and `search` accepts.
 *
 * @category Client
 */
export interface PageOptions {
  /** The most results to yield. */
  limit?: number;
  /** A `next_page_id` from an earlier page, to continue from it. */
  page?: string;
  /** How many results each request asks for, 1 to 200. */
  pageSize?: number;
  /** Cancels the requests. */
  signal?: AbortSignal;
}

/** One page as the service reported it, before it is clipped to the limit. */
export interface RawPage<T> {
  results: readonly T[];
  pagination?: { next_page_id?: string; has_next?: boolean };
  common_prefixes?: readonly string[];
}

/** Fetch the page at `token` (undefined for the first page). */
export type PageFetcher<T> = (
  token: string | undefined,
  pageSize: number,
  signal: AbortSignal | undefined,
) => Promise<RawPage<T>>;

/**
 * Validate pagination options and choose the page size.
 *
 * Without an explicit `pageSize`, a `limit` below the maximum page size
 * becomes the page size, so the service stops as soon as enough results exist.
 */
export function resolvePageSize(pageSize?: number, limit?: number): number {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new RangeError("limit must be a whole number, not negative");
  }
  const size =
    pageSize ?? (limit ? Math.min(MAX_PAGE_SIZE, limit) : MAX_PAGE_SIZE);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
    throw new RangeError(`pageSize must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return size;
}

export function validatePageToken(page?: string): string | undefined {
  if (!page) return undefined;
  if (page.length > MAX_PAGE_TOKEN_LENGTH) {
    throw new RangeError("page token is too long");
  }
  return page;
}

/**
 * Every result of a listing or search, fetched page by page as it is iterated.
 *
 * Iterate it with `for await` to get every result; {@link Paginator.pages}
 * yields {@link Page} objects whose `next_page_id` lets a later call continue
 * where this one stopped. Nothing is requested until iteration starts, and
 * each iteration starts over from the beginning.
 *
 * ```ts
 * for await (const doc of index.documents.list({ prefix: "notes/" })) {
 *   console.log(doc.key);
 * }
 * ```
 *
 * @category Client
 */
export class Paginator<T> implements AsyncIterable<T> {
  /** How many results each request asks for. */
  readonly pageSize: number;
  /** The most results the paginator yields, if limited. */
  readonly limit: number | undefined;
  private readonly start: string | undefined;
  private readonly signal: AbortSignal | undefined;

  /** @internal */
  constructor(
    private readonly fetchPage: PageFetcher<unknown>,
    private readonly convert: (item: any) => T,
    options: PageOptions = {},
  ) {
    this.pageSize = resolvePageSize(options.pageSize, options.limit);
    this.limit = options.limit;
    this.start = validatePageToken(options.page);
    this.signal = options.signal;
  }

  /** Yield each page, including an empty page that the service says has more after it. */
  async *pages(): AsyncGenerator<Page<T>, void, undefined> {
    let remaining = this.limit;
    let token = this.start;
    let started = false;
    while (remaining !== 0 && !(started && token === undefined)) {
      const previous = token;
      const raw = await this.fetchPage(token, this.pageSize, this.signal);
      started = true;
      const hasNext = Boolean(raw.pagination?.has_next);
      const next = hasNext
        ? raw.pagination?.next_page_id || undefined
        : undefined;
      if (hasNext) {
        if (next === undefined || next === previous) {
          throw new GrepvineError(
            "the service did not advance to a new page of results",
          );
        }
      }
      token = next;
      let results = raw.results ?? [];
      if (remaining !== undefined) {
        if (results.length > remaining) {
          results = results.slice(0, remaining);
          token = undefined;
        }
        remaining -= results.length;
      }
      yield {
        results: results.map(this.convert),
        next_page_id: next,
        has_next: hasNext,
        page_size: this.pageSize,
        common_prefixes: [...(raw.common_prefixes ?? [])],
      };
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    for await (const page of this.pages()) yield* page.results;
  }

  /** The first result, or undefined when there is none. */
  async first(): Promise<T | undefined> {
    for await (const item of this) return item;
    return undefined;
  }

  /** Every result, collected into an array. */
  async toArray(): Promise<T[]> {
    const items: T[] = [];
    for await (const item of this) items.push(item);
    return items;
  }
}
