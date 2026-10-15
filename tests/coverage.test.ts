import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { fakeClient, json } from "./fake.js";

// sdk-operations.json gives every API operation its place on the client; a
// new operation in spec/source.json fails here until it has an entry.

const source = JSON.parse(readFileSync("spec/source.json", "utf8")) as {
  operations: string[];
};
const map = JSON.parse(readFileSync("sdk-operations.json", "utf8")) as Record<
  string,
  string[]
>;
type Operation = { operationId: string; parameters?: { $ref?: string }[] };
const spec = JSON.parse(readFileSync("spec/openapi.json", "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
};
const routes = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item).map(([method, operation]) => ({
    path,
    method: method.toUpperCase(),
    operationId: operation.operationId,
    // Browsers may send only the headers a route declares.
    idempotent: Boolean(
      operation.parameters?.some(
        (p) => p.$ref === "#/components/parameters/IdempotencyKey",
      ),
    ),
  })),
);

it("maps exactly the operations of the API", () => {
  expect(Object.keys(map).sort()).toEqual([...source.operations].sort());
  expect(routes.map((route) => route.operationId).sort()).toEqual(
    [...source.operations].sort(),
  );
  const methods = Object.values(map).map((path) => path.join("."));
  expect(new Set(methods).size).toBe(methods.length);
});

it.each(routes)(
  "client.$operationId sends $method $path",
  async ({ path, method, operationId, idempotent }) => {
    const { client, requests } = fakeClient(() => json({}));
    let target: unknown = client;
    for (const segment of map[operationId]) {
      target = (target as Record<string, unknown>)[segment];
    }
    expect(target, map[operationId].join(".")).toBeTypeOf("function");
    // Every path parameter is "p"; bodies are left out.
    const names = [...path.matchAll(/{(\w+)}/g)].map((match) => match[1]);
    const parameters: Record<string, unknown> = Object.fromEntries(
      names.map((name) => [name, "p"]),
    );
    if (operationId === "putDocument") parameters.content = new Blob(["x"]);
    await (target as (parameters: object) => Promise<unknown>)(parameters);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe(method);
    expect(new URL(requests[0].url).pathname).toBe(
      "/v1" + path.replace(/{\w+}/g, "p"),
    );
    expect(requests[0].headers.has("Idempotency-Key")).toBe(idempotent);
  },
);
