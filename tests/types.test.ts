import { expect, it } from "vitest";
import type * as api from "../src/generated/types.gen.js";
import type * as sdk from "../src/index.js";

// The models are written out for the reference documentation; they must stay
// interchangeable with the API's types. A mismatch fails the type check.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

it("matches the API's types", () => {
  const checks: true[] = [
    true satisfies Same<sdk.Organization, api.Organization>,
    true satisfies Same<sdk.Role, api.Role>,
    true satisfies Same<sdk.User, api.User>,
    true satisfies Same<sdk.Member, api.Member>,
    true satisfies Same<sdk.ApiKey, api.ApiKey>,
    true satisfies Same<sdk.ApiKeyCreated, api.ApiKeyCreated>,
    true satisfies Same<sdk.DeviceAuthorization, api.DeviceAuthorization>,
    true satisfies Same<sdk.IndexState, api.IndexState>,
    true satisfies Same<sdk.IndexTags, api.IndexTags>,
    true satisfies Same<sdk.IndexTagChanges, api.IndexTagChanges>,
    true satisfies Same<sdk.IndexData, api.Index>,
    true satisfies Same<sdk.Match, api.Match>,
    true satisfies Same<sdk.ContextLine, api.ContextLine>,
    true satisfies Same<sdk.TaggedMetadataValue, api.MetadataValue>,
  ];
  expect(checks.every(Boolean)).toBe(true);
});
