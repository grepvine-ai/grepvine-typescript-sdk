import {
  deleteDocument,
  deleteObjects,
  getDocument,
  listDocuments,
  putDocument,
  putObjects,
} from "../generated/sdk.gen.js";
import type { Metadata } from "../generated/types.gen.js";
import {
  GrepvineError,
  PartialBatchError,
  PreconditionFailedError,
} from "../errors.js";
import { isNode } from "../config.js";
import { documentMetadata, untag, type MetadataInput } from "../metadata.js";
import {
  Document,
  DocumentError,
  DocumentSummary,
  MutationResult,
  type ContentRange,
} from "../models.js";
import { Paginator, type PageOptions } from "../paginator.js";
import { unwrap, type Runtime } from "../runtime.js";
import {
  checkIdempotencyKey,
  preconditionHeaders,
  type RequestOptions,
} from "./common.js";

export const MAX_BATCH_RECORDS = 2048;
export const MAX_BATCH_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 60 * 1024 * 1024;
const MAX_KEY_LENGTH = 1024;

/**
 * Document content: text, bytes, a `Blob` or `File`, or (in Node.js) a
 * `file:` URL of a file to upload.
 *
 * @category Documents
 */
export type Content = string | Uint8Array | ArrayBuffer | Blob | URL;

/**
 * Options of a single-document {@link Documents.put}.
 *
 * @category Documents
 */
export interface PutOptions extends RequestOptions {
  /** Metadata fields to add, or to override the `path` and `size` the SDK records. */
  metadata?: MetadataInput;
  /** Store the document only if it still has this revision. */
  ifMatch?: string;
  /** Store the document only if it does not exist. */
  ifNoneMatch?: boolean;
  /** The key that makes a repeated write apply once; 16 to 128 characters. */
  idempotencyKey?: string;
}

/**
 * One document of an array-form {@link Documents.put}.
 *
 * @category Documents
 */
export interface DocumentInput {
  key: string;
  content: Content;
  metadata?: MetadataInput;
  ifMatch?: string;
  ifNoneMatch?: boolean;
}

/**
 * One document of an array-form {@link Documents.delete}.
 *
 * @category Documents
 */
export interface DeleteInput {
  key: string;
  ifMatch?: string;
}

/**
 * Options of an array-form write.
 *
 * @category Documents
 */
export interface BatchOptions extends RequestOptions {
  /**
   * The key that makes a repeated write apply once; 16 to 128 characters.
   * Each request of the write uses it with a numbered suffix.
   */
  idempotencyKey?: string;
}

/**
 * Options of {@link Documents.get} and {@link Documents.fetch}.
 *
 * @category Documents
 */
export interface GetOptions extends RequestOptions {
  /**
   * The bytes to read, `[start, end]` inclusive. Leave `start` undefined to
   * read the last `end` bytes, or `end` undefined to read from `start` on.
   */
  range?: [start: number | undefined, end?: number | undefined];
}

/**
 * Options of {@link Documents.list}.
 *
 * @category Documents
 */
export interface ListDocumentsOptions extends PageOptions {
  /** Only documents whose keys start with this text. */
  prefix?: string;
  /**
   * Fold documents that share the text up to the next delimiter (usually
   * `"/"`) into each page's `common_prefixes`.
   */
  delimiter?: string;
}

interface Loaded {
  blob: Blob;
  size: number;
  mtime?: Date;
}

const nodeImport = (name: string): Promise<any> =>
  import(/* webpackIgnore: true */ /* @vite-ignore */ name);

async function loadContent(content: Content): Promise<Loaded> {
  if (typeof content === "string") {
    const bytes = new TextEncoder().encode(content);
    return { blob: new Blob([bytes]), size: bytes.byteLength };
  }
  if (content instanceof Uint8Array) {
    return {
      blob: new Blob([new Uint8Array(content)]),
      size: content.byteLength,
    };
  }
  if (content instanceof ArrayBuffer) {
    return { blob: new Blob([content]), size: content.byteLength };
  }
  if (content instanceof Blob) return { blob: content, size: content.size };
  if (content instanceof URL) {
    if (content.protocol !== "file:" || !isNode()) {
      throw new TypeError("a URL as content must be a file: URL, in Node.js");
    }
    const fs = await nodeImport("node:fs");
    const { fileURLToPath } = await nodeImport("node:url");
    const path = fileURLToPath(content);
    const stat = await fs.promises.stat(path);
    return {
      blob: await fs.openAsBlob(path),
      size: stat.size,
      mtime: stat.mtime,
    };
  }
  throw new TypeError(
    "content must be a string, Uint8Array, ArrayBuffer, Blob or file: URL",
  );
}

const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/** The content as text when it is text, else undefined. */
function asText(content: Content): string | undefined {
  if (typeof content === "string") return content;
  if (content instanceof Uint8Array || content instanceof ArrayBuffer) {
    try {
      return strictDecoder.decode(content);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function checkKey(key: unknown, where: string): string {
  if (typeof key !== "string" || !key) {
    throw new TypeError(`${where} needs a non-empty string key`);
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new RangeError(
      `${where}: document key must be at most ${MAX_KEY_LENGTH} characters`,
    );
  }
  return key;
}

function rangeHeader([start, end]: [
  number | undefined,
  (number | undefined)?,
]): string {
  const check = (n: number | undefined, name: string) => {
    if (n !== undefined && (!Number.isInteger(n) || n < 0)) {
      throw new RangeError(
        `range ${name} must be a whole number, not negative`,
      );
    }
  };
  check(start, "start");
  check(end, "end");
  if (start === undefined && end === undefined) {
    throw new TypeError("range needs a start, an end, or both");
  }
  if (start === undefined) return `bytes=-${end}`;
  if (end === undefined) return `bytes=${start}-`;
  if (end < start) throw new RangeError("range end must not precede its start");
  return `bytes=${start}-${end}`;
}

function revisionFromEtag(value: string | null): string {
  if (!value) return "";
  let revision = value.trim();
  if (revision.startsWith("W/")) revision = revision.slice(2);
  if (
    revision.length >= 2 &&
    revision.startsWith('"') &&
    revision.endsWith('"')
  ) {
    revision = revision.slice(1, -1);
  }
  return revision;
}

function contentRange(value: string | null): ContentRange | undefined {
  const match = value
    ? /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/.exec(value.trim())
    : null;
  if (!match) return undefined;
  const [start, end] = [Number(match[1]), Number(match[2])];
  return { start, end, total: match[3] === "*" ? end + 1 : Number(match[3]) };
}

interface PutRecord {
  key: string;
  content: Content;
  metadata?: MetadataInput;
  ifMatch?: string;
  ifNoneMatch: boolean;
}

type Step =
  | { kind: "batch"; records: PutRecord[]; ndjson: string; keys: string[] }
  | { kind: "single"; record: PutRecord; keys: string[] };

const PUT_FIELDS = new Set([
  "key",
  "content",
  "metadata",
  "ifMatch",
  "ifNoneMatch",
]);
const DELETE_FIELDS = new Set(["key", "ifMatch"]);

function normalizePutInputs(documents: Iterable<DocumentInput>): PutRecord[] {
  const records: PutRecord[] = [];
  let ordinal = 0;
  for (const document of documents) {
    const where = `documents[${ordinal}]`;
    if (!document || typeof document !== "object") {
      throw new TypeError(`${where} must be an object with key and content`);
    }
    const unknown = Object.keys(document).filter(
      (field) => !PUT_FIELDS.has(field),
    );
    if (unknown.length) {
      throw new TypeError(
        `${where} has unknown field(s): ${unknown.sort().join(", ")}`,
      );
    }
    const key = checkKey(document.key, where);
    if (document.content === undefined) {
      throw new TypeError(`${where} (${JSON.stringify(key)}) needs content`);
    }
    if (
      document.ifMatch !== undefined &&
      typeof document.ifMatch !== "string"
    ) {
      throw new TypeError(
        `${where} (${JSON.stringify(key)}): ifMatch must be a string`,
      );
    }
    const ifNoneMatch = Boolean(document.ifNoneMatch);
    if (document.ifMatch !== undefined && ifNoneMatch) {
      throw new TypeError(
        `${where} (${JSON.stringify(key)}): ifMatch and ifNoneMatch cannot be combined`,
      );
    }
    records.push({
      key,
      content: document.content,
      metadata: document.metadata,
      ifMatch: document.ifMatch,
      ifNoneMatch,
    });
    ordinal++;
  }
  return records;
}

function normalizeDeleteInputs(
  keys: Iterable<string | DeleteInput>,
): DeleteInput[] {
  const records: DeleteInput[] = [];
  let ordinal = 0;
  for (const entry of keys) {
    const where = `keys[${ordinal}]`;
    if (typeof entry === "string") {
      records.push({ key: checkKey(entry, where) });
    } else if (entry && typeof entry === "object") {
      const unknown = Object.keys(entry).filter(
        (field) => !DELETE_FIELDS.has(field),
      );
      if (unknown.length) {
        throw new TypeError(
          `${where} has unknown field(s): ${unknown.sort().join(", ")}`,
        );
      }
      const key = checkKey(entry.key, where);
      if (entry.ifMatch !== undefined && typeof entry.ifMatch !== "string") {
        throw new TypeError(
          `${where} (${JSON.stringify(key)}): ifMatch must be a string`,
        );
      }
      records.push(
        entry.ifMatch === undefined ? { key } : { key, ifMatch: entry.ifMatch },
      );
    } else {
      throw new TypeError(`${where} must be a key or an object with a key`);
    }
    ordinal++;
  }
  return records;
}

const encoder = new TextEncoder();

/** One batch record as an NDJSON line, with its UTF-8 content length. */
function ndjsonLine(
  record: PutRecord,
  text: string,
): { line: string; bytes: number } {
  const bytes = encoder.encode(text).byteLength;
  const body: {
    key: string;
    content: string;
    metadata: Metadata;
    if_match?: string;
    if_none_match?: "*";
  } = {
    key: record.key,
    content: text,
    metadata: documentMetadata(record.key, bytes, record.metadata),
  };
  if (record.ifMatch !== undefined) body.if_match = record.ifMatch;
  if (record.ifNoneMatch) body.if_none_match = "*";
  return { line: JSON.stringify(body) + "\n", bytes };
}

/**
 * Group records into bounded batches and single uploads, keeping input order.
 *
 * Text travels in NDJSON batches of at most 2,048 records and 16 MiB of
 * content; binary or larger documents travel one at a time.
 */
export function planBatches(records: PutRecord[]): Step[] {
  const plan: Step[] = [];
  let pending: PutRecord[] = [];
  let lines: string[] = [];
  let pendingBytes = 0;
  const flush = () => {
    if (pending.length) {
      plan.push({
        kind: "batch",
        records: pending,
        ndjson: lines.join(""),
        keys: pending.map((record) => record.key),
      });
    }
    pending = [];
    lines = [];
    pendingBytes = 0;
  };
  for (const record of records) {
    const text = asText(record.content);
    let encoded: { line: string; bytes: number } | undefined;
    if (text !== undefined) {
      encoded = ndjsonLine(record, text);
      if (
        encoded.bytes > MAX_BATCH_CONTENT_BYTES ||
        encoded.line.length > MAX_LINE_BYTES
      ) {
        encoded = undefined;
      }
    }
    if (!encoded) {
      flush();
      plan.push({ kind: "single", record, keys: [record.key] });
      continue;
    }
    if (
      pending.length >= MAX_BATCH_RECORDS ||
      pendingBytes + encoded.bytes > MAX_BATCH_CONTENT_BYTES
    ) {
      flush();
    }
    pending.push(record);
    lines.push(encoded.line);
    pendingBytes += encoded.bytes;
  }
  flush();
  return plan;
}

function batchResults(results: unknown, expected: number): MutationResult[] {
  if (!Array.isArray(results)) {
    throw new GrepvineError(
      "the service returned a batch result without results",
    );
  }
  if (results.length !== expected) {
    throw new GrepvineError(
      `the service returned ${results.length} results for a batch of ${expected} documents`,
    );
  }
  return results.map((item) => MutationResult.fromJSON(item));
}

/**
 * The documents of one index, reached as `index.documents`.
 *
 * @category Documents
 */
export class Documents {
  /** @internal */
  constructor(
    private readonly runtime: Runtime,
    /** The organization of the index. */
    readonly organization: string,
    /** The name of the index. */
    readonly index: string,
  ) {}

  private get path() {
    return { organization: this.organization, index: this.index };
  }

  /**
   * Store one document.
   *
   * The SDK records `path` and `size` metadata (and `mtime` for a file) so
   * filters on them work; `metadata` adds fields or overrides those.
   * A failed `ifMatch` or `ifNoneMatch` condition throws
   * {@link PreconditionFailedError}.
   */
  put(
    key: string,
    content: Content,
    options?: PutOptions,
  ): Promise<MutationResult>;
  /**
   * Store several documents and return one result per document, in input
   * order.
   *
   * Text documents travel in batches of up to 2,048 documents and 16 MiB;
   * binary or larger documents travel one at a time. Each document is stored
   * on its own: one whose `ifMatch` or `ifNoneMatch` condition fails is left
   * unchanged and its result carries an `error`, while the others are
   * stored. See {@link PartialBatchError} for a write that fails part-way.
   */
  put(
    documents: Iterable<DocumentInput>,
    options?: BatchOptions,
  ): Promise<MutationResult[]>;
  async put(
    keyOrDocuments: string | Iterable<DocumentInput>,
    contentOrOptions?: Content | BatchOptions,
    options?: PutOptions,
  ): Promise<MutationResult | MutationResult[]> {
    if (typeof keyOrDocuments === "string") {
      if (contentOrOptions === undefined || contentOrOptions === null) {
        throw new TypeError(
          "put() needs content when storing a single document",
        );
      }
      return this.putOne(
        keyOrDocuments,
        contentOrOptions as Content,
        options ?? {},
      );
    }
    if (options !== undefined) {
      throw new TypeError(
        "in the array form, give content and options inside each document",
      );
    }
    const batch = (contentOrOptions ?? {}) as BatchOptions;
    const records = normalizePutInputs(keyOrDocuments);
    if (!records.length) return [];
    if (batch.idempotencyKey !== undefined)
      checkIdempotencyKey(batch.idempotencyKey);
    const plan = planBatches(records);
    const committed: MutationResult[] = [];
    for (const [position, step] of plan.entries()) {
      const key = batch.idempotencyKey
        ? `${batch.idempotencyKey}-${position}`
        : this.runtime.newId();
      try {
        if (step.kind === "batch") {
          committed.push(...(await this.putBatch(step, key, batch.signal)));
        } else {
          const { record } = step;
          try {
            committed.push(
              await this.putOne(record.key, record.content, {
                metadata: record.metadata,
                ifMatch: record.ifMatch,
                ifNoneMatch: record.ifNoneMatch,
                idempotencyKey: key,
                signal: batch.signal,
              }),
            );
          } catch (error) {
            if (!(error instanceof PreconditionFailedError)) throw error;
            committed.push(
              new MutationResult({
                key: record.key,
                error: new DocumentError({
                  code: error.code,
                  reason: error.reason,
                  message: error.message,
                }),
              }),
            );
          }
        }
      } catch (error) {
        if (!(error instanceof GrepvineError) || !committed.length) throw error;
        throw new PartialBatchError({
          committed,
          failedKeys: step.keys,
          pendingKeys: plan.slice(position + 1).flatMap((later) => later.keys),
          cause: error,
        });
      }
    }
    return committed;
  }

  private async putOne(
    key: string,
    content: Content,
    options: PutOptions,
  ): Promise<MutationResult> {
    checkKey(key, "put()");
    const headers = {
      "Idempotency-Key": checkIdempotencyKey(
        options.idempotencyKey ?? this.runtime.newId(),
      ),
      ...preconditionHeaders(options.ifMatch, options.ifNoneMatch),
    };
    const loaded = await loadContent(content);
    const metadata = documentMetadata(
      key,
      loaded.size,
      options.metadata,
      loaded.mtime,
    );
    const { data } = unwrap(
      await putDocument({
        ...(await this.runtime.call(options.signal)),
        path: this.path,
        headers,
        body: { key, content: loaded.blob, metadata: JSON.stringify(metadata) },
      }),
    );
    return MutationResult.fromJSON(data);
  }

  private async putBatch(
    step: Extract<Step, { kind: "batch" }>,
    idempotencyKey: string,
    signal: AbortSignal | undefined,
  ): Promise<MutationResult[]> {
    const { data } = unwrap(
      await putObjects({
        ...(await this.runtime.call(signal)),
        path: this.path,
        headers: { "Idempotency-Key": idempotencyKey },
        body: step.ndjson,
        // The body is NDJSON already; send it as it is.
        bodySerializer: (body: unknown) => body as string,
      }),
    );
    return batchResults(data?.results, step.records.length);
  }

  /** The content of a document as bytes. Use {@link Documents.fetch} for its revision and metadata too. */
  get(
    key: string,
    options?: GetOptions & { mode?: "bytes" },
  ): Promise<Uint8Array>;
  /** The content of a document as text. */
  get(
    key: string,
    options: GetOptions & { mode: "text"; encoding?: string },
  ): Promise<string>;
  async get(
    key: string,
    options: GetOptions & { mode?: "bytes" | "text"; encoding?: string } = {},
  ): Promise<Uint8Array | string> {
    const { mode = "bytes", encoding, ...rest } = options;
    if (mode !== "bytes" && mode !== "text") {
      throw new TypeError('mode must be "bytes" or "text"');
    }
    const document = await this.fetch(key, rest);
    return mode === "bytes" ? document.content : document.text(encoding);
  }

  /** A document with its content, revision and metadata. */
  async fetch(key: string, options: GetOptions = {}): Promise<Document> {
    checkKey(key, "fetch()");
    const headers: { Accept: string; Range?: string } = {
      Accept: "application/octet-stream",
    };
    if (options.range !== undefined) headers.Range = rangeHeader(options.range);
    const { data, response } = unwrap(
      await getDocument({
        ...(await this.runtime.call(options.signal)),
        path: { ...this.path, key },
        headers,
        parseAs: "arrayBuffer",
      }),
    );
    let metadata: Record<string, unknown> = {};
    const raw = response.headers.get("x-grepvine-metadata");
    if (raw) {
      try {
        metadata = untag(JSON.parse(raw));
      } catch {
        metadata = {};
      }
    }
    return new Document({
      key,
      revision: revisionFromEtag(response.headers.get("etag")),
      content: new Uint8Array(data as unknown as ArrayBuffer),
      metadata,
      content_range:
        response.status === 206
          ? contentRange(response.headers.get("content-range"))
          : undefined,
    });
  }

  /** The documents of the index, optionally under `prefix`. */
  list(options: ListDocumentsOptions = {}): Paginator<DocumentSummary> {
    const { prefix, delimiter } = options;
    if (
      delimiter !== undefined &&
      (delimiter.length < 1 || delimiter.length > 16)
    ) {
      throw new RangeError("delimiter must be 1 to 16 characters");
    }
    return new Paginator(
      async (page, amount, signal) =>
        unwrap(
          await listDocuments({
            ...(await this.runtime.call(signal)),
            path: this.path,
            query: {
              amount,
              ...(page ? { page } : {}),
              ...(prefix ? { prefix } : {}),
              ...(delimiter ? { delimiter } : {}),
            },
          }),
        ).data,
      (data) => new DocumentSummary(data),
      options,
    );
  }

  /**
   * Delete one document. A missing document throws {@link NotFoundError}; a
   * failed `ifMatch` throws {@link PreconditionFailedError}.
   */
  delete(
    key: string,
    options?: RequestOptions & { ifMatch?: string; idempotencyKey?: string },
  ): Promise<MutationResult>;
  /**
   * Delete several documents, given as keys or `{ key, ifMatch }` objects,
   * and return one result per key in input order.
   *
   * Each document is deleted on its own: a missing document, or one whose
   * `ifMatch` fails, is reported by its result's `error` (code `"not_found"`
   * or `"precondition_failed"`) while the others are deleted.
   */
  delete(
    keys: Iterable<string | DeleteInput>,
    options?: BatchOptions,
  ): Promise<MutationResult[]>;
  async delete(
    keyOrKeys: string | Iterable<string | DeleteInput>,
    options: RequestOptions & {
      ifMatch?: string;
      idempotencyKey?: string;
    } = {},
  ): Promise<MutationResult | MutationResult[]> {
    if (typeof keyOrKeys === "string") {
      return this.deleteOne(keyOrKeys, options);
    }
    if (options.ifMatch !== undefined) {
      throw new TypeError("in the array form, give ifMatch inside each object");
    }
    const records = normalizeDeleteInputs(keyOrKeys);
    if (!records.length) return [];
    if (options.idempotencyKey !== undefined)
      checkIdempotencyKey(options.idempotencyKey);
    const committed: MutationResult[] = [];
    const chunks: DeleteInput[][] = [];
    for (let start = 0; start < records.length; start += MAX_BATCH_RECORDS) {
      chunks.push(records.slice(start, start + MAX_BATCH_RECORDS));
    }
    for (const [position, chunk] of chunks.entries()) {
      const key = options.idempotencyKey
        ? `${options.idempotencyKey}-${position}`
        : this.runtime.newId();
      try {
        committed.push(...(await this.deleteBatch(chunk, key, options.signal)));
      } catch (error) {
        if (!(error instanceof GrepvineError) || !committed.length) throw error;
        throw new PartialBatchError({
          committed,
          failedKeys: chunk.map((record) => record.key),
          pendingKeys: chunks
            .slice(position + 1)
            .flat()
            .map((record) => record.key),
          cause: error,
        });
      }
    }
    return committed;
  }

  private async deleteOne(
    key: string,
    options: RequestOptions & { ifMatch?: string; idempotencyKey?: string },
  ): Promise<MutationResult> {
    checkKey(key, "delete()");
    const { data } = unwrap(
      await deleteDocument({
        ...(await this.runtime.call(options.signal)),
        path: { ...this.path, key },
        headers: {
          "Idempotency-Key": checkIdempotencyKey(
            options.idempotencyKey ?? this.runtime.newId(),
          ),
          ...preconditionHeaders(options.ifMatch, false),
        },
      }),
    );
    return MutationResult.fromJSON(data);
  }

  private async deleteBatch(
    chunk: DeleteInput[],
    idempotencyKey: string,
    signal: AbortSignal | undefined,
  ): Promise<MutationResult[]> {
    const objects = chunk.map((record) =>
      record.ifMatch === undefined
        ? { key: record.key }
        : { key: record.key, if_match: record.ifMatch },
    );
    const { data } = unwrap(
      await deleteObjects({
        ...(await this.runtime.call(signal)),
        path: this.path,
        headers: { "Idempotency-Key": idempotencyKey },
        body: { objects },
      }),
    );
    return batchResults(data?.results, chunk.length);
  }
}
