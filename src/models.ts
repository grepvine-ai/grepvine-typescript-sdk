import type * as api from "./generated/types.gen.js";
import { untag } from "./metadata.js";

// Data the SDK returns keeps the API's field names (`created_at`,
// `line_number`); arguments and options use camelCase.

/**
 * A role in an organization.
 *
 * @category Models
 */
export type Role = "owner" | "admin" | "developer" | "reader";

/**
 * An organization the caller can see, with the caller's role in it.
 *
 * @category Models
 */
export interface Organization {
  id: string;
  name: string;
  role: Role;
  created_at: string;
}

/**
 * An account.
 *
 * @category Models
 */
export interface User {
  id: string;
  name: string;
  email: string;
  created_at: string;
}

/**
 * A member of an organization and their role.
 *
 * @category Models
 */
export interface Member {
  user: User;
  role: Role;
  created_at: string;
}

/**
 * An API key. Its secret is shown only once, in {@link ApiKeyCreated}.
 *
 * @category Models
 */
export interface ApiKey {
  id: string;
  name: string;
  /** The first characters of the key, to recognize it by. */
  prefix: string;
  created_at: string;
  last_used_at?: string;
  revoked_at?: string;
}

/**
 * A new API key, including its secret `key`, which is shown only once.
 *
 * @category Models
 */
export interface ApiKeyCreated extends ApiKey {
  key: string;
}

/**
 * A device login in progress: the code to show the person approving it, and
 * where they approve it.
 *
 * @category Models
 */
export interface DeviceAuthorization {
  /** The code the device polls with; keep it private. */
  device_code: string;
  /** The code the person approving the login enters. */
  user_code: string;
  verification_uri: string;
  /** `verification_uri` with the code filled in. */
  verification_uri_complete: string;
  /** Seconds until the login expires. */
  expires_in: number;
  /** Seconds to wait between polls. */
  interval: number;
}

/**
 * The lifecycle state of an index.
 *
 * @category Models
 */
export type IndexState = "creating" | "ready" | "deleting" | "delete_failed";

/**
 * Key/value labels on an index. At most 64; a key is 1 to 128 characters
 * without whitespace or control characters, a value at most 1,024 characters
 * without control characters.
 *
 * @category Models
 */
export interface IndexTags {
  [key: string]: string;
}

/**
 * Tags to set, by key, and tags to remove, given as `null`.
 *
 * @category Models
 */
export interface IndexTagChanges {
  [key: string]: string | null;
}

/**
 * The fields of an index as the API reports them.
 *
 * `document_count` and the other counters are a snapshot from the time the
 * index was fetched. `description` is Markdown, and empty when none was set.
 * `tags` are the index's key/value labels as of the same moment.
 *
 * @category Models
 */
export interface IndexData {
  id: string;
  organization: string;
  name: string;
  canonical_id: string;
  description: string;
  tags: IndexTags;
  state: IndexState;
  document_count: number;
  content_bytes: number;
  created_at: string;
  last_updated_at?: string;
  /**
   * How far the index's background optimization has progressed, as a
   * percentage, while one runs. Only a read of one index reports it.
   */
  optimization_progress_percent?: number;
}

/**
 * One match, as a byte offset and length within the document.
 *
 * @category Search
 */
export interface Match {
  offset: number;
  length: number;
}

/**
 * One line near a search result.
 *
 * @category Search
 */
export interface ContextLine {
  line_number: number;
  text: string;
  text_truncated: boolean;
}

/**
 * A metadata value tagged with its type, as the API stores it.
 *
 * @category Models
 */
export type TaggedMetadataValue =
  | { type: "string"; value: string }
  | { type: "integer"; value: number }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "timestamp"; value: string };

/**
 * Why an array-form write left one document unchanged.
 *
 * `code` is `"precondition_failed"` when the document's `ifMatch` or
 * `ifNoneMatch` condition did not hold, and `"not_found"` when a document to
 * delete does not exist. `message` is the service's sentence about it. The
 * fields mean what they mean on {@link APIError}.
 *
 * @category Models
 */
export class DocumentError {
  readonly code: string;
  readonly reason: string;
  readonly message: string;

  constructor(fields: { code: string; reason: string; message: string }) {
    this.code = fields.code;
    this.reason = fields.reason;
    this.message = fields.message;
  }

  toString(): string {
    return `${this.message} (${this.code})`;
  }

  /** @internal */
  static fromJSON(data: unknown): DocumentError | undefined {
    if (!data || typeof data !== "object") return undefined;
    const { code, reason, error } = data as Record<string, unknown>;
    return new DocumentError({
      code: code ? String(code) : "request_failed",
      reason: reason ? String(reason) : "",
      message: error ? String(error) : "the document was not changed",
    });
  }
}

/**
 * The outcome of storing or deleting one document.
 *
 * A document that was stored or deleted has its new `revision` and no
 * `error`. In the array forms of `put` and `delete`, every document has a
 * result; one the write left unchanged has an `error` saying why and no
 * revision. The single-document forms throw the matching {@link APIError}
 * instead.
 *
 * @category Models
 */
export class MutationResult {
  readonly key: string;
  readonly revision: string | undefined;
  readonly error: DocumentError | undefined;

  constructor(fields: {
    key: string;
    revision?: string;
    error?: DocumentError;
  }) {
    this.key = fields.key;
    this.revision = fields.revision || undefined;
    this.error = fields.error;
  }

  /** Whether the document was stored or deleted. */
  get ok(): boolean {
    return this.error === undefined;
  }

  /** @internal */
  static fromJSON(data: api.MutationResult): MutationResult {
    return new MutationResult({
      key: String(data.key),
      revision: data.revision ? String(data.revision) : undefined,
      error: DocumentError.fromJSON(data.error),
    });
  }
}

/**
 * One entry of a document listing. `metadata` holds plain values.
 *
 * @category Models
 */
export class DocumentSummary {
  readonly key: string;
  readonly revision: string;
  readonly content_bytes: number;
  readonly metadata: Record<string, unknown>;
  readonly updated_at: string;
  /** Whether a search can match this document. */
  readonly searchable: boolean;

  /** @internal */
  constructor(data: api.DocumentSummary) {
    this.key = data.key;
    this.revision = data.revision;
    this.content_bytes = data.content_bytes;
    this.metadata = untag(data.metadata);
    this.updated_at = data.updated_at;
    this.searchable = data.searchable;
  }

  /** The document's size in bytes. */
  get size(): number {
    return this.content_bytes;
  }
}

/**
 * The byte range a partial document read covers (inclusive), with the
 * document's total size.
 *
 * @category Models
 */
export interface ContentRange {
  start: number;
  end: number;
  total: number;
}

/**
 * A document's content together with its revision and metadata.
 *
 * @category Models
 */
export class Document {
  readonly key: string;
  readonly revision: string;
  readonly content: Uint8Array;
  readonly metadata: Record<string, unknown>;
  /** The range read, when only part of the document was requested. */
  readonly content_range: ContentRange | undefined;

  /** @internal */
  constructor(fields: {
    key: string;
    revision: string;
    content: Uint8Array;
    metadata: Record<string, unknown>;
    content_range?: ContentRange;
  }) {
    this.key = fields.key;
    this.revision = fields.revision;
    this.content = fields.content;
    this.metadata = fields.metadata;
    this.content_range = fields.content_range;
  }

  /** The size of the whole document in bytes. */
  get size(): number {
    return this.content_range?.total ?? this.content.byteLength;
  }

  /** The content decoded as text. */
  text(encoding = "utf-8"): string {
    return new TextDecoder(encoding).decode(this.content);
  }
}

/**
 * A half-open `[start, end)` range of positions in a result's `text`.
 *
 * @category Search
 */
export interface Span {
  start: number;
  end: number;
}

const encoder = new TextEncoder();

/**
 * One match, or several matches that share lines, together with the lines it
 * covers.
 *
 * Offsets and lengths reported by the API count bytes within the document.
 * Use {@link SearchResult.matchSpans} for positions within `text`, and
 * {@link SearchResult.matchTexts} for the matched strings.
 *
 * @category Search
 */
export class SearchResult {
  readonly key: string;
  readonly revision: string;
  /** One-based number of the first line the result covers. */
  readonly line_number: number;
  /** One-based number of the last line the result covers. */
  readonly last_line_number: number;
  readonly line_start_offset: number;
  readonly line_end_offset: number;
  /** Byte offset of the first byte of `text` within the document. */
  readonly text_start_offset: number;
  /** One-based number of the line `text` begins on. */
  readonly text_line_number: number;
  /** The covered lines, without the last line's break. */
  readonly text: string;
  readonly matches: readonly Match[];
  readonly text_truncated: boolean;
  readonly matches_truncated: boolean;
  /** The requested lines before the result; empty when none were asked for. */
  readonly lines_before: readonly ContextLine[];
  /** The requested lines after the result; empty when none were asked for. */
  readonly lines_after: readonly ContextLine[];

  /** @internal */
  constructor(data: api.QueryResult) {
    this.key = data.key;
    this.revision = data.revision;
    this.line_number = data.line_number;
    this.last_line_number = data.last_line_number;
    this.line_start_offset = data.line_start_offset;
    this.line_end_offset = data.line_end_offset;
    this.text_start_offset = data.text_start_offset;
    this.text_line_number = data.text_line_number;
    this.text = data.text;
    this.matches = data.matches ?? [];
    this.text_truncated = data.text_truncated;
    this.matches_truncated = data.matches_truncated;
    this.lines_before = data.lines_before ?? [];
    this.lines_after = data.lines_after ?? [];
  }

  /** The covered text as UTF-8 bytes, the unit the API's offsets count. */
  get textBytes(): Uint8Array {
    return encoder.encode(this.text);
  }

  /** The covered lines of `text`. */
  get lines(): string[] {
    return this.text.split("\n");
  }

  /** The covered lines of `text` paired with their one-based line numbers. */
  numberedLines(): [number, string][] {
    return this.lines.map((line, i) => [this.text_line_number + i, line]);
  }

  /**
   * Each match as a byte range within {@link SearchResult.textBytes}.
   *
   * A match that consumed the last line's break extends one byte past the
   * text; such a span is clipped to the text.
   */
  matchByteSpans(): Span[] {
    const limit = this.textBytes.byteLength;
    const clip = (n: number) => Math.min(Math.max(n, 0), limit);
    return this.matches.map((match) => ({
      start: clip(match.offset - this.text_start_offset),
      end: clip(match.offset + match.length - this.text_start_offset),
    }));
  }

  /**
   * Each match as a range of UTF-16 positions within `text`, ready for
   * `text.slice(start, end)`.
   */
  matchSpans(): Span[] {
    // byteStarts[i] is the byte offset at which UTF-16 position i begins.
    const byteStarts: number[] = [0];
    let bytes = 0;
    for (const char of this.text) {
      const code = char.codePointAt(0)!;
      const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      // The second half of a surrogate pair begins inside the character.
      if (char.length === 2) byteStarts.push(bytes + 0.5);
      bytes += width;
      byteStarts.push(bytes);
    }
    const position = (byte: number) => {
      let low = 0;
      let high = byteStarts.length - 1;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (byteStarts[mid] < byte) low = mid + 1;
        else high = mid;
      }
      return low;
    };
    return this.matchByteSpans().map((span) => ({
      start: position(span.start),
      end: position(span.end),
    }));
  }

  /** The matched text of each match. */
  matchTexts(): string[] {
    return this.matchSpans().map((span) =>
      this.text.slice(span.start, span.end),
    );
  }
}

/**
 * One page of results.
 *
 * Pass `next_page_id` back as `page` and `page_size` as `pageSize`, with every
 * other argument unchanged, to continue from this page. A token is valid for
 * 15 minutes.
 *
 * @category Client
 */
export interface Page<T> {
  readonly results: readonly T[];
  readonly next_page_id: string | undefined;
  readonly has_next: boolean;
  readonly page_size: number;
  /** The folded prefixes of a document listing with a delimiter. */
  readonly common_prefixes: readonly string[];
}
