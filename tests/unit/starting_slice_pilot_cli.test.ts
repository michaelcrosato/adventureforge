import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { writePilotArtifactSafely } from "../../bin/starting-slice.js";

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

describe("starting-slice pilot CLI", () => {
  it("requires one explicit fleet directory", () => {
    const result = spawnSync(process.execPath, [TSX, "bin/starting-slice.ts", "pilot"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    expect(result.status, output).toBe(2);
    expect(output).toContain(
      "usage: npm run starting-slice:pilot -- --fleet ai-runs/fleet/<label>",
    );
  });

  it("publishes a distinct pilot artifact without creating certification evidence", () => {
    const base = mkdtempSync(join(tmpdir(), "af-pilot-output-"));
    const fleetDir = join(base, "pilot");
    mkdirSync(fleetDir);
    try {
      const result = { cohort_kind: "pilot", authority_certified: false };
      const output = writePilotArtifactSafely(fleetDir, result);

      expect(output).toBe(join(fleetDir, "starting-slice-pilot.json"));
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(result);
      expect(existsSync(join(fleetDir, "starting-slice-certification.json"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("refuses to replace a hard-linked pilot output", () => {
    const base = mkdtempSync(join(tmpdir(), "af-pilot-hardlink-"));
    const fleetDir = join(base, "pilot");
    const outside = join(base, "outside.json");
    mkdirSync(fleetDir);
    writeFileSync(outside, "outside remains unchanged\n");
    linkSync(outside, join(fleetDir, "starting-slice-pilot.json"));
    try {
      expect(() => writePilotArtifactSafely(fleetDir, { valid: true })).toThrow(
        /pilot output must not have multiple hard links/i,
      );
      expect(readFileSync(outside, "utf8")).toBe("outside remains unchanged\n");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
