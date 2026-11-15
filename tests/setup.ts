import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, vi } from "vitest";

// No test reads the developer's settings: no GREPVINE_* variable is set and
// the home directory is a new, empty one.
beforeEach(() => {
  for (const name of [
    "GREPVINE_API_KEY",
    "GREPVINE_AGENT_SECRET",
    "GREPVINE_API_ENDPOINT",
    "GREPVINE_ORGANIZATION",
    "GREPVINE_CONFIG",
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("HOME", mkdtempSync(join(tmpdir(), "grepvine-home-")));
  return () => {
    vi.unstubAllEnvs();
  };
});
