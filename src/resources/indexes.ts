import {
  createIndex,
  deleteIndex,
  getIndex,
  listIndexes,
  queryIndex,
  updateIndex,
} from "../generated/sdk.gen.js";
import type { QueryRequest } from "../generated/types.gen.js";
import { ConflictError, GrepvineError, NotFoundError } from "../errors.js";
import {
  SearchResult,
  type IndexData,
  type IndexState,
  type IndexTagChanges,
  type IndexTags,
} from "../models.js";
import { Paginator, type PageOptions } from "../paginator.js";
import { unwrap, type Runtime } from "../runtime.js";
import { parseIndexRef, type RequestOptions } from "./common.js";
import { Documents } from "./documents.js";

const MAX_DESCRIPTION_LENGTH = 16384;
const MAX_TAGS = 64;
const MAX_TAG_KEY_LENGTH = 128;
const MAX_TAG_VALUE_LENGTH = 1024;
const MAX_CONTEXT_LINES = 20;
// Control characters (Unicode category Cc).
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function checkDescription(description: string): string {
  if (typeof description !== "string") {
    throw new TypeError("description must be a string");
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new RangeError(
      `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
    );
  }
  return description;
}

function checkTagKey(key: string): void {
  if (key.length < 1 || key.length > MAX_TAG_KEY_LENGTH) {
    throw new RangeError(
      `tag keys must be 1 to ${MAX_TAG_KEY_LENGTH} characters`,
    );
  }
  if (/\s/u.test(key) || CONTROL.test(key)) {
    throw new TypeError(
      `tag key ${JSON.stringify(key)} must not contain whitespace or control characters`,
    );
  }
}

function checkTagValue(key: string, value: unknown): void {
  if (typeof value !== "string") {
    throw new TypeError(
      `the value of tag ${JSON.stringify(key)} must be a string`,
    );
  }
  if (value.length > MAX_TAG_VALUE_LENGTH) {
    throw new RangeError(
      `the value of tag ${JSON.stringify(key)} must be at most ${MAX_TAG_VALUE_LENGTH} characters`,
    );
  }
  if (CONTROL.test(value)) {
    throw new TypeError(
      `the value of tag ${JSON.stringify(key)} must not contain control characters`,
    );
  }
}

function checkTags(tags: IndexTags): IndexTags {
  const entries = Object.entries(tags);
  if (entries.length > MAX_TAGS) {
    throw new RangeError(`an index has at most ${MAX_TAGS} tags`);
  }
  for (const [key, value] of entries) {
    checkTagKey(key);
    checkTagValue(key, value);
  }
  return { ...tags };
}

function checkTagChanges(changes: IndexTagChanges): IndexTagChanges {
  const entries = Object.entries(changes);
  if (entries.length > MAX_TAGS) {
    throw new RangeError(`an update changes at most ${MAX_TAGS} tags`);
  }
  for (const [key, value] of entries) {
    checkTagKey(key);
    if (value !== null) checkTagValue(key, value);
  }
  return { ...changes };
}

/**
 * Options of {@link Indexes.create}.
 *
 * @category Indexes
 */
export interface CreateIndexOptions extends RequestOptions {
  /** What the index holds, in Markdown, at most 16,384 characters. */
  description?: string;
  /** Key/value labels, for example the commit the index was synced from. */
  tags?: IndexTags;
  /**
   * Return an index that already exists as it is, its description and tags
   * untouched, instead of throwing {@link ConflictError}.
   */
  existOk?: boolean;
  /** Return only once the index is ready, as {@link Index.waitUntilReady} does. */
  wait?: boolean;
}

/**
 * Options of {@link Indexes.update} and {@link Index.update}. At least one of
 * `description` and `tags` is needed.
 *
 * @category Indexes
 */
export interface UpdateIndexOptions extends RequestOptions {
  /** Replaces the description; an empty string clears it. */
  description?: string;
  /**
   * Merged into the current tags: every key given is set, a key given as
   * `null` is removed, and keys not mentioned stay as they are.
   */
  tags?: IndexTagChanges;
}

/**
 * Options of {@link Index.waitUntilReady}.
 *
 * @category Indexes
 */
export interface WaitOptions extends RequestOptions {
  /** How long to wait in total, in milliseconds. Default 60,000. */
  timeout?: number;
  /** The pause between checks, in milliseconds. Default 500. */
  interval?: number;
}

/**
 * Options of {@link Index.search}.
 *
 * @category Search
 */
export interface SearchOptions extends PageOptions {
  /** Treat `pattern` as a regular expression (the default); `false` for literal text. */
  regex?: boolean;
  /** Match case exactly (the default). */
  caseSensitive?: boolean;
  /** Match whole words only; needs `regex: false`. */
  wholeWord?: boolean;
  /** Let a match span lines. */
  multiline?: boolean;
  /** One filter expression over document metadata, such as `"path STARTSWITH 'src/'"`. */
  filter?: string;
  /** Several filter expressions, joined with `AND`. */
  filters?: readonly string[];
  /** Context lines to return before each result, at most 20. */
  linesBefore?: number;
  /** Context lines to return after each result, at most 20. */
  linesAfter?: number;
}

export function combineFilters(
  filter: string | undefined,
  filters: readonly string[] | undefined,
): string | undefined {
  if (filter !== undefined && filters !== undefined) {
    throw new TypeError("pass either filter or filters, not both");
  }
  if (filter !== undefined) return filter || undefined;
  if (!filters?.length) return undefined;
  if (filters.some((expression) => !expression)) {
    throw new TypeError("filters must not contain empty expressions");
  }
  if (filters.length === 1) return filters[0];
  return filters.map((expression) => `(${expression})`).join(" AND ");
}

/** Build a search request. Only fields that differ from the defaults are sent. */
export function queryBody(
  pattern: string,
  options: SearchOptions,
): QueryRequest {
  const {
    regex = true,
    caseSensitive = true,
    wholeWord = false,
    multiline = false,
    linesBefore = 0,
    linesAfter = 0,
  } = options;
  if (!pattern) throw new TypeError("pattern must not be empty");
  if (wholeWord && regex)
    throw new TypeError("wholeWord requires regex: false");
  for (const lines of [linesBefore, linesAfter]) {
    if (!Number.isInteger(lines) || lines < 0 || lines > MAX_CONTEXT_LINES) {
      throw new RangeError(
        `linesBefore and linesAfter must be between 0 and ${MAX_CONTEXT_LINES}`,
      );
    }
  }
  const filter = combineFilters(options.filter, options.filters);
  const body: QueryRequest = { pattern };
  if (!regex) body.mode = "literal";
  if (!caseSensitive) body.case_sensitive = false;
  if (wholeWord) body.whole_word = true;
  if (multiline) body.multiline = true;
  if (filter) body.filter = filter;
  if (linesBefore) body.lines_before = linesBefore;
  if (linesAfter) body.lines_after = linesAfter;
  return body;
}

/**
 * The indexes of an organization, reached as `client.indexes`. Indexes are
 * referenced as `"organization/index"`.
 *
 * @category Indexes
 */
export class Indexes {
  /** @internal */
  constructor(private readonly runtime: Runtime) {}

  /**
   * Every index of the organization, or at most `limit` of them.
   *
   * With `prefix`, only the indexes whose names start with it, in any case.
   * A `page` token continues only a listing with the same `prefix`.
   */
  list(
    organization: string,
    options: PageOptions & { prefix?: string } = {},
  ): Paginator<Index> {
    const { prefix } = options;
    return new Paginator(
      async (page, amount, signal) =>
        unwrap(
          await listIndexes({
            ...(await this.runtime.call(signal)),
            path: { organization },
            query: {
              amount,
              ...(page ? { page } : {}),
              ...(prefix !== undefined ? { prefix } : {}),
            },
          }),
        ).data,
      (data: IndexData) => new Index(data, this.runtime),
      options,
    );
  }

  /** The index `"organization/index"`. */
  async get(ref: string, options: RequestOptions = {}): Promise<Index> {
    const path = parseIndexRef(ref);
    const { data } = unwrap(
      await getIndex({ ...(await this.runtime.call(options.signal)), path }),
    );
    return new Index(data, this.runtime);
  }

  /**
   * Create the index `"organization/index"`.
   *
   * With `existOk`, an index that already exists is returned as it is. With
   * `wait`, the index is returned once it is ready.
   */
  async create(ref: string, options: CreateIndexOptions = {}): Promise<Index> {
    const { organization, index: name } = parseIndexRef(ref);
    const body: { name: string; description?: string; tags?: IndexTags } = {
      name,
    };
    if (options.description !== undefined) {
      body.description = checkDescription(options.description);
    }
    if (options.tags !== undefined) body.tags = checkTags(options.tags);
    let index: Index;
    try {
      const { data } = unwrap(
        await createIndex({
          ...(await this.runtime.call(options.signal)),
          path: { organization },
          body,
        }),
      );
      index = new Index(data, this.runtime);
    } catch (error) {
      if (!(error instanceof ConflictError) || !options.existOk) throw error;
      try {
        index = await this.get(ref, options);
      } catch (lookup) {
        // The index vanished between the two requests; report the conflict.
        if (lookup instanceof NotFoundError) throw error;
        throw lookup;
      }
    }
    return options.wait
      ? index.waitUntilReady({ signal: options.signal })
      : index;
  }

  /**
   * Change the description or the tags of the index `"organization/index"`.
   *
   * `description` replaces the current one; an empty string clears it.
   * `tags` is merged into the current tags: every key given is set, a key
   * given as `null` is removed, and keys not mentioned stay as they are. An
   * option left out leaves that field unchanged; at least one is needed.
   */
  async update(ref: string, options: UpdateIndexOptions): Promise<Index> {
    const path = parseIndexRef(ref);
    if (options.description === undefined && options.tags === undefined) {
      throw new TypeError("nothing to change");
    }
    const body: { description?: string; tags?: IndexTagChanges } = {};
    if (options.description !== undefined) {
      body.description = checkDescription(options.description);
    }
    if (options.tags !== undefined) body.tags = checkTagChanges(options.tags);
    const { data } = unwrap(
      await updateIndex({
        ...(await this.runtime.call(options.signal)),
        path,
        body,
      }),
    );
    return new Index(data, this.runtime);
  }

  /** Start deleting the index. Deletion completes in the background. */
  async delete(ref: string, options: RequestOptions = {}): Promise<void> {
    const path = parseIndexRef(ref);
    unwrap(
      await deleteIndex({ ...(await this.runtime.call(options.signal)), path }),
    );
  }

  /** Whether the index exists and is visible to the caller. */
  async exists(ref: string, options: RequestOptions = {}): Promise<boolean> {
    try {
      await this.get(ref, options);
      return true;
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      throw error;
    }
  }
}

/**
 * An index and the operations on it.
 *
 * Its fields are a snapshot from when it was fetched; {@link Index.refresh}
 * returns a new handle with the current values. Methods that change the
 * index return a new handle too.
 *
 * @category Indexes
 */
export class Index {
  /** The index as the API reported it when this handle was created. */
  readonly data: IndexData;
  /** The documents stored in this index. */
  readonly documents: Documents;
  private readonly runtime: Runtime;

  /** @internal */
  constructor(data: IndexData, runtime: Runtime) {
    this.data = Object.freeze({
      ...data,
      tags: Object.freeze({ ...(data.tags ?? {}) }),
    });
    this.runtime = runtime;
    this.documents = new Documents(runtime, data.organization, data.name);
  }

  get id(): string {
    return this.data.id;
  }
  get organization(): string {
    return this.data.organization;
  }
  get name(): string {
    return this.data.name;
  }
  /** The `organization/name` reference of this index. */
  get ref(): string {
    return `${this.data.organization}/${this.data.name}`;
  }
  get canonical_id(): string {
    return this.data.canonical_id;
  }
  /** What the index holds, in Markdown; empty when no description was set. */
  get description(): string {
    return this.data.description ?? "";
  }
  /** The index's key/value labels as of this handle; read-only. */
  get tags(): Readonly<IndexTags> {
    return this.data.tags;
  }
  get state(): IndexState {
    return this.data.state;
  }
  /** How many documents the index held when this handle was created. */
  get document_count(): number {
    return this.data.document_count;
  }
  get content_bytes(): number {
    return this.data.content_bytes;
  }
  get created_at(): string {
    return this.data.created_at;
  }
  get last_updated_at(): string | undefined {
    return this.data.last_updated_at;
  }
  /**
   * How far the index's background optimization has progressed, while one
   * runs. An index from a listing never reports it.
   */
  get optimization_progress_percent(): number | undefined {
    return this.data.optimization_progress_percent;
  }

  private get indexes(): Indexes {
    return new Indexes(this.runtime);
  }

  /** A new handle with the index's current counters and state. */
  refresh(options: RequestOptions = {}): Promise<Index> {
    return this.indexes.get(this.ref, options);
  }

  /** Whether this index still exists. */
  exists(options: RequestOptions = {}): Promise<boolean> {
    return this.indexes.exists(this.ref, options);
  }

  /** Start deleting this index. */
  delete(options: RequestOptions = {}): Promise<void> {
    return this.indexes.delete(this.ref, options);
  }

  /**
   * Change this index's description or tags and return a handle carrying
   * them. This handle keeps the old values.
   */
  update(options: UpdateIndexOptions): Promise<Index> {
    return this.indexes.update(this.ref, options);
  }

  /** Set these tags, keeping every other tag; the same as `update({ tags })`. */
  setTags(tags: IndexTags, options: RequestOptions = {}): Promise<Index> {
    return this.update({ ...options, tags });
  }

  /** Remove these tags, keeping every other tag. */
  removeTags(...keys: string[]): Promise<Index> {
    return this.update({
      tags: Object.fromEntries(keys.map((key) => [key, null])),
    });
  }

  /**
   * Wait until the index is ready and return a handle with its current state.
   *
   * Throws {@link GrepvineError} if the index leaves `creating` for another
   * state, or is not ready within `timeout`.
   */
  async waitUntilReady(options: WaitOptions = {}): Promise<Index> {
    const timeout = options.timeout ?? 60_000;
    const interval = options.interval ?? 500;
    if (!(timeout > 0) || !(interval > 0)) {
      throw new RangeError("timeout and interval must be positive");
    }
    const deadline = this.runtime.now() + timeout;
    let index: Index = this;
    while (true) {
      if (index.state === "ready") return index;
      if (index.state !== "creating") {
        throw new GrepvineError(
          `index ${this.ref} cannot become ready: it is ${index.state}`,
        );
      }
      const left = deadline - this.runtime.now();
      if (left <= 0) {
        throw new GrepvineError(
          `index ${this.ref} was not ready within ${timeout} ms`,
        );
      }
      await this.runtime.sleep(Math.min(interval, left), options.signal);
      index = await index.refresh({ signal: options.signal });
    }
  }

  /**
   * Search the index for `pattern`, a regular expression unless `regex` is
   * `false`.
   *
   * ```ts
   * for await (const result of index.search("TODO|FIXME")) {
   *   console.log(`${result.key}:${result.line_number}: ${result.text}`);
   * }
   * ```
   */
  search(
    pattern: string,
    options: SearchOptions = {},
  ): Paginator<SearchResult> {
    const body = queryBody(pattern, options);
    const path = { organization: this.organization, index: this.name };
    return new Paginator(
      async (page, amount, signal) =>
        unwrap(
          await queryIndex({
            ...(await this.runtime.call(signal)),
            path,
            body,
            query: { amount, ...(page ? { page } : {}) },
          }),
        ).data,
      (data) => new SearchResult(data),
      options,
    );
  }
}
