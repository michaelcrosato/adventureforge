/**
 * ENGINE — the pure reducer (spec §8.1, §8.4, §8.5).
 *
 * `step` is the one public engine function. It must not mutate its input, must
 * not perform I/O, and must not read any clock or global RNG. All randomness
 * flows through the seeded PRNG (core/rng.ts) derived from state.seed/state.step.
 *
 * Content lives OUTSIDE the engine. The engine asks an RPG `Rules` resolver what
 * an action means in the current state while keeping the reducer pure and
 * content-agnostic.
 */
import { MAX_ENGINE_STEP, type GameState } from "./state.js";
import type { GameEvent } from "./events.js";
import type { Condition } from "./conditions.js";
import { evalConditions } from "./conditions.js";
import type { Effect } from "./effects.js";
import { applyEffects } from "./effects.js";
import { canonicalize } from "./hash.js";
import type { RpgAction, StepResult } from "../api/types.js";

/** Minimal shape the reducer needs from an RPG-compatible action. */
export type EngineAction = { type: string; [key: string]: unknown };

/** What an action resolves to in a given state. `null` ⇒ no such rule. */
export type Resolution = {
  conditions: Condition[];
  effects: Effect[];
};

/**
 * The content layer's contract with the engine. A resolver is pure: same state
 * + same action ⇒ same resolution. It never touches I/O or randomness.
 */
export type Rules<A extends EngineAction = RpgAction> = {
  /** The legal-action set for this state (Jericho-style, §9). Ground truth for legality. */
  legalActions: (state: GameState) => A[];
  /** Conditions + effects for an action, or null if the action has no rule here. */
  resolve: (state: GameState, action: A) => Resolution | null;
  /** Effects fired when a location is entered (scene/room `on_enter`, §8.4 step 4). */
  onEnter?: (state: GameState, locationId: string) => Effect[];
  /**
   * Win conditions evaluated after an action's effects, even when NO location
   * transition occurred (§8.4.5) — for a win that must fire on a deliberate
   * non-move action (claiming the goal item, administering a cure) rather than on
   * bare room entry. Returns the `end_game` effect(s) to append, or `[]` if no win
   * is met. Optional: a runner whose wins only ever fire on room entry omits it and
   * keeps `onEnter`'s win check (the two are complementary — `onEnter` covers
   * reach-the-room wins, `checkWin` covers act-in-the-room wins).
   */
  checkWin?: (state: GameState) => Effect[];
  /**
   * Optional: append extra events derived from the events a step just produced —
   * engine *chrome*, not content. The canonical use is classic text-adventure score feedback:
   * the RPG runner turns a `score` inc_var/dec_var event into a player-facing
   * "[Your score has gone up by N points…]" narration (the same generic-chrome idea
   * as the observation's "Final score: X of Y." closure). Pure: it sees the full,
   * ordered event list for the step and returns only the events to append. The
   * content-free engine never inspects which var is "score" — that knowledge stays
   * in the content layer that supplies this hook.
   *
   * The argument is a SNAPSHOT — mutating it cannot affect the step's result, and
   * returning it unchanged appends nothing. Purity is enforced here, not trusted.
   */
  decorateEvents?: (events: GameEvent[]) => GameEvent[];
};

/** Structural equality for actions — used to test membership in the legal set. */
export function actionEquals(a: EngineAction, b: EngineAction): boolean {
  return canonicalize(a) === canonicalize(b);
}

function reject(state: GameState, reason: string): StepResult {
  const events: GameEvent[] = [{ type: "rejected", reason }];
  return { state, events, ok: false, rejectionReason: reason };
}

/**
 * Build the pure `step(state, action)` for a given rule set. The returned
 * function matches the §8.1 signature exactly.
 */
export function makeStep<A extends EngineAction = RpgAction>(rules: Rules<A>) {
  return function step(state: GameState, action: A): StepResult {
    // A finished game accepts no further actions. No state change.
    if (state.ended) return reject(state, "The game has already ended.");

    // Keep the public action counter inside the safe integer domain. `step`
    // feeds deterministic RNG and trace hashes; once it cannot advance exactly,
    // replay and save/load integrity are no longer trustworthy.
    if (state.step >= MAX_ENGINE_STEP) {
      return reject(state, "The game has reached the maximum safe step count.");
    }

    // §8.4.1 — legality against the legal-action set. No state change on failure.
    // Canonicalize the probe ONCE rather than inside the predicate: actionEquals
    // canonicalizes both operands, so testing membership in a set of N actions cost
    // 2N JSON.stringify passes when N+1 suffice. Purely local — same comparison, same
    // result — and it sits under every solver BFS, where it is the hot path.
    const target = canonicalize(action);
    const legal = rules.legalActions(state).some((a) => canonicalize(a) === target);
    if (!legal) return reject(state, "That action is not available right now.");

    const resolution = rules.resolve(state, action);
    if (resolution === null) return reject(state, "That action has no effect here.");

    // §8.4.2 — conditions. No state change on failure.
    if (!evalConditions(resolution.conditions, state)) {
      return reject(state, "You can't do that yet.");
    }

    // §8.4.3 — apply effects in declared order. State-changing effects emit one
    // event each; an idempotent remove of an item not held emits no false DROP.
    const before = state.current;
    const applied = applyEffects(resolution.effects, state);
    let next = applied.state;
    const events: GameEvent[] = [...applied.events];

    // §8.4.4 — on_enter effects when a location transition occurred.
    if (rules.onEnter && next.current !== before && !next.ended) {
      const enter = applyEffects(rules.onEnter(next, next.current), next);
      next = enter.state;
      events.push(...enter.events);
    }

    // §8.4.5 — post-action win check. A win that turns on a non-move action
    // (taking the relic, administering the cure) fires here, against the
    // post-effects state. Skipped when the game already ended — so a win an
    // effect-level or onEnter `end_game` already fired never double-fires.
    if (rules.checkWin && !next.ended) {
      const win = applyEffects(rules.checkWin(next), next);
      next = win.state;
      events.push(...win.events);
    }

    // Engine chrome: append decoration events (e.g. score-change feedback) derived
    // from everything that just happened this step. State-free — it adds player-facing
    // narration only, never mutates `next` — so determinism and the state hash are
    // untouched. Run last, so the score line lands after the action's own narration.
    //
    // The hook gets a SNAPSHOT, not the live array: this is the engine's only
    // extension seam, and handing it the array we are about to return let a
    // misbehaving decorator splice or clear the step's own events. Copying here
    // makes the documented purity a property of the engine rather than a promise
    // the hook has to keep — same defensive spread as `applied.events` above. A
    // decorator that returns its own argument is caught too, since the returned
    // array is the snapshot and appending it would duplicate every event.
    if (rules.decorateEvents) {
      const snapshot = [...events];
      const decorated = rules.decorateEvents(snapshot);
      if (decorated !== snapshot) events.push(...decorated);
    }

    // §8.4.6 — advance the step counter (state hash is recomputed by callers/trace).
    next = { ...next, step: next.step + 1 };

    return { state: next, events, ok: true };
  };
}
