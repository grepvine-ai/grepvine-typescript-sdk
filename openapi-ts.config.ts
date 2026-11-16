import { readFileSync } from "node:fs";
import { $, defineConfig } from "@hey-api/openapi-ts";

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
  requestBody?: {
    required?: boolean;
    content: Record<string, { schema: { $ref?: string } }>;
  };
  responses?: Record<
    string,
    { content?: Record<string, { schema?: { $ref?: string } }> }
  >;
};

const schemaRef = "#/components/schemas/";

// Paged operations, as in the Python SDK: one that takes `page` becomes
// `listPage` (its mapped name plus `Page`) and returns one page. When the
// page holds only `results` and `pagination`, the mapped name, `list`, goes
// through every page; `item` is the `$ref` of its results. Keyed by the
// generated class (`GrepvineApi.organizations.members`).
const spec: Spec & {
  components: {
    schemas: Record<
      string,
      { properties?: { results?: { items?: { $ref?: string } } } }
    >;
  };
} = JSON.parse(
  readFileSync(new URL("./spec/openapi.json", import.meta.url), "utf8"),
);
const paged = new Map<
  string,
  { method: string; item?: string; required: boolean }
>();
for (const [path, item] of Object.entries(spec.paths)) {
  for (const operation of Object.values(item)) {
    const mapped = operations[operation.operationId ?? ""];
    const ref =
      operation.responses?.["200"]?.content?.["application/json"]?.schema
        ?.$ref ?? "";
    const properties =
      spec.components.schemas[ref.slice(schemaRef.length)]?.properties ?? {};
    const fields = Object.keys(properties).sort().join();
    if (
      mapped &&
      operation.parameters?.some(
        (parameter) => parameter.$ref === "#/components/parameters/Page",
      )
    ) {
      paged.set(["GrepvineApi", ...mapped.slice(0, -1)].join("."), {
        method: mapped.at(-1)!,
        item:
          fields === "pagination,results"
            ? properties.results?.items?.$ref
            : undefined,
        required:
          path.includes("{") || Boolean(operation.requestBody?.required),
      });
    }
  }
}

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
          const method = path.at(-1)!;
          const resource = path.slice(0, -1);
          const page = paged.get(["GrepvineApi", ...resource].join("."));
          return [
            [
              "GrepvineApi",
              ...resource,
              page?.method === method ? `${method}Page` : method,
            ],
          ];
        },
        containerName: "GrepvineApi",
        methods: "instance",
      },
      $hooks: {
        events: {
          // Each paged resource gets its iterating method, just before the
          // single-page one.
          "node:set:before": ({ node, plugin }) => {
            // The class as the plugin's DSL builds it, which is not typed.
            const resource = node as any;
            const page = paged.get(resource?.symbol?.meta?.resourceId);
            if (resource?.["~dsl"] !== "ClassTsDsl" || !page?.item) return;
            const single = `${page.method}Page`;
            const method = `${resource.symbol.name}["${single}"]`;
            const [paginate, parameters] = ["paginate", "ListParameters"].map(
              (name) => plugin.symbol(name, { external: "../paginate.js" }),
            );
            const item = plugin.referenceSymbol({
              category: "type",
              resource: "definition",
              resourceId: page.item,
            });
            const body: any[] = resource.body;
            const at = body.findIndex(
              (member) => member.symbol?.name === single,
            );
            if (at < 0) throw new Error(`${method} was not generated`);
            body.splice(
              at,
              0,
              $.method(page.method, (m) =>
                m
                  .public()
                  .doc([
                    "Every result, page after page, requested as the loop reaches each page.",
                    "",
                    `\`${single}\` returns one page.`,
                  ])
                  .param("parameters", (p) =>
                    p
                      .optional(!page.required)
                      .type($.type(parameters).generic($.type(method))),
                  )
                  .param("options", (p) =>
                    p
                      .optional()
                      .type(
                        $.type
                          .object()
                          .prop("signal", (s) =>
                            s.optional().type("AbortSignal"),
                          ),
                      ),
                  )
                  .returns(
                    $.type("AsyncGenerator")
                      .generic($.type(item))
                      .generic("void")
                      .generic("undefined"),
                  )
                  .do(
                    $(paginate)
                      .call(
                        $("this").attr(single).attr("bind").call("this"),
                        "parameters",
                        "options",
                      )
                      .return(),
                  ),
              ),
              $.newline(),
            );
          },
        },
      },
      paramsStructure: "flat",
      responseStyle: "data",
    },
    { name: "@hey-api/client-fetch", throwOnError: true },
  ],
});
