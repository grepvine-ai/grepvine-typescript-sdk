import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { fakeClient, json, page } from "./fake.js";

// sdk-operations.json gives every API operation its place on the client; a
// new operation in spec/source.json fails here until it has an entry.

const source = JSON.parse(readFileSync("spec/source.json", "utf8")) as {
  operations: string[];
};
// null keeps an operation out of the SDK.
const map = JSON.parse(readFileSync("sdk-operations.json", "utf8")) as Record<
  string,
  string[] | null
>;
type Operation = {
  operationId: string;
  parameters?: { $ref?: string }[];
  responses: Record<string, { content?: Record<string, { schema: Ref }> }>;
};
type Ref = { $ref?: string };
const spec = JSON.parse(readFileSync("spec/openapi.json", "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, { properties?: object }> };
};
// As in the Python SDK, an operation that takes `page` is paged: `…Page`
// returns one page. When the page holds only `results` and `pagination`, the
// mapped method itself goes through every page.
const pageFields = (operation: Operation) => {
  const ref =
    operation.responses["200"]?.content?.["application/json"]?.schema.$ref;
  const name = ref?.replace("#/components/schemas/", "") ?? "";
  return Object.keys(spec.components.schemas[name]?.properties ?? {}).sort();
};
const takesPage = (operation: Operation) =>
  Boolean(
    operation.parameters?.some(
      (p) => p.$ref === "#/components/parameters/Page",
    ),
  );
const routes = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item).map(([method, operation]) => ({
    mapped: map[operation.operationId],
    paged: takesPage(operation),
    iterated:
      takesPage(operation) &&
      pageFields(operation).join() === "pagination,results",
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
  const methods = Object.values(map)
    .filter((path) => path !== null)
    .map((path) => path.join("."));
  expect(new Set(methods).size).toBe(methods.length);
});

it("pages exactly the listings", () => {
  const operations = (key: "paged" | "iterated") =>
    routes
      .filter((route) => route[key])
      .map((route) => route.operationId)
      .sort();
  expect(operations("paged")).toEqual([
    "listAPIKeys",
    "listAgents",
    "listDocuments",
    "listIndexes",
    "listOrganizationMembers",
    "listOrganizations",
    "queryIndex",
  ]);
  // A document page also carries `common_prefixes`.
  expect(operations("iterated")).toEqual(
    operations("paged").filter((id) => id !== "listDocuments"),
  );
});

it.each(routes.filter((route) => route.mapped))(
  "client.$operationId sends $method $path",
  async ({ path, method, operationId, idempotent, paged, iterated }) => {
    const { client, requests } = fakeClient(() => json(paged ? page([]) : {}));
    const mapped = map[operationId]!;
    let resource = client as unknown as Record<string, unknown>;
    for (const segment of mapped.slice(0, -1)) {
      resource = resource[segment] as Record<string, unknown>;
    }
    const last = mapped.at(-1)!;
    const target = resource[paged ? `${last}Page` : last];
    expect(target, mapped.join(".")).toBeTypeOf("function");
    // Every path parameter is "p"; bodies are left out.
    const names = [...path.matchAll(/{(\w+)}/g)].map((match) => match[1]);
    const parameters: Record<string, unknown> = Object.fromEntries(
      names.map((name) => [name, "p"]),
    );
    if (operationId === "putDocument") parameters.content = new Blob(["x"]);
    await (target as (parameters: object) => Promise<unknown>)(parameters);
    if (iterated) {
      // The mapped method goes through the pages: here, the one empty page.
      const list = resource[last] as (p: object) => AsyncIterable<unknown>;
      for await (const item of list(parameters)) expect.fail(String(item));
    } else if (paged) {
      expect(resource[last]).toBeUndefined();
    }
    expect(requests).toHaveLength(iterated ? 2 : 1);
    expect(requests[0].method).toBe(method);
    expect(new URL(requests[0].url).pathname).toBe(
      "/v1" + path.replace(/{\w+}/g, "p"),
    );
    expect(requests[0].headers.has("Idempotency-Key")).toBe(idempotent);
  },
);
