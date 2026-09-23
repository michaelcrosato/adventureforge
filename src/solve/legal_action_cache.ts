/**
 * Legal-action memoization by immutable state identity.
 *
 * `makeStep` defensively re-checks membership in `rules.legalActions(state)` on
 * every transition (engine.ts §8.4.1). A BFS that enumerates a state's actions and
 * then steps each one therefore enumerates the same state once for the loop plus
 * once per (action × rule set) — measured on `gallowmere` as 35,261 `legalActions`
 * invocations for 6,851 states, a 5.1× multiple. The enumeration itself is the
 * expensive part: it probes every verb against every visible object and runs a full
 * `resolveRpgAction` + condition evaluation per candidate.
 *
 * Engine states are immutable and each is visited once, so object identity is a
 * sound cache key and a WeakMap releases the entry with the state graph.
 *
 * Sharing one cache across several rule sets is licensed by the invariant the
 * exhaustive solver already documents: legality is RNG-independent in every mode, so
 * a best-roll and a worst-roll regime see the same legal set for the same state. The
 * cache is per-search, never global: a caller that mutates a pack between searches
 * gets a fresh map rather than a stale answer.
 *
 * This is the same trick `rpg_metamorphic_observation_stream.test.ts` used inline to
 * make its four-way regime comparison affordable; the solver had the identical need.
 */
import type { Rules } from "../core/engine.js";
import type { EngineAction } from "../core/engine.js";
import type { GameState } from "../core/state.js";

type LegalActionCache<A extends EngineAction> = WeakMap<GameState, A[]>;

export function newLegalActionCache<A extends EngineAction>(): LegalActionCache<A> {
  return new WeakMap<GameState, A[]>();
}

/**
 * Wrap `rules` so `legalActions` answers from `cache` when the same state object has
 * already been enumerated. Every other hook is passed through untouched, so the
 * wrapped rules are behaviourally identical — this changes how often the enumeration
 * runs, never what it returns.
 */
export function memoizeLegalActions<A extends EngineAction>(
  rules: Rules<A>,
  cache: LegalActionCache<A>,
): Rules<A> {
  return {
    ...rules,
    legalActions(state: GameState): A[] {
      const cached = cache.get(state);
      if (cached !== undefined) return cached;
      const actions = rules.legalActions(state);
      cache.set(state, actions);
      return actions;
    },
  };
}
