/**
 * Effect mini-DSL + reducer (spec §7.1, §8.4 step 3).
 *
 * Effects are PURE: each takes a GameState and returns a NEW GameState plus the
 * single event it produced. The reducer never mutates its input. The vocabulary
 * is closed — content cannot introduce new effect kinds (§14 gate).
 */
import { z } from "zod";
import { readVar, type GameState, type ObjectRuntime } from "./state.js";
import type { GameEvent } from "./events.js";

// Numeric var operands must be FINITE: a NaN/±Infinity literal in content is a
// hard validation error, never a playable pack. This stops a content bug from
// silently poisoning var comparisons (var_gte/lte/eq all read through `readVar`'s
// 0 default and behave surprisingly against NaN). Runtime accumulation is guarded separately
// (see `guardFinite`) for the overflow case the schema cannot see statically.
const NameValue = z.object({ name: z.string().min(1), value: z.number().finite() }).strict();
const NameBy = z.object({ name: z.string().min(1), by: z.number().finite() }).strict();

export const EffectSchema = z.union([
  z.object({ set_flag: z.string().min(1) }).strict(),
  z.object({ clear_flag: z.string().min(1) }).strict(),
  z.object({ add_item: z.string().min(1) }).strict(),
  z.object({ remove_item: z.string().min(1) }).strict(),
  z.object({ set_var: NameValue }).strict(),
  z.object({ inc_var: NameBy }).strict(),
  z.object({ dec_var: NameBy }).strict(),
  z.object({ add_journal: z.string() }).strict(),
  z.object({ goto: z.string().min(1) }).strict(),
  z.object({ open_object: z.string().min(1) }).strict(),
  // The inverse of open_object (first-class CLOSE verb). Open-state is NOT
  // monotone once this exists: the RPG validator's `is_open` win-stability
  // check tracks close_object falsifiers exactly as relocks falsify
  // is_explicitly_unlocked. Additive — no shipped pack emits it, so every existing pack
  // compiles byte-identically and all recorded traces replay unchanged.
  z.object({ close_object: z.string().min(1) }).strict(),
  z
    .object({
      set_object_locked: z.object({ id: z.string().min(1), locked: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      place_object: z
        .object({
          id: z.string().min(1),
          room: z.string().min(1),
          takenBy: z.enum(["player", "world"]).optional(),
        })
        .strict(),
    })
    .strict(),
  // Stage 4 (§13, §14 gate): advance a quest to a named stage. Reuses the
  // questStage field already in GameState (§6); deterministic, no randomness.
  z
    .object({
      set_quest_stage: z.object({ quest: z.string().min(1), stage: z.string().min(1) }).strict(),
    })
    .strict(),
  z.object({ narrate: z.string() }).strict(),
  z.object({ end_game: z.string().min(1) }).strict(),
]);

export type Effect = z.infer<typeof EffectSchema>;

function patchObject(
  state: GameState,
  id: string,
  patch: Partial<ObjectRuntime>,
): Record<string, ObjectRuntime> {
  const prev = state.objectState[id] ?? {};
  return { ...state.objectState, [id]: { ...prev, ...patch } };
}

/**
 * Keep a numeric var value FINITE. The schema rejects non-finite literals, but a
 * runtime accumulation (e.g. repeated inc_var, or a pre-existing non-finite var)
 * could still compute NaN/±Infinity. When it does, we reject the write — keeping
 * the prior value so var comparisons stay meaningful — and report a `diagnostic`
 * on the event rather than silently poisoning state. Deterministic: the same
 * inputs always produce the same rejection.
 */
function guardFinite(
  name: string,
  candidate: number,
  prior: number,
): { value: number; diagnostic?: string } {
  if (Number.isFinite(candidate)) return { value: candidate };
  return {
    value: prior,
    diagnostic: `non-finite result for var "${name}" (${String(candidate)}) rejected; kept ${prior} to preserve deterministic comparisons`,
  };
}

/** Apply ONE effect. Returns the new state and the event it emitted. Pure. */
export function applyEffect(
  effect: Effect,
  state: GameState,
): { state: GameState; event: GameEvent } {
  if ("set_flag" in effect) {
    return {
      state: { ...state, flags: { ...state.flags, [effect.set_flag]: true } },
      event: { type: "state_change", effect: "set_flag", flag: effect.set_flag },
    };
  }
  if ("clear_flag" in effect) {
    return {
      state: { ...state, flags: { ...state.flags, [effect.clear_flag]: false } },
      event: { type: "state_change", effect: "clear_flag", flag: effect.clear_flag },
    };
  }
  if ("add_item" in effect) {
    const inventory = state.inventory.includes(effect.add_item)
      ? [...state.inventory]
      : [...state.inventory, effect.add_item];
    return {
      state: { ...state, inventory },
      event: { type: "take", item: effect.add_item },
    };
  }
  if ("remove_item" in effect) {
    return {
      state: { ...state, inventory: state.inventory.filter((i) => i !== effect.remove_item) },
      event: { type: "drop", item: effect.remove_item },
    };
  }
  if ("set_var" in effect) {
    const prior = readVar(state.vars, effect.set_var.name);
    const { value, diagnostic } = guardFinite(effect.set_var.name, effect.set_var.value, prior);
    return {
      state: { ...state, vars: { ...state.vars, [effect.set_var.name]: value } },
      event: {
        type: "state_change",
        effect: "set_var",
        name: effect.set_var.name,
        value,
        ...(diagnostic ? { diagnostic } : {}),
      },
    };
  }
  if ("inc_var" in effect) {
    const prior = readVar(state.vars, effect.inc_var.name);
    const { value: next, diagnostic } = guardFinite(
      effect.inc_var.name,
      prior + effect.inc_var.by,
      prior,
    );
    return {
      state: { ...state, vars: { ...state.vars, [effect.inc_var.name]: next } },
      // `value` is the var's resulting total (consistent with set_var's "new value"),
      // and `delta` is the signed change just applied (+by, or 0 if a non-finite
      // result was rejected). Without delta a consumer can't recover "points just
      // earned" from the event: a blind playtester (sealed_crypt, seed 13) saw the
      // identical rope-use score event report value:15 in one run and value:10 in
      // another and could not tell the +10 increment from the running total (bug_0060).
      event: {
        type: "state_change",
        effect: "inc_var",
        name: effect.inc_var.name,
        value: next,
        delta: diagnostic ? 0 : effect.inc_var.by,
        ...(diagnostic ? { diagnostic } : {}),
      },
    };
  }
  if ("dec_var" in effect) {
    const prior = readVar(state.vars, effect.dec_var.name);
    const { value: next, diagnostic } = guardFinite(
      effect.dec_var.name,
      prior - effect.dec_var.by,
      prior,
    );
    return {
      state: { ...state, vars: { ...state.vars, [effect.dec_var.name]: next } },
      // delta is the signed change (-by, or 0 if a non-finite result was rejected),
      // so a consumer reads the cost directly off the event instead of diffing the
      // running total (bug_0060).
      event: {
        type: "state_change",
        effect: "dec_var",
        name: effect.dec_var.name,
        value: next,
        delta: diagnostic ? 0 : -effect.dec_var.by,
        ...(diagnostic ? { diagnostic } : {}),
      },
    };
  }
  if ("add_journal" in effect) {
    return {
      state: { ...state, journal: [...state.journal, effect.add_journal] },
      event: { type: "state_change", effect: "add_journal", text: effect.add_journal },
    };
  }
  if ("goto" in effect) {
    const from = state.current;
    return {
      state: { ...state, current: effect.goto, visited: { ...state.visited, [effect.goto]: true } },
      event: { type: "move", from, to: effect.goto },
    };
  }
  if ("open_object" in effect) {
    return {
      state: { ...state, objectState: patchObject(state, effect.open_object, { open: true }) },
      event: { type: "open_object", id: effect.open_object },
    };
  }
  if ("close_object" in effect) {
    return {
      state: { ...state, objectState: patchObject(state, effect.close_object, { open: false }) },
      event: { type: "close_object", id: effect.close_object },
    };
  }
  if ("set_object_locked" in effect) {
    return {
      state: {
        ...state,
        objectState: patchObject(state, effect.set_object_locked.id, {
          locked: effect.set_object_locked.locked,
        }),
      },
      event: {
        type: "state_change",
        effect: "set_object_locked",
        id: effect.set_object_locked.id,
        locked: effect.set_object_locked.locked,
      },
    };
  }
  if ("place_object" in effect) {
    // Move an object into a room (e.g. a DROP, or a scripted placement). The
    // object's room overrides its static home; holding it (inventory) takes
    // precedence over room when locating it (§7.3, parser object model).
    return {
      state: {
        ...state,
        objectState: patchObject(state, effect.place_object.id, {
          room: effect.place_object.room,
          ...(effect.place_object.takenBy ? { takenBy: effect.place_object.takenBy } : {}),
        }),
      },
      event: {
        type: "state_change",
        effect: "place_object",
        id: effect.place_object.id,
        room: effect.place_object.room,
      },
    };
  }
  if ("set_quest_stage" in effect) {
    return {
      state: {
        ...state,
        questStage: {
          ...state.questStage,
          [effect.set_quest_stage.quest]: effect.set_quest_stage.stage,
        },
      },
      event: {
        type: "state_change",
        effect: "set_quest_stage",
        quest: effect.set_quest_stage.quest,
        stage: effect.set_quest_stage.stage,
      },
    };
  }
  if ("narrate" in effect) {
    return { state, event: { type: "narration", text: effect.narrate } };
  }
  if ("end_game" in effect) {
    return {
      state: { ...state, ended: true, endingId: effect.end_game },
      event: { type: "ending", endingId: effect.end_game },
    };
  }
  const _exhaustive: never = effect;
  return _exhaustive;
}

/**
 * Apply a list of effects IN ORDER. Returns the new state and ordered events.
 *
 * The list stops at `end_game`. Termination is a property of the STATE, not of a
 * particular call site, so the reducer has to hold it: the engine's own
 * ended-guards (engine.ts — next action, on_enter, checkWin) all sit OUTSIDE this
 * loop and can only stop the NEXT list, never the rest of the current one. Without
 * the check here, `[{end_game:"died"},{goto:"room_b"},{add_item:"sword"},{end_game:"won"}]`
 * ends the game, then keeps mutating it, and the LAST end_game silently overwrites
 * `endingId` — so the player is told they died and then handed a second `ending`
 * event for a victory, in a room they were moved to after death.
 *
 * That shape is one authoring slip away, and no validator objects: both validators
 * only check that an `end_game` target is a declared ending, never where it sits in
 * a list. The live routes that build such a list are ordinary composition, not
 * exotica — `resolveSkillCheck` returns `[lead, ...on_failure, ...on_failure_when]`
 * and the RPG runner concatenates a check's effects onto the interaction's, then
 * `withRpgDialogueInterruption` composes its dialogue-close `set_var` onto all of it
 * (ahead of any `end_game`, since anything after one never lands — bug_0640).
 * No shipped pack orders one this way today, so every recorded trace and pinned
 * per-step hash is unchanged; this keeps it that way by construction rather than by
 * authoring luck.
 */
export function applyEffects(
  effects: Effect[],
  state: GameState,
): { state: GameState; events: GameEvent[] } {
  let cur = state;
  const events: GameEvent[] = [];
  for (const e of effects) {
    // The game is over: nothing further in this list lands, and nothing further
    // is reported. The effect that ENDED it has already been applied and its
    // `ending` event pushed, so a terminal list still narrates in full.
    if (cur.ended) break;
    // `remove_item` is intentionally idempotent. An authored cleanup list may
    // cover several mutually exclusive routes, so the item is not necessarily
    // present on every path. Keep that no-op out of the event log: reporting a
    // DROP for an item the player never held leaks internal bookkeeping and is
    // materially false. Capture presence before applying the effect so a real
    // add-then-remove sequence still emits its ordered TAKE and DROP events.
    const removedHeldItem = "remove_item" in e && cur.inventory.includes(e.remove_item);
    const res = applyEffect(e, cur);
    cur = res.state;
    if (!("remove_item" in e) || removedHeldItem) events.push(res.event);
  }
  return { state: cur, events };
}
