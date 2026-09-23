import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SHELL_FREE_LAUNCHERS = [
  "blind-tester/fleet.mjs",
  "tests/acceptance/fleet_mock_pipeline.test.ts",
  "tests/regression/blind_runner_smoke_entrypoint.test.ts",
  "tests/regression/rpg_validation_bar.test.ts",
  "tests/regression/trace_cli_integrity.test.ts",
];

describe("Node subprocess launchers avoid command-shell interpretation", () => {
  it.each(SHELL_FREE_LAUNCHERS)("%s does not enable a child-process shell", (path) => {
    const source = readFileSync(path, "utf8");

    expect(source).not.toMatch(/\bshell\s*:/);
  });
});
