/**
 * RPG legal-action generator + resolver (spec §9, §9.2) — the Jericho idea applied
 * to the unified RPG game: compute every currently-valid command and expose a stable
 * `id`, a human-style `command`, and the structured `Action`. The same function
 * that lists an action (`resolveRpgAction`) is what the engine calls to
 * resolve it, so the legal set never contains an action `step` would then reject
 * as *illegal* (legal ⊇ executable, §14). Conditions may still be re-checked by
 * the engine; the generator only lists condition-satisfied actions.
 */
import { evalConditions, type Condition } from "../core/conditions.js";
import { applyEffects, type Effect } from "../core/effects.js";
import type { RpgAction } from "../api/types.js";
import type { Resolution } from "../core/engine.js";
import { readVar, type GameState } from "../core/state.js";
import type { DialogueTopic, Interaction } from "./schema.js";
import type { ManeuverPhase } from "./maneuver_sequence.js";
import { authoredUseActionIdentity } from "./action_ids.js";
import {
  type RpgModelIndex,
  activeDialogue,
  dlgVar,
  isLocked,
  isOpen,
  locateObject,
  nodeText,
  nodeOrdinal,
  npcForState,
  npcsInRoom,
  objectDescription,
  objectName,
  roomDescription,
  visibleObjectIds,
} from "./model.js";

// A USE action that carries a `skill_check` (resolved by the runner as a d20 + skill
// roll, parser/RPG alike) is annotated with the rolled stat + difficulty + die type, so a
// player (and a client) can SEE a stat is in play before committing — without it a
// declared skill var reads as vestigial (bug_0274; CYOA sibling bug_0269). `die: "d20"`
// surfaces the ceiling so "nerve(3) vs 12" reads as "d20+3 vs 12" not a flat impossible
// comparison (bug_0311; mirrors the post-roll d20 label in bug_0141). Only
// `skill`/current `modifier`/`difficulty`/`die` and optional authored public
// `stakes` surface — never the check's raw effects, which carry score/flag/end_game
// routing — so the destination graph stays hidden. Omitted on every non-skill action,
// so the legacy option shape is unchanged.
export type RpgActionOption = {
  id: string;
  command: string;
  action: RpgAction;
  /** Input-only spellings. Structured UI/MCP surfaces expose only `id`; the
   * terminal projection may advertise unambiguous human-readable aliases. */
  inputAliases?: readonly string[];
  skill_check?: {
    skill: string;
    modifier: number;
    difficulty: number;
    die: string;
    stakes?: string;
  };
  combat?: {
    attack_bonus: number;
    defense_bonus: number;
    one_shot: true;
    phase?: ManeuverPhase;
  };
  resources?: { gains: string[]; costs: string[] };
};

/** A visible but currently unavailable authored USE. Deliberately omits the
 * executable action, its conditions, and all effects so this projection can
 * explain friction without exposing puzzle routing. */
export type RpgBlockedActionOption = {
  id: string;
  command: string;
  reason: string;
};

function dialogueTopicMatches(topic: DialogueTopic, id: string): boolean {
  return topic.id === id || (topic.aliases ?? []).includes(id);
}

// State-aware so an enumerated command shows the object's REACTIVE name (bug_0188):
// a righted "toppled cresset" re-labels itself rather than freezing the stale word
// into "look at toppled cresset". Absent any variant `name` this is the base name.
const objName = (index: RpgModelIndex, state: GameState, id: string): string => {
  const o = index.objects.get(id);
  return o ? objectName(o, state) : id;
};

/** Add the ordinary definite article unless an authored name already begins
 * with a capitalized proper owner's possessive noun phrase. */
function definiteObjectNounPhrase(name: string): string {
  const properOwner =
    /^(?:\p{Lu}[\p{L}\p{M}]*(?:-\p{Lu}[\p{L}\p{M}]*)*)(?:\s+\p{Lu}[\p{L}\p{M}]*(?:-\p{Lu}[\p{L}\p{M}]*)*)*['’]s(?:\s|$)/u;
  return properOwner.test(name) ? name : `the ${name}`;
}

/** True if `id` is reachable for the player right now (held or visible in the room). */
export function present(index: RpgModelIndex, state: GameState, id: string): boolean {
  if (state.inventory.includes(id)) return true;
  return visibleObjectIds(index, state, state.current).includes(id);
}

/**
 * True when a structured LOOK targets an authored INSPECT interaction.
 *
 * Exhaustive tooling normally skips LOOK as pure observation. RPG INSPECT
 * interactions deliberately ride on that same natural player action, however,
 * and may set flags, award score, or otherwise open later states. Callers that
 * prune observation actions use this predicate to keep those authored looks in
 * the search without exploring inert room/object rereads.
 */
export function isAuthoredInspectAction(index: RpgModelIndex, action: RpgAction): boolean {
  if (action.type !== "LOOK" || action.target === undefined) return false;
  return (
    index.objects
      .get(action.target)
      ?.interactions.some((interaction) => interaction.verb === "INSPECT") ?? false
  );
}

/** Find the USE interaction (if any) for using `item` on `target`. Exported so the
 *  RPG runner (Stage 4) can detect a skill-check interaction before resolving.
 *
 *  Resolved through `index.useInteractionsByTarget`, so a row is found by what it
 *  TARGETS rather than by which object it was authored under. Reading the target
 *  object's own `interactions` list made authoring position a hidden requirement:
 *  enumeration, the command parser and the winnability validator all harvest USE
 *  rows from every object, so a `USE rope on well` written under `rope` was offered
 *  in the menu and certified as a win route, then failed to resolve and vanished —
 *  a pack that validated clean and could not be finished. Every shipped row happens
 *  to sit on its target, so this widens what resolves without changing any of them. */
export function useInteraction(
  index: RpgModelIndex,
  target: string,
  item?: string,
  state?: GameState,
): Interaction | undefined {
  return index.useInteractionsByTarget.get(target)?.find((it) => {
    if (it.item !== item) return false;
    return state === undefined || evalConditions(it.conditions, state);
  });
}

function readInteractions(index: RpgModelIndex, target: string): Interaction[] {
  return (index.objects.get(target)?.interactions ?? []).filter((it) => it.verb === "READ");
}

/**
 * True when `condition` is a gate the interaction's OWN effects flip: the
 * `not_flag: X` / `set_flag: X` pair (and its `has_flag`/`clear_flag` inverse) that
 * authors use to make a clue fire exactly once.
 *
 * Deliberately limited to flags. An item or var gate that an interaction also
 * consumes (`has_item: X` alongside `remove_item: X`) is NOT treated as one-shot
 * bookkeeping: there the precondition is the thing itself, and dropping it would
 * keep offering the action after the object is gone.
 */
function selfRetiringGate(condition: Condition, effects: readonly Effect[]): boolean {
  if ("not_flag" in condition)
    return effects.some((e) => "set_flag" in e && e.set_flag === condition.not_flag);
  if ("has_flag" in condition)
    return effects.some((e) => "clear_flag" in e && e.clear_flag === condition.has_flag);
  return false;
}

/**
 * The subset of a READ interaction's conditions that gate READING AT ALL, as opposed
 * to gating that interaction's one-shot payload.
 *
 * The shipped idiom is `read_text` on the object plus one READ interaction gated
 * `not_flag: X` whose effects `set_flag: X`. ANDing every condition into the ACTION
 * (as this case used to) retired the whole row after the first read, so the document
 * BODY — the charter's inheritance clause, the memorandum's list of names, the tally
 * the player is meant to quote back later — became unreachable for the rest of the
 * game, on all 16 shipped objects that carry a READ. Stripping the interaction's own
 * self-retiring flag gate keeps the body readable while the payload still fires once.
 *
 * The genuinely environmental gates stay: `has_item: dark_lantern` on the printers'
 * memorandum must keep the text unreadable in the dark, and `not_flag:
 * oswin_overruled` must keep a superseded exhibit closed. Because the result is
 * always a SUBSET of the authored conditions, this can only ever offer READ in states
 * where it was already offered plus states where it was wrongly withheld — it never
 * withdraws one. In any state where READ was legal before, every interaction's
 * conditions held, so the effects are unchanged too.
 */
function readAccessConditions(it: Interaction): Condition[] {
  const keep = (condition: Condition): Condition | null => {
    if (selfRetiringGate(condition, it.effects)) return null;
    // `all_of` is the authored spelling for a multi-part gate, and content mixes the
    // one-shot flag in with real preconditions there, so recurse instead of treating
    // the whole group as atomic. `any_of`/`none_of` stay atomic: a disjunction is not
    // retired just because one arm is.
    if ("all_of" in condition) {
      const survivors = condition.all_of
        .map((child) => keep(child))
        .filter((child): child is Condition => child !== null);
      return survivors.length > 0 ? { all_of: survivors } : null;
    }
    return condition;
  };
  return it.conditions
    .map((condition) => keep(condition))
    .filter((condition): condition is Condition => condition !== null);
}

/** The object's interactions for a state-reactive verb (INSPECT/OPEN/CLOSE),
 *  pre-filtered to those whose conditions hold NOW. Gated per-interaction —
 *  deliberately not the READ pattern of ANDing every condition into the
 *  action, so a retired one-shot clue never retires the verb itself. */
function firingInteractions(
  index: RpgModelIndex,
  state: GameState,
  target: string,
  verb: "INSPECT" | "OPEN" | "CLOSE",
): Interaction[] {
  return (index.objects.get(target)?.interactions ?? []).filter(
    (it) => it.verb === verb && evalConditions(it.conditions, state),
  );
}

/**
 * Resolve a structured action into conditions + effects for the engine, or null
 * if the action is structurally impossible in this state (wrong room, object not
 * present, etc.). Pure: same (index, state, action) ⇒ same resolution.
 */
function resolveRpgActionCore(
  index: RpgModelIndex,
  state: GameState,
  action: RpgAction,
): Resolution | null {
  const here = state.current;
  switch (action.type) {
    case "LOOK": {
      if (action.npc !== undefined) {
        const npc = npcsInRoom(index, state, here).find((candidate) => candidate.id === action.npc);
        return npc ? { conditions: [], effects: [{ narrate: npc.description }] } : null;
      }
      if (action.target === undefined) {
        const room = index.rooms.get(here);
        return room
          ? { conditions: [], effects: [{ narrate: roomDescription(room, state) }] }
          : null;
      }
      if (!present(index, state, action.target)) return null;
      const o = index.objects.get(action.target);
      if (!o) return null;
      // INSPECT interactions ride on examine (bug: schema admitted the verb
      // since Stage 2 but no runtime path ever fired it — shipped clue
      // narrations in collectors_warrant/weighmasters_round silently never
      // showed). Fired per-interaction so a one-shot clue retires itself
      // while the base description stays examinable forever.
      const inspects = firingInteractions(index, state, action.target, "INSPECT");
      return {
        conditions: [],
        effects: [
          { narrate: objectDescription(o, state) },
          ...inspects.flatMap((it) => it.effects),
        ],
      };
    }
    case "INVENTORY": {
      const items = state.inventory.length
        ? state.inventory.map((i) => objName(index, state, i)).join(", ")
        : "nothing";
      return { conditions: [], effects: [{ narrate: `You are carrying: ${items}.` }] };
    }
    case "READ": {
      if (!present(index, state, action.target)) return null;
      const o = index.objects.get(action.target);
      if (!o) return null;
      // READ interactions are fired PER-INTERACTION, exactly as INSPECT/OPEN/CLOSE are
      // (`firingInteractions`), so a one-shot clue retires itself without retiring the
      // document it is attached to. The action's own conditions keep only the gates that
      // decide whether the object can be read at all (`readAccessConditions`).
      const reads = readInteractions(index, action.target);
      const effects: Effect[] = [];
      if (o.read_text) effects.push({ narrate: o.read_text });
      for (const it of reads) {
        if (evalConditions(it.conditions, state)) effects.push(...it.effects);
      }
      if (effects.length === 0) return null; // nothing to read
      const conditions: Condition[] = reads.flatMap((it) => readAccessConditions(it));
      return { conditions, effects };
    }
    case "TAKE": {
      const o = index.objects.get(action.item);
      if (!o || !o.takeable || state.inventory.includes(action.item)) return null;
      if (!visibleObjectIds(index, state, here).includes(action.item)) return null;
      const takeEffects =
        state.objectState[action.item]?.takenBy === "player" ? [] : (o.take_effects ?? []);
      // take_effects (bug_0107) fire after the first pickup, so a goal item can award
      // climactic points on the deliberate CLAIM. If the item is dropped and re-taken,
      // objectState.takenBy records that the claim already happened (bug_0383).
      //
      // Note the exact scope of that guard: DROP's `place_object` is its ONLY writer, so
      // it covers the drop/re-take loop and nothing else. Any other route out of the
      // inventory — an authored `remove_item` for a consumed key, an item handed over, a
      // maneuver's resource cost — leaves objectState untouched, `locateObject` falls back
      // to the object's authored home room, and a re-TAKE re-awards. Shipped packs keep
      // those sets disjoint by convention (tide_mill.yaml hand-writes `takenBy: player`
      // beside its own `remove_item`), which is what `rpg_score_economy_sound` proves; the
      // one-shot is therefore a content convention here, not yet an engine invariant.
      return {
        conditions: [],
        effects: [
          { add_item: action.item },
          { narrate: `You take ${definiteObjectNounPhrase(o.name)}.` },
          ...takeEffects,
        ],
      };
    }
    case "DROP": {
      if (!state.inventory.includes(action.item)) return null;
      const o = index.objects.get(action.item);
      if (!o) return null;
      // A held (worn/equipped/bound) or deliberately non-droppable object can
      // never be set down; DROP simply isn't offered.
      if (o.held || o.droppable === false) return null;
      return {
        conditions: [],
        effects: [
          { remove_item: action.item },
          { place_object: { id: action.item, room: here, takenBy: "player" } },
          { narrate: `You drop ${definiteObjectNounPhrase(o.name)}.` },
        ],
      };
    }
    case "OPEN": {
      const o = index.objects.get(action.target);
      if (!o || !present(index, state, action.target)) return null;
      // OPEN interactions fire on the ATTEMPT — even on a non-openable
      // object (the weighmasters north_door "warning on try" shape) or a
      // locked one ("it's locked, and something shifts inside"). The
      // built-in open still requires openable ∧ unlocked; opening something
      // already standing open is nonsense, so an open object offers neither.
      if (isOpen(state, action.target)) return null;
      const opens = firingInteractions(index, state, action.target, "OPEN");
      const builtin = o.openable && !isLocked(index, state, action.target);
      if (!builtin && opens.length === 0) return null;
      const effects: Effect[] = [];
      if (builtin) {
        // OPEN narration describes the view produced by the built-in open itself,
        // not the pre-open state. This matters for contents whose world visibility
        // is gated by `is_open` on their container. Runtime placement also wins over
        // authored `contents`, so an item moved elsewhere is not announced as inside.
        const openedState: GameState = {
          ...state,
          objectState: {
            ...state.objectState,
            [action.target]: {
              ...state.objectState[action.target],
              open: true,
            },
          },
        };
        const visibleAfterOpen = new Set(visibleObjectIds(index, openedState, here));
        const revealedContents = o.contents.filter((id) => {
          if (!visibleAfterOpen.has(id)) return false;
          const location = locateObject(index, openedState, id);
          return location.kind === "container" && location.container === action.target;
        });
        const reveal = revealedContents.length
          ? ` Inside: ${revealedContents.map((c) => objName(index, openedState, c)).join(", ")}.`
          : "";
        effects.push(
          { open_object: action.target },
          { narrate: `You open ${definiteObjectNounPhrase(o.name)}.${reveal}` },
        );
      }
      for (const it of opens) effects.push(...it.effects);
      return { conditions: [], effects };
    }
    case "CLOSE": {
      const o = index.objects.get(action.target);
      if (!o || !present(index, state, action.target)) return null;
      // First-class CLOSE (the schema admitted the verb since Stage 2; the
      // resolver never had a case, so `close X` was parsed then always
      // rejected). Only an object standing open can be closed — which also
      // means a CLOSE interaction on a never-openable object is dead
      // content, the exact hole this fix removes for INSPECT/OPEN, so the
      // gate is on open-state, not openable-ness (an `open_object` effect
      // can open a non-openable fixture; closing it then works).
      if (!isOpen(state, action.target)) return null;
      const closes = firingInteractions(index, state, action.target, "CLOSE");
      const builtin = o.openable;
      if (!builtin && closes.length === 0) return null;
      const effects: Effect[] = [];
      if (builtin) {
        effects.push(
          { close_object: action.target },
          { narrate: `You close ${definiteObjectNounPhrase(o.name)}.` },
        );
      }
      for (const it of closes) effects.push(...it.effects);
      return { conditions: [], effects };
    }
    case "UNLOCK": {
      const o = index.objects.get(action.target);
      if (!o || !present(index, state, action.target) || !isLocked(index, state, action.target))
        return null;
      if (o.key_id === undefined || action.with !== o.key_id || !state.inventory.includes(o.key_id))
        return null;
      // A keyed lock may carry its own narration + effects (score, set_flag, etc.)
      // so a climactic unlock no longer needs a bespoke `USE key on lock`
      // interaction to award points or narrate richly — both grammars now lead to the
      // engine's first-class UNLOCK (bug_0077). Default narration/effects are unchanged
      // when the pack declares neither, so existing packs resolve byte-identically.
      return {
        conditions: [{ has_item: o.key_id }],
        effects: [
          { set_object_locked: { id: action.target, locked: false } },
          { narrate: o.unlock_narrate ?? `You unlock ${definiteObjectNounPhrase(o.name)}.` },
          ...(o.unlock_effects ?? []),
        ],
      };
    }
    case "USE": {
      const it = useInteraction(index, action.target, action.item, state);
      if (!it || !present(index, state, action.target)) return null;
      if (action.item !== undefined && !state.inventory.includes(action.item)) return null;
      const itemConditions: Condition[] =
        action.item === undefined ? [] : [{ has_item: action.item }];
      return { conditions: [...itemConditions, ...it.conditions], effects: it.effects };
    }
    case "MOVE": {
      const room = index.rooms.get(here);
      const exit = room?.exits.find((e) => e.direction === action.direction);
      if (!exit) return null;
      return { conditions: exit.conditions, effects: [{ goto: exit.to }] };
    }
    case "TALK": {
      const candidate = index.npcs.get(action.npc);
      const npc = candidate ? npcForState(candidate, state) : undefined;
      if (!npc || npc.room !== here || activeDialogue(index, state)) return null;
      const ord = nodeOrdinal(npc, npc.dialogue.root);
      const root = npc.dialogue.nodes[ord - 1];
      if (!root) return null;
      return {
        conditions: npc.conditions ?? [],
        effects: [
          { set_var: { name: dlgVar(npc.id), value: ord } },
          ...root.effects,
          { narrate: `${npc.name}: "${nodeText(root, state)}"` },
        ],
      };
    }
    case "ASK": {
      const active = activeDialogue(index, state);
      if (!active || active.npc.id !== action.npc) return null;
      const topic = active.node.topics.find((t) => dialogueTopicMatches(t, action.topic));
      if (!topic) return null;
      // A gated topic is filtered from the legal set (via `option`) and re-checked
      // here by the engine, so a told-once info topic can retire itself.
      const conditions = topic.conditions ?? [];
      if (topic.end || topic.goto === undefined) {
        return {
          conditions,
          effects: [
            { set_var: { name: dlgVar(active.npc.id), value: 0 } },
            { narrate: `(You end the conversation.)` },
          ],
        };
      }
      const targetOrd = nodeOrdinal(active.npc, topic.goto);
      const target = active.npc.dialogue.nodes[targetOrd - 1];
      if (!target) return null;
      // A reply node whose authored tree includes an unconditional return to the
      // root is an answer, not another player decision. Resume the root after the
      // answer's effects + spoken line in this same step. The post-step observation
      // therefore exposes the root's post-effect variants/topics without making a
      // player spend a separate "nod / ask something else" navigation action.
      const rootOrd = nodeOrdinal(active.npc, active.npc.dialogue.root);
      const root = active.npc.dialogue.nodes[rootOrd - 1];
      const isUnconditionalRootBack = (candidate: DialogueTopic): boolean =>
        candidate.end !== true &&
        candidate.goto === active.npc.dialogue.root &&
        (candidate.conditions?.length ?? 0) === 0;
      // Never fold away a genuine child-only branch. Direct follow-ups on Cade
      // and Ives are mirrored at their roots; a custom pack whose reply node
      // contains a unique choice stays on that node exactly as authored.
      const rootMirrorsReplyChoices =
        root !== undefined &&
        target.topics.every(
          (candidate) =>
            isUnconditionalRootBack(candidate) ||
            root.topics.some(
              (rootTopic) =>
                rootTopic.id === candidate.id &&
                rootTopic.goto === candidate.goto &&
                rootTopic.end === candidate.end &&
                JSON.stringify(rootTopic.conditions ?? []) ===
                  JSON.stringify(candidate.conditions ?? []),
            ),
        );
      const autoResumesRoot =
        target.id !== active.npc.dialogue.root &&
        rootOrd > 0 &&
        root?.effects.length === 0 &&
        rootMirrorsReplyChoices &&
        target.topics.some(isUnconditionalRootBack);
      return {
        conditions,
        effects: [
          { set_var: { name: dlgVar(active.npc.id), value: targetOrd } },
          ...target.effects,
          {
            narrate: `${active.npc.name}: "${nodeText(target, state)}"`,
          },
          ...(autoResumesRoot
            ? [{ set_var: { name: dlgVar(active.npc.id), value: rootOrd } } satisfies Effect]
            : []),
        ],
      };
    }
    default:
      return null;
  }
}

/**
 * Compose an action with a conversation close when its resulting state can no
 * longer sustain that exchange.
 *
 * Same-room actions stay first-class without discarding the exchange: a player
 * can read the book Cade just pointed at and then take the already-offered next
 * topic. Moving, ending play, or making the speaking NPC ineligible clears the
 * active variable after the action's own effects and prose. Explicit leave topics
 * already clear themselves and are not decorated twice. TALK and combat are
 * suppressed by their legal enumerators. The dialogue variable is excluded from
 * the journey consequence hash, so an automatic close never invents a meaningful
 * decision.
 */
export function withRpgDialogueInterruption(
  index: RpgModelIndex,
  state: GameState,
  resolution: Resolution,
): Resolution {
  const active = activeDialogue(index, state);
  if (!active) return resolution;

  // Project only the already-resolved deterministic effects. This does not run
  // on-enter or win hooks; the runner independently closes dialogue before a
  // terminal hook. Projection lets a same-room READ keep Cade available while a
  // state change that retires the speaking NPC closes the now-stale exchange.
  const projected = applyEffects(resolution.effects, state).state;
  const projectedActive = activeDialogue(index, projected);
  const exchangeStillValid =
    !projected.ended &&
    projected.current === state.current &&
    projectedActive?.npc.id === active.npc.id &&
    projectedActive.npc.room === projected.current &&
    evalConditions(projectedActive.npc.conditions ?? [], projected);
  if (exchangeStillValid || projectedActive === null) return resolution;

  return {
    conditions: resolution.conditions,
    effects: [...resolution.effects, { set_var: { name: dlgVar(active.npc.id), value: 0 } }],
  };
}

export function resolveRpgAction(
  index: RpgModelIndex,
  state: GameState,
  action: RpgAction,
): Resolution | null {
  const resolution = resolveRpgActionCore(index, state, action);
  return resolution ? withRpgDialogueInterruption(index, state, resolution) : null;
}

function option(
  index: RpgModelIndex,
  state: GameState,
  id: string,
  command: string,
  action: RpgAction,
): RpgActionOption | null {
  const res = resolveRpgAction(index, state, action);
  if (!res || !evalConditions(res.conditions, state)) return null;
  return { id, command, action };
}

type UseActionProjection = Pick<RpgActionOption, "id" | "command" | "action" | "inputAliases">;

/** Resolve an exact current id first, then an unambiguous input-only legacy alias.
 * Ambiguous aliases deliberately fail closed rather than guessing a stage. */
export function rpgActionOptionForInputId(
  actions: readonly RpgActionOption[],
  id: string,
): RpgActionOption | null {
  const exact = actions.find((action) => action.id === id);
  if (exact) return exact;
  const aliases = actions.filter((action) => action.inputAliases?.includes(id));
  return aliases.length === 1 ? aliases[0]! : null;
}

/** Build the stable player-facing identity shared by legal and blocked USE
 * projections. Keeping this in one place prevents a hint from naming a command
 * differently from the action once its gate opens. */
function projectUseAction(
  index: RpgModelIndex,
  state: GameState,
  it: Interaction,
): UseActionProjection | null {
  if (it.verb !== "USE" || it.target === undefined) return null;
  const selfUse = it.item !== undefined && it.item === it.target;
  const legacyId =
    it.item === undefined
      ? `use_${it.target}`
      : selfUse
        ? `use_${it.item}`
        : `use_${it.item}_on_${it.target}`;
  const identity = authoredUseActionIdentity({
    ...(it.item !== undefined ? { item: it.item } : {}),
    target: it.target,
    ...(it.command_verb !== undefined ? { commandVerb: it.command_verb } : {}),
    legacyId,
    verbIdentifiedTarget: index.verbIdentifiedTargetOnlyUseTargets.has(it.target),
  });
  const itemName = it.item === undefined ? "" : objName(index, state, it.item);
  const targetName = objName(index, state, it.target);
  const command =
    it.item === undefined
      ? `${it.command_verb ?? "use"} ${targetName}`
      : selfUse
        ? `${it.command_verb ?? "use"} ${itemName}`
        : it.command_verb !== undefined
          ? (it.command_template ?? `${it.command_verb} {item} on {target}`)
              .replace("{item}", itemName)
              .replace("{target}", targetName)
          : `use ${itemName} on ${targetName}`;
  const action: RpgAction =
    it.item === undefined
      ? { type: "USE", target: it.target }
      : { type: "USE", item: it.item, target: it.target };
  return {
    id: identity.id,
    command,
    action,
    ...(identity.inputAliases ? { inputAliases: identity.inputAliases } : {}),
  };
}

function structurallyPresentUse(
  index: RpgModelIndex,
  state: GameState,
  interaction: Interaction,
  projection: UseActionProjection,
): boolean {
  if (projection.action.type !== "USE") return false;
  // The hint must belong to a row this index actually knows about — keyed by target,
  // matching what `useInteraction` will resolve, so a hint is never advertised for a
  // row the engine cannot run.
  if (!index.useInteractionsByTarget.get(projection.action.target)?.includes(interaction))
    return false;
  return (
    present(index, state, projection.action.target) &&
    (projection.action.item === undefined || state.inventory.includes(projection.action.item))
  );
}

/**
 * Enumerate every legal action for the current state. An active conversation
 * contributes its current ASK topics, then ordinary noncombat room actions are
 * offered alongside them. Same-room actions preserve the exchange; an action
 * that leaves the scene ends it atomically. TALK remains suppressed here and
 * combat remains suppressed by the RPG runner.
 */
export function enumerateRpgBaseActions(index: RpgModelIndex, state: GameState): RpgActionOption[] {
  if (state.ended) return [];
  const out: RpgActionOption[] = [];
  const push = (o: RpgActionOption | null): void => {
    if (o) out.push(o);
  };

  const active = activeDialogue(index, state);
  if (active) {
    for (const t of active.node.topics) {
      const projected = option(index, state, `ask_${t.id}`, `ask: ${t.prompt}`, {
        type: "ASK",
        npc: active.npc.id,
        topic: t.id,
      });
      if (projected && t.aliases?.length) projected.inputAliases = [...t.aliases];
      push(projected);
    }
  }

  const here = state.current;
  const room = index.rooms.get(here);
  if (!room) return out;

  // Movement (sorted by direction for determinism — code-unit order, so the
  // enumeration cannot vary with the host's default locale/ICU the way bare
  // localeCompare nominally can).
  for (const exit of [...room.exits].sort((a, b) =>
    a.direction < b.direction ? -1 : a.direction > b.direction ? 1 : 0,
  )) {
    push(
      option(index, state, `go_${exit.direction}`, `go ${exit.direction}`, {
        type: "MOVE",
        direction: exit.direction,
      }),
    );
  }

  // Objects visible in the room.
  for (const oid of visibleObjectIds(index, state, here)) {
    const o = index.objects.get(oid);
    if (!o) continue;
    const oName = objectName(o, state);
    push(option(index, state, `examine_${oid}`, `look at ${oName}`, { type: "LOOK", target: oid }));
    push(option(index, state, `read_${oid}`, `read ${oName}`, { type: "READ", target: oid }));
    push(option(index, state, `take_${oid}`, `take ${oName}`, { type: "TAKE", item: oid }));
    push(option(index, state, `open_${oid}`, `open ${oName}`, { type: "OPEN", target: oid }));
    push(option(index, state, `close_${oid}`, `close ${oName}`, { type: "CLOSE", target: oid }));
    if (o.key_id !== undefined) {
      push(
        option(
          index,
          state,
          `unlock_${oid}`,
          `unlock ${oName} with ${objName(index, state, o.key_id)}`,
          {
            type: "UNLOCK",
            target: oid,
            with: o.key_id,
          },
        ),
      );
    }
  }

  // Held objects: examine, read, drop, and any USE interaction whose target is present.
  for (const item of [...state.inventory].sort()) {
    const o = index.objects.get(item);
    if (!o) continue;
    const oName = objectName(o, state);
    push(
      option(index, state, `examine_${item}`, `look at ${oName}`, { type: "LOOK", target: item }),
    );
    push(option(index, state, `read_${item}`, `read ${oName}`, { type: "READ", target: item }));
    push(option(index, state, `drop_${item}`, `drop ${oName}`, { type: "DROP", item }));
  }

  // USE interactions across the pack whose target is present and whose optional item is held.
  // A self-targeted USE (item === target) is the "consume this thing" pattern —
  // drink the phial, eat the bread — and reads as `use <obj>`, not the nonsensical
  // `use <obj> on <obj>`.
  for (const o of index.objectsWithUseInteractions) {
    for (const it of o.interactions) {
      const projection = projectUseAction(index, state, it);
      if (!projection || projection.action.type !== "USE") continue;
      if (!evalConditions(it.conditions, state)) continue;
      // Several authored rows may share one (item, target) pair, and the id is derived
      // from that pair alone — so they all mint the SAME action id. Only one of them can
      // ever run: `useInteraction`, and with it every id-addressed surface, takes the
      // first condition-satisfying row. Listing the others produced duplicate ids whose
      // second entry was permanently unselectable AND whose advertised skill_check
      // belonged to a row the engine would not execute — the menu promised a d20 roll
      // that never happened. Project exactly the row resolution will pick.
      if (useInteraction(index, projection.action.target, projection.action.item, state) !== it)
        continue;
      // A USE may declare a natural verb (command_verb) so the listed command matches
      // the prose that primes it. Its id stays verb-agnostic unless every target-only
      // row on an overloaded target has a distinct verb, in which case that verb names
      // the stage and the old target-only id remains an input alias. A self-USE
      // reads "<verb> <obj>" ("drink black phial"). An item-on-target USE reads via
      // command_template ("tie {item} to {target}", "lever {target} with {item}") so
      // the word order/preposition match too, falling back to "<verb> <item> on
      // <target>" when no template is given, or the generic "use ... on ..." with no
      // command_verb at all.
      const opt = option(index, state, projection.id, projection.command, projection.action);
      if (opt && projection.inputAliases) opt.inputAliases = projection.inputAliases;
      // Surface the rolled skill + difficulty + die type when this USE is a skill check,
      // so the listed command reads as the intentional d20 roll it is (bug_0274). `die`
      // surfaces the ceiling so the check never looks impossible (bug_0311). Never branch
      // effects, which would leak score/flag/end_game routing.
      if (opt && it.skill_check) {
        opt.skill_check = {
          skill: it.skill_check.skill,
          // readVar, not a bare index: an authored name like "__proto__" would
          // otherwise read the inherited accessor instead of 0 (defense in
          // depth — the validator already forces the var to be declared).
          modifier: readVar(state.vars, it.skill_check.skill),
          difficulty: it.skill_check.difficulty,
          die: "d20",
          ...(it.skill_check.stakes ? { stakes: it.skill_check.stakes } : {}),
        };
      }
      push(opt);
    }
  }

  // NPCs present.
  for (const npc of npcsInRoom(index, state, here)) {
    const preferredId = `examine_npc_${npc.id}`;
    let id = preferredId;
    let disambiguator = 2;
    while (out.some((candidate) => candidate.id === id)) {
      id = `${preferredId}__${String(disambiguator)}`;
      disambiguator += 1;
    }
    push(
      option(index, state, id, `look at ${npc.name}`, {
        type: "LOOK",
        npc: npc.id,
      }),
    );
    push(
      option(index, state, `talk_${npc.id}`, `talk to ${npc.name}`, { type: "TALK", npc: npc.id }),
    );
  }

  // Always-available informational actions.
  push(option(index, state, "look_around", "look", { type: "LOOK" }));
  push(option(index, state, "inventory", "inventory", { type: "INVENTORY" }));
  return out;
}

/**
 * Enumerate authored USE affordances that are visible and structurally possible,
 * but whose gameplay conditions do not currently hold. This is a derived display
 * projection only: blocked rows are never mixed into the executable legal set.
 */
export function enumerateRpgBlockedActions(
  index: RpgModelIndex,
  state: GameState,
): RpgBlockedActionOption[] {
  if (state.ended) return [];

  const emitted = new Set<string>();
  const out: RpgBlockedActionOption[] = [];

  for (const object of index.objectsWithUseInteractions) {
    for (const interaction of object.interactions) {
      const hint = interaction.blocked_hint;
      if (!hint) continue;
      const projection = projectUseAction(index, state, interaction);
      if (!projection || !structurallyPresentUse(index, state, interaction, projection)) continue;
      if (!evalConditions(hint.visible_when, state)) continue;
      if (evalConditions(interaction.conditions, state)) continue;
      if (emitted.has(projection.id)) continue;

      // Bolt Optimization: Instead of building full legal action options for the room
      // via `enumerateRpgBaseActions(index, state)`, directly check if any USE interaction
      // for this target/item pair currently resolves (i.e., is executable / legal).
      // This saves significant CPU time in RPG observation generation.
      const useAction = projection.action;
      const isLegal =
        useAction.type === "USE" &&
        useInteraction(index, useAction.target, useAction.item, state) !== undefined;
      if (isLegal) continue;

      emitted.add(projection.id);
      out.push({ id: projection.id, command: projection.command, reason: hint.reason });
    }
  }

  return out;
}
