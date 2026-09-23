/**
 * bug_0182 — a SoundnessBench-style NEGATIVE CORPUS for `validateRpg`: a set of
 * deliberately-UNSOUND RPG packs the Stage-4 validator MUST REJECT, each pinning ONE
 * previously-untested error branch in the REJECTION direction.
 *
 * This is the generator/validator-boundary twin of bug_0181's load-boundary rejection
 * gate. The motivating gap (SoundnessBench, arXiv:2412.03154; the single-checker blind
 * spot, arXiv:2510.14253 / [[verifier-assertion-guard]]): a checker is only proven
 * sound if its FAILING branches are exercised on input that SHOULD fail. An audit of
 * the suite (bug_0182) found `validateRpg` emits ten error codes, but SIX had NO
 * rejection-direction witness anywhere in the test suite — only COMBAT_UNWINNABLE,
 * COMBAT_NOT_GUARANTEED, COMBAT_GAUNTLET_NOT_GUARANTEED and ENEMY_DEATH_ENDING_UNDECLARED
 * were pinned red-going. So a regression that silently broke any of the six (a dropped
 * `findings.push`, an inverted guard, a `??` default that swallows the case) would pass
 * every existing test GREEN — the present-but-untested-checker surface.
 *
 * The six this corpus opened with:
 *   - MISSING_STAT            — meta.vars_init lacks a required HP/attack/defense stat
 *   - BAD_HP                  — starting HP is not positive
 *   - ENEMY_ROOM_MISSING      — an enemy stands in a room that does not exist
 *   - ENEMY_DEATH_NOT_DEATH   — an enemy's death_ending names a NON-death ending
 *   - SKILL_CHECK_IMPOSSIBLE  — a check whose difficulty exceeds d20 + best skill
 *   - END_GAME_UNDECLARED     — an RPG-only branch (on_defeat) ends at an undeclared ending
 *
 * Then the same blind spot re-opened, exactly as the foundation corpus predicted it
 * would. `validateRpg` grew from those ten codes to 33 while this list stayed a
 * hand-written six, and a later audit found MANEUVER_SEQUENCE_ENEMY_GATE_VOLATILE and
 * MANEUVER_SEQUENCE_HP_CONDITION appearing NOWHERE in the repository outside their
 * three emit sites — invert either guard and every test stayed green. The fix the
 * foundation corpus already carries was never brought across: derive the required code
 * set BY SCANNING THE VALIDATOR SOURCE, so a code that gains an emit site fails this
 * suite until it is either fixtured here or consciously allowlisted with a witness
 * elsewhere. The coverage pin below does that, and the two orphaned maneuver-sequence
 * codes are fixtured as cases seven and eight:
 *   - MANEUVER_SEQUENCE_ENEMY_GATE_VOLATILE — an active-state condition on a sequenced
 *     enemy reads one of its own maneuver result flags, so committing an opening could
 *     make the live foe vanish between beats
 *   - MANEUVER_SEQUENCE_HP_CONDITION        — a sequenced enemy (or one of its
 *     maneuvers) gates on combat HP, which changes between beats and cannot be treated
 *     as an encounter constant
 *
 * Method (the bug_0118/0179 copy-mutate discipline): the GREEN base is the canonical
 * sound pack `generateRpgPack(0)` — it validates clean and carries every structure the
 * defects need (two enemies with on_defeat, a `might` skill_check, vars_init stats, a
 * declared non-death ending). Each case structuredClone()s it and introduces EXACTLY
 * ONE defect, so the rejection is attributable to that mutation alone. The differential
 * anchor (`the green base is clean and carries none of these codes`) proves the code is
 * absent until the mutation introduces it — never a code the base already raised.
 *
 * PURELY ADDITIVE: a new regression test + a bug artifact. No source/validator/engine/
 * schema/generator/corpus/protected-file change, no hash re-pin — the validator is
 * exercised exactly as shipped.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { Enemy, RpgPack } from "../../src/rpg/schema.js";
import { generateRpgPack } from "../../src/gen/rpg_generator.js";
import { validateRpg } from "../../src/validate/rpg_validator.js";

// The canonical sound pack: validates clean (pinned green by rpg_generator.test.ts).
const GREEN: RpgPack = generateRpgPack(0);

const codesOf = (pack: RpgPack): string[] =>
  validateRpg(pack)
    .findings.filter((f) => f.severity === "error")
    .map((f) => f.code);

/** The base pack always has enemies; this narrows the index access for the typechecker. */
const firstEnemy = (p: RpgPack) => {
  const e = p.enemies[0];
  if (!e) throw new Error("base pack has no enemy to mutate");
  return e;
};

/**
 * Installs an INERT two-maneuver follow-through sequence on the first enemy and hands
 * it back. The maneuver-sequence checks only run for an enemy that declares `after`,
 * so the two sequence cases need this scaffold before their defect — and the scaffold
 * itself must add no finding, which the differential anchor below asserts outright.
 */
const withManeuverSequence = (p: RpgPack): Enemy => {
  const enemy = firstEnemy(p);
  enemy.maneuvers = [
    {
      id: "opening_drive",
      command: "drive in low",
      conditions: [],
      result_flag: "opening_drive_used",
      attack_bonus: 2,
      defense_bonus: -1,
      narration: "You drive in low.",
    },
    {
      id: "follow_cut",
      command: "follow with a cut",
      after: "opening_drive",
      conditions: [],
      result_flag: "follow_cut_used",
      attack_bonus: 1,
      defense_bonus: 0,
      narration: "You follow the drive with a cut.",
    },
  ];
  return enemy;
};

/** Each case = one single-defect mutation of the GREEN base, expected to emit `code`. */
interface NegativeCase {
  code: string;
  why: string;
  mutate: (p: RpgPack) => void;
}

const CASES: NegativeCase[] = [
  {
    code: "MISSING_STAT",
    why: "meta.vars_init drops the required defense stat",
    mutate: (p) => {
      delete (p.meta.vars_init as Record<string, number>).defense;
    },
  },
  {
    code: "BAD_HP",
    why: "starting HP is zero (present, but not positive)",
    mutate: (p) => {
      p.meta.vars_init.hp = 0;
    },
  },
  {
    code: "ENEMY_ROOM_MISSING",
    why: "an enemy stands in a room id that does not exist",
    mutate: (p) => {
      firstEnemy(p).room = "no_such_room";
    },
  },
  {
    code: "ENEMY_DEATH_NOT_DEATH",
    why: "an enemy's death_ending points at a declared NON-death ending",
    mutate: (p) => {
      const nonDeath = p.endings.find((e) => !e.death);
      if (!nonDeath) throw new Error("base pack has no non-death ending to point at");
      firstEnemy(p).death_ending = nonDeath.id;
    },
  },
  {
    code: "ENEMY_DEATH_ENDING_UNDECLARED",
    why: "an enemy's death_ending names an ending the pack never declares",
    mutate: (p) => {
      firstEnemy(p).death_ending = "no_such_ending";
    },
  },
  {
    code: "SKILL_CHECK_IMPOSSIBLE",
    why: "a skill check's difficulty exceeds d20 + the best reachable skill",
    mutate: (p) => {
      let found = false;
      for (const o of p.objects)
        for (const it of o.interactions)
          if (it.skill_check) {
            // best `might` ceiling is small (init 3, no buff) ⇒ d20+might tops out ~23.
            it.skill_check.difficulty = 100;
            found = true;
          }
      if (!found) throw new Error("base pack has no skill_check to make impossible");
    },
  },
  {
    code: "END_GAME_UNDECLARED",
    why: "an RPG-only branch (enemy on_defeat) ends at an undeclared ending",
    mutate: (p) => {
      // on_defeat is an RPG-only effect list the PARSER validator never scans, so this
      // exercises validateRpg's own END_GAME_UNDECLARED loop specifically.
      firstEnemy(p).on_defeat.push({ end_game: "no_such_ending" } as never);
    },
  },
  {
    code: "MANEUVER_SEQUENCE_ENEMY_GATE_VOLATILE",
    why: "a sequenced enemy's active-state condition reads its own maneuver result flag",
    mutate: (p) => {
      // Committing the opening sets `opening_drive_used`, which would then switch the
      // live foe off mid-sequence — the enemy the player is halfway through fighting.
      withManeuverSequence(p).conditions = [{ not_flag: "opening_drive_used" }];
    },
  },
  {
    code: "MANEUVER_SEQUENCE_HP_CONDITION",
    why: "a sequenced enemy gates its active state on combat HP, which moves between beats",
    mutate: (p) => {
      // HP changes every exchange, so it cannot be treated as an encounter constant
      // the way the sequence analysis needs. (The validator emits the same code for a
      // MANEUVER-level HP condition; that branch is pinned separately below.)
      withManeuverSequence(p).conditions = [{ var_gte: { name: "hp", value: 5 } }];
    },
  },
];

describe("validateRpg negative corpus — rejection-direction witnesses (bug_0182)", () => {
  it("the GREEN base validates clean and carries none of the targeted codes (differential anchor)", () => {
    const base = codesOf(GREEN);
    expect(validateRpg(GREEN).ok).toBe(true);
    for (const c of CASES) expect(base).not.toContain(c.code);
  });

  for (const c of CASES) {
    it(`REJECTS ${c.code}: ${c.why}`, () => {
      const mutant = structuredClone(GREEN);
      c.mutate(mutant);
      const report = validateRpg(mutant);
      expect(report.ok).toBe(false);
      expect(report.findings.map((f) => f.code)).toContain(c.code);
    });
  }

  it("the corpus is non-degenerate: every case mutates the base into a distinct rejection", () => {
    // Each mutation must FLIP a clean pack to a rejected one — proving the case is a
    // real defect, not a no-op that happened to share the base's (empty) error set.
    for (const c of CASES) {
      const mutant = structuredClone(GREEN);
      c.mutate(mutant);
      expect(codesOf(mutant).length).toBeGreaterThan(0);
    }
  });

  it("the maneuver-sequence scaffold is INERT (the two sequence cases isolate their defect)", () => {
    // Both sequence cases install `withManeuverSequence` before their condition. If the
    // scaffold itself raised anything, those cases would prove nothing about the guard
    // they name — they would only prove that adding maneuvers is rejected.
    const scaffolded = structuredClone(GREEN);
    withManeuverSequence(scaffolded);
    expect(codesOf(scaffolded)).toEqual([]);
    expect(validateRpg(scaffolded).ok).toBe(true);
  });

  it("REJECTS MANEUVER_SEQUENCE_HP_CONDITION at the MANEUVER level too", () => {
    // The code has two emit sites: the enemy's own conditions (a CASE above) and any
    // maneuver's conditions. Inverting either one alone must not pass this suite.
    const mutant = structuredClone(GREEN);
    const enemy = withManeuverSequence(mutant);
    enemy.maneuvers![0]!.conditions = [{ var_gte: { name: "hp", value: 5 } }];
    const report = validateRpg(mutant);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.code)).toEqual(["MANEUVER_SEQUENCE_HP_CONDITION"]);
  });
});

/**
 * The coverage pin. Without it this corpus pinned only what somebody remembered to add:
 * the hand-written case list above was written against a validator that emitted ten
 * codes, `validateRpg` now emits 33, and nothing failed when the gap opened. So invert
 * the direction, exactly as rpg_foundation_negative_corpus.test.ts does — read the emit
 * sites out of the validator SOURCE and require every one to have a witness, with the
 * remainder as an EXPLICIT allowlist. Adding a finding code now fails this suite until
 * it is fixtured here or consciously listed below.
 *
 * Source-parsing keeps the corpus purely additive: no validator change is needed to
 * make its codes machine-readable.
 */
describe("validateRpg finding-code coverage pin", () => {
  const validatorSource = readFileSync("src/validate/rpg_validator.ts", "utf8");
  const emittedCodes = [
    ...new Set(
      [...validatorSource.matchAll(/\b(?:err|warn)\(\s*"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]!),
    ),
  ].sort();

  /**
   * Codes with no fixture in THIS file. Every entry carries a rejection-direction
   * witness elsewhere in the suite — the maneuver family in
   * tests/regression/rpg_enemy_maneuvers.test.ts, the combat bounds across
   * rpg_combat_guaranteed_optin / rpg_combat_winnability_semantics /
   * dawn_beacon_guaranteed_gauntlet, and the pressure tracks in
   * tests/unit/rpg_pressure_tracks.test.ts. The allowlist keeps the data-driven pin
   * honest without duplicating those already-strong probes, and the checks below stop
   * it from becoming a place to park an unwitnessed code. Sorted, to compare against
   * the sorted emit-site scan.
   */
  const WITNESS_ALLOWLIST = [
    "COMBAT_GAUNTLET_NOT_GUARANTEED",
    "COMBAT_NOT_GUARANTEED",
    "COMBAT_UNWINNABLE",
    "DEAD_PRESSURE_TRACK",
    "DUPLICATE_MANEUVER_COMMAND",
    "DUPLICATE_MANEUVER_ID",
    "DUPLICATE_MANEUVER_RESULT_FLAG",
    "MANEUVER_ACTION_ID_COLLISION",
    "MANEUVER_AFTER_CYCLE",
    "MANEUVER_AFTER_MISSING",
    "MANEUVER_AFTER_NOT_ROOT",
    "MANEUVER_AFTER_SELF",
    "MANEUVER_DEFEAT_FLAG_COLLISION",
    "MANEUVER_NO_MODIFIER",
    "MANEUVER_RESOURCE_EFFECT_CONFLICT",
    "MANEUVER_RESOURCE_EFFECT_DUPLICATE",
    "MANEUVER_RESOURCE_EFFECT_UNGUARDED",
    "MANEUVER_RESULT_FLAG_CLEARED",
    "MANEUVER_RESULT_FLAG_FOREIGN_WRITER",
    "MANEUVER_RESULT_FLAG_INITIALIZED",
    "MANEUVER_SEQUENCE_ANALYSIS_LIMIT",
    "MANEUVER_SEQUENCE_ENCOUNTER_UNPROVEN",
    "MANEUVER_SEQUENCE_NO_ROOT",
    "PRESSURE_INITIAL_BELOW_MIN",
    "PRESSURE_VAR_UNDECLARED",
  ];

  /** Every `*.test.ts` in the suite EXCEPT this file — whose allowlist literal above
   *  would otherwise "witness" every code it lists, making the check vacuous. */
  const SELF = "rpg_validator_negative_corpus.test.ts";
  const otherTestSources: { file: string; source: string }[] = [];
  const collect = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.name.endsWith(".test.ts") && entry.name !== SELF)
        otherTestSources.push({ file: path, source: readFileSync(path, "utf8") });
    }
  };
  collect("tests");

  const fixturedHere = new Set(CASES.map((c) => c.code));

  it("reads the validator's emit sites at all (the source scan is never vacuous)", () => {
    // If the emit shape changes, this must fail loudly rather than quietly concluding
    // the validator emits nothing and passing the coverage check by default.
    expect(emittedCodes.length).toBeGreaterThan(30);
    expect(emittedCodes).toContain("COMBAT_UNWINNABLE");
    expect(emittedCodes).toContain("MISSING_STAT");
    expect(emittedCodes).toContain("MANEUVER_SEQUENCE_HP_CONDITION");
    expect(otherTestSources.length).toBeGreaterThan(100);
  });

  it("every validateRpg finding code has a fixture here, or is explicitly allowlisted", () => {
    expect(emittedCodes.filter((code) => !fixturedHere.has(code))).toEqual(WITNESS_ALLOWLIST);
  });

  it("the allowlist carries no stale entries", () => {
    // A code that gained a fixture here must leave the list...
    expect(WITNESS_ALLOWLIST.filter((code) => fixturedHere.has(code))).toEqual([]);
    // ...and a code the validator no longer emits must leave it too.
    expect(WITNESS_ALLOWLIST.filter((code) => !emittedCodes.includes(code))).toEqual([]);
  });

  it("every allowlisted code is named by some other test file", () => {
    // The floor that stops the allowlist from becoming the exemption the pin exists to
    // prevent: a code parked here with no test naming it anywhere fails immediately.
    // (Naming is necessary, not sufficient — the strong witness is that file's
    // assertion, which is why fixturing here is always the better answer.)
    const unwitnessed = WITNESS_ALLOWLIST.filter(
      (code) => !otherTestSources.some((entry) => entry.source.includes(code)),
    );
    expect(unwitnessed).toEqual([]);
  });
});
