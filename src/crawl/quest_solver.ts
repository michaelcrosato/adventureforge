/**
 * Quest solver — BFS with parent pointers over CONCRETE play, used by the
 * overworld crawler (Task 8) to prove a quest round trip can actually be
 * completed: start it, play it through to a genuine (non-death) ending, then
 * hand the ending back to `OverworldSession.completeQuest`.
 *
 * Deliberately distinct from `src/solve/exhaustive_endings.ts`'s
 * `exhaustiveEndingsMulti` (which proves REACHABILITY under a best/worst-roll
 * bracket and returns no path): this solver steps `prepared.rules` AS SHIPPED
 * (the same rules real play uses, with the default seeded runtime rng —
 * `rngForRuntimeState`, a pure function of `(state.seed, state.step)`), and
 * reconstructs the actual action sequence a player would need to press to
 * reach the ending it finds — that sequence is exactly what the overworld
 * crawler replays to complete the quest.
 *
 * Dedupe uses the same `stateKey` fingerprint `exhaustiveEndingsMulti` uses
 * (excludes `step`, so equivalent states collapse) — sound here for the same
 * reason it's sound there: shipped RPG packs are already proven winnable
 * under worst-case rolls (see rpg_all_endings_reachable.test.ts), so some
 * legal, deterministic playthrough reaching a non-death ending is expected to
 * exist and be found well within a generous state cap.
 *
 * The search skips reversible and inert observation actions, but retains a
 * target LOOK when it carries an authored INSPECT interaction: those natural
 * looks can set flags or award score and therefore are gameplay decisions, not
 * pure refreshes. Dropping inert reads keeps the reachable region tractable
 * (with the full action set, dawn_beacon blows past 60k states without finding
 * an ending). Any path found remains genuine, fully legal play.
 */
import type { RpgAction } from "../api/types.js";
import { makeStep } from "../core/engine.js";
import { memoizeLegalActions, newLegalActionCache } from "../solve/legal_action_cache.js";
import type { GameState } from "../core/state.js";
import { enumerateRpgActions, initStateForRpgPack } from "../rpg/runner.js";
import { isAuthoredInspectAction } from "../rpg/legal_actions.js";
import { stateKey } from "../solve/exhaustive_endings.js";
import type { PreparedQuest } from "./prepare.js";

/** Mirrors `SKIPPED_ACTIONS` in src/solve/exhaustive_endings.ts (private
 *  there) — reversible world edits + pure observations no route ever needs. */
const SKIPPED_ACTION_TYPES: ReadonlySet<string> = new Set([
  "DROP",
  "CLOSE",
  "LOOK",
  "INVENTORY",
  "READ",
  "INSPECT",
]);

/** Why `solveToEnding` found no non-death ending — the two causes need different
 *  diagnoses (see `describeSolveToEndingFailure`): "capped" means the search was
 *  cut off before it could prove anything either way (an honest "unknown", never
 *  a false "unwinnable"); "exhausted-restricted" means the ENTIRE reachable region
 *  under the restricted action set (reversible/inert observations skipped,
 *  authored INSPECT looks retained) was explored and none reached a non-death ending — which does
 *  NOT prove the quest unwinnable, only that no route using the unrestricted
 *  actions exists; the restriction may be hiding a path that needs one of the
 *  skipped actions. */
type SolveToEndingFailureReason = "capped" | "exhausted-restricted";

type SolveToEndingSuccess = {
  ok: true;
  actions: RpgAction[];
  endingId: string;
  endingTitle: string;
  death: boolean;
};

type SolveToEndingFailure = {
  ok: false;
  reason: SolveToEndingFailureReason;
};

type SolveToEndingResult = SolveToEndingSuccess | SolveToEndingFailure;

type SolveToEndingOptions = {
  /**
   * Optional trusted initial state for an embedded overworld launch. Direct
   * quest QA omits this and retains the pack's exact baseline initialization.
   */
  initialState?: GameState;
};

/** Human-readable WORLD-finding wording for a `solveToEnding` failure — kept
 *  next to `SolveToEndingFailureReason` so the two causes' phrasing can't drift
 *  apart from what `reason` actually distinguishes. Exported so the exact
 *  wording is unit-testable without driving a full overworld crawl. */
export function describeSolveToEndingFailure(
  reason: SolveToEndingFailureReason,
  questId: string,
  maxStates: number,
): string {
  if (reason === "capped") {
    return `no non-death ending solvable for round trip (search capped at ${maxStates} states) for quest "${questId}"`;
  }
  return (
    `no non-death ending reachable under the restricted action set ` +
    `(DROP/CLOSE/inert LOOK/INVENTORY/READ/INSPECT skipped; authored INSPECT looks retained) for quest "${questId}" — ` +
    `either the quest is unwinnable or its only path needs a skipped action`
  );
}

type SolverNode = {
  state: GameState;
  parentKey: string | null;
  via: RpgAction | null;
};

/**
 * BFS `prepared.rules` from a fresh seeded initial state, stepping every
 * enumerated progress action, until the first state that is `ended` with a
 * declared, non-death `endingId`. Reconstructs the action path via parent
 * pointers. Returns an `{ ok: false, reason }` failure when no such state is
 * found — `reason: "capped"` when the search hits `maxStates` distinct states
 * first (an honest, unproven cap — never silently reported as "no ending
 * exists"), or `reason: "exhausted-restricted"` when the frontier under the
 * restricted action set is fully explored with no non-death ending reached
 * (also not proof the quest is unwinnable — see `SolveToEndingFailureReason`).
 */
export function solveToEnding(
  prepared: PreparedQuest,
  seed: number,
  maxStates: number,
  options: SolveToEndingOptions = {},
): SolveToEndingResult {
  const { index, rules } = prepared;
  // The loop below enumerates each state's options and then steps them, and makeStep
  // re-enumerates internally for its legality check — so every state was enumerated
  // once per option plus once for the loop. Memoize by state identity; states are
  // immutable and visited once, so the answer cannot go stale.
  const cache = newLegalActionCache<RpgAction>();
  const step = makeStep(memoizeLegalActions(rules, cache));
  const start = options.initialState ?? initStateForRpgPack(index, seed);

  const deathEndingIds = new Set(
    index.pack.endings.filter((ending) => ending.death).map((ending) => ending.id),
  );
  const endingTitleById = new Map(index.pack.endings.map((ending) => [ending.id, ending.title]));

  const nodesByKey = new Map<string, SolverNode>();
  const startKey = stateKey(start);
  nodesByKey.set(startKey, { state: start, parentKey: null, via: null });
  const queue: string[] = [startKey];

  const reconstructActions = (key: string): RpgAction[] => {
    const actions: RpgAction[] = [];
    let cursor: string | null = key;
    while (cursor !== null) {
      const node = nodesByKey.get(cursor);
      if (!node) break;
      if (node.via) actions.unshift(node.via);
      cursor = node.parentKey;
    }
    return actions;
  };

  let head = 0;
  while (head < queue.length) {
    if (nodesByKey.size > maxStates) return { ok: false, reason: "capped" }; // unproven, never a false negative

    const key = queue[head++]!;
    const node = nodesByKey.get(key)!;
    const state = node.state;

    if (state.ended) {
      if (state.endingId && !deathEndingIds.has(state.endingId)) {
        return {
          ok: true,
          actions: reconstructActions(key),
          endingId: state.endingId,
          endingTitle: endingTitleById.get(state.endingId) ?? state.endingId,
          death: false,
        };
      }
      continue; // terminal (death, or no declared ending) — a dead end, not a route
    }

    let options;
    try {
      options = enumerateRpgActions(index, state);
    } catch {
      continue; // treat an enumerate throw as a dead branch for solving purposes
    }

    for (const option of options) {
      if (
        SKIPPED_ACTION_TYPES.has(option.action.type) &&
        !isAuthoredInspectAction(index, option.action)
      )
        continue;
      let result;
      try {
        result = step(state, option.action);
      } catch {
        continue;
      }
      if (!result.ok) continue;
      const k = stateKey(result.state);
      if (nodesByKey.has(k)) continue;
      nodesByKey.set(k, { state: result.state, parentKey: key, via: option.action });
      queue.push(k);
    }
  }

  return { ok: false, reason: "exhausted-restricted" }; // frontier exhausted without a non-death ending
}
