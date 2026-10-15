import {
  DeviceLogin as DeviceLoginOperations,
  Documents as DocumentOperations,
  Indexes as IndexOperations,
} from "./generated/sdk.gen.js";
import type {
  ApiKeyCreated,
  DeviceAuthorization,
  Index,
  Metadata,
  MetadataValue,
  MutationResult,
  PutObjectRecord,
} from "./generated/types.gen.js";
import {
  APIError,
  GrepvineError,
  PartialBatchError,
  PreconditionFailedError,
} from "./errors.js";
import { sleep } from "./retry.js";

/**
 * Indexes of an organization, reached as `client.indexes`.
 *
 * @category Indexes
 */
export class Indexes extends IndexOperations {
  /**
   * Wait until the index is ready to store and search documents, checking
   * every `interval` milliseconds (default 500) for at most `timeout`
   * milliseconds (default 60,000), and return it.
   *
   * An index that is being deleted, or that does not become ready in time,
   * throws {@link GrepvineError}.
   *
   * ```ts
   * await client.indexes.create({ organization: "acme", name: "docs" });
   * const index = await client.indexes.waitUntilReady({ organization: "acme", index: "docs" });
   * ```
   */
  async waitUntilReady(parameters: {
    organization: string;
    index: string;
    timeout?: number;
    interval?: number;
    signal?: AbortSignal;
  }): Promise<Index> {
    const { organization, index, signal } = parameters;
    const { timeout = 60_000, interval = 500 } = parameters;
    if (!(timeout > 0) || !(interval > 0)) {
      throw new RangeError("timeout and interval must be positive");
    }
    const deadline = Date.now() + timeout;
    while (true) {
      const current = await this.get({ organization, index }, { signal });
      if (current.state === "ready") return current;
      if (current.state !== "creating") {
        throw new GrepvineError(
          `index ${organization}/${index} cannot become ready: it is ${current.state}`,
        );
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new GrepvineError(
          `index ${organization}/${index} was not ready within ${timeout} ms`,
        );
      }
      await sleep(Math.min(interval, left), signal);
    }
  }
}

/**
 * One document of {@link Documents.putMany}.
 *
 * Text (a string, or bytes that are valid UTF-8) travels in batches; other
 * content, or text over 16 MiB, is stored on its own.
 *
 * @category Documents
 */
export interface DocumentInput {
  key: string;
  content: string | Uint8Array | Blob;
  /**
   * Fields to store with the document: strings, numbers (whole numbers are
   * stored as integers), booleans, dates, or values tagged as `{ type, value }`.
   */
  metadata?: Record<string, string | number | boolean | Date | MetadataValue>;
  /** Store the document only if it still has this revision. */
  ifMatch?: string;
  /** Store the document only if it does not exist. */
  ifNoneMatch?: boolean;
}

const MAX_BATCH_RECORDS = 2048;
const MAX_BATCH_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function tagValue(
  value: NonNullable<DocumentInput["metadata"]>[string],
): MetadataValue {
  if (value instanceof Date) {
    return { type: "timestamp", value: value.toISOString() };
  }
  if (typeof value === "number") {
    return { type: Number.isInteger(value) ? "integer" : "number", value };
  }
  if (typeof value !== "object") {
    return { type: typeof value, value } as MetadataValue;
  }
  return value;
}

/** The `path` and `size` every stored document carries, then the caller's fields. */
function documentMetadata(document: DocumentInput, size: number): Metadata {
  const metadata: Metadata = {
    path: { type: "string", value: document.key },
    size: { type: "integer", value: size },
  };
  for (const [name, value] of Object.entries(document.metadata ?? {})) {
    metadata[name] = tagValue(value);
  }
  return metadata;
}

function asText(content: DocumentInput["content"]): string | undefined {
  if (typeof content === "string") return content;
  try {
    if (content instanceof Uint8Array) return decoder.decode(content);
  } catch {}
}

type Step =
  | { records: PutObjectRecord[]; keys: string[] }
  | { document: DocumentInput; keys: string[] };

/** Group documents into bounded NDJSON batches and single uploads, in input order. */
function plan(documents: Iterable<DocumentInput>): Step[] {
  const steps: Step[] = [];
  let batch: PutObjectRecord[] = [];
  let bytes = 0;
  const flush = () => {
    if (batch.length)
      steps.push({ records: batch, keys: batch.map((r) => r.key) });
    batch = [];
    bytes = 0;
  };
  for (const document of documents) {
    if (!document?.key) throw new TypeError("every document needs a key");
    if (document.ifMatch !== undefined && document.ifNoneMatch) {
      throw new TypeError(
        `${document.key}: ifMatch and ifNoneMatch cannot be combined`,
      );
    }
    const text = asText(document.content);
    const size = text === undefined ? 0 : encoder.encode(text).byteLength;
    if (text === undefined || size > MAX_BATCH_BYTES) {
      flush();
      steps.push({ document, keys: [document.key] });
      continue;
    }
    if (batch.length >= MAX_BATCH_RECORDS || bytes + size > MAX_BATCH_BYTES) {
      flush();
    }
    batch.push({
      key: document.key,
      content: text,
      metadata: documentMetadata(document, size),
      ...(document.ifMatch !== undefined && { if_match: document.ifMatch }),
      ...(document.ifNoneMatch && { if_none_match: "*" as const }),
    });
    bytes += size;
  }
  flush();
  return steps;
}

/**
 * The documents of an index, reached as `client.documents`.
 *
 * @category Documents
 */
export class Documents extends DocumentOperations {
  /**
   * Store any number of documents and return one result per document, in
   * input order.
   *
   * Text travels as NDJSON in batches of up to 2,048 documents and 16 MiB;
   * other content travels one document at a time. Every document gets `path`
   * (its key) and `size` metadata, which `metadata` can override. Each
   * document is stored on its own: one whose `ifMatch` or `ifNoneMatch`
   * condition fails is left unchanged and its result carries an `error`.
   *
   * A failure after part of the documents were stored throws
   * {@link PartialBatchError}. With `idempotencyKey` (16 to 120 characters),
   * repeating the call with the same documents finishes it without storing
   * any document twice.
   *
   * ```ts
   * const results = await client.documents.putMany({
   *   organization: "acme",
   *   index: "docs",
   *   documents: [{ key: "a.md", content: "# A", metadata: { kind: "guide" } }],
   * });
   * ```
   */
  async putMany(parameters: {
    organization: string;
    index: string;
    documents: Iterable<DocumentInput>;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }): Promise<MutationResult[]> {
    const { organization, index, idempotencyKey, signal } = parameters;
    const steps = plan(parameters.documents);
    const committed: MutationResult[] = [];
    for (const [position, step] of steps.entries()) {
      const headers = idempotencyKey
        ? { "Idempotency-Key": `${idempotencyKey}-${position}` }
        : {};
      try {
        if ("records" in step) {
          const body = step.records.map((r) => JSON.stringify(r) + "\n");
          const { results } = await this.putBatch(
            { organization, index, ...headers, body: body.join("") },
            { signal },
          );
          if (results?.length !== step.records.length) {
            throw new GrepvineError(
              `the service answered ${results?.length ?? 0} results for ${step.records.length} documents`,
            );
          }
          committed.push(...results);
        } else {
          committed.push(
            await this.putOne(
              organization,
              index,
              step.document,
              headers,
              signal,
            ),
          );
        }
      } catch (error) {
        if (!(error instanceof GrepvineError) || !committed.length) throw error;
        throw new PartialBatchError({
          committed,
          failedKeys: step.keys,
          pendingKeys: steps.slice(position + 1).flatMap((later) => later.keys),
          cause: error,
        });
      }
    }
    return committed;
  }

  private async putOne(
    organization: string,
    index: string,
    document: DocumentInput,
    headers: { "Idempotency-Key"?: string },
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const content =
      document.content instanceof Blob
        ? document.content
        : new Blob([document.content as BlobPart]);
    try {
      return await this.put(
        {
          organization,
          index,
          ...headers,
          ...(document.ifMatch !== undefined && {
            "If-Match": document.ifMatch,
          }),
          ...(document.ifNoneMatch && { "If-None-Match": "*" as const }),
          key: document.key,
          content,
          metadata: JSON.stringify(documentMetadata(document, content.size)),
        },
        { signal },
      );
    } catch (error) {
      if (!(error instanceof PreconditionFailedError)) throw error;
      const { code, reason, message } = error;
      return { key: document.key, error: { code, reason, error: message } };
    }
  }
}

/**
 * Logging in devices by approval, reached as `client.deviceLogin`.
 *
 * A device calls {@link DeviceLogin.authorize} (or `start` and `poll`) and
 * shows a code; a person approves it with `approve` from a client that holds
 * a session or an API key, and the device receives an API key of its own.
 *
 * @category Device login
 */
export class DeviceLogin extends DeviceLoginOperations {
  /**
   * Log in this device: start a login, report it through `onCode`, and poll
   * at the service's interval, slowing down when asked, until the key is
   * issued.
   *
   * A denied login throws {@link InvalidRequestError} with code
   * `"access_denied"`. A login that expires, or outlasts `timeout`
   * milliseconds, throws {@link GrepvineError}.
   *
   * ```ts
   * const { key } = await client.deviceLogin.authorize({
   *   apiKeyName: "build agent",
   *   onCode: ({ user_code, verification_uri_complete }) =>
   *     console.log(`Open ${verification_uri_complete} and enter ${user_code}`),
   * });
   * ```
   */
  async authorize(parameters: {
    apiKeyName: string;
    onCode: (authorization: DeviceAuthorization) => void | Promise<void>;
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<ApiKeyCreated> {
    const { signal, timeout } = parameters;
    const authorization = await this.start(
      { api_key_name: parameters.apiKeyName },
      { signal },
    );
    await parameters.onCode(authorization);
    const expires = Date.now() + authorization.expires_in * 1000;
    const deadline =
      timeout === undefined ? expires : Math.min(expires, Date.now() + timeout);
    let interval = Math.max(authorization.interval, 1) * 1000;
    while (Date.now() < deadline) {
      await sleep(Math.min(interval, deadline - Date.now()), signal);
      if (Date.now() >= deadline) break;
      try {
        return await this.poll(
          { device_code: authorization.device_code },
          { signal },
        );
      } catch (error) {
        if (!(error instanceof APIError) || error.statusCode !== 400)
          throw error;
        if (error.code === "slow_down") interval += 5_000;
        else if (error.code !== "authorization_pending") throw error;
      }
    }
    throw new GrepvineError(
      deadline < expires
        ? `the device login was not approved within ${timeout} ms`
        : "the device login expired before it was approved",
    );
  }
}
