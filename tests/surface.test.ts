import { expect, it } from "vitest";
import * as sdk from "../src/index.js";

it("exports the client, errors and models, and nothing from the API operations", () => {
  expect(Object.keys(sdk).sort()).toEqual(
    [
      "APIError",
      "Account",
      "ApiKeys",
      "AuthenticationError",
      "ConfigurationError",
      "ConflictError",
      "DeviceLogin",
      "Document",
      "DocumentError",
      "DocumentSummary",
      "Documents",
      "GrepvineClient",
      "GrepvineError",
      "Index",
      "Indexes",
      "InvalidPageError",
      "InvalidRequestError",
      "Members",
      "MutationResult",
      "NotFoundError",
      "Organizations",
      "Paginator",
      "PartialBatchError",
      "PayloadTooLargeError",
      "PermissionDeniedError",
      "PreconditionFailedError",
      "RangeNotSatisfiableError",
      "RateLimitedError",
      "RetryPolicy",
      "SearchResult",
      "ServerError",
      "TransportError",
    ].sort(),
  );
});

it("arranges errors in the same hierarchy as the Python SDK", () => {
  expect(
    new sdk.InvalidPageError({
      statusCode: 400,
      code: "invalid_page",
      reason: "",
      message: "m",
    }),
  ).toBeInstanceOf(sdk.InvalidRequestError);
  for (const ErrorClass of [
    sdk.InvalidRequestError,
    sdk.AuthenticationError,
    sdk.PermissionDeniedError,
    sdk.NotFoundError,
    sdk.ConflictError,
    sdk.PreconditionFailedError,
    sdk.PayloadTooLargeError,
    sdk.RangeNotSatisfiableError,
    sdk.RateLimitedError,
    sdk.ServerError,
  ]) {
    const error = new ErrorClass({
      statusCode: 500,
      code: "c",
      reason: "r",
      message: "m",
    });
    expect(error).toBeInstanceOf(sdk.APIError);
    expect(error).toBeInstanceOf(sdk.GrepvineError);
    expect(error.name).toBe(ErrorClass.name);
  }
  expect(new sdk.ConfigurationError("x")).toBeInstanceOf(sdk.GrepvineError);
  expect(new sdk.TransportError("x")).toBeInstanceOf(sdk.GrepvineError);
});

it("exposes every resource on the client", () => {
  const client = new sdk.GrepvineClient({ apiKey: "k" });
  expect(client.organizations).toBeInstanceOf(sdk.Organizations);
  expect(client.organizations.members("acme")).toBeInstanceOf(sdk.Members);
  expect(client.indexes).toBeInstanceOf(sdk.Indexes);
  expect(client.apiKeys).toBeInstanceOf(sdk.ApiKeys);
  expect(client.account).toBeInstanceOf(sdk.Account);
  expect(client.deviceLogin).toBeInstanceOf(sdk.DeviceLogin);
  expect(typeof client.http).toBe("function");
});
