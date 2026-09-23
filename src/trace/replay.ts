/**
 * Trace replay (spec §8.8).
 *
 * `replay(trace, rules)` reconstructs the initial state and applies the actions
 * through `step`, asserting the recorded FINAL hash if present. Determinism
 * (§8.5) means a correct engine always reproduces that hash; a mismatch is how
 * bugs become reproducible (§15). When the trace carries Trace-v2
 * `per_step_hashes`, replay also pinpoints the FIRST divergent action
 * (`divergedAtStep`); a v1 trace (final hash only) replays exactly as before.
 */
import { hashState } from "../core/hash.js";
import type { EngineAction, Rules } from "../core/engine.js";
import { runActions, type Trace } from "./record.js";
import { SAVE_MODE, SaveIntegrityError } from "../persist/save_load.js";
import {
  assertTraceActions,
  assertTraceExpectedFinalHash,
  assertTraceIdentityFields,
  assertTraceSourceRefConsistency,
  assertTraceState,
  assertTraceStepHashes,
  type TraceActionFields,
  type TraceExpectedFinalHashFields,
  type TraceIdentityFields,
  type TraceSourceRefFields,
  type TraceStateFields,
  type TraceStepHashFields,
} from "./integrity.js";

type ReplayResult = {
  ok: boolean;
  finalHash: string;
  expectedFinalHash?: string;
  /**
   * Index of the first action whose post-state hash diverged from the trace's
   * recorded `per_step_hashes` baseline. Populated only when the trace carries
   * that Trace-v2 field AND a divergence exists; otherwise undefined (a v1 trace
   * has no per-step baseline, so divergence can only be known at the final hash).
   */
  divergedAtStep?: number;
  message?: string;
};

/** First index where two same-length hash arrays differ; -1 if none. */
function firstDivergentStep(actual: string[], baseline: string[]): number {
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== baseline[i]) return i;
  }
  return -1;
}

export function assertTraceMode<A extends EngineAction>(
  trace: Trace<A>,
): asserts trace is Trace<A> & { mode: typeof SAVE_MODE } & TraceSourceRefFields;
export function assertTraceMode(trace: {
  mode?: unknown;
  trace_id?: unknown;
  content_hash?: unknown;
  seed?: unknown;
  initial_state?: unknown;
  actions?: unknown;
  expected_final_hash?: unknown;
  per_step_hashes?: unknown;
  source_ref?: unknown;
  worldQuestId?: unknown;
  generatedRpgSeed?: unknown;
}): asserts trace is { mode: typeof SAVE_MODE } & TraceIdentityFields &
  TraceActionFields &
  TraceStateFields &
  TraceExpectedFinalHashFields &
  TraceStepHashFields &
  TraceSourceRefFields;
export function assertTraceMode(trace: {
  mode?: unknown;
  trace_id?: unknown;
  content_hash?: unknown;
  seed?: unknown;
  initial_state?: unknown;
  actions?: unknown;
  expected_final_hash?: unknown;
  per_step_hashes?: unknown;
  source_ref?: unknown;
  worldQuestId?: unknown;
  generatedRpgSeed?: unknown;
}): void {
  if (trace.mode !== SAVE_MODE) {
    throw new SaveIntegrityError(
      `Trace mode must be "${SAVE_MODE}", got ${JSON.stringify(trace.mode)}.`,
    );
  }
  assertTraceIdentityFields(trace);
  assertTraceState(trace);
  assertTraceActions(trace);
  assertTraceExpectedFinalHash(trace);
  assertTraceStepHashes(trace);
  assertTraceSourceRefConsistency(trace);
}

/**
 * Replay a trace against a rule set. If the trace carries `expected_final_hash`,
 * the result `ok` reflects whether the replayed final hash matches it. If it also
 * carries `per_step_hashes` (Trace v2), `divergedAtStep` localizes the first
 * action whose post-state diverged — the actual debugging value (§15).
 *
 * `ok` is the conjunction of every check the trace made available: a per-step
 * divergence fails the replay on its own, whether or not a final hash was
 * recorded to compare. `ok:true` therefore means "nothing this trace could prove
 * wrong is wrong", never "nothing was checked".
 */
export function replayTrace<A extends EngineAction>(
  trace: Trace<A>,
  rules: Rules<A>,
): ReplayResult {
  assertTraceMode(trace);
  const run = runActions(rules, trace.initial_state, trace.actions);
  const finalHash = hashState(run.finalState);

  // Localize the first divergent step when a per-step baseline exists.
  let divergedAtStep: number | undefined;
  if (trace.per_step_hashes !== undefined) {
    const idx = firstDivergentStep(run.hashes, trace.per_step_hashes);
    if (idx !== -1) divergedAtStep = idx;
  }
  const stepField = divergedAtStep !== undefined ? { divergedAtStep } : {};

  if (trace.expected_final_hash === undefined) {
    // A trace may legitimately omit the final hash — assertTraceExpectedFinalHash
    // (integrity.ts) permits absence, so hand-authored and trimmed traces land
    // here. But a per-step baseline the trace DOES carry is still evidence, and a
    // divergence against it is a known replay failure: reporting ok:true beside a
    // populated divergedAtStep is self-contradictory, and every consumer gates on
    // `.ok` alone (bin/replay exits 0, inspect_trace prints hash_ok:true), so the
    // one thing this replay actually proved wrong would be announced as a clean
    // round-trip (§8.8, §15). Fail on the divergence we can see.
    if (divergedAtStep === undefined) {
      return {
        ok: true,
        finalHash,
        message: "Replayed with no expected final hash to assert.",
      };
    }
    return {
      ok: false,
      finalHash,
      divergedAtStep,
      message:
        `Replayed with no expected final hash to assert, but the recorded per-step baseline diverged. ` +
        `First divergence at step ${divergedAtStep} (action ${describeAction(trace, divergedAtStep)}).`,
    };
  }

  const finalMatches = finalHash === trace.expected_final_hash;
  if (finalMatches && divergedAtStep === undefined) {
    return { ok: true, finalHash, expectedFinalHash: trace.expected_final_hash };
  }

  const where =
    divergedAtStep !== undefined
      ? ` First divergence at step ${divergedAtStep} (action ${describeAction(trace, divergedAtStep)}).`
      : "";
  return {
    ok: finalMatches && divergedAtStep === undefined,
    finalHash,
    expectedFinalHash: trace.expected_final_hash,
    ...stepField,
    message: `Final hash ${finalHash} ${finalMatches ? "==" : "!="} expected ${
      trace.expected_final_hash
    }.${where}`,
  };
}

/** Best-effort, side-effect-free label for the action at a divergent step. */
function describeAction<A extends EngineAction>(trace: Trace<A>, step: number): string {
  const action = trace.actions[step];
  if (action === undefined) return "out of range";
  const id = (action as { id?: unknown }).id;
  const type = (action as { type?: unknown }).type;
  return [type, id].filter((v) => typeof v === "string").join(":") || JSON.stringify(action);
}
