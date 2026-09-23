/**
 * Mode-agnostic exhaustive ending-reachability solver (shared by parser and RPG
 * structural-verification suites).
 *
 * The engine (src/core/engine.ts) is content-free: it asks a `Rules` resolver for the
 * legal-action set of a state and for what each action means. `rules.legalActions(state)`
 * is, by the engine's own contract, the GROUND TRUTH legality set — the exact set
 * `makeStep` validates an action against — so a breadth-first search that, from each
 * reachable state, steps the legal actions and dedupes on a total state fingerprint
 * explores the concrete reachable region of a pack, regardless of mode (parser
 * verb-object commands and RPG combat actions both surface here as `Action`s). This is
 * the dynamic ground truth the validators' conservative static reachability check only
 * approximates.
 *
 * Soundness rests on three properties of the modes this serves:
 *   1. DETERMINISM / ROLL BRACKETING — `resolve` is pure for a given rules object
 *      (same state + action + roll stream ⇒ same result). RPG skill checks and combat are
 *      the routing-relevant rolls; the structural callers use `exhaustiveEndingsMulti` with
 *      rule sets that force the player's best/worst rolls, so one fingerprint can expose
 *      both success and failure transitions. See rpg_all_endings_reachable.test.ts.
 *      (RPG winnability under WORST rolls stays proven separately by the combat-bound
 *      checks, src/validate/rpg_validator.ts; this proves ROUTE EXISTENCE — every declared
 *      ending is reachable under SOME play.)
 *   2. FINITENESS — the fingerprint collapses interchangeable states, and every shipped
 *      pack's vars are bounded, so the visited set is finite and the BFS terminates.
 *      The MAX_STATES
 *      caller-supplied cap is only a backstop: a future unbounded-var pack trips it and
 *      the caller FAILS on `cappedOut`, so the search can never silently pass by
 *      truncating an unexplored region.
 *   3. MONOTONE ACTION RESTRICTION — the parser verb×object space is dominated by
 *      REVERSIBLE / inert moves (drop an item, close a door, look around) that explode the
 *      state count (an item dropped in each of N rooms, every inventory subset) without
 *      ever being NEEDED to reach an ending. The search therefore steps only "progress"
 *      actions (see `isProgressAction`), skipping drop/close and the pure-observation
 *      verbs. This is sound for a REACHABILITY proof because restricting the action set is
 *      monotone: any ending still reached is reached by a real, legal playthrough using a
 *      SUBSET of the game's actions, so it is genuinely reachable in the full game. The
 *      only thing a restriction can do is HIDE an ending that truly requires a dropped/
 *      closed item or an authored observation interaction — and that surfaces as a declared
 *      ending going unreached, i.e. a LOUD test failure, never a silent pass. Mode-specific
 *      callers that prove score/menu/variant completeness widen `explore` to retain such
 *      stateful actions. (Shipped packs gate every transition on
 *      has_item / visited / flags / is_explicitly_unlocked; `not_item`/drop appear only in reactive
 *      prose `when:` variants, never on a route — so no ending needs a drop.)
 */
import { makeStep, type EngineAction, type Rules } from "../core/engine.js";
import { memoizeLegalActions, newLegalActionCache } from "./legal_action_cache.js";
import type { GameState } from "../core/state.js";
import type { Action } from "../api/types.js";

/**
 * Action types the default ending search does not step: reversible world edits and
 * observation-shaped actions. Some modes attach sticky effects to READ or to authored
 * INSPECT interactions carried by LOOK; completeness callers for those properties supply
 * a wider `explore` predicate. The default restriction keeps parser verb×object searches
 * tractable and can only hide an ending, which produces a loud reachability failure (see the
 * MONOTONE ACTION RESTRICTION note above). Every
 * other action type — MOVE, TAKE, OPEN, UNLOCK, USE, TALK, ASK, GIVE, ATTACK — is
 * a potential route step and is always explored.
 */
const SKIPPED_ACTIONS: ReadonlySet<string> = new Set([
  "DROP",
  "CLOSE",
  "LOOK",
  "INVENTORY",
  "READ",
  "INSPECT",
]);

function isProgressAction(a: EngineAction): boolean {
  return !SKIPPED_ACTIONS.has(a.type);
}

/**
 * A total, order-independent fingerprint of a game state, covering EVERY field a
 * `Condition`/`Effect` can read or a win can turn on — so two states with the same
 * fingerprint are genuinely interchangeable for reachability and the BFS can dedupe one
 * away without ever pruning a still-distinct branch:
 *   - `current`     — the scene/room the player stands in.
 *   - `visited`     — the set of places seen (parser wins gate on `{visited: room}`).
 *   - `flags`       — boolean switches.
 *   - `inventory`   — carried object ids.
 *   - `vars`        — every numeric var (CYOA's `ticks`, the parser `score`).
 *   - `objectState` — per-object open/lock/location (an opened chest is a DIFFERENT
 *                     state from a closed one even when flags/inventory are untouched —
 *                     omitting this collapses the two and the BFS can never explore "the
 *                     chest is now open"). The lock is encoded as the TRI-STATE the engine
 *                     reads, not as a boolean: no runtime entry (the static `locked` flag
 *                     applies — `isLocked` falls back to it), explicitly locked, and
 *                     explicitly unlocked during play (the only value the
 *                     `is_explicitly_unlocked` condition accepts). Folding "no entry" and
 *                     "explicitly unlocked" into one code let the BFS dedupe two states a
 *                     condition can tell apart. Open-state stays two-valued: every reader
 *                     (`isOpen`, `is_open`) tests `open === true`.
 *   - `questStage`  — quest progress, readable by conditions.
 *   - `ended`/`endingId` — distinguishes terminal states (and which ending fired).
 *
 * Deliberately EXCLUDED: `step` (a monotonic action counter — including it would make
 * every state unique and defeat dedupe entirely; the live RPG runtime does key its rolls
 * on (seed, step), but the searches here bracket every roll with best/worst rule sets
 * whose rng ignores the state, so under those rules `step` decides no transition — a
 * caller that steps the live step-keyed stream would need it in its `key`) and
 * `journal` (append-only player-facing narration that no condition reads, and which is
 * path-dependent, so including it would likewise prevent all dedupe).
 *
 * Built with `Object.keys` and plain loops rather than `Object.entries` chains: this runs
 * once per transition of every census-proof search, and the per-property `[key, value]`
 * tuples were most of its allocation. The keys and their order are unchanged — the
 * default string sort is the same UTF-16 code-unit order the old `a < b` comparator
 * gave over (unique) property names.
 */
export function stateKey(s: GameState): string {
  const flags = trueKeys(s.flags);
  const visited = trueKeys(s.visited);
  const inv = [...s.inventory].sort().join(",");
  const vars = sortedPairs(s.vars);
  const objectIds = Object.keys(s.objectState).sort();
  let objects = "";
  for (let i = 0; i < objectIds.length; i++) {
    const id = objectIds[i]!;
    const o = s.objectState[id]!;
    // "0" = no runtime lock entry, "1" = explicitly locked, "u" = explicitly unlocked.
    // Absent and locked keep their historical codes, so a pack that never touches a lock
    // (every shipped pack) fingerprints byte-identically to before.
    const lock = o.locked === undefined ? 0 : o.locked ? 1 : "u";
    objects += `${i === 0 ? "" : ";"}${id}:${o.open ? 1 : 0}${lock}:${o.takenBy ?? ""}:${o.room ?? ""}`;
  }
  const quests = sortedPairs(s.questStage);
  return `${s.current}|${visited}|${flags}|${inv}|${vars}|${objects}|${quests}|${s.ended ? "E" : ""}${s.endingId ?? ""}`;
}

/** The keys of `rec` whose value is truthy, sorted and comma-joined. */
function trueKeys(rec: Record<string, boolean>): string {
  const keys: string[] = [];
  for (const k of Object.keys(rec)) if (rec[k]) keys.push(k);
  return keys.sort().join(",");
}

/** `k=v` for every own key of `rec`, sorted by key and comma-joined. */
function sortedPairs(rec: Record<string, number | string>): string {
  const keys = Object.keys(rec).sort();
  let out = "";
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    out += `${i === 0 ? "" : ","}${k}=${rec[k]}`;
  }
  return out;
}

export type ExhaustiveResult = {
  /** Every ending id an actual playthrough can terminate at (over the progress-action set). */
  reached: Set<string>;
  /** Distinct states explored (for the verified-live record / cap diagnostics). */
  states: number;
  /** True iff the search hit `maxStates` before exhausting — an UNPROVEN result. */
  cappedOut: boolean;
};

/**
 * Optional knobs on the search, all defaulting to the reachability-tuned behaviour so
 * every existing caller is byte-for-byte unchanged:
 *   - `explore` — the action policy: which legal actions the BFS steps. Defaults to
 *     `isProgressAction` (skip reversible/observation moves), the MONOTONE restriction
 *     that is sound for the every-ending-reachable PROOF (restricting actions can only
 *     HIDE an ending → a loud failure, never invent one). That restriction is NOT sound
 *     for a LIVENESS proof, where skipping a state that displays a variant would FALSELY
 *     call the variant dead (a false positive). The parser variant-liveness caller
 *     therefore widens the policy to step every action EXCEPT those that provably cannot
 *     gate a variant (the pure-observation verbs and DROP — see that test's header), so
 *     a variant is called dead only when the reachable region genuinely never displays
 *     it. (READ in particular carries interaction `effects` — e.g. a `read_recipe` flag —
 *     so it is NOT pure narration and a liveness search must step it; the reachability
 *     search skips it soundly only because no ROUTE gates on a read flag, just reactive
 *     prose. RPG authored INSPECT effects similarly ride on LOOK, so RPG score/variant/menu
 *     callers restore only target looks backed by an INSPECT interaction.)
 *   - `key` — the dedupe fingerprint. Defaults to `stateKey`.
 *   - `onEdge` — observe every TRANSITION the search produces, as a `(fromKey, toKey)`
 *     pair of state fingerprints, INCLUDING edges into already-seen states (which the BFS
 *     would otherwise drop on the dedupe check). Lets a caller reconstruct the full
 *     reachable transition graph — e.g. to run a backward-liveness fixpoint proving every
 *     reachable state can still reach a terminal (no dynamic soft-lock pocket — see
 *     no_dead_pocket.test.ts). Default undefined: when omitted NO edge work is done and the
 *     search is byte-for-byte the original BFS, so every existing caller is unchanged.
 */
export type SearchOpts<A extends EngineAction = Action> = {
  explore?: (a: A) => boolean;
  key?: (s: GameState) => string;
  onEdge?: (fromKey: string, toKey: string) => void;
};

/**
 * Exhaustively explore a pack from `start` through its own `Rules` over the progress-action
 * set; return every ending id reachable by concrete play. Mode-agnostic: the caller
 * supplies the mode's compiled rules and initial state. A rejected action does not change
 * state and is skipped. When `cappedOut` is false the frontier emptied, so `reached` is the
 * complete set of endings reachable via progress actions — a declared ending NOT in it is
 * unreachable (a route is severed), and any ending in it but undeclared is a dangling end
 * target. When `cappedOut` is true the result is unproven and the caller must FAIL.
 */
export function exhaustiveEndings<A extends EngineAction = Action>(
  rules: Rules<A>,
  start: GameState,
  maxStates: number,
  onState?: (s: GameState) => void,
  opts?: SearchOpts<A>,
): ExhaustiveResult {
  return exhaustiveEndingsMulti([rules], start, maxStates, onState, opts);
}

/**
 * The generalization that backs `exhaustiveEndings` and lifts the search into the RPG mode.
 *
 * Deterministic callers can pass one `Rules` whose `resolve` is pure and get the original
 * single-transition BFS. Roll-bearing callers pass SEVERAL rule sets that differ ONLY in
 * the rolls their combat/skill resolver draws: the RPG callers pass best/worst
 * combat+skill regimes. Because the routing-relevant consequence is monotonic in those
 * rolls — did the d20 meet the difficulty, did the enemy reach 0 HP, did the player reach
 * 0 HP — the two extremes bracket every outcome a middle roll could produce, so any ending reachable under SOME rolls is reached here (and
 * conversely every state visited is a real, legal playthrough on real die values, so
 * nothing spurious is reached). See rpg_all_endings_reachable.test.ts for the soundness
 * argument.
 *
 * `legalActions` does NOT depend on the roll (legality is rng-independent in every mode), so
 * the legal set is taken from the first rule set and each action is stepped under all of
 * them; a rejected step (e.g. an action a regime makes unavailable) is simply skipped. For a
 * single deterministic rule set this is identical to the original single-rules BFS — the
 * second-and-later steps just reproduce the first and dedupe away.
 */
export function exhaustiveEndingsMulti<A extends EngineAction = Action>(
  ruleSets: Rules<A>[],
  start: GameState,
  maxStates: number,
  onState?: (s: GameState) => void,
  opts?: SearchOpts<A>,
): ExhaustiveResult {
  if (ruleSets.length === 0)
    throw new Error("exhaustiveEndingsMulti requires at least one rule set");
  // One cache per search, shared across the rule sets — legality is rng-independent
  // (see above), so every regime sees the same legal set for the same state object.
  // Without this, each state is enumerated once for the loop below AND once inside
  // makeStep's legality check per (action × rule set): 5.1 enumerations per state
  // measured on gallowmere, all but one of them redundant.
  const cache = newLegalActionCache<A>();
  const memoized = ruleSets.map((r) => memoizeLegalActions(r, cache));
  const primary = memoized[0]!;
  const explore = opts?.explore ?? ((a: A) => isProgressAction(a));
  const key = opts?.key ?? stateKey;
  const onEdge = opts?.onEdge;
  const steps = memoized.map((r) => makeStep(r));
  const reached = new Set<string>();
  const seen = new Set<string>();
  // Keep FIFO traversal without repeatedly shifting a growing array. `Array.shift()` moves
  // the remaining entries on every dequeue and becomes the dominant cost once a shipped
  // pack reaches hundreds of thousands of states. A monotonic cursor preserves the exact
  // BFS order; clearing consumed slots releases their state graphs while the backing array
  // remains stable for O(1) append/dequeue operations.
  const queue: (GameState | undefined)[] = [start];
  let queueHead = 0;
  seen.add(key(start));

  while (queueHead < queue.length) {
    if (seen.size > maxStates) return { reached, states: seen.size, cappedOut: true };
    const s = queue[queueHead]!;
    queue[queueHead] = undefined;
    queueHead += 1;
    // Observe every DISTINCT reachable state exactly once (each is enqueued once,
    // dequeued once). Lets a caller mine the full reachable region — e.g. which
    // reactive scene/ending variant is the first match in each viewing context —
    // without the generic BFS needing any mode-specific knowledge. Called for the
    // start, terminal, and interior states alike.
    if (onState) onState(s);
    if (s.ended) {
      if (s.endingId) reached.add(s.endingId);
      continue; // a terminal state offers no further actions (a graph sink)
    }
    // Only fingerprint the source state when a caller is collecting edges.
    const fromKey = onEdge ? key(s) : "";
    for (const a of primary.legalActions(s)) {
      if (!explore(a)) continue; // outside the caller's action policy (default: progress-only)
      for (const step of steps) {
        const r = step(s, a);
        if (!r.ok) continue; // a rejected action does not change state
        const k = key(r.state);
        // Surface the transition BEFORE the dedupe check, so edges into an already-seen
        // state (a join in the graph) are reported too — a backward-liveness fixpoint needs
        // every edge, not just tree edges.
        if (onEdge) onEdge(fromKey, k);
        if (seen.has(k)) continue;
        seen.add(k);
        queue.push(r.state);
      }
    }
  }
  return { reached, states: seen.size, cappedOut: false };
}
