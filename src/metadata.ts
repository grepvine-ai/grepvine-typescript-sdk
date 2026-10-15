import type { Metadata } from "./generated/types.gen.js";
import type { TaggedMetadataValue } from "./models.js";

/**
 * A plain metadata value: text, a boolean, a number or a date.
 *
 * Whole numbers are stored as integers and must be safe JavaScript integers;
 * other finite numbers are stored as numbers. Dates are stored as timestamps.
 *
 * @category Documents
 */
export type MetadataValue = string | number | boolean | Date;

/**
 * Metadata as given to the SDK: plain values, or values already tagged as
 * `{ type, value }`.
 *
 * @category Documents
 */
export type MetadataInput = Record<string, MetadataValue | TaggedMetadataValue>;

const TYPE_TAGS = new Set([
  "string",
  "integer",
  "number",
  "boolean",
  "timestamp",
]);
export const MAX_METADATA_FIELDS = 64;

/** Tag one plain value; an already tagged value passes through after a check. */
export function tagValue(value: unknown): TaggedMetadataValue {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError("timestamp metadata must be a valid date");
    }
    return { type: "timestamp", value: value.toISOString() };
  }
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("number metadata must be finite");
    }
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) {
        throw new RangeError(
          "integer metadata must be a safe JavaScript integer",
        );
      }
      return { type: "integer", value };
    }
    return { type: "number", value };
  }
  if (value && typeof value === "object") {
    const tagged = value as { type?: unknown; value?: unknown };
    if (!TYPE_TAGS.has(tagged.type as string) || !("value" in tagged)) {
      throw new TypeError(
        "a tagged metadata value needs a 'type' of string, integer, number, " +
          "boolean or timestamp and a 'value'",
      );
    }
    return { type: tagged.type, value: tagged.value } as TaggedMetadataValue;
  }
  throw new TypeError(
    `metadata values must be strings, numbers, booleans or dates, not ${typeof value}`,
  );
}

/** Tag every value of a metadata object. */
export function tag(metadata: MetadataInput): Metadata {
  const tagged: Metadata = {};
  for (const [name, value] of Object.entries(metadata)) {
    if (!name) throw new TypeError("metadata field names must not be empty");
    tagged[name] = tagValue(value);
  }
  return tagged;
}

/** Turn one tagged value back into a plain value; unknown shapes are returned as they are. */
export function untagValue(wire: unknown): unknown {
  if (!wire || typeof wire !== "object" || !("value" in wire)) return wire;
  const { type, value } = wire as { type?: unknown; value: unknown };
  if (type === "timestamp" && typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date;
  }
  return value;
}

/** Turn a tagged metadata object into plain values. */
export function untag(wire: unknown): Record<string, unknown> {
  if (!wire || typeof wire !== "object") return {};
  const plain: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(wire)) {
    plain[name] = untagValue(value);
  }
  return plain;
}

/**
 * The metadata of a stored document: the `path` and `size` the SDK records
 * (and `mtime` for a file), overlaid with the caller's fields, which win.
 */
export function documentMetadata(
  key: string,
  size: number,
  metadata?: MetadataInput,
  mtime?: Date,
): Metadata {
  const merged: Metadata = {
    path: { type: "string", value: key },
    size: { type: "integer", value: size },
  };
  if (mtime) merged.mtime = { type: "timestamp", value: mtime.toISOString() };
  if (metadata) Object.assign(merged, tag(metadata));
  if (Object.keys(merged).length > MAX_METADATA_FIELDS) {
    throw new RangeError(
      `a document may carry at most ${MAX_METADATA_FIELDS} metadata fields`,
    );
  }
  return merged;
}
