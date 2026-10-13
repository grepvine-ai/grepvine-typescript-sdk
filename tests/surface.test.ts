import { expect, it } from "vitest";
import * as operations from "../src/generated/sdk.gen.js";

it("exports only index, document, search, and CLI device-login operations", () => {
  expect(Object.keys(operations).sort()).toEqual(
    [
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
      "startDeviceAuthorization",
      "pollDeviceToken",
    ].sort(),
  );
});
