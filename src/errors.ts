import type { MutationResult } from "./models.js";

/**
 * Base class of every error the SDK throws.
 *
 * @category Errors
 */
export class GrepvineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The client is not configured: no API key, or an unusable endpoint or
 * configuration file.
 *
 * @category Errors
 */
export class ConfigurationError extends GrepvineError {}

/**
 * The request could not be delivered after the configured attempts. `cause`
 * is the last failure.
 *
 * @category Errors
 */
export class TransportError extends GrepvineError {}

/**
 * The service answered with an error.
 *
 * `code` says what went wrong in machine-readable form, `message` is the
 * service's sentence about it, and `requestId` identifies the request for
 * support.
 *
 * @category Errors
 */
export class APIError extends GrepvineError {
  /** The HTTP status of the answer. */
  readonly statusCode: number;
  /** What went wrong, in machine-readable form, such as `"not_found"`. */
  readonly code: string;
  /** The broad area of the error, such as `"index"`. */
  readonly reason: string;
  /** The identifier of the request, for support. */
  readonly requestId: string | undefined;
  /** The `Retry-After` interval the service sent, in whole seconds. */
  readonly retryAfter: number | undefined;

  constructor(fields: {
    statusCode: number;
    code: string;
    reason: string;
    message: string;
    requestId?: string;
    retryAfter?: number;
  }) {
    super(fields.message);
    this.statusCode = fields.statusCode;
    this.code = fields.code;
    this.reason = fields.reason;
    this.requestId = fields.requestId;
    this.retryAfter = fields.retryAfter;
  }

  override toString(): string {
    const detail = this.requestId
      ? `${this.code}; request ${this.requestId}`
      : this.code;
    return `${this.name}: ${this.message} (${detail})`;
  }
}

/**
 * The request was rejected (HTTP 400). Fix the input and try again.
 *
 * @category Errors
 */
export class InvalidRequestError extends APIError {}

/**
 * The page token is invalid.
 *
 * Tokens expire after 15 minutes and are valid only with the same arguments,
 * including `pageSize`, as the request that produced them.
 *
 * @category Errors
 */
export class InvalidPageError extends InvalidRequestError {}

/**
 * The API key or session is missing or not valid (HTTP 401).
 *
 * @category Errors
 */
export class AuthenticationError extends APIError {}

/**
 * The API key may not perform this action (HTTP 403).
 *
 * @category Errors
 */
export class PermissionDeniedError extends APIError {}

/**
 * The resource does not exist or is not visible to this API key (HTTP 404).
 *
 * @category Errors
 */
export class NotFoundError extends APIError {}

/**
 * The request conflicts with the current state (HTTP 409), such as creating
 * an index that exists.
 *
 * @category Errors
 */
export class ConflictError extends APIError {}

/**
 * An `ifMatch` or `ifNoneMatch` condition did not hold (HTTP 412).
 *
 * Only the single-document forms throw it. The array forms report a failed
 * condition in the document's {@link MutationResult.error}.
 *
 * @category Errors
 */
export class PreconditionFailedError extends APIError {}

/**
 * The document or batch exceeds a size limit (HTTP 413).
 *
 * @category Errors
 */
export class PayloadTooLargeError extends APIError {}

/**
 * The requested byte range does not overlap the document (HTTP 416).
 *
 * @category Errors
 */
export class RangeNotSatisfiableError extends APIError {}

/**
 * The service asked the client to slow down for longer than the client was
 * willing to wait.
 *
 * @category Errors
 */
export class RateLimitedError extends APIError {}

/**
 * The service failed (HTTP 5xx) on every attempt.
 *
 * @category Errors
 */
export class ServerError extends APIError {}

/**
 * An array-form write failed after the service had answered some of its
 * requests.
 *
 * `committed` holds the results of the documents the service answered for, in
 * input order; a document it left unchanged carries an `error` there.
 * `failedKeys` are the keys of the request that failed; the service may have
 * applied some of them before the failure. `pendingKeys` were never
 * attempted. `cause` is the underlying error. When the write was given an
 * `idempotencyKey`, repeating it with the same key and the same documents
 * finishes it without applying any document twice.
 *
 * @category Errors
 */
export class PartialBatchError extends GrepvineError {
  readonly committed: readonly MutationResult[];
  readonly failedKeys: readonly string[];
  readonly pendingKeys: readonly string[];
  declare readonly cause: GrepvineError;

  constructor(fields: {
    committed: readonly MutationResult[];
    failedKeys: readonly string[];
    pendingKeys: readonly string[];
    cause: GrepvineError;
  }) {
    const applied = fields.committed.filter((result) => result.ok).length;
    const unchanged = fields.committed.length - applied;
    const left = unchanged ? `, ${unchanged} were left unchanged,` : "";
    super(
      `${fields.failedKeys.length} document(s) failed after ${applied} were written${left} ` +
        `and ${fields.pendingKeys.length} were not attempted: ${fields.cause.message}`,
      { cause: fields.cause },
    );
    this.committed = Object.freeze([...fields.committed]);
    this.failedKeys = Object.freeze([...fields.failedKeys]);
    this.pendingKeys = Object.freeze([...fields.pendingKeys]);
  }
}

const BY_STATUS: Record<number, typeof APIError> = {
  400: InvalidRequestError,
  401: AuthenticationError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  412: PreconditionFailedError,
  413: PayloadTooLargeError,
  416: RangeNotSatisfiableError,
  429: RateLimitedError,
};

/** The `Retry-After` header as whole seconds, or undefined when absent or unusable. */
export function parseRetryAfter(headers: Headers): number | undefined {
  const raw = (headers.get("retry-after") ?? "").trim();
  return /^\d+$/.test(raw) ? Number(raw) : undefined;
}

function errorFields(body: unknown, status: number) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      code: "request_failed",
      reason: "http",
      message: `HTTP ${status}`,
    };
  }
  const { code, reason, error } = body as Record<string, unknown>;
  return {
    code: code ? String(code) : "request_failed",
    reason: reason ? String(reason) : "http",
    message: error ? String(error) : `HTTP ${status}`,
  };
}

/** Translate an error answer into the matching {@link APIError} subclass. */
export function mapError(
  status: number,
  headers: Headers,
  body: unknown,
  messageSuffix = "",
): APIError {
  const { code, reason, message } = errorFields(body, status);
  let ErrorClass: typeof APIError;
  if (status === 400 && code === "invalid_page") ErrorClass = InvalidPageError;
  else if (BY_STATUS[status]) ErrorClass = BY_STATUS[status];
  else if (status >= 500) ErrorClass = ServerError;
  else ErrorClass = APIError;
  return new ErrorClass({
    statusCode: status,
    code,
    reason,
    message: message + messageSuffix,
    requestId: headers.get("x-request-id") ?? undefined,
    retryAfter: parseRetryAfter(headers),
  });
}
