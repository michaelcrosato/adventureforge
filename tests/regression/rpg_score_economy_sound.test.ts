/**
 * Structural verification (§15) — every shipped RPG pack's SCORE ECONOMY is sound: the
 * maximum score reachable by concrete play equals the declared `max_score`, EXACTLY. The
 * RPG completion of bug_0148's parser score-economy proof, and the score analogue of the
 * bug_0145/0146/0147 variant-liveness trilogy (same exhaustive BFS, same onState hook, a
 * different property asserted at each reachable state). Together with bug_0148 this closes
 * the score-economy defect class for BOTH score-bearing modes — CYOA packs carry no
 * milestone scoring, so parser + RPG are the whole scope.
 *
 * ── The gap this closes (a defect class NO existing check covers) ────────────────────
 * The corpus already proves, exhaustively: every declared ENDING is reachable
 * (rpg_all_endings_reachable, bug_0124) and every reactive VARIANT is live
 * (rpg_variant_liveness, bug_0147). It does NOT prove the score economy is sound. Two real
 * defects slip through every current check (exactly as in the parser proof):
 *   (1) BOUNDED OVERFLOW — a misconfigured / double-counted / re-farmable award pushes the
 *       reachable score PAST the declared ceiling (a "55/50"). The exhaustive ending solver
 *       catches only an UNBOUNDED farm (the score var never settles -> the BFS hits its
 *       state cap -> a loud cappedOut). A BOUNDED over-award (two one-time awards summing
 *       above max_score, or a miscalibrated inc_var) leaves the state space finite, so the
 *       solver passes and NOTHING flags it.
 *   (2) PHANTOM POINTS — `max_score` is declared HIGHER than any route can reach (the
 *       completionist's "I finished 25/50 and there were no more points anywhere"). The
 *       reachability proof checks only WHICH endings fire, never the score AT them, so a
 *       max_score no route reaches is invisible to it.
 * One tight invariant catches BOTH directions: the maximum score observed over the COMPLETE
 * reachable region equals `pack.meta.max_score`.
 *   - reachable max  > declared -> overflow / farm / under-declared max_score   (case 1)
 *   - reachable max  < declared -> phantom points (max_score unreachably high)   (case 2)
 *   - reachable max == declared -> the economy is exactly as advertised          (sound)
 *
 * ── Why RPG is the harder mode, and how this stays SOUND ─────────────────────────────
 * CYOA and the parser stage are fully DETERMINISTIC, so the parser proof (bug_0148) mines
 * the score from a single-`Rules` BFS. RPG adds the engine's only randomness: an ATTACK
 * round draws a d6 for the player's strike and a d6 for the enemy's reply, a skill check
 * draws a d20 (src/rpg/combat.ts). So, exactly as the every-ending RPG proof (bug_0124) and
 * the RPG variant-liveness proof (bug_0147) do, this drives `exhaustiveEndingsMulti` under
 * TWO rule sets that differ only in the rolls their combat/skill resolver draws — one
 * forcing the player's BEST rolls (max strike, min damage taken, max skill roll), one their
 * WORST — and records the maximum `score` var over the union of both reachable regions.
 *
 * The soundness argument is the SCORE specialization of the bracket's monotonicity. Every
 * score award fires at one of three kinds of site:
 *   - ROLL-INDEPENDENT awards (an interaction/take/on_enter/dialogue `inc_var`) — collected
 *     by stepping the relevant non-combat action, which the BFS explores under BOTH regimes.
 *   - ROLL-WINNING awards — an enemy's `on_defeat` (fires when the enemy dies) and a skill
 *     check's `on_success` (fires when the d20 meets the difficulty). The BEST regime maxes
 *     these out: it wins every fight and passes every check, so it collects ALL of them.
 *   - ROLL-LOSING awards — a skill check's `on_failure` (fires when the d20 misses). The
 *     best regime collects NONE of these (it always passes). This is the ONE site the best
 *     regime skips, and the only way the bracket could UNDER-count the true maximum (a
 *     fail-then-retry-succeed middle path could collect a fail-award AND a success-award the
 *     two fixed extremes never collect together). There is no "survive a lost fight" award
 *     site — a fight the player loses ends at the enemy's `death_ending` (terminal), so
 *     combat contributes only roll-winning awards.
 * So if no score award rides an `on_failure`, the BEST regime alone collects every award
 * the true-maximum path collects, hence observed max (which includes the best regime) ==
 * true reachable max. The suite ASSERTS exactly that (the `scoreAwardOnFailure` guard
 * below): a future on_failure score award trips a LOUD, explained failure rather than
 * silently under-crediting into a FALSE phantom-points alarm. Both shipped packs satisfy it
 * today (every skill check's on_failure only narrates — see the "keep at it" feedback).
 *
 * ── The roll-bracket caveat (shared with bug_0124/0147), reused ──────────────────────────
 * The bracket also reaches the right STATES only if routing does not depend on a transient
 * HP value the extremes skip. One conservative form is supported: a monotone player
 * `hp <= threshold` route in a `combat_guaranteed` pack whose threshold is at least the
 * maximum possible one-round counterattack. The all-worst regime must cross that threshold
 * alive. Enemy HP, equality/lower-bound, and unsafe player-HP predicates still fail loudly.
 *
 * ── The action policy (shared with the liveness proofs) ─────────────────────────────────
 * The shared BFS's default (reachability) policy SKIPS READ and LOOK, but score awards can
 * ride READ effects or an authored INSPECT interaction that resolves through natural LOOK.
 * This therefore uses the bug_0146 LIVENESS action policy plus the runtime's explicit
 * authored-inspect predicate: step READ, stateful target LOOK, ATTACK, USE, and every other
 * progress action while skipping inert observations and DROP. The search FAILS on cappedOut,
 * so it can never pass by truncating an unexplored region. Every shipped pack must settle
 * under the bounded cap. Wolf Winter's pre-crisis authored graph measured 630,199 states;
 * the unchanged 800k ceiling forces later families to preserve a complete bounded bracket
 * and remains a loud runaway guard rather than an implicit truncation.
 *
 * Packs are auto-discovered from content/rpg/quests, so a new RPG pack is covered the moment
 * it ships (the health-covers-all-packs bar, bug_0096).
 */
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { compileRpgSource, loadRpgSourceFile } from "../../src/rpg/source.js";
import {
  indexRpgPack,
  buildRpgRules,
  initStateForRpgPack,
  type RpgIndex,
} from "../../src/rpg/runner.js";
import { isAuthoredInspectAction } from "../../src/rpg/legal_actions.js";
import type { Rng } from "../../src/core/rng.js";
import type { RpgAction } from "../../src/api/types.js";
import { exhaustiveEndingsMulti } from "./support/exhaustive_endings.js";
import { hpConditionSupportForPack } from "./support/rpg_hp_condition_support.js";
import {
  seededOpeningTransferFailureMessage,
  seededOpeningTransferSupportForPack,
} from "./support/seeded_opening_transfer.js";

const PACK_DIR = "content/rpg/quests";
const packFiles = readdirSync(PACK_DIR)
  .filter((f) => f.endsWith(".yaml"))
  .sort();

// The conventional Stage-3 scoring var (identical to the parser proof, bug_0148). Score
// accrues via inc_var; the validator's SCORE_UNREACHABLE upper bound already reasons about
// this same var, so there is no second scoring var to consider.
const SCORE_VAR = "score";

// Same evidence-backed safety bound as the action-id / variant-liveness / metamorphic
// proofs. Route-rich Wolf Winter's pre-crisis graph measured 630,199 states under this
// policy on 2026-07-14; every later family must still settle under this unchanged ceiling,
// so a combinatorial blowup fails LOUDLY instead of truncating into a silent pass.
const MAX_STATES = 800_000;

// Vitest runs the full corpus concurrently in CI, where the largest shipped-pack search
// can take far longer than an isolated run under two-vCPU contention. Run 29421570804
// completed every other assertion (2,535 passed) but Wolf-Winter reached this old
// nine-minute fail-fast before reporting its unchanged bounded result. Interruptible
// dialogue (f23c8a09) made room actions legal beside topics, multiplying edges per
// dialogue state. MAX_STATES still bounds the actual search work, so this only gives the
// exhaustive proof the same CI headroom as the observation-stream proof; it cannot turn
// a capped or incorrect result green.
const SOLVER_TEST_TIMEOUT_MS = 1_500_000;

// The liveness action policy (bug_0146): step every legal action EXCEPT the ones that
// provably cannot gate a score award — the inert observation verbs and DROP. Authored
// INSPECT effects ride on LOOK, so their target looks are explicitly restored below.
const LIVENESS_SKIP: ReadonlySet<string> = new Set([
  "DROP",
  "CLOSE",
  "LOOK",
  "INVENTORY",
  "INSPECT",
]);
const livenessExplore = (index: RpgIndex, action: RpgAction): boolean =>
  isAuthoredInspectAction(index, action) || !LIVENESS_SKIP.has(action.type);

// A fixed-sequence PRNG (copied from rpg_all_endings_reachable / rpg_variant_liveness): each
// draw consumes the next fraction (the last repeats once exhausted). `int(min,max)` maps the
// fraction the way mulberry32 does, so HIGH->max face, 0->min face. resolveAttack draws
// player strike then enemy reply; resolveSkillCheck draws once.
const HIGH = 0.999999;
const LOW = 0;
function fixedSeqRng(fracs: number[]): Rng {
  let i = 0;
  const next = (): number => {
    const f = fracs[Math.min(i, fracs.length - 1)] ?? 0;
    i += 1;
    return f;
  };
  return {
    next,
    int(min: number, max: number): number {
      const lo = Math.ceil(min);
      const hi = Math.floor(max);
      return lo + Math.floor(next() * (hi - lo + 1));
    },
  };
}
// BEST for the player: own strike max, damage taken min, skill roll max -> [HIGH, LOW].
// WORST for the player: own strike min, damage taken max, skill roll min -> [LOW, HIGH].
const bestRng = (): Rng => fixedSeqRng([HIGH, LOW]);
const worstRng = (): Rng => fixedSeqRng([LOW, HIGH]);

/** True iff an effect writes the score var (inc_var or set_var named `score`). */
function effectWritesScore(eff: unknown): boolean {
  if (!eff || typeof eff !== "object") return false;
  for (const k of ["inc_var", "set_var"] as const) {
    const w = (eff as Record<string, unknown>)[k];
    if (w && typeof w === "object" && (w as { name?: unknown }).name === SCORE_VAR) return true;
  }
  return false;
}

/**
 * Recursively scan a compiled pack for a score award sitting inside a skill-check
 * `on_failure` branch — the ONE roll-losing award site the best-roll regime skips (see the
 * header). If any pack ever does this, the best regime no longer reaches the true maximum
 * and the bracket would FALSELY flag phantom points; the guard surfaces it as a loud,
 * explained failure instead. (`on_failure` arrays appear only under a skill_check, so a
 * generic scan for the key is exactly the roll-losing branch.)
 */
function scoreAwardOnFailure(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(scoreAwardOnFailure);
  if (node && typeof node === "object") {
    const onFail = (node as Record<string, unknown>).on_failure;
    if (Array.isArray(onFail) && onFail.some(effectWritesScore)) return true;
    return Object.values(node as Record<string, unknown>).some(scoreAwardOnFailure);
  }
  return false;
}

/**
 * The maximum `score` var observed over the COMPLETE reachable region under the best/worst-
 * roll bracket (the true reachable maximum), plus whether the search exhausted that region.
 * onState records at EVERY distinct state INCLUDING terminal/ended ones — crucial, because
 * both shipped packs' top award lands AT the terminal claim (cold_forge's +20 ember on_enter
 * and sunken_barrow's +25 circlet take_effects both fire as the win condition trips).
 */
function maxReachableScore(index: RpgIndex): { max: number; min: number; cappedOut: boolean } {
  let max = 0;
  // The floor, over the same complete region (intake cacc2a4f). Nothing clamps `score` at
  // zero — dec_var has no floor in src/core/effects.ts — and a negative score makes a save
  // permanently unloadable (assertRpgStateReferences refuses it). The WORST regime is in the
  // bracket, so a penalty that rides a failed roll is visited too.
  let min = 0;
  const ruleSets = [buildRpgRules(index, bestRng), buildRpgRules(index, worstRng)];
  const result = exhaustiveEndingsMulti(
    ruleSets,
    initStateForRpgPack(index, 7),
    MAX_STATES,
    (s) => {
      const score = s.vars[SCORE_VAR] ?? 0; // score is undefined until the first inc_var
      if (score > max) max = score;
      if (score < min) min = score;
    },
    { explore: (action) => livenessExplore(index, action) },
  );
  return { max, min, cappedOut: result.cappedOut };
}

describe("bug_0149 — every RPG pack's reachable max score equals its declared max_score", () => {
  it("discovers the shipped RPG packs", () => {
    // Guard against a vacuous pass if the glob ever yields nothing.
    expect(packFiles.length).toBeGreaterThanOrEqual(2);
  });

  // Guard against a vacuous suite: at least one shipped pack must actually declare a scoring
  // economy (max_score > 0), or the per-pack equality below would be 0 === 0 noise.
  it("the shipped corpus actually exercises scoring (some pack declares max_score > 0)", () => {
    const maxima = packFiles.map((f) => {
      const loaded = loadRpgSourceFile(join(PACK_DIR, f));
      if (!loaded.ok) throw new Error(`pack must compile: ${f}`);
      return loaded.compiled.pack.meta.max_score;
    });
    expect(maxima.some((m) => m > 0)).toBe(true);
  });

  for (const file of packFiles) {
    it(
      `${file}: the reachable maximum score equals the declared max_score (no overflow, no phantom points)`,
      () => {
        const loaded = loadRpgSourceFile(join(PACK_DIR, file));
        expect(loaded.ok).toBe(true);
        if (!loaded.ok) return;
        const pack = loaded.compiled.pack;
        const seededOpeningSupport = seededOpeningTransferSupportForPack(pack);
        expect(
          seededOpeningSupport.unsupported,
          seededOpeningTransferFailureMessage(file, seededOpeningSupport),
        ).toBe(false);
        const declared = pack.meta.max_score;

        // Caveat guard A: only a monotone, safely crossed player-HP upper bound is supported.
        // Every other raw HP route still fails loudly.
        const hpSupport = hpConditionSupportForPack(pack);
        expect(
          hpSupport.unsupported,
          `pack gates a condition on an unsupported HP predicate — only player hp <= threshold ` +
            `at or above the maximum one-round counterattack in a combat_guaranteed pack is supported`,
        ).toBe(false);

        // Caveat guard B (score-specific): the bracket reaches the right SCORE soundly only
        // when no award rides a skill-check on_failure (the one roll-losing site the best
        // regime skips). Otherwise the bracket could under-count -> a FALSE phantom alarm.
        expect(
          scoreAwardOnFailure(pack),
          `pack awards score in a skill-check on_failure — the best-roll regime never fails, ` +
            `so the bracket would under-count the reachable maximum; branch the check before ` +
            `trusting the economy here`,
        ).toBe(false);

        const { max, min, cappedOut } = maxReachableScore(indexRpgPack(pack));

        // The search must have exhausted the reachable region, else the observed maximum is
        // unproven (a higher score could lie in the truncated tail).
        expect(cappedOut, `state-space search hit the ${MAX_STATES} cap`).toBe(false);
        // The floor (intake cacc2a4f): no reachable state may carry a negative score, or a
        // save taken there could never be restored.
        expect(
          min,
          `a reachable state carries score ${min} — a penalty drives score below zero, and a save taken there is unloadable`,
        ).toBeGreaterThanOrEqual(0);
        // The crux: reachable max > declared is overflow/farm/under-declared max_score;
        // reachable max < declared is phantom points (a max_score no route can reach).
        expect(
          max,
          `reachable max score (${max}) != declared max_score (${declared}) — ` +
            (max > declared
              ? "score OVERFLOWS the declared ceiling (a farmable/double-counted award?)"
              : "declared max_score is PHANTOM (no route reaches it)"),
        ).toBe(declared);
      },
      SOLVER_TEST_TIMEOUT_MS,
    );
  }

  it("FAILS on a planted OVERFLOW pack (a reachable score above the declared ceiling)", () => {
    // Two one-time awards (read +20, take +15) sum to 35 by concrete play, but max_score
    // declares only 30 — a bounded over-award the exhaustive ending solver would NOT catch
    // (the state space stays finite). The check must catch it: reachable max 35 != 30.
    const src = `
meta: { id: t, title: T, start_room: a, max_score: 30, vars_init: { hp: 10, attack: 3, defense: 1 } }
rooms:
  - id: a
    name: A
    description: "base"
    objects: [tome, gem]
    exits: [{ direction: north, to: b }]
  - id: b
    name: B
    description: "B"
    exits: [{ direction: south, to: a }]
objects:
  - id: tome
    name: tome
    description: "a tome"
    read_text: "words"
    interactions:
      - verb: READ
        target: tome
        conditions: [{ not_flag: read_tome }]
        effects:
          - set_flag: read_tome
          - inc_var: { name: score, by: 20 }
  - id: gem
    name: gem
    description: "a gem"
    takeable: true
    take_effects:
      - inc_var: { name: score, by: 15 }
win_conditions: [{ id: w, conditions: [{ visited: b }], ending: e }]
endings: [{ id: e, title: E, text: "done" }]
`;
    const r = compileRpgSource(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { max, cappedOut } = maxReachableScore(indexRpgPack(r.compiled.pack));
    expect(cappedOut).toBe(false);
    expect(max).toBe(35); // the true reachable max…
    expect(max).not.toBe(r.compiled.pack.meta.max_score); // …which the equality check rejects (35 != 30)
  });

  it("FAILS on a planted BELOW-ZERO pack (a penalty that can drive score negative)", () => {
    // The gem's take awards +10, but kicking the bucket costs 5 and is available from the
    // start — so a player who kicks first holds score -5 (intake cacc2a4f). The floor check
    // must see that state: reachable min -5 < 0, while the max still equals max_score.
    const src = `
meta: { id: t, title: T, start_room: a, max_score: 10, vars_init: { hp: 10, attack: 3, defense: 1 } }
rooms:
  - id: a
    name: A
    description: "base"
    objects: [bucket, gem]
    exits: [{ direction: north, to: b }]
  - id: b
    name: B
    description: "B"
    exits: [{ direction: south, to: a }]
objects:
  - id: bucket
    name: bucket
    description: "a bucket"
    interactions:
      - verb: USE
        target: bucket
        conditions: [{ not_flag: kicked }]
        effects:
          - set_flag: kicked
          - dec_var: { name: score, by: 5 }
  - id: gem
    name: gem
    description: "a gem"
    takeable: true
    take_effects:
      - inc_var: { name: score, by: 10 }
win_conditions: [{ id: w, conditions: [{ visited: b }], ending: e }]
endings: [{ id: e, title: E, text: "done" }]
`;
    const r = compileRpgSource(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { max, min, cappedOut } = maxReachableScore(indexRpgPack(r.compiled.pack));
    expect(cappedOut).toBe(false);
    expect(max).toBe(10); // the ceiling check alone would pass this pack…
    expect(min).toBe(-5); // …but the floor sees the kick-first state
    expect(min).toBeLessThan(0);
  });

  it("FAILS on a planted PHANTOM-POINTS pack (a declared max_score no route can reach)", () => {
    // The tome awards +20 — the only score source — yet max_score declares 50. The
    // completionist's "20/50 and no points left anywhere": reachable max 20 != 50.
    const src = `
meta: { id: t, title: T, start_room: a, max_score: 50, vars_init: { hp: 10, attack: 3, defense: 1 } }
rooms:
  - id: a
    name: A
    description: "base"
    objects: [tome]
    exits: [{ direction: north, to: b }]
  - id: b
    name: B
    description: "B"
    exits: [{ direction: south, to: a }]
objects:
  - id: tome
    name: tome
    description: "a tome"
    read_text: "words"
    interactions:
      - verb: READ
        target: tome
        conditions: [{ not_flag: read_tome }]
        effects:
          - set_flag: read_tome
          - inc_var: { name: score, by: 20 }
win_conditions: [{ id: w, conditions: [{ visited: b }], ending: e }]
endings: [{ id: e, title: E, text: "done" }]
`;
    const r = compileRpgSource(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { max, cappedOut } = maxReachableScore(indexRpgPack(r.compiled.pack));
    expect(cappedOut).toBe(false);
    expect(max).toBe(20); // the true reachable max…
    expect(max).not.toBe(r.compiled.pack.meta.max_score); // …which the equality check rejects (20 != 50)
  });

  it("CREDITS a score award reachable only by WINNING a fight (the best-roll regime is load-bearing)", () => {
    // The RPG soundness crux: the top of the score economy rides an enemy's `on_defeat`, and
    // the bracket reaches it ONLY because the BEST-roll regime drives the fight to the
    // enemy's death. The ogre is tuned so the player WINS under best rolls but DIES under
    // worst — so the +10 defeat award is reachable ONLY via the best regime. A negative twin
    // (worst regime alone) tops out at 0, demonstrating the best-roll regime is load-bearing
    // for the score economy — the score analogue of bug_0147's win-a-fight liveness control.
    //   best  (strike d6=6, reply d6=1): R1 player 6+2=8 -> ogre 12->4, ogre 1+8=9 -> hero 10->1;
    //                                     R2 player 8 -> ogre 4->0 dies (+10), hero lives at 1.
    //   worst (strike d6=1, reply d6=6): R1 player 1+2=3 -> ogre 12->9, ogre 6+8=14 -> hero dies.
    const src = `
meta: { id: t, title: T, start_room: a, max_score: 10, vars_init: { hp: 10, attack: 2, defense: 0 } }
rooms:
  - id: a
    name: A
    description: "an ogre blocks the way"
    exits: [{ direction: north, to: b }]
  - id: b
    name: B
    description: "B"
    exits: [{ direction: south, to: a }]
enemies:
  - id: ogre
    name: ogre
    description: "a hulking ogre"
    room: a
    hp: 12
    attack: 8
    defense: 0
    defeat_flag: ogre_slain
    death_ending: dead
    on_defeat:
      - inc_var: { name: score, by: 10 }
win_conditions: [{ id: w, conditions: [{ visited: b }], ending: e }]
endings:
  - { id: e, title: E, text: "you live" }
  - { id: dead, title: D, text: "the ogre kills you" }
`;
    const r = compileRpgSource(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const index = indexRpgPack(r.compiled.pack);

    // With the full best/worst bracket the +10 defeat award is reached (best regime wins),
    // so the reachable max == the declared max_score of 10 — a sound economy.
    expect(maxReachableScore(index).max).toBe(10);

    // Control: drive the SAME pack under the WORST regime alone — the player dies before the
    // ogre falls, the +10 never lands, and the reachable max is (correctly) 0. This is what
    // the proof would FALSELY read as phantom points without the best regime in the bracket.
    let worstMax = 0;
    exhaustiveEndingsMulti(
      [buildRpgRules(index, worstRng)],
      initStateForRpgPack(index, 7),
      MAX_STATES,
      (s) => {
        const score = s.vars[SCORE_VAR] ?? 0;
        if (score > worstMax) worstMax = score;
      },
      { explore: (action) => livenessExplore(index, action) },
    );
    expect(worstMax).toBe(0);
  });

  it("CREDITS a score award carried by a natural LOOK with authored INSPECT effects", () => {
    const src = `
meta: { id: t, title: T, start_room: a, max_score: 20, vars_init: { hp: 10, attack: 3, defense: 1 } }
rooms:
  - id: a
    name: A
    description: "base"
    objects: [patient]
    exits: [{ direction: north, to: b }]
  - id: b
    name: B
    description: "B"
    on_enter:
      - inc_var: { name: score, by: 10 }
    exits: [{ direction: south, to: a }]
objects:
  - id: patient
    name: patient
    description: "visible symptoms"
    interactions:
      - verb: INSPECT
        target: patient
        conditions: [{ not_flag: patient_examined }]
        effects:
          - set_flag: patient_examined
          - inc_var: { name: score, by: 10 }
win_conditions: [{ id: w, conditions: [{ visited: b }], ending: e }]
endings: [{ id: e, title: E, text: "done" }]
`;
    const result = compileRpgSource(src);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { max, cappedOut } = maxReachableScore(indexRpgPack(result.compiled.pack));
    expect(cappedOut).toBe(false);
    expect(max).toBe(20);
  });

  it("the on_failure-award guard BITES (a score award on a roll-losing branch is flagged)", () => {
    // The score-specific soundness guard: a +5 award on a skill-check on_failure is the one
    // award site the best-roll regime skips. `scoreAwardOnFailure` must flag it so a real
    // pack that did this would fail LOUD (rather than the bracket silently under-counting and
    // raising a false phantom alarm). A control pack whose on_failure only narrates must NOT
    // trip the guard.
    const awardsOnFailure = `
meta: { id: t, title: T, start_room: a, max_score: 5, vars_init: { hp: 10, attack: 3, defense: 1, might: 3 } }
rooms:
  - id: a
    name: A
    description: "base"
    objects: [slab]
    exits: [{ direction: north, to: b }]
  - id: b
    name: B
    description: "B"
    exits: [{ direction: south, to: a }]
objects:
  - id: slab
    name: slab
    description: "a slab"
    interactions:
      - verb: USE
        item: slab
        target: slab
        skill_check:
          skill: might
          difficulty: 12
          on_success:
            - narrate: "it gives"
          on_failure:
            - inc_var: { name: score, by: 5 }
win_conditions: [{ id: w, conditions: [{ visited: b }], ending: e }]
endings: [{ id: e, title: E, text: "done" }]
`;
    const bad = compileRpgSource(awardsOnFailure);
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    expect(scoreAwardOnFailure(bad.compiled.pack)).toBe(true);

    // Both shipped packs (whose on_failure only narrates "keep at it") must NOT trip it.
    for (const file of packFiles) {
      const loaded = loadRpgSourceFile(join(PACK_DIR, file));
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(scoreAwardOnFailure(loaded.compiled.pack)).toBe(false);
    }
  });
});
