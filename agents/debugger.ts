/**
 * Debugger agent (spec §12.5, §15).
 *
 * Turns a failed or odd playthrough into a diagnosis. It is deterministic code over
 * the pure engine: it replays a trace's actions through `step`, inspects the
 * terminal state and the legal-action set at each turn, and classifies what went
 * wrong (soft-lock, conversation trap, an unrecoverable death, or a loop with no
 * exit). `inspect_trace` is its caller. The §15 bug records themselves are authored
 * YAML under `traces/bugs/`, checked by `npm run verify:bug-traces`; a JSON
 * artifact builder and a regression-test stub generator used to live beside this
 * and the fixer, and were removed once nothing but their own tests called them.
 *
 * No LLM is required to *find* a structural failure; the engine's legal-action
 * set is ground truth. A model can still author the prose diagnosis, but the
 * classification here is code, so it cannot be argued away.
 */
import type { GameState } from "../src/core/state.js";
import type { EngineAction, Rules } from "../src/core/engine.js";
import { makeStep } from "../src/core/engine.js";
import { hashState } from "../src/core/hash.js";

export type FailureType =
  | "soft_lock" // not ended, but no legal action makes progress
  | "loop" // revisits a prior state with no ending reachable
  | "rejected_action" // a step the player expected to work was illegal
  | "death_unrecoverable" // ended on a death with no earlier save point in the trace
  | "no_failure"; // reached a (non-death) ending cleanly

export type Diagnosis = {
  type: FailureType;
  description: string;
  severity: "low" | "medium" | "high";
  where: string[];
  /** Step index (0-based action ordinal) at which the issue manifested. */
  step: number;
};

export type DiagnoseOptions = {
  /** True if `endingId` is a winning (non-death) ending. Defaults to "any ending wins". */
  isWinningEnding?: (endingId: string) => boolean;
  /** Location label for `where` (scene/room id). Defaults to `state.current`. */
  locationLabel?: (state: GameState) => string;
};

/**
 * Replay a trace and classify its outcome. Pure: same (rules, state, actions) ⇒
 * same diagnosis (§8.5). Detects the classic adventure failure modes a playtester
 * persona surfaces (§12.8) without needing to understand the content.
 */
export function diagnose<A extends EngineAction>(
  rules: Rules<A>,
  initialState: GameState,
  actions: A[],
  opts: DiagnoseOptions = {},
): Diagnosis {
  const step = makeStep(rules);
  const where = (s: GameState): string => opts.locationLabel?.(s) ?? s.current;
  // Progress key ignores the monotonic step counter: returning to the same
  // *meaningful* state (location/flags/vars/inventory/objects) is a non-progress
  // loop even though the step number always advances.
  const progressKey = (s: GameState): string => hashState({ ...s, step: 0 });
  let state = initialState;
  const seen = new Set<string>([progressKey(state)]);

  for (let i = 0; i < actions.length; i++) {
    const result = step(state, actions[i]!);
    if (!result.ok) {
      return {
        type: "rejected_action",
        description: `Action #${i} (${actions[i]!.type}) was rejected: ${result.rejectionReason ?? "illegal"}.`,
        severity: "medium",
        where: [`location:${where(state)}`],
        step: i,
      };
    }
    state = result.state;
    const h = progressKey(state);
    // A repeated state with no ending reached is a non-progress loop.
    if (!state.ended && seen.has(h)) {
      return {
        type: "loop",
        description: `The playthrough returned to an already-seen state at "${where(state)}" without ending — a non-progress loop.`,
        severity: "medium",
        where: [`location:${where(state)}`],
        step: i,
      };
    }
    seen.add(h);
  }

  if (state.ended) {
    const id = state.endingId ?? "(unknown)";
    const won = opts.isWinningEnding ? opts.isWinningEnding(id) : true;
    if (won) {
      return {
        type: "no_failure",
        description: `Reached ending "${id}".`,
        severity: "low",
        where: [`ending:${id}`],
        step: actions.length,
      };
    }
    return {
      type: "death_unrecoverable",
      description: `Ended on death/failure ending "${id}". Recoverable only if an earlier save exists (§8.7); this trace carries none.`,
      severity: "high",
      where: [`ending:${id}`],
      step: actions.length,
    };
  }

  // Not ended after the trace: is the player stuck (no legal actions)?
  const legal = rules.legalActions(state);
  if (legal.length === 0) {
    return {
      type: "soft_lock",
      description: `At "${where(state)}" there are no legal actions and the game has not ended — a soft-lock.`,
      severity: "high",
      where: [`location:${where(state)}`],
      step: actions.length,
    };
  }
  return {
    type: "no_failure",
    description: `Playthrough ran out of recorded actions at "${where(state)}" with ${legal.length} legal action(s) remaining.`,
    severity: "low",
    where: [`location:${where(state)}`],
    step: actions.length,
  };
}
