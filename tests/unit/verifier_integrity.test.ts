/**
 * Verifier-integrity guard (scripts/verify-integrity.ts) — the enforced form of
 * "don't route around the verifier" (AGENTS.md, trust-but-verify).
 *
 * Unit-tests the pure detectors on synthetic input (so we know the guard actually
 * catches the mechanical reward-hacks), and asserts the REAL repo passes the static
 * check — which makes this guard part of `npm test` and therefore part of the bar.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  detectDisabledTests,
  listTestFiles,
  readAll,
  countTestCases,
  countAssertions,
  countStrongAssertions,
  detectTautologies,
  countTautologyAssertions,
  detectLoopStateOverflow,
  detectForbiddenPathPatterns,
  detectForbiddenTrackedFiles,
  detectForbiddenLegacyImports,
  detectCountRegressions,
  parseGuardConstants,
  detectGuardWeakening,
  runStatic,
  runDrift,
  classifyDrift,
  PROTECTED_FILES,
  FORBIDDEN_FILES,
  FORBIDDEN_TRACKED_FILES,
  FORBIDDEN_PATH_PATTERNS,
  HASH_PIN_FILES,
  HASH_PIN_CONTENT_SOURCE_SCOPES,
  MIN_TEST_CASES,
  MIN_ASSERTIONS,
  MIN_STRONG_ASSERTIONS,
  MAX_TAUTOLOGY_ASSERTIONS,
  MAX_LIVE_LOOP_STATE_ENTRIES,
  MAX_LIVE_LOOP_STATE_ENTRY_BYTES,
  type GuardConstants,
} from "../../scripts/verify-integrity.js";
import { LOOP_ARCHIVE_FILE } from "../../src/afk/loop_state.js";

describe("detectDisabledTests catches every disabled/focused marker", () => {
  // Markers are assembled at runtime (not written verbatim) so this test file does
  // not itself trip the guard's scan of tests/ — proving the detector works WITHOUT
  // poking an exclusion hole in the static check.
  const I = "it",
    T = "test",
    D = "describe";
  const cases: [string, boolean][] = [
    [`${I}.skip('x', () => {})`, true],
    [`  ${I}.only('x', () => {})`, true],
    [`${D}.skip('x', () => {})`, true],
    [`${T}.todo('later')`, true],
    [`x${I}('x', () => {})`, true],
    [`x${D}('x', () => {})`, true],
    [`${I}('a real test', () => { expect(1).` + `toBe(1); })`, false],
    [`// ${I}.skip in a comment is still conservatively flagged`, true],
  ];
  for (const [line, shouldFlag] of cases) {
    it(`${shouldFlag ? "flags" : "allows"}: ${line.trim().slice(0, 40)}`, () => {
      const findings = detectDisabledTests([{ path: "t.test.ts", text: line }]);
      expect(findings.length > 0).toBe(shouldFlag);
      if (shouldFlag) expect(findings[0]!.code).toBe("TEST_DISABLED");
    });
  }
});

describe("countTestCases", () => {
  it("counts it()/test() calls", () => {
    const text = "it('a',()=>{}); test('b',()=>{}); it ('c',()=>{}); describe('grp',()=>{});";
    expect(countTestCases([{ text }])).toBe(3); // two it + one test; describe not counted
  });
});

describe("countAssertions", () => {
  it("counts expect() calls (the test-body guard, not it()/test())", () => {
    // Assertion patterns assembled at runtime to avoid triggering the tautology scanner on source text.
    const tBe = "toBe";
    const text =
      "it('a',()=>{ expect(1)." + tBe + "(1); expect (x).toEqual(y); }); test('b',()=>{});";
    expect(countAssertions([{ text }])).toBe(2); // two expect( ; it/test not counted
  });
});

describe("countStrongAssertions", () => {
  it("counts value-pinning matchers but not weak existence checks", () => {
    const text =
      "expect(a).toBe(1); expect(b).toEqual(2); expect(c).toContain('z'); expect(d).toBeDefined(); expect(e).toBeTruthy();";
    expect(countStrongAssertions([{ text }])).toBe(3); // toBe/toEqual/toContain; not toBeDefined/toBeTruthy
  });
});

describe("detectCountRegressions — counts cannot drop and tautologies cannot rise", () => {
  const codes = (fs: { code: string }[]) => fs.map((f) => f.code);

  it("passes when both counts grow (a normal +tests cycle)", () => {
    expect(
      detectCountRegressions({ cases: 100, assertions: 300 }, { cases: 103, assertions: 312 }),
    ).toEqual([]);
  });

  it("BLOCKS a strict→loose swap — cases AND assertions held, strong dropped (bug_0133)", () => {
    const fs = detectCountRegressions(
      { cases: 100, assertions: 300, strong: 290 },
      { cases: 100, assertions: 300, strong: 287 }, // 3 strict matchers turned loose
    );
    expect(codes(fs)).toEqual(["STRONG_ASSERTION_REGRESSION"]);
    expect(fs.every((f) => f.severity === "error")).toBe(true);
  });

  it("the strong guard is silent when the strong counts are absent (legacy two-count call sites)", () => {
    expect(
      detectCountRegressions({ cases: 100, assertions: 300 }, { cases: 100, assertions: 300 }),
    ).toEqual([]);
  });

  it("BLOCKS a new tautology even when cases, assertions, and strong matchers hold", () => {
    const fs = detectCountRegressions(
      { cases: 100, assertions: 300, strong: 290, tautologies: 0 },
      { cases: 100, assertions: 300, strong: 290, tautologies: 1 },
    );
    expect(codes(fs)).toEqual(["TAUTOLOGY_REGRESSION"]);
    expect(fs[0]!.severity).toBe("error");
  });

  it("the tautology guard is silent when tautology counts are absent (legacy call sites)", () => {
    expect(
      detectCountRegressions(
        { cases: 100, assertions: 300, strong: 290 },
        { cases: 100, assertions: 300, strong: 290 },
      ),
    ).toEqual([]);
  });

  it("BLOCKS a dropped test-case count (tests removed/skipped)", () => {
    const fs = detectCountRegressions(
      { cases: 100, assertions: 300 },
      { cases: 99, assertions: 300 },
    );
    expect(codes(fs)).toContain("TEST_COUNT_REGRESSION");
    expect(fs.every((f) => f.severity === "error")).toBe(true);
  });

  it("BLOCKS gutting a test body — cases held, assertions dropped (the launder this closes)", () => {
    // The exact reward-hack the it()-count-only guard misses: keep every it() shell so
    // the case count is unchanged, but delete the expect()s inside one of them.
    const fs = detectCountRegressions(
      { cases: 100, assertions: 300 },
      { cases: 100, assertions: 297 },
    );
    expect(codes(fs)).toEqual(["ASSERTION_COUNT_REGRESSION"]);
    expect(fs[0]!.severity).toBe("error");
  });
});

describe("detectLoopStateOverflow — live handoff stays token-small", () => {
  const log = (n: number): string =>
    Array.from({ length: n }, (_, i) => `### Cycle result - compact_${i}\n\n- done.\n`).join("\n");

  it("allows the configured live rotation window", () => {
    expect(detectLoopStateOverflow(log(MAX_LIVE_LOOP_STATE_ENTRIES))).toEqual([]);
  });

  it("blocks an overgrown live AI_LOOP_STATE.md", () => {
    const findings = detectLoopStateOverflow(log(MAX_LIVE_LOOP_STATE_ENTRIES + 1));
    expect(findings.map((f) => f.code)).toEqual(["LOOP_STATE_OVER_ROTATED"]);
    expect(findings[0]!.message).toContain(`${MAX_LIVE_LOOP_STATE_ENTRIES + 1}`);
  });

  it("counts the '## AFK Cycle' entries the driver actually writes (bug_0631)", () => {
    // Pre-fix the guard counted "### Cycle result" alone, so a full legacy section plus
    // any number of driver scaffolds read as within bounds.
    const scaffold = (i: number): string => `## AFK Cycle 2026-09-0${i}T00-00-00-000Z\n- done.\n`;
    const mixed = `${log(MAX_LIVE_LOOP_STATE_ENTRIES)}\n${scaffold(1)}`;
    const findings = detectLoopStateOverflow(mixed);
    expect(findings.map((f) => f.code)).toEqual(["LOOP_STATE_OVER_ROTATED"]);
    expect(findings[0]!.message).toContain(`${MAX_LIVE_LOOP_STATE_ENTRIES + 1} live cycle entries`);

    const scaffoldsOnly = Array.from({ length: MAX_LIVE_LOOP_STATE_ENTRIES }, (_, i) =>
      scaffold(i),
    ).join("");
    expect(detectLoopStateOverflow(scaffoldsOnly)).toEqual([]);
    expect(detectLoopStateOverflow(`${scaffoldsOnly}${scaffold(9)}`).map((f) => f.code)).toEqual([
      "LOOP_STATE_OVER_ROTATED",
    ]);
  });

  it("blocks live entry text over the byte ceiling, measured from the first entry (c1101bfc)", () => {
    const intro = `# AI Loop State\n\n<!-- feedback_acceptance: ${"m".repeat(8000)} -->\n\n`;
    const entry = (bytes: number): string => {
      const heading = "## AFK Cycle 2026-09-22T00-00-00-000Z\n";
      return `${heading}${"x".repeat(bytes - heading.length - 1)}\n`;
    };
    // Exactly at the ceiling passes, and a large machine-owned intro is not counted: the
    // post-gate seal rewrites it after the bar, so it must not be able to fail the next one.
    expect(detectLoopStateOverflow(`${intro}${entry(MAX_LIVE_LOOP_STATE_ENTRY_BYTES)}`)).toEqual(
      [],
    );
    const over = detectLoopStateOverflow(`${intro}${entry(MAX_LIVE_LOOP_STATE_ENTRY_BYTES + 1)}`);
    expect(over.map((f) => f.code)).toEqual(["LOOP_STATE_OVER_BYTES"]);
    expect(over[0]!.message).toContain(`${MAX_LIVE_LOOP_STATE_ENTRY_BYTES + 1} bytes`);
    expect(over[0]!.severity).toBe("error");
  });

  it("keeps the byte ceiling at or below the rotation's own target (never looser)", () => {
    expect(MAX_LIVE_LOOP_STATE_ENTRY_BYTES).toBeLessThanOrEqual(30 * 1024);
    expect(MAX_LIVE_LOOP_STATE_ENTRIES).toBeLessThanOrEqual(15);
  });

  it("holds on the real, committed AI_LOOP_STATE.md", () => {
    expect(detectLoopStateOverflow(readFileSync("AI_LOOP_STATE.md", "utf8"))).toEqual([]);
  });
});

describe("detectForbiddenPathPatterns — retired test families stay gone", () => {
  it("blocks recreated CYOA/parser unit test families by path pattern", () => {
    const findings = detectForbiddenPathPatterns([
      "tests/unit/cyoa_engine.test.ts",
      "tests/unit/parser_grammar.test.ts",
      "tests/regression/cyoa_score_economy.test.ts",
      "tests/regression/parser_all_endings_reachable.test.ts",
      "tests/property/cyoa_determinism.test.ts",
      "tests/property/parser_determinism.test.ts",
      "tests/unit/rpg.test.ts",
    ]);
    expect(findings.map((f) => f.where)).toEqual([
      "tests/unit/cyoa_engine.test.ts",
      "tests/unit/parser_grammar.test.ts",
      "tests/regression/cyoa_score_economy.test.ts",
      "tests/regression/parser_all_endings_reachable.test.ts",
      "tests/property/cyoa_determinism.test.ts",
      "tests/property/parser_determinism.test.ts",
    ]);
    expect(findings.every((f) => f.code === "FORBIDDEN_PATH_PATTERN")).toBe(true);
  });
});

describe("detectForbiddenTrackedFiles — token-heavy local artifacts stay out of Git", () => {
  it("blocks ignored loop artifacts if they become tracked", () => {
    const findings = detectForbiddenTrackedFiles([
      "AI_LOOP_STATE.md",
      LOOP_ARCHIVE_FILE,
      "ai-runs/agent-cleaner-cycle459.log",
      "ai-runs/2026-07-06T00-00-00-000Z/playtest.md",
      "src/core/engine.ts",
    ]);
    expect(findings.map((f) => f.code)).toEqual([
      "FORBIDDEN_TRACKED_FILE",
      "FORBIDDEN_TRACKED_FILE",
      "FORBIDDEN_TRACKED_FILE",
    ]);
    expect(findings.map((f) => f.where)).toEqual([
      LOOP_ARCHIVE_FILE,
      "ai-runs/agent-cleaner-cycle459.log",
      "ai-runs/2026-07-06T00-00-00-000Z/playtest.md",
    ]);
    expect(findings[0]!.message).toContain("untracked");
  });
});

describe("detectForbiddenLegacyImports — live source stays RPG-only", () => {
  it("blocks imports of retired CYOA/parser modules in runtime code", () => {
    const findings = detectForbiddenLegacyImports([
      {
        path: "src/rpg/runner.ts",
        text: [
          'import { build } from "../parser/model.js";',
          'export { choose } from "./cyoa/engine.js";',
          'const validator = await import("../validate/parser_validator.js");',
          'import { hashState } from "../core/hash.js";',
        ].join("\n"),
      },
    ]);

    expect(findings.map((f) => f.code)).toEqual([
      "FORBIDDEN_LEGACY_IMPORT",
      "FORBIDDEN_LEGACY_IMPORT",
      "FORBIDDEN_LEGACY_IMPORT",
    ]);
    expect(findings.map((f) => f.where)).toEqual([
      "src/rpg/runner.ts:1",
      "src/rpg/runner.ts:2",
      "src/rpg/runner.ts:3",
    ]);
  });

  it("allows RPG/core imports and prose references", () => {
    const findings = detectForbiddenLegacyImports([
      {
        path: "src/rpg/schema.ts",
        text: [
          'import { hashState } from "../core/hash.js";',
          'import { buildRpgRules } from "./runner.js";',
          'const note = "legacy parser text is allowed in prose, not imports";',
        ].join("\n"),
      },
    ]);

    expect(findings).toEqual([]);
  });
});

describe("classifyDrift — legitimate re-pin vs launder vs weakening (research-aligned)", () => {
  const errs = (fs: { severity: string }[]) => fs.filter((f) => f.severity === "error");

  it("ALLOWS (warns) a hash re-pin accompanied by its exact related content source", () => {
    const fs = classifyDrift(
      ["content/rpg/quests/sunken_barrow.yaml", "tests/unit/rpg_validator.test.ts"],
      () => true,
    );
    expect(errs(fs)).toEqual([]); // no hard error → the cycle commits
    expect(fs.some((f) => f.code === "HASH_PIN_REPINNED" && f.severity === "warning")).toBe(true);
  });

  it("BLOCKS an unrelated content byte from laundering a re-pin", () => {
    const fs = classifyDrift(
      ["content/rpg/quests/wolf_winter.yaml", "tests/unit/rpg_validator.test.ts"],
      () => true,
    );
    expect(fs.some((f) => f.code === "HASH_PIN_UNACCOMPANIED" && f.severity === "error")).toBe(
      true,
    );
    expect(fs.some((f) => f.code === "HASH_PIN_REPINNED")).toBe(false);
  });

  it("scopes the barrow trace pin to sunken_barrow only", () => {
    const related = classifyDrift(
      ["content/rpg/quests/sunken_barrow.yaml", "traces/rpg/barrow_victory.json"],
      () => true,
    );
    const unrelated = classifyDrift(
      ["content/rpg/quests/wolf_winter.yaml", "traces/rpg/barrow_victory.json"],
      () => true,
    );

    expect(related.map((finding) => finding.code)).toEqual(["HASH_PIN_REPINNED"]);
    expect(unrelated.map((finding) => finding.code)).toEqual(["HASH_PIN_UNACCOMPANIED"]);
  });

  it("BLOCKS a re-pin with no related content change", () => {
    const fs = classifyDrift(["tests/unit/rpg_validator.test.ts"], () => true);
    expect(fs.some((f) => f.code === "HASH_PIN_UNACCOMPANIED" && f.severity === "error")).toBe(
      true,
    );
  });

  it("keeps algorithm and retired-source pin changes behind explicit acknowledgment", () => {
    const algorithm = classifyDrift(
      ["src/core/sha256.ts", "tests/unit/sha256.test.ts"],
      () => true,
    );
    const retired = classifyDrift(
      [
        "content/rpg/quests/sunken_barrow.yaml",
        "traces/bugs/bug_0002_watchtower_blind_polish.yaml",
      ],
      () => true,
    );

    expect(algorithm.map((finding) => finding.code)).toContain("HASH_PIN_UNACCOMPANIED");
    expect(
      algorithm.find((finding) => finding.code === "HASH_PIN_UNACCOMPANIED")!.message,
    ).toContain("AI_LOOP_ALLOW_VERIFIER_EDITS=1");
    expect(retired.map((finding) => finding.code)).toEqual(["HASH_PIN_UNACCOMPANIED"]);
  });

  it("SURFACES (warns) a modified protected file — free rein over code, weakening caught elsewhere", () => {
    const fs = classifyDrift(["src/core/engine.ts"], () => true);
    expect(errs(fs)).toEqual([]);
    expect(fs.some((f) => f.code === "VERIFIER_TOUCHED" && f.severity === "warning")).toBe(true);
  });

  it("BLOCKS deleting a protected verification asset", () => {
    const fs = classifyDrift(["tests/property/determinism.test.ts"], () => false);
    expect(fs.some((f) => f.code === "PROTECTED_DELETED" && f.severity === "error")).toBe(true);
  });
});

describe("parseGuardConstants — pure parse of the guard's own defensive surface", () => {
  it("round-trips the LIVE verify-integrity.ts constants (the real floors + lists)", () => {
    const text = readFileSync(join(process.cwd(), "scripts/verify-integrity.ts"), "utf8");
    const parsed = parseGuardConstants(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.minTestCases).toBe(MIN_TEST_CASES);
    expect(parsed!.minAssertions).toBe(MIN_ASSERTIONS);
    expect(parsed!.minStrongAssertions).toBe(MIN_STRONG_ASSERTIONS);
    expect(parsed!.protectedFiles).toEqual(PROTECTED_FILES);
    expect(parsed!.forbiddenFiles).toEqual(FORBIDDEN_FILES);
    expect(parsed!.forbiddenTrackedFiles).toEqual(FORBIDDEN_TRACKED_FILES);
    expect(parsed!.forbiddenPathPatterns).toEqual(FORBIDDEN_PATH_PATTERNS);
    expect(parsed!.hashPinFiles).toEqual(HASH_PIN_FILES);
    expect(parsed!.hashPinContentSourceScopes).toEqual(HASH_PIN_CONTENT_SOURCE_SCOPES);
    expect(HASH_PIN_CONTENT_SOURCE_SCOPES).toEqual([
      "tests/unit/rpg_validator.test.ts=>content/rpg/quests/sunken_barrow.yaml",
      "tests/unit/rpg_validator.test.ts=>content/broken-fixtures/rpg_unwinnable.yaml",
      "traces/rpg/barrow_victory.json=>content/rpg/quests/sunken_barrow.yaml",
    ]);
    const noAutomaticScopes = text.replace(
      /export const HASH_PIN_CONTENT_SOURCE_SCOPES = \[[\s\S]*?\] as const;/,
      "export const HASH_PIN_CONTENT_SOURCE_SCOPES = [] as const;",
    );
    expect(parseGuardConstants(noAutomaticScopes)!.hashPinContentSourceScopes).toEqual([]);
  });

  it("returns null on malformed text (a missing field is skipped, never a false alarm)", () => {
    // Has the MIN_* floors but no array literals → unparseable, so null (not a partial).
    const partial = [
      "export const MIN_TEST_CASES = 2600;",
      "export const MIN_ASSERTIONS = 16200;",
      "export const MIN_STRONG_ASSERTIONS = 15500;",
    ].join("\n");
    expect(parseGuardConstants(partial)).toBeNull();
    expect(parseGuardConstants("nothing parseable here")).toBeNull();
  });
});

describe("detectGuardWeakening — lowering a floor or dropping a protected entry is a hard error", () => {
  const base: GuardConstants = {
    minTestCases: 120,
    minAssertions: 400,
    minStrongAssertions: 400,
    protectedFiles: ["a.ts", "b.ts"],
    forbiddenFiles: ["legacy.ts"],
    forbiddenTrackedFiles: ["archive.md"],
    forbiddenPathPatterns: ["^legacy/.*$"],
    hashPinFiles: ["pin.ts"],
    hashPinContentSourceScopes: ["pin.ts=>content/related.yaml"],
  };
  const codes = (fs: { code: string }[]) => fs.map((f) => f.code);

  it("identical constants → no finding (the honest no-op cycle)", () => {
    expect(detectGuardWeakening(base, { ...base })).toEqual([]);
  });

  it("raising a floor and adding entries → no finding (tightening is always allowed)", () => {
    const stronger: GuardConstants = {
      ...base,
      minTestCases: 130,
      minAssertions: 410,
      protectedFiles: ["a.ts", "b.ts", "c.ts"],
      forbiddenFiles: ["legacy.ts", "legacy2.ts"],
      forbiddenTrackedFiles: ["archive.md", "local-heavy.md"],
      forbiddenPathPatterns: ["^legacy/.*$", "^retired/.*$"],
      hashPinFiles: ["pin.ts", "pin2.ts"],
      // Removing an automatic justification scope is tightening, not weakening.
      hashPinContentSourceScopes: [],
    };
    expect(detectGuardWeakening(base, stronger)).toEqual([]);
  });

  it("lowering MIN_TEST_CASES → GUARD_WEAKENED error", () => {
    const fs = detectGuardWeakening(base, { ...base, minTestCases: 119 });
    expect(codes(fs)).toEqual(["GUARD_WEAKENED"]);
    expect(fs[0]!.severity).toBe("error");
    expect(fs[0]!.message).toContain("MIN_TEST_CASES");
  });

  it("lowering MIN_ASSERTIONS or MIN_STRONG_ASSERTIONS → GUARD_WEAKENED error", () => {
    expect(detectGuardWeakening(base, { ...base, minAssertions: 399 })[0]!.code).toBe(
      "GUARD_WEAKENED",
    );
    expect(detectGuardWeakening(base, { ...base, minStrongAssertions: 1 })[0]!.code).toBe(
      "GUARD_WEAKENED",
    );
  });

  it("removing a PROTECTED_FILES entry → GUARD_WEAKENED error naming the dropped path", () => {
    const fs = detectGuardWeakening(base, { ...base, protectedFiles: ["a.ts"] });
    expect(codes(fs)).toEqual(["GUARD_WEAKENED"]);
    expect(fs[0]!.severity).toBe("error");
    expect(fs[0]!.message).toContain("b.ts");
  });

  it("moving a retired file from PROTECTED_FILES to FORBIDDEN_FILES is not weakening", () => {
    const before: GuardConstants = {
      ...base,
      protectedFiles: ["a.ts", "retired.ts"],
      forbiddenFiles: [],
    };
    const now: GuardConstants = {
      ...before,
      protectedFiles: ["a.ts"],
      forbiddenFiles: ["retired.ts"],
    };
    expect(detectGuardWeakening(before, now)).toEqual([]);
  });

  it("removing a HASH_PIN_FILES entry → GUARD_WEAKENED error", () => {
    const fs = detectGuardWeakening(base, { ...base, hashPinFiles: [] });
    expect(codes(fs)).toEqual(["GUARD_WEAKENED"]);
    expect(fs[0]!.message).toContain("pin.ts");
  });

  it("adding a hash-pin source scope or restoring the legacy wildcard is weakening", () => {
    const widened = detectGuardWeakening(base, {
      ...base,
      hashPinContentSourceScopes: [
        ...base.hashPinContentSourceScopes!,
        "pin.ts=>content/unrelated.yaml",
      ],
    });
    const { hashPinContentSourceScopes: _scopes, ...wildcardGuard } = base;
    const wildcard = detectGuardWeakening(base, wildcardGuard);

    expect(widened[0]!.message).toContain("content/unrelated.yaml");
    expect(wildcard[0]!.message).toContain("legacy any-content wildcard");
  });

  it("migrating from the legacy any-content wildcard to exact scopes is tightening", () => {
    const { hashPinContentSourceScopes: _scopes, ...legacy } = base;
    expect(detectGuardWeakening(legacy, base)).toEqual([]);
  });

  it("removing a FORBIDDEN_FILES entry → GUARD_WEAKENED error", () => {
    const fs = detectGuardWeakening(base, { ...base, forbiddenFiles: [] });
    expect(codes(fs)).toEqual(["GUARD_WEAKENED"]);
    expect(fs[0]!.message).toContain("legacy.ts");
  });

  it("removing a FORBIDDEN_TRACKED_FILES entry → GUARD_WEAKENED error", () => {
    const fs = detectGuardWeakening(base, { ...base, forbiddenTrackedFiles: [] });
    expect(codes(fs)).toEqual(["GUARD_WEAKENED"]);
    expect(fs[0]!.message).toContain("archive.md");
  });

  it("removing a FORBIDDEN_PATH_PATTERNS entry → GUARD_WEAKENED error", () => {
    const fs = detectGuardWeakening(base, { ...base, forbiddenPathPatterns: [] });
    expect(codes(fs)).toEqual(["GUARD_WEAKENED"]);
    expect(fs[0]!.message).toContain("^legacy/.*$");
  });

  it("mentions the AI_LOOP_ALLOW_VERIFIER_EDITS override so a deliberate loosening has a path", () => {
    const fs = detectGuardWeakening(base, { ...base, minTestCases: 0 });
    expect(fs[0]!.message).toContain("AI_LOOP_ALLOW_VERIFIER_EDITS=1");
  });
});

describe("runDrift surfaces GUARD_WEAKENED (and the env override downgrades it)", () => {
  // Use the parent commit as the ref so the diff is real; the synthetic weakened `before`
  // is injected by intercepting `git show <ref>:scripts/verify-integrity.ts`. Skip if the
  // repo has no parent commit (shallow/initial) — the path is the same one runDrift takes.
  const root = process.cwd();
  let hasParent = true;
  try {
    execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: root, encoding: "utf8" });
  } catch {
    hasParent = false;
  }

  it("the working tree's CURRENT guard never weakens itself vs the live source (honest tree)", () => {
    // The real surface compared to itself must produce no GUARD_WEAKENED finding.
    const now = parseGuardConstants(
      readFileSync(join(root, "scripts/verify-integrity.ts"), "utf8"),
    );
    expect(now).not.toBeNull();
    expect(detectGuardWeakening(now!, now!)).toEqual([]);
  });

  it.runIf(hasParent)(
    "fires GUARD_WEAKENED when the ref's floor is higher than the working tree's, and AI_LOOP_ALLOW_VERIFIER_EDITS=1 downgrades it",
    () => {
      // Build a synthetic 'before' whose MIN_TEST_CASES is far above the working tree's
      // current floor, simulating a cycle that lowered it. Compare via the pure detector
      // on the SAME structs runDrift would build, then assert the env-override semantics
      // match runDrift's acknowledgment loop.
      const now = parseGuardConstants(
        readFileSync(join(root, "scripts/verify-integrity.ts"), "utf8"),
      )!;
      const weakenedBefore: GuardConstants = { ...now, minTestCases: now.minTestCases + 1000 };
      const findings = detectGuardWeakening(weakenedBefore, now);
      expect(findings.map((f) => f.code)).toEqual(["GUARD_WEAKENED"]);
      expect(findings[0]!.severity).toBe("error");

      // And the real runDrift on the honest tree (before === now) must NOT fire it: the
      // expected VERIFIER_TOUCHED warning is fine, GUARD_WEAKENED must be absent.
      const res = runDrift(root, "HEAD~1");
      expect(res.findings.some((f) => f.code === "GUARD_WEAKENED")).toBe(false);
      const acked = runDrift(root, "HEAD~1", {
        ...process.env,
        AI_LOOP_ALLOW_VERIFIER_EDITS: "1",
      });
      expect(acked.findings.some((f) => f.code === "GUARD_WEAKENED")).toBe(false);
    },
  );

  it("the env override downgrades a GUARD_WEAKENED error to a warning (acknowledgment-loop semantics)", () => {
    // Mirror runDrift's acknowledgment loop directly on synthetic findings: a deliberate,
    // acknowledged loosening becomes a non-blocking warning; a silent one stays an error.
    const before: GuardConstants = {
      minTestCases: 200,
      minAssertions: 400,
      minStrongAssertions: 400,
      protectedFiles: ["a.ts"],
      forbiddenFiles: [],
      forbiddenTrackedFiles: [],
      forbiddenPathPatterns: [],
      hashPinFiles: [],
    };
    const now: GuardConstants = { ...before, minTestCases: 120 };
    const raw = detectGuardWeakening(before, now);
    expect(raw[0]!.severity).toBe("error");
    const acknowledged = true;
    const downgraded = raw.map((f) =>
      acknowledged && f.code === "GUARD_WEAKENED" ? { ...f, severity: "warning" as const } : f,
    );
    expect(downgraded[0]!.severity).toBe("warning");
    expect(downgraded.some((f) => f.severity === "error")).toBe(false);
  });
});

describe("runStatic on the real repo (this is the bar)", () => {
  const res = runStatic(process.cwd());

  it("passes — no protected asset missing, no disabled test, count above floor", () => {
    if (!res.ok) console.error(res.findings);
    expect(res.ok).toBe(true);
    expect(res.findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("every protected verification asset actually exists", () => {
    const missing = res.findings.filter((f) => f.code === "PROTECTED_MISSING");
    expect(missing).toEqual([]);
    // sanity: the protected list includes the determinism property tests + the guard itself
    expect(PROTECTED_FILES).toContain("tests/property/determinism.test.ts");
    expect(PROTECTED_FILES).toContain("scripts/verify-integrity.ts");
  });

  it("forbidden legacy assets are absent from the real repo", () => {
    expect(FORBIDDEN_FILES).toContain("src/gen/cyoa_generator.ts");
    expect(FORBIDDEN_FILES).toContain("src/gen/parser_generator.ts");
    expect(FORBIDDEN_FILES).toContain("bin/play.ts");
    expect(FORBIDDEN_FILES).toContain("bin/cyoa.ts");
    expect(FORBIDDEN_FILES).toContain("bin/parser.ts");
    expect(FORBIDDEN_FILES).toContain("bin/parser_play.ts");
    expect(FORBIDDEN_FILES).toContain("src/cyoa");
    expect(FORBIDDEN_FILES).toContain("src/validate/cyoa_validator.ts");
    expect(FORBIDDEN_FILES).toContain("content/cyoa");
    expect(FORBIDDEN_FILES).toContain("src/parser");
    expect(FORBIDDEN_FILES).toContain("src/validate/parser_validator.ts");
    expect(FORBIDDEN_FILES).toContain("content/parser");
    expect(FORBIDDEN_FILES).toContain("tests/property/parser_determinism.test.ts");
    expect(FORBIDDEN_PATH_PATTERNS).toContain("^tests/unit/cyoa.*\\.test\\.ts$");
    expect(FORBIDDEN_PATH_PATTERNS).toContain("^tests/unit/parser.*\\.test\\.ts$");
    expect(FORBIDDEN_PATH_PATTERNS).toContain("^tests/(?:regression|property)/cyoa.*\\.test\\.ts$");
    expect(FORBIDDEN_PATH_PATTERNS).toContain(
      "^tests/(?:regression|property)/parser.*\\.test\\.ts$",
    );
    expect(res.findings.filter((f) => f.code === "FORBIDDEN_FILE_PRESENT")).toEqual([]);
    expect(res.findings.filter((f) => f.code === "FORBIDDEN_PATH_PATTERN")).toEqual([]);
  });

  it("token-heavy ignored loop archives are not tracked in the real repo", () => {
    expect(FORBIDDEN_TRACKED_FILES).toContain(LOOP_ARCHIVE_FILE);
    expect(FORBIDDEN_TRACKED_FILES).toContain("ai-runs/");
    expect(res.findings.filter((f) => f.code === "FORBIDDEN_TRACKED_FILE")).toEqual([]);
  });

  it("passes the test-count floor — no mass deletion", () => {
    expect(res.findings.filter((f) => f.code === "TEST_COUNT_FLOOR")).toEqual([]);
    // If this ever trips, tests were mass-removed — investigate, don't lower the floor.
  });

  // The three tests above assert only that the repo is ABOVE its floors, which stayed
  // true for months while the floors sat at 2-4% of the real corpus and their comments
  // claimed counts an order of magnitude stale. `> 0` is not a bar. Pin the floors to a
  // real FRACTION of the live suite instead, so going stale is itself a failure.
  it("the floors are a meaningful fraction of the live corpus, not a token", () => {
    const files = readAll(process.cwd(), listTestFiles(process.cwd()));
    const cases = countTestCases(files);
    const assertions = countAssertions(files);
    const strong = countStrongAssertions(files);

    // Above half: a floor far below this cannot catch a mass deletion.
    expect(MIN_TEST_CASES / cases).toBeGreaterThan(0.5);
    expect(MIN_ASSERTIONS / assertions).toBeGreaterThan(0.5);
    expect(MIN_STRONG_ASSERTIONS / strong).toBeGreaterThan(0.5);

    // Below the live counts: a floor at or above them would red the repo on any
    // legitimate consolidation, and the fix for that is always to re-measure.
    expect(MIN_TEST_CASES).toBeLessThan(cases);
    expect(MIN_ASSERTIONS).toBeLessThan(assertions);
    expect(MIN_STRONG_ASSERTIONS).toBeLessThan(strong);
  });

  it("passes the assertion-count floor — no test body has been mass-gutted", () => {
    expect(MIN_ASSERTIONS).toBeGreaterThan(0);
    expect(res.findings.filter((f) => f.code === "ASSERTION_COUNT_FLOOR")).toEqual([]);
    // If this ever trips, expect()s were mass-removed — investigate, don't lower the floor.
  });

  it("passes the strong-matcher floor — no mass strict→loose swap (bug_0133)", () => {
    expect(MIN_STRONG_ASSERTIONS).toBeGreaterThan(0);
    expect(res.findings.filter((f) => f.code === "STRONG_ASSERTION_FLOOR")).toEqual([]);
    // If this ever trips, strict matchers were swapped en masse for loose ones — investigate.
  });
});

describe("detectTautologies — catches vacuous semantic tautologies the strong-matcher count misses", () => {
  // Tautological patterns are assembled at runtime (not written verbatim in source) so this test
  // file does not itself trip the guard's scan of tests/ — same technique as detectDisabledTests.
  const tBe = "toBe",
    tEq = "toEqual";
  it("flags literal-bool tautology: expect(true).<tBe>(true)", () => {
    const text = "it('x', () => { expect(true)." + tBe + "(true); });";
    const findings = detectTautologies([{ path: "t.test.ts", text }]);
    expect(findings.length).toBe(1);
    expect(findings[0]!.code).toBe("TAUTOLOGY_ASSERTION");
  });
  it("flags literal-false tautology: expect(false).<tBe>(false)", () => {
    const findings = detectTautologies([
      { path: "t.test.ts", text: "expect(false)." + tBe + "(false);" },
    ]);
    expect(findings.length).toBe(1);
  });
  it("flags identical-identifier self-comparison: expect(foo).<tBe>(foo)", () => {
    const findings = detectTautologies([
      { path: "t.test.ts", text: "expect(foo)." + tBe + "(foo);" },
    ]);
    expect(findings.length).toBe(1);
    expect(findings[0]!.code).toBe("TAUTOLOGY_ASSERTION");
  });
  it("flags numeric-literal tautology: expect(42).<tBe>(42)", () => {
    const findings = detectTautologies([
      { path: "t.test.ts", text: "expect(42)." + tBe + "(42);" },
    ]);
    expect(findings.length).toBe(1);
  });
  it("does NOT flag a genuine assertion: expect(a).<tBe>(1)", () => {
    const findings = detectTautologies([{ path: "t.test.ts", text: "expect(a)." + tBe + "(1);" }]);
    expect(findings.length).toBe(0);
  });
  it("does NOT flag expect(true).<tBe>(false) — different literal values", () => {
    const findings = detectTautologies([
      { path: "t.test.ts", text: "expect(true)." + tBe + "(false);" },
    ]);
    expect(findings.length).toBe(0);
  });
  it("does NOT flag expect(a).<tBe>(b) — different identifiers", () => {
    const findings = detectTautologies([{ path: "t.test.ts", text: "expect(a)." + tBe + "(b);" }]);
    expect(findings.length).toBe(0);
  });
  it("countTautologyAssertions returns the count of tautological matches", () => {
    const tautText = "expect(true)." + tBe + "(true); expect(42)." + tBe + "(42);";
    expect(countTautologyAssertions([{ text: tautText }])).toBe(2);
    expect(countTautologyAssertions([{ text: "expect(a)." + tBe + "(1);" }])).toBe(0);
  });
  it("MAX_TAUTOLOGY_ASSERTIONS is 0 for the real repo floor", () => {
    expect(MAX_TAUTOLOGY_ASSERTIONS).toBe(0);
  });
  it("the real repo has zero tautological assertions", () => {
    const res = runStatic(process.cwd());
    expect(res.findings.filter((f) => f.code === "TAUTOLOGY_ASSERTION")).toEqual([]);
    expect(res.findings.filter((f) => f.code === "TAUTOLOGY_FLOOR")).toEqual([]);
  });
  void tEq; // suppress unused-variable lint warning; available for future toEqual tautology tests
});
