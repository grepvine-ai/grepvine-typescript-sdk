// Local TypeDoc plugin for the Grepvine SDK site.
//
// 1. The reference is organized by resource. Each export's @category comes
//    from its comment, or else from its source file. Nothing from src/generated
//    may reach the reference; the build fails if it does.
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
  [/\/src\/(client|runtime|retry|paginator|resources\/common)\.ts$/, "Client"],
  [/\/src\/resources\/organizations\.ts$/, "Organizations"],
  [/\/src\/resources\/indexes\.ts$/, "Indexes"],
  [/\/src\/(resources\/documents|metadata)\.ts$/, "Documents"],
  [/\/src\/errors\.ts$/, "Errors"],
  [/\/src\/models\.ts$/, "Models"],
];
const generated = /\/src\/generated\//;

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
        const file = reflection.sources?.[0]?.fullFileName ?? "";
        if (generated.test(file)) {
          throw new Error(
            `${reflection.name} comes from src/generated and must not be documented`,
          );
        }
        if (reflection.comment?.getTag("@category")) continue;
        const match = categories.find(([pattern]) => pattern.test(file));
        if (!match) continue;
        reflection.comment ??= new Comment();
        reflection.comment.blockTags.push(
          new CommentTag("@category", [{ kind: "text", text: match[1] }]),
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
