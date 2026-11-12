import { readFileSync } from "node:fs";
import { defineConfig } from "@hey-api/openapi-ts";

// Where each operation lives on the client: resource path, then method name.
// Shared with the Python SDK; tests/coverage.test.ts checks it is complete.
// null keeps an operation out of the SDK, such as the sign-in page's own
// requests; the models only it uses are left out with it.
const operations: Record<string, string[] | null> = JSON.parse(
  readFileSync(new URL("./sdk-operations.json", import.meta.url), "utf8"),
);

type Spec = {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, object>;
    parameters: Record<string, { required?: boolean }>;
  };
};
type Operation = {
  operationId?: string;
  parameters?: { $ref?: string }[];
  requestBody?: { content: Record<string, { schema: { $ref?: string } }> };
};

const schemaRef = "#/components/schemas/";

export default defineConfig({
  input: "./spec/openapi.json",
  parser: {
    patch: {
      // How the client presents the spec; spec/openapi.json stays unchanged.
      input: (input) => {
        const spec = input as unknown as Spec;
        // The client sends both headers itself: the CSRF token of a session
        // after `account.login`, and an idempotency key on every write.
        spec.components.parameters.IdempotencyKey.required = false;
        for (const [path, item] of Object.entries(spec.paths)) {
          for (const [method, operation] of Object.entries(item)) {
            if (operations[operation.operationId ?? ""] === null)
              delete item[method];
          }
          if (Object.keys(item).length === 0) delete spec.paths[path];
        }
        for (const item of Object.values(spec.paths)) {
          for (const operation of Object.values(item)) {
            operation.parameters = operation.parameters?.filter(
              (parameter) =>
                parameter.$ref !== "#/components/parameters/CSRFToken",
            );
            // An inline object body becomes method parameters of its own
            // (`indexes.create({ organization, name })`) instead of one
            // parameter holding the whole body.
            for (const media of Object.values(
              operation.requestBody?.content ?? {},
            )) {
              const ref = media.schema.$ref;
              if (ref?.startsWith(schemaRef)) {
                media.schema = structuredClone(
                  spec.components.schemas[ref.slice(schemaRef.length)],
                );
              }
            }
          }
        }
      },
    },
  },
  output: {
    path: "src/generated",
    postProcess: [
      {
        command: "prettier",
        args: ["{{path}}", "--write", "--ignore-path", "/dev/null"],
      },
    ],
  },
  plugins: [
    "@hey-api/typescript",
    {
      name: "@hey-api/sdk",
      operations: {
        // The same as `strategy: "single"` with `nesting` from the map, but
        // keeping `nesting: "operationId"` keeps the operation-based type
        // names (`ListIndexesData`) instead of path-based ones.
        strategy: (operation) => {
          const path = operations[operation.operationId ?? ""];
          if (!path) {
            throw new Error(
              `operation ${operation.operationId} has no entry in sdk-operations.json`,
            );
          }
          return [["GrepvineApi", ...path]];
        },
        containerName: "GrepvineApi",
        methods: "instance",
      },
      paramsStructure: "flat",
      responseStyle: "data",
    },
    { name: "@hey-api/client-fetch", throwOnError: true },
  ],
});
