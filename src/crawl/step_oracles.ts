/**
 * Shared per-step crawl oracles (CRASH/INTEGRITY/RENDER/PERSIST) plus the
 * end-of-episode SOFTLOCK checks (S4 immediate form + S3 solver form).
 *
 * Extracted (Task 6) so `quest_crawler.ts`'s live stepping loop and
 * `minimize.ts`'s `reproducesFingerprint` replay run the EXACT same
 * defect-detection logic and can never drift — a minimized repro trace must
 * keep re-triggering the SAME finding fingerprint the live crawl saw.
 */
import type { RpgAction, StepResult } from "../api/types.js";
import { hashState } from "../core/hash.js";
import type { Rng } from "../core/rng.js";
import type { GameState } from "../core/state.js";
import { load, save, SAVE_MODE, type SaveMetadata } from "../persist/save_load.js";
import { buildRpgRules, type RpgIndex } from "../rpg/runner.js";
import { assertRpgStateReferences } from "../rpg/state_integrity.js";
import { exhaustiveEndingsMulti } from "../solve/exhaustive_endings.js";
import { z } from "zod";
import { CrawlLocationSchema, type CrawlFinding, type CrawlSeverity } from "./findings.js";
import { renderDefects } from "./oracles.js";
import type { PreparedQuest } from "./prepare.js";

export type CrawlLocation = z.infer<typeof CrawlLocationSchema>;

/** `err.name: err.message` for an Error, else `String(err)`. */
export function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** The finding fields a per-step oracle can produce, minus the base fields the
 *  caller's `FindingCollector` stamps on (seed/policy/commit/repro; severity
 *  defaults per-code when omitted). */
type OracleFindingInput = Omit<
  CrawlFinding,
  "seed" | "policy" | "commit" | "severity" | "repro"
> & { severity?: CrawlSeverity };

type StepOracleParams = {
  prepared: PreparedQuest;
  step: (state: GameState, action: RpgAction) => StepResult;
  /** State BEFORE `action` is applied. */
  state: GameState;
  action: RpgAction;
  /** Value for the produced finding(s)' `step` field. */
  totalStep: number;
  loc: (state: GameState) => CrawlLocation;
  eSeed: number;
  /** Episode-local step index — PERSIST's cadence + message. */
  sInEpisode: number;
  /** 0 disables the PERSIST oracle. */
  persistEvery: number;
};

type StepOracleOutcome =
  /** `step` itself threw (e.g. a planted resolver bomb) — state unchanged. */
  | { kind: "crashed"; findings: OracleFindingInput[] }
  /** `step` returned `ok:false` — state unchanged; the caller decides whether
   *  that's a LEGALITY finding (live crawl) or a legal, silent skip
   *  (shrinking — a candidate subsequence may break a precondition). */
  | { kind: "rejected"; result: StepResult }
  /** `step` applied; `findings` carries INTEGRITY/RENDER/PERSIST results;
   *  `fatal` is true iff the caller's per-episode loop must stop here (an
   *  INTEGRITY failure or a RENDER-render throw — mirrors the live crawler's
   *  `break`). */
  | { kind: "applied"; state: GameState; findings: OracleFindingInput[]; fatal: boolean };

/**
 * Execute `action` against `state` and run the SAME per-step oracle checks the
 * live quest crawler runs around and after every step: CRASH (a throw out of
 * `step`), INTEGRITY, RENDER (itself CRASH-wrapped), and PERSIST
 * (cadence-gated). Shared by `crawlQuest`'s stepping loop and
 * `reproducesFingerprint`'s replay (Task 6) so the two can never drift.
 */
export function runStepOracles(p: StepOracleParams): StepOracleOutcome {
  let result: StepResult;
  try {
    result = p.step(p.state, p.action);
  } catch (err) {
    return {
      kind: "crashed",
      findings: [
        {
          code: "CRASH",
          step: p.totalStep,
          location: p.loc(p.state),
          action: p.action,
          message: `step threw on action ${JSON.stringify(p.action)}: ${describeError(err)}`,
          stateHash: hashState(p.state),
        },
      ],
    };
  }
  if (!result.ok) return { kind: "rejected", result };

  const state = result.state;
  const findings: OracleFindingInput[] = [];
  const { index, contentHash, sourceRef } = p.prepared;

  // INTEGRITY
  try {
    assertRpgStateReferences(index, state);
  } catch (err) {
    findings.push({
      code: "INTEGRITY",
      step: p.totalStep,
      location: p.loc(state),
      action: p.action,
      message: describeError(err),
      stateHash: hashState(state),
    });
    return { kind: "applied", state, findings, fatal: true };
  }

  // RENDER (observation + events; CRASH oracle around the render itself)
  try {
    for (const m of renderDefects(index, state, result.events)) {
      findings.push({
        code: "RENDER",
        step: p.totalStep,
        location: p.loc(state),
        action: p.action,
        message: m,
        stateHash: hashState(state),
      });
    }
  } catch (err) {
    findings.push({
      code: "CRASH",
      step: p.totalStep,
      location: p.loc(state),
      action: p.action,
      message: `observation render threw: ${describeError(err)}`,
      stateHash: hashState(state),
    });
    return { kind: "applied", state, findings, fatal: true };
  }

  // PERSIST: save→load must roundtrip to a byte-identical state on every state
  // the engine itself produced. A throw is itself a finding, never propagated.
  if (p.persistEvery > 0 && p.sInEpisode % p.persistEvery === 0) {
    try {
      const metadata: SaveMetadata =
        sourceRef && sourceRef[0] === "wq"
          ? { worldQuestId: sourceRef[1] }
          : { generatedRpgSeed: p.eSeed };
      const bytes = save(state, contentHash, SAVE_MODE, metadata);
      const bundle = load(bytes, contentHash);
      if (hashState(bundle.state) !== hashState(state)) {
        findings.push({
          code: "PERSIST",
          step: p.totalStep,
          location: p.loc(state),
          action: p.action,
          message: `save→load hash mismatch at step ${p.sInEpisode}`,
          stateHash: hashState(state),
        });
      }
    } catch (err) {
      findings.push({
        code: "PERSIST",
        step: p.totalStep,
        location: p.loc(state),
        action: p.action,
        message: `save/load threw at step ${p.sInEpisode}: ${describeError(err)}`,
        stateHash: hashState(state),
      });
    }
  }

  return { kind: "applied", state, findings, fatal: false };
}

/** Message for the immediate (S4) SOFTLOCK oracle — a live, non-ended state
 *  with zero legal actions. Shared so the live crawler and the reproducer
 *  fingerprint-match identically. */
export const S4_SOFTLOCK_MESSAGE = "live (non-ended) state has zero legal actions";

/**
 * Forced-roll RNG bracket for the SOFTLOCK(solver) oracle — same construction
 * as `tests/regression/rpg_all_endings_reachable.test.ts` (see there for the
 * full soundness argument): BEST forces the player's max strike / min damage
 * taken / max skill roll, WORST the reverse.
 */
const ROLL_HIGH = 0.999999;
const ROLL_LOW = 0;
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
// resolveAttack draws the player's strike first, the enemy's reply second;
// resolveSkillCheck draws once.
const bestRng = (): Rng => fixedSeqRng([ROLL_HIGH, ROLL_LOW]);
const worstRng = (): Rng => fixedSeqRng([ROLL_LOW, ROLL_HIGH]);

/**
 * End-of-episode SOFTLOCK(solver form): an exhaustive best/worst-roll search
 * from `state` proves no declared ending is reachable. A capped-out search is
 * unproven and never a finding. Explicit `explore: () => true` — allow EVERY
 * enumerated action, not the module's default progress-only policy (sound for
 * a reachability PROOF, but inverted for this oracle: a hidden ending here
 * would mean a FALSE softlock finding). Shared by `crawlQuest` and
 * `reproducesFingerprint` so the two can never drift.
 */
export function softlockSolverCheck(
  index: RpgIndex,
  state: GameState,
  solverBudget: number,
): { message: string } | null {
  const bestRules = buildRpgRules(index, bestRng);
  const worstRules = buildRpgRules(index, worstRng);
  const res = exhaustiveEndingsMulti([bestRules, worstRules], state, solverBudget, undefined, {
    explore: () => true,
  });
  if (res.reached.size === 0 && !res.cappedOut) {
    return {
      message: `no declared ending reachable from post-episode state (searched ${res.states} states)`,
    };
  }
  return null;
}
