/**
 * Options every request accepts.
 *
 * @category Client
 */
export interface RequestOptions {
  /** Cancels the request. */
  signal?: AbortSignal;
}

/** Split `"organization/index"` into its two names, as `gv` does. */
export function parseIndexRef(ref: string): {
  organization: string;
  index: string;
} {
  const slash = ref.indexOf("/");
  const organization = slash < 0 ? "" : ref.slice(0, slash);
  const index = slash < 0 ? "" : ref.slice(slash + 1);
  if (!organization || !index || index.includes("/")) {
    throw new TypeError("index must be ORGANIZATION/INDEX");
  }
  return { organization, index };
}

const MIN_IDEMPOTENCY_KEY_LENGTH = 16;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

export function checkIdempotencyKey(key: string): string {
  if (
    key.length < MIN_IDEMPOTENCY_KEY_LENGTH ||
    key.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw new RangeError(
      `idempotencyKey must be ${MIN_IDEMPOTENCY_KEY_LENGTH} to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  return key;
}

export function preconditionHeaders(
  ifMatch: string | undefined,
  ifNoneMatch: boolean | undefined,
): { "If-Match"?: string; "If-None-Match"?: "*" } {
  if (ifMatch !== undefined && ifNoneMatch) {
    throw new TypeError("ifMatch and ifNoneMatch cannot be combined");
  }
  if (ifMatch !== undefined) {
    if (!ifMatch) throw new TypeError("ifMatch must be a revision");
    return { "If-Match": ifMatch };
  }
  return ifNoneMatch ? { "If-None-Match": "*" } : {};
}
