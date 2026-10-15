// Local TypeDoc plugin for the Grepvine SDK site.
//
// 1. The reference is organized by resource. Each export's @category comes
//    from its comment, or else from its source file: a resource class, and
//    the request and response types of an operation, go under the resource of
//    sdk-operations.json; other API types go under Models.
// 2. The theme stylesheet imports tokens.css, then components.css, the
//    design-system layers in docs/theme; they are copied next to it.
// 3. The code-block grammar of the Grepvine design system is two colours on a
//    dark block: keywords pink, strings lime, everything else paper, in both
//    themes. Shiki's highlight.css is rewritten to that palette after rendering.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Comment,
  CommentTag,
  Converter,
  ReflectionKind,
  RendererEvent,
} from "typedoc";

const theme = dirname(fileURLToPath(import.meta.url));
const layers = ["tokens.css", "components.css"];

const categories = [
  [/\/src\/(client|retry|paginate)\.ts$/, "Client"],
  [/\/src\/errors\.ts$/, "Errors"],
];
const resources = {
  organizations: "Organizations",
  indexes: "Indexes",
  documents: "Documents",
  search: "Search",
  apiKeys: "API keys",
  account: "Account",
  deviceLogin: "Device login",
};
const classes = {
  GrepvineApi: "Client",
  Options: "Client",
  Members: "Organizations",
  ...Object.fromEntries(
    Object.entries(resources).map(([name, label]) => [
      name[0].toUpperCase() + name.slice(1),
      label,
    ]),
  ),
};
// Operation type names (ListApiKeysData) differ in case from operation IDs
// (listAPIKeys), so they are compared in lower case.
const operations = new Map(
  Object.entries(
    JSON.parse(
      readFileSync(new URL("../../sdk-operations.json", import.meta.url)),
    ),
  ).map(([operationId, path]) => [
    operationId.toLowerCase(),
    resources[path[0]],
  ]),
);
const operationType = /^(\w+?)(Data|Errors|Error|Responses|Response)$/;

/** The category of an export without a @category tag, by its source file. */
function category(name, file) {
  if (file.endsWith("/src/generated/sdk.gen.ts")) return classes[name];
  if (file.endsWith("/src/generated/types.gen.ts")) {
    const match = operationType.exec(name);
    return (match && operations.get(match[1].toLowerCase())) ?? "Models";
  }
  return categories.find(([pattern]) => pattern.test(file))?.[1];
}

// Colours of the github-dark Shiki theme that typedoc.json pins.
const KEYWORD = "#F97583";
const STRING = "#9ECBFF";
const palette = {
  keyword: "#ff4fd8",
  string: "#c4ff3d",
  text: "#f1f1f4",
  background: "#0b0b0e",
};

/** @param {import("typedoc").Application} app */
export function load(app) {
  app.converter.on(
    Converter.EVENT_RESOLVE_BEGIN,
    (context) => {
      const exported = context.project.getChildrenByKind(
        ReflectionKind.SomeExport,
      );
      for (const reflection of exported) {
        // Resources are reached through the client, never constructed, and
        // the client's instance registry is internal.
        for (const child of reflection.children ?? []) {
          const internal =
            child.name === "__registry" ||
            (child.kindOf(ReflectionKind.Constructor) &&
              reflection.name in classes &&
              reflection.name !== "GrepvineApi");
          if (internal) context.project.removeReflection(child);
        }
        const file = reflection.sources?.[0]?.fullFileName ?? "";
        if (reflection.comment?.getTag("@category")) continue;
        const label = category(reflection.name, file);
        if (!label) continue;
        reflection.comment ??= new Comment();
        reflection.comment.blockTags.push(
          new CommentTag("@category", [{ kind: "text", text: label }]),
        );
      }
    },
    // Run before TypeDoc's CategoryPlugin reads the tags.
    100,
  );

  app.renderer.on(
    RendererEvent.END,
    (event) => {
      const assets = join(event.outputDirectory, "assets");
      for (const layer of layers) {
        cpSync(join(theme, layer), join(assets, layer));
      }

      const path = join(assets, "highlight.css");
      const css = readFileSync(path, "utf8");
      const rewritten = css
        .replace(
          /(--(?:light|dark)-hl-\d+): (#[0-9A-Fa-f]{6});/g,
          (_, name, colour) => {
            const upper = colour.toUpperCase();
            if (upper === KEYWORD) return `${name}: ${palette.keyword};`;
            if (upper === STRING) return `${name}: ${palette.string};`;
            return `${name}: ${palette.text};`;
          },
        )
        .replace(
          /(--(?:light|dark)-code-background): #[0-9A-Fa-f]{6};/g,
          `$1: ${palette.background};`,
        );
      // Synchronous: the TypeDoc CLI exits without awaiting async listeners.
      writeFileSync(path, rewritten);
    },
    // Run after TypeDoc has written its assets.
    -100,
  );
}
