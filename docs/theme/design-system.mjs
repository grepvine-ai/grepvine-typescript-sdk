// Locates the Grepvine design system: a checkout of
// grepvine-ai/grepvine-design-system at the commit in design-system.ref. It is
// the sibling ../grepvine-design-system by default, or GREPVINE_DESIGN_SYSTEM.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const theme = dirname(fileURLToPath(import.meta.url));
const root = resolve(theme, "../..");

export const designSystem = resolve(
  process.env.GREPVINE_DESIGN_SYSTEM ||
    join(root, "..", "grepvine-design-system"),
);

if (!existsSync(join(designSystem, "tokens.css"))) {
  const ref = readFileSync(join(theme, "design-system.ref"), "utf8").trim();
  throw new Error(
    `No Grepvine design system at ${designSystem}. Clone ` +
      "https://github.com/grepvine-ai/grepvine-design-system there and check " +
      `out ${ref}, or set GREPVINE_DESIGN_SYSTEM to an existing checkout.`,
  );
}
