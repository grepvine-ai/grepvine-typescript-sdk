import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as operations from "../src/generated/sdk.gen.js";

// Every API operation has exactly one home in the client: a new operation in
// spec/source.json fails here until a client method calls it.

const source = JSON.parse(readFileSync("spec/source.json", "utf8")) as {
  operations: string[];
};

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === "generated" ? [] : files(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const code = files("src").map((path) => ({
  path,
  text: readFileSync(path, "utf8"),
}));

it.each(source.operations)(
  "%s is called by exactly one client method",
  (operationId) => {
    const name = Object.keys(operations).find(
      (exported) => exported.toLowerCase() === operationId.toLowerCase(),
    );
    expect(name, `no function for ${operationId}`).toBeDefined();
    // Calls of the function itself: not a method of that name, nor its declaration.
    const call = new RegExp(`(?<![\\w.])${name}\\(`, "g");
    const declaration = new RegExp(`^\\s*(?:async\\s+)?${name}\\(`);
    const calls = code.flatMap(({ path, text }) =>
      text
        .split("\n")
        .filter((line) => !declaration.test(line))
        .flatMap((line) => [...line.matchAll(call)].map(() => path)),
    );
    expect(calls, `${operationId} calls`).toHaveLength(1);
    expect(calls[0]).toMatch(/src\/resources\//);
  },
);

it("covers every operation the API defines", () => {
  expect(Object.keys(operations).length).toBe(source.operations.length);
});
