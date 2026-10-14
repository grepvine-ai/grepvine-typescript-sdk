import {
  createIndex,
  deleteIndex,
  getIndex,
  putDocument,
  queryIndex,
} from "./generated/sdk.gen.js";
import type { Client as RawClient } from "./generated/client/index.js";
import type {
  Error as WireError,
  Metadata,
  MutationResult,
  QueryRequest,
} from "./generated/types.gen.js";
import { createGrepvineClient, putObjects } from "./helpers.js";

/** Metadata values; the wrapper supplies the API's type tags. Unsafe integers are rejected. */
export type MetadataInput = Record<string, string | number | boolean | Date>;
/** One text document in a {@link Documents.putMany} batch. */
export type Document = {
  key: string;
  content: string;
  metadata?: MetadataInput;
  ifMatch?: string;
  ifNoneMatch?: boolean;
};
/** Options for {@link IndexHandle.search}. Search is regex unless `literal` is set; `amount` is 1–200. */
export type SearchOptions = {
  literal?: boolean;
  filter?: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  multiline?: boolean;
  linesBefore?: number;
  linesAfter?: number;
  amount?: number;
  signal?: AbortSignal;
};

/** A failed or unreadable API response. `retryAfter` is in seconds, or undefined. */
export class ApiError extends Error {
  readonly code: string;
  readonly reason: string;
  readonly requestId?: string;
  readonly retryAfter?: number;
  constructor(
    readonly status: number,
    error: WireError | undefined,
    readonly headers: Headers,
  ) {
    super(error?.error ?? "The service returned an unexpected response.");
    this.name = "ApiError";
    this.code = error?.code ?? "invalid_response";
    this.reason = error?.reason ?? "response";
    this.requestId = headers.get("X-Request-ID") ?? undefined;
    const retry = headers.get("Retry-After");
    const seconds = retry === null ? NaN : Number(retry);
    if (Number.isFinite(seconds) && seconds >= 0) this.retryAfter = seconds;
  }
}

/** Thrown by {@link Documents.putMany} when any document was not stored. `results` keeps the successes too. */
export class BatchError extends Error {
  readonly failures: MutationResult[];
  constructor(
    readonly results: MutationResult[],
    readonly requestId?: string,
  ) {
    const failures = results.filter((item) => item.error || !item.revision);
    super(`${failures.length} of ${results.length} documents were not stored.`);
    this.name = "BatchError";
    this.failures = failures;
  }
}

function wireError(error: unknown): WireError | undefined {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "reason" in error &&
    "error" in error &&
    typeof error.code === "string" &&
    typeof error.reason === "string" &&
    typeof error.error === "string"
  ) {
    return { code: error.code, reason: error.reason, error: error.error };
  }
}

function checked(response: { error?: unknown; response?: Response }): void {
  if (!response.response) {
    if (response.error instanceof Error) throw response.error;
    throw new Error("The request could not be completed.", {
      cause: response.error,
    });
  }
  if (!response.response.ok)
    throw new ApiError(
      response.response.status,
      wireError(response.error),
      response.response.headers,
    );
}

function result<T>(response: {
  data?: T;
  error?: unknown;
  response?: Response;
}): T {
  checked(response);
  if (response.data === undefined)
    throw new ApiError(
      response.response!.status,
      undefined,
      response.response!.headers,
    );
  return response.data;
}

function reference(ref: string) {
  const parts = ref.split("/");
  if (parts.length !== 2 || parts.some((part) => !part))
    throw new Error("Use an index reference in the form organization/index");
  return { organization: parts[0], index: parts[1] };
}

function idempotency(key?: string): string {
  if (key === "") throw new Error("An idempotency key cannot be empty");
  return key ?? globalThis.crypto.randomUUID();
}

function metadata(values: MetadataInput): Metadata {
  const output = Object.create(null) as Metadata;
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "boolean") output[key] = { type: "boolean", value };
    else if (typeof value === "string") output[key] = { type: "string", value };
    else if (typeof value === "number") {
      if (!Number.isFinite(value))
        throw new Error("Number metadata must be finite");
      if (Number.isInteger(value) && !Number.isSafeInteger(value))
        throw new Error("Integer metadata must be a safe JavaScript integer");
      output[key] = Number.isInteger(value)
        ? { type: "integer", value }
        : { type: "number", value };
    } else if (value instanceof Date) {
      output[key] = { type: "timestamp", value: value.toISOString() };
    } else {
      throw new Error(
        "Metadata values must be strings, numbers, booleans, or dates",
      );
    }
  }
  return output;
}

function batchBody(documents: Iterable<Document>): string {
  const lines: string[] = [];
  let total = 0;
  for (const document of documents) {
    if (lines.length >= 2048)
      throw new Error("putMany accepts at most 2048 documents per call");
    if (typeof document.content !== "string")
      throw new Error(
        "Batch document content must be text; use put for binary content",
      );
    total += new TextEncoder().encode(document.content).byteLength;
    if (total > 16 * 1024 * 1024)
      throw new Error("putMany accepts at most 16 MiB of text per call");
    lines.push(
      JSON.stringify({
        key: document.key,
        content: document.content,
        ...(document.metadata === undefined
          ? {}
          : { metadata: metadata(document.metadata) }),
        ...(document.ifMatch === undefined
          ? {}
          : { if_match: document.ifMatch }),
        ...(document.ifNoneMatch ? { if_none_match: "*" } : {}),
      }),
    );
  }
  if (!lines.length) throw new Error("putMany needs at least one document");
  return lines.join("\n") + "\n";
}

/**
 * Resource handles, Promise-based network methods and async search iterators.
 *
 * `baseUrl` may be given with or without `/v1`. `timeoutMs` applies to each
 * request (default 30,000). `raw` is the generated Fetch client, for use with
 * the raw operations.
 */
export class GrepvineClient {
  readonly raw: RawClient;
  readonly indexes: Indexes;
  readonly timeoutMs: number;
  constructor(options: {
    apiKey: string;
    baseUrl?: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
  }) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0)
      throw new Error(
        "Request timeout must be a positive integer in milliseconds",
      );
    const endpoint = (options.baseUrl ?? "https://api.grepvine.ai").replace(
      /\/+$/,
      "",
    );
    this.raw = createGrepvineClient({
      apiKey: options.apiKey,
      baseUrl: endpoint.endsWith("/v1") ? endpoint : endpoint + "/v1",
      fetch: options.fetch,
    });
    this.indexes = new Indexes(this);
  }

  /**
   * Internal per-call configuration; raw remains available for generated operations.
   * @internal
   */
  options(signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return {
      client: this.raw,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    };
  }
}

/** Index operations, reached as `client.indexes`. */
export class Indexes {
  constructor(private readonly client: GrepvineClient) {}
  /** Build a handle without an HTTP request. info fetches its current state. */
  get(ref: string) {
    return new IndexHandle(this.client, ref);
  }
  /** Create the index `organization/index` and return its handle. */
  async create(
    ref: string,
    options: {
      description?: string;
      tags?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ) {
    const path = reference(ref);
    result(
      await createIndex({
        ...this.client.options(options.signal),
        path: { organization: path.organization },
        body: {
          name: path.index,
          description: options.description,
          tags: options.tags,
        },
      }),
    );
    return this.get(ref);
  }
}

/** One index, named `organization/index`. Creating a handle sends no request. */
export class IndexHandle {
  readonly documents: Documents;
  readonly path: { organization: string; index: string };
  constructor(
    readonly client: GrepvineClient,
    readonly ref: string,
  ) {
    this.path = reference(ref);
    this.documents = new Documents(this);
  }
  /** Fetch the index's current state. */
  async info(options: { signal?: AbortSignal } = {}) {
    return result(
      await getIndex({
        ...this.client.options(options.signal),
        path: this.path,
      }),
    );
  }
  /** Request deletion of the index. */
  async delete(options: { signal?: AbortSignal } = {}) {
    checked(
      await deleteIndex({
        ...this.client.options(options.signal),
        path: this.path,
      }),
    );
  }
  /** Poll until the index is ready. Throws if it leaves `creating` for any other state. */
  async waitReady(
    options: {
      timeoutMs?: number;
      intervalMs?: number;
      signal?: AbortSignal;
    } = {},
  ) {
    const timeout = options.timeoutMs ?? 30_000;
    const interval = options.intervalMs ?? 100;
    if (
      !Number.isSafeInteger(timeout) ||
      timeout <= 0 ||
      !Number.isFinite(interval) ||
      interval <= 0
    ) {
      throw new Error(
        "Readiness timeout and interval must be positive and finite",
      );
    }
    const deadline = AbortSignal.timeout(timeout);
    const signal = options.signal
      ? AbortSignal.any([deadline, options.signal])
      : deadline;
    while (true) {
      signal.throwIfAborted();
      const info = await this.info({ signal });
      if (info.state === "ready") return this;
      if (info.state !== "creating")
        throw new Error(`Index cannot become ready in state ${info.state}`);
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, interval);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  /** Yield every match, following continuation tokens lazily. */
  async *search(pattern: string, options: SearchOptions = {}) {
    const { literal = false, amount = 200, signal } = options;
    const body: QueryRequest = {
      pattern,
      mode: literal ? "literal" : "regex",
      filter: options.filter,
      case_sensitive: options.caseSensitive,
      whole_word: options.wholeWord,
      multiline: options.multiline,
      lines_before: options.linesBefore,
      lines_after: options.linesAfter,
    };
    let page: string | undefined;
    while (true) {
      const response = result(
        await queryIndex({
          ...this.client.options(signal),
          path: this.path,
          body,
          query: { amount, ...(page === undefined ? {} : { page }) },
        }),
      );
      yield* response.results;
      if (!response.pagination.has_next) return;
      page = response.pagination.next_page_id;
    }
  }
}

/** Document operations on one index, reached as `index.documents`. */
export class Documents {
  constructor(private readonly index: IndexHandle) {}
  /**
   * Store one document. Content may be text, a Blob/File, Uint8Array or
   * ArrayBuffer. An idempotency key is generated unless one is supplied.
   */
  async put(
    key: string,
    content: string | Blob | Uint8Array | ArrayBuffer,
    options: {
      metadata?: MetadataInput;
      idempotencyKey?: string;
      ifMatch?: string;
      ifNoneMatch?: boolean;
      signal?: AbortSignal;
    } = {},
  ) {
    const blob =
      content instanceof Blob
        ? content
        : new Blob([
            content instanceof Uint8Array ? new Uint8Array(content) : content,
          ]);
    const response = await putDocument({
      ...this.index.client.options(options.signal),
      path: this.index.path,
      headers: {
        "Idempotency-Key": idempotency(options.idempotencyKey),
        ...(options.ifMatch === undefined
          ? {}
          : { "If-Match": options.ifMatch }),
        ...(options.ifNoneMatch ? { "If-None-Match": "*" as const } : {}),
      },
      body: {
        key,
        content: blob,
        ...(options.metadata === undefined
          ? {}
          : { metadata: JSON.stringify(metadata(options.metadata)) }),
      },
    });
    const stored = result(response);
    if (stored.error || !stored.revision)
      throw new ApiError(
        response.response!.status,
        stored.error,
        response.response!.headers,
      );
    return stored;
  }
  /**
   * Store one batch of up to 2,048 text documents and 16 MiB of UTF-8 content.
   * Batches are not split or retried. Throws {@link BatchError} on any failed
   * document unless `raiseOnError` is false.
   */
  async putMany(
    documents: Iterable<Document>,
    options: {
      idempotencyKey?: string;
      raiseOnError?: boolean;
      signal?: AbortSignal;
    } = {},
  ) {
    const body = batchBody(documents);
    const response = await putObjects({
      ...this.index.client.options(options.signal),
      path: this.index.path,
      headers: { "Idempotency-Key": idempotency(options.idempotencyKey) },
      body,
    });
    const stored = result(response).results;
    if (
      options.raiseOnError !== false &&
      stored.some((item) => item.error || !item.revision)
    ) {
      throw new BatchError(
        stored,
        response.response?.headers.get("X-Request-ID") ?? undefined,
      );
    }
    return stored;
  }
}
