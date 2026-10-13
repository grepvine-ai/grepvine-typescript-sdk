import { expect, it } from "vitest";
import * as operations from "../src/generated/sdk.gen.js";

it("exports every public API operation", () => {
  expect(Object.keys(operations).sort()).toEqual(
    [
      "registerUser",
      "getUsernameAvailability",
      "login",
      "logout",
      "getCurrentUser",
      "changePassword",
      "startDeviceAuthorization",
      "approveDeviceAuthorization",
      "denyDeviceAuthorization",
      "pollDeviceToken",
      "listApiKeys",
      "createApiKey",
      "revokeApiKey",
      "listOrganizations",
      "createOrganization",
      "getOrganization",
      "deleteOrganization",
      "listOrganizationMembers",
      "addOrganizationMember",
      "updateOrganizationMember",
      "removeOrganizationMember",
      "transferOrganizationOwnership",
      "listIndexes",
      "createIndex",
      "getIndex",
      "updateIndex",
      "deleteIndex",
      "listDocuments",
      "putDocument",
      "getDocument",
      "deleteDocument",
      "putObjects",
      "deleteObjects",
      "queryIndex",
    ].sort(),
  );
});
