/**
 * The Grepvine TypeScript SDK.
 *
 * @packageDocumentation
 */

export { GrepvineClient } from "./client.js";
export type { GrepvineClientOptions, HttpFetch } from "./client.js";
export type { ClientConfig } from "./runtime.js";
export { RetryPolicy } from "./retry.js";
export type { RetryPolicyOptions } from "./retry.js";
export { Paginator } from "./paginator.js";
export type { PageOptions } from "./paginator.js";
export type { RequestOptions } from "./resources/common.js";

export { Organizations, Members } from "./resources/organizations.js";
export type { MemberRole } from "./resources/organizations.js";
export { Indexes, Index } from "./resources/indexes.js";
export type {
  CreateIndexOptions,
  SearchOptions,
  UpdateIndexOptions,
  WaitOptions,
} from "./resources/indexes.js";
export { Documents } from "./resources/documents.js";
export type {
  BatchOptions,
  Content,
  DeleteInput,
  DocumentInput,
  GetOptions,
  ListDocumentsOptions,
  PutOptions,
} from "./resources/documents.js";
export { ApiKeys, Account, DeviceLogin } from "./resources/account.js";
export type {
  AuthorizeOptions,
  ChangePasswordOptions,
  DevicePoll,
  LoginOptions,
  RegisterOptions,
} from "./resources/account.js";
export type { MetadataInput, MetadataValue } from "./metadata.js";

export {
  APIError,
  AuthenticationError,
  ConfigurationError,
  ConflictError,
  GrepvineError,
  InvalidPageError,
  InvalidRequestError,
  NotFoundError,
  PartialBatchError,
  PayloadTooLargeError,
  PermissionDeniedError,
  PreconditionFailedError,
  RangeNotSatisfiableError,
  RateLimitedError,
  ServerError,
  TransportError,
} from "./errors.js";

export {
  Document,
  DocumentError,
  DocumentSummary,
  MutationResult,
  SearchResult,
} from "./models.js";
export type {
  ApiKey,
  ApiKeyCreated,
  ContentRange,
  ContextLine,
  DeviceAuthorization,
  IndexData,
  IndexState,
  IndexTagChanges,
  IndexTags,
  Match,
  Member,
  Organization,
  Page,
  Role,
  Span,
  TaggedMetadataValue,
  User,
} from "./models.js";
