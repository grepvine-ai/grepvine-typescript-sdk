import { expect, it } from "vitest";
import * as sdk from "../src/index.js";

it("exports the client, its resources, the helpers and the errors", () => {
  expect(Object.keys(sdk).sort()).toEqual(
    [
      "APIError",
      "Account",
      "ApiKeys",
      "AuthenticationError",
      "ConfigurationError",
      "ConflictError",
      "DeviceLogin",
      "Documents",
      "GrepvineClient",
      "GrepvineError",
      "Indexes",
      "InvalidPageError",
      "InvalidRequestError",
      "Members",
      "NotFoundError",
      "Organizations",
      "PartialBatchError",
      "PayloadTooLargeError",
      "PermissionDeniedError",
      "PreconditionFailedError",
      "RangeNotSatisfiableError",
      "RateLimitedError",
      "RetryPolicy",
      "Search",
      "ServerError",
      "TransportError",
      "paginate",
    ].sort(),
  );
});

it("puts the helpers on the resources they belong to", () => {
  const client = new sdk.GrepvineClient({ apiKey: "k" });
  expect(client.organizations).toBeInstanceOf(sdk.Organizations);
  expect(client.indexes).toBeInstanceOf(sdk.Indexes);
  expect(client.indexes.waitUntilReady).toBeTypeOf("function");
  expect(client.documents.putMany).toBeTypeOf("function");
  expect(client.deviceLogin.authorize).toBeTypeOf("function");
  expect(client.organizations.members).toBeInstanceOf(sdk.Members);
  expect(client.indexes).toBe(client.indexes);
});

it("keeps the API's names for models and operation types", () => {
  const index: sdk.Index = {
    id: "i",
    organization: "acme",
    name: "docs",
    canonical_id: "i",
    description: "",
    tags: {},
    state: "ready",
    document_count: 0,
    content_bytes: 0,
    created_at: "",
  };
  const data: sdk.ListIndexesData["path"] = {
    organization: index.organization,
  };
  expect(data.organization).toBe("acme");
});
