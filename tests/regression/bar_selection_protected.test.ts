/**
 * bug_0636 — the files that choose WHICH BAR a change must clear are verification assets.
 *
 * scripts/test-lanes.ts owns CENSUS_PROOF_SOURCE_SCOPES and the fast/exhaustive partition;
 * scripts/cycle-bar.ts is how loop.sh asks it; `npm run ship` reads the same list. Dropping
 * one scope, or making the classifier answer "fast", routes an engine or content change
 * through health:fast with the census proofs never run — while every test count and
 * every shard stays green, so nothing else in verify-integrity could notice. The opening-
 * density and bug-trace verifiers are two of the nine health steps. All four sat outside
 * PROTECTED_FILES beside scripts/ci-test-groups.ts, which was already inside it for the
 * same reason.
 *
 * Exercises the REAL list and the REAL pure detectors, like generator_program_protected.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_FILES,
  PROTECTED_FILES,
  classifyDrift,
  detectGuardWeakening,
  parseGuardConstants,
  type GuardConstants,
} from "../../scripts/verify-integrity.js";

const BAR_SELECTION = [
  "scripts/test-lanes.ts",
  "scripts/cycle-bar.ts",
  "scripts/verify-opening-density.ts",
  "scripts/verify-bug-traces.ts",
] as const;

describe("bug_0636 — bar-selection files are guarded", () => {
  it("every bar-selection file is in PROTECTED_FILES and exists on disk", () => {
    for (const f of BAR_SELECTION) {
      expect(PROTECTED_FILES).toContain(f);
      expect(existsSync(join(process.cwd(), f)), f).toBe(true);
    }
  });

  it("the drift guard's pure parser reads the same list the static check enforces", () => {
    // parseGuardConstants reads the array literal as TEXT; a stray quote or bracket in a
    // comment would add a phantom entry or truncate the list, silently disarming the
    // membership lock below for everything after it.
    const parsed = parseGuardConstants(readFileSync("scripts/verify-integrity.ts", "utf8"));
    expect(parsed).not.toBeNull();
    expect(parsed!.protectedFiles).toEqual([...PROTECTED_FILES]);
  });

  it("deleting one is PROTECTED_DELETED; editing one is surfaced, not blocked", () => {
    for (const f of BAR_SELECTION) {
      const deleted = classifyDrift([f], () => false);
      expect(deleted.map((x) => [x.code, x.severity, x.where])).toEqual([
        ["PROTECTED_DELETED", "error", f],
      ]);
      const edited = classifyDrift([f], () => true);
      expect(edited.map((x) => [x.code, x.severity])).toEqual([["VERIFIER_TOUCHED", "warning"]]);
    }
  });

  it("removing one from PROTECTED_FILES is GUARD_WEAKENED", () => {
    const before: GuardConstants = {
      minTestCases: 120,
      minAssertions: 400,
      minStrongAssertions: 400,
      protectedFiles: [...PROTECTED_FILES],
      forbiddenFiles: [...FORBIDDEN_FILES],
      forbiddenTrackedFiles: [],
      forbiddenPathPatterns: [],
      hashPinFiles: [],
    };
    for (const f of BAR_SELECTION) {
      const now: GuardConstants = {
        ...before,
        protectedFiles: PROTECTED_FILES.filter((entry) => entry !== f),
      };
      const findings = detectGuardWeakening(before, now);
      expect(findings.map((x) => x.code)).toEqual(["GUARD_WEAKENED"]);
      expect(findings[0]!.message).toContain(`PROTECTED_FILES entry removed: ${f}`);
    }
  });
});
