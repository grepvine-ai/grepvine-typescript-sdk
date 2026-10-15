import type { MutationResult } from "./generated/types.gen.js";

/**
 * Base class of every error the SDK throws.
 */
export class GrepvineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The client is not configured correctly, such as an unusable endpoint. */
export class ConfigurationError extends GrepvineError {}

/** The request could not be delivered after the configured attempts. `cause` is the last failure. */
export class TransportError extends GrepvineError {}

/**
 * The service answered with an error.
 *
 * `code` says what went wrong in machine-readable form, `message` is the
 * service's sentence about it, and `requestId` identifies the request for
 * support.
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

/** The request was rejected (HTTP 400). Fix the input and try again. */
export class InvalidRequestError extends APIError {}

/** The page token is invalid.  Tokens expire after 15 minutes and are valid only with the same arguments, including `amount`, as the request that produced them. */
export class InvalidPageError extends InvalidRequestError {}

/** The API key or session is missing or not valid (HTTP 401). */
export class AuthenticationError extends APIError {}

/** The API key may not perform this action (HTTP 403). */
export class PermissionDeniedError extends APIError {}

/** The resource does not exist or is not visible to this API key (HTTP 404). */
export class NotFoundError extends APIError {}

/** The request conflicts with the current state (HTTP 409), such as creating an index that exists. */
export class ConflictError extends APIError {}

/** An `If-Match` or `If-None-Match` condition did not hold (HTTP 412). */
export class PreconditionFailedError extends APIError {}

/** The document or batch exceeds a size limit (HTTP 413). */
export class PayloadTooLargeError extends APIError {}

/** The requested byte range does not overlap the document (HTTP 416). */
export class RangeNotSatisfiableError extends APIError {}

/** The service asked the client to slow down for longer than the client was willing to wait. */
export class RateLimitedError extends APIError {}

/** The service failed (HTTP 5xx) on every attempt. */
export class ServerError extends APIError {}

/**
 * A {@link Documents.putMany} failed after the service had stored some of its
 * documents.
 *
 * `committed` holds the results of the documents the service answered for, in
 * input order. `failedKeys` are the keys of the request that failed; the
 * service may have stored some of them. `pendingKeys` were never sent.
 * `cause` is the underlying error. Repeating the call with the same
 * `idempotencyKey` and documents finishes it without storing any document
 * twice.
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
    super(
      `${fields.failedKeys.length} document(s) failed after ${fields.committed.length} were answered ` +
        `and ${fields.pendingKeys.length} were not sent: ${fields.cause.message}`,
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

/** Translate an error answer into the matching {@link APIError} subclass. */
export function mapError(
  status: number,
  headers: Headers,
  body: unknown,
  messageSuffix = "",
): APIError {
  const fields =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code = fields.code ? String(fields.code) : "request_failed";
  const retryAfter = (headers.get("retry-after") ?? "").trim();
  let ErrorClass = BY_STATUS[status] ?? APIError;
  if (status === 400 && code === "invalid_page") ErrorClass = InvalidPageError;
  else if (status >= 500) ErrorClass = ServerError;
  return new ErrorClass({
    statusCode: status,
    code,
    reason: fields.reason ? String(fields.reason) : "http",
    message:
      (fields.error ? String(fields.error) : `HTTP ${status}`) + messageSuffix,
    requestId: headers.get("x-request-id") ?? undefined,
    retryAfter: /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined,
  });
}
