// Local TypeDoc plugin for the Grepvine SDK site.
//
// 1. Files under src/generated are rewritten by `npm run generate`, so they can't
//    carry @category tags. Categories are assigned here from each export's
//    source file instead, and an explicit @category in a comment still wins.
// 2. The theme stylesheet imports the design-system layers
//    (tokens.css, then components/bundle.css); they are copied next to it.
// 3. The code-block grammar of the Grepvine design system is two colours on a
//    dark block: keywords pink, strings lime, everything else paper, in both
//    themes. Shiki's highlight.css is rewritten to that palette after rendering.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Comment,
  CommentTag,
  Converter,
  ReflectionKind,
  RendererEvent,
} from "typedoc";
import { designSystem } from "./design-system.mjs";

const layers = ["tokens.css", "components/bundle.css"];

const categories = [
  [/\/src\/convenience\.ts$/, "Convenience client"],
  [/\/src\/helpers\.ts$/, "Raw client"],
  [/\/src\/generated\/(client|core)\//, "Raw client"],
  [/\/src\/generated\/sdk\.gen\.ts$/, "Operations"],
  [/\/src\/generated\/types\.gen\.ts$/, "API types"],
];

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
        if (reflection.comment?.getTag("@category")) continue;
        const file = reflection.sources?.[0]?.fullFileName ?? "";
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
        cpSync(
          join(designSystem, layer),
          join(assets, "design-system", layer.replace("components/", "")),
        );
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
