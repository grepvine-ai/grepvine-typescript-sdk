import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const source = JSON.parse(readFileSync("spec/source.json", "utf8"));
const checksum = createHash("sha256")
  .update(readFileSync("spec/openapi.json"))
  .digest("hex");
if (checksum !== source.snapshot_sha256) {
  throw new Error("Snapshot checksum does not match spec/source.json");
}
execFileSync("openapi-ts", [], { stdio: "inherit" });
