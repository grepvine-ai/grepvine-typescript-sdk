import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Standalone repositories consume their snapshot without a Python toolchain.
if (existsSync("spec/openapi.json")) {
  const source = JSON.parse(readFileSync("spec/source.json", "utf8"));
  const checksum = createHash("sha256")
    .update(readFileSync("spec/openapi.json"))
    .digest("hex");
  if (checksum !== source.snapshot_sha256) {
    throw new Error("Snapshot checksum does not match spec/source.json");
  }
} else {
  execFileSync(
    "uv",
    [
      "--directory",
      "../python-sdk",
      "run",
      "--frozen",
      "python",
      "scripts/contract.py",
    ],
    { stdio: "inherit" },
  );
}
execFileSync("openapi-ts", [], { stdio: "inherit" });
