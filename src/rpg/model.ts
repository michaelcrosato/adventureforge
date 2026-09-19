/**
 * RPG world model helpers.
 *
 * These are the pure index, location, reactive-text, dialogue, and fresh-state
 * helpers used by the RPG runner. They intentionally live under `src/rpg` so the
 * RPG runtime no longer depends on the legacy parser model module for its core
 * world state layout.
 */
import { dlgVar, nodeByOrdinal, nodeOrdinal } from "../core/dialogue_state.js";
import {
  indexObjectHomes,
  isLocked as coreIsLocked,
  isOpen,
  locateObject,
  visibleObjectIds as coreVisibleObjectIds,
  type ObjectLocation,
} from "../core/object_locations.js";
import { evalConditions } from "../core/conditions.js";
import { appendMatchingText, reactiveName, reactiveText } from "../core/reactive_text.js";
import type { GameState } from "../core/state.js";
import type {
  DialogueNode,
  Ending,
  Exit,
  GameObject,
  Interaction,
  Npc,
  Room,
  RpgPack,
} from "./schema.js";
import { initRuntimeState } from "./state_init.js";
import type { CampaignCharacterImportInput } from "./campaign_character_import.js";
import {
  wolfWinterDispatchOverlayFlagForPack,
  type EmbeddedLaunchOverlay,
} from "../core/embedded_launch_overlay_receipt.js";
import { seededOpeningFlagForSeed } from "./seeded_opening.js";

export type RpgModelIndex = {
  pack: RpgPack;
  rooms: Map<string, Room>;
  objects: Map<string, GameObject>;
  npcs: Map<string, Npc>;
  npcByRoom: Map<string, Npc[]>;
  homeRoom: Map<string, string>;
  containerOf: Map<string, string>;
  objectsWithUseInteractions: GameObject[];
  /**
   * Every authored USE interaction that names a target, keyed by that TARGET —
   * regardless of which object the row was authored under.
   *
   * USE resolution used to read `objects.get(target).interactions` directly, which
   * silently made "the row must be authored on the object it targets" a load-bearing
   * rule that nothing states and no validator checks. Enumeration
   * (`enumerateRpgBaseActions`), the natural-language parser (`customUseByVerb`) and
   * the foundation validator's effect harvest all walk EVERY object instead, so a
   * `USE rope on well` authored under `rope` was listed, typed, and certified
   * winnable — then dropped at resolution because the lookup only ever saw the well's
   * own rows. Indexing by target makes the runtime agree with the three surfaces that
   * were already host-agnostic. Insertion order is pack-object order, so "first
   * condition-satisfying row" means the same thing here as it does in the
   * enumeration loop.
   */
  useInteractionsByTarget: ReadonlyMap<string, readonly Interaction[]>;
  /** Target-only USE hubs whose authored rows each have a distinct natural verb. */
  verbIdentifiedTargetOnlyUseTargets: ReadonlySet<string>;
};

export function indexRpgModel(pack: RpgPack): RpgModelIndex {
  const rooms = new Map(pack.rooms.map((r) => [r.id, r]));
  const objects = new Map(pack.objects.map((o) => [o.id, o]));
  const npcs = new Map(pack.npcs.map((n) => [n.id, n]));
  const npcByRoom = new Map<string, Npc[]>();
  for (const n of pack.npcs) {
    const candidateRooms = new Set([n.room, ...(n.variants ?? []).flatMap((v) => v.room ?? [])]);
    for (const room of candidateRooms) {
      const list = npcByRoom.get(room) ?? [];
      list.push(n);
      npcByRoom.set(room, list);
    }
  }
  const { homeRoom, containerOf } = indexObjectHomes(pack.rooms, pack.objects);
  const objectsWithUseInteractions = pack.objects.filter((o) =>
    o.interactions.some((it) => it.verb === "USE" && it.target !== undefined),
  );
  const useInteractionsByTarget = new Map<string, Interaction[]>();
  for (const object of objectsWithUseInteractions) {
    for (const interaction of object.interactions) {
      if (interaction.verb !== "USE" || interaction.target === undefined) continue;
      const rows = useInteractionsByTarget.get(interaction.target);
      if (rows) rows.push(interaction);
      else useInteractionsByTarget.set(interaction.target, [interaction]);
    }
  }
  const targetOnlyUseVerbs = new Map<string, (string | undefined)[]>();
  const selfUseTargets = new Set<string>();
  for (const object of objectsWithUseInteractions) {
    for (const interaction of object.interactions) {
      if (
        interaction.verb === "USE" &&
        interaction.item !== undefined &&
        interaction.item === interaction.target
      ) {
        selfUseTargets.add(interaction.target);
      }
      if (
        interaction.verb !== "USE" ||
        interaction.item !== undefined ||
        interaction.target === undefined
      ) {
        continue;
      }
      const verbs = targetOnlyUseVerbs.get(interaction.target) ?? [];
      verbs.push(interaction.command_verb);
      targetOnlyUseVerbs.set(interaction.target, verbs);
    }
  }
  const verbIdentifiedTargetOnlyUseTargets = new Set<string>();
  for (const [target, verbs] of targetOnlyUseVerbs) {
    const authoredVerbs = verbs.filter((verb): verb is string => verb !== undefined);
    if (
      verbs.length > 1 &&
      authoredVerbs.length === verbs.length &&
      new Set(authoredVerbs).size === verbs.length &&
      !selfUseTargets.has(target)
    ) {
      verbIdentifiedTargetOnlyUseTargets.add(target);
    }
  }
  return {
    pack,
    rooms,
    objects,
    npcs,
    npcByRoom,
    homeRoom,
    containerOf,
    objectsWithUseInteractions,
    useInteractionsByTarget,
    verbIdentifiedTargetOnlyUseTargets,
  };
}

export type Location = ObjectLocation;

export { isOpen, locateObject };

export function roomDescription(room: Room, state: GameState): string {
  return reactiveText(room.description, room.variants, state);
}

export function exitLockedMessage(exit: Exit, state: GameState): string | undefined {
  if (exit.locked_msg === undefined) return undefined;
  return reactiveText(exit.locked_msg, exit.locked_msg_variants, state);
}

export function objectDescription(object: GameObject, state: GameState): string {
  return reactiveText(object.description, object.variants, state);
}

export function objectName(object: GameObject, state: GameState): string {
  return reactiveName(object.name, object.variants, state);
}

export function nodeText(node: DialogueNode, state: GameState): string {
  return appendMatchingText(
    reactiveText(node.npc_text, node.variants, state),
    node.append_variants,
    state,
  );
}

/** Resolve the first matching NPC presentation variant without changing identity. */
export function npcForState(npc: Npc, state: GameState): Npc {
  const variant = npc.variants?.find((candidate) => evalConditions(candidate.when, state));
  if (!variant) return npc;
  return {
    ...npc,
    name: variant.name ?? npc.name,
    description: variant.description ?? npc.description,
    room: variant.room ?? npc.room,
    dialogue: {
      ...npc.dialogue,
      root: variant.dialogue_root ?? npc.dialogue.root,
    },
  };
}

/** Return each condition-satisfied NPC whose resolved presentation occupies a room. */
export function npcsInRoom(index: RpgModelIndex, state: GameState, room: string): Npc[] {
  const out: Npc[] = [];
  for (const candidate of index.npcByRoom.get(room) ?? []) {
    const npc = npcForState(candidate, state);
    if (npc.room === room && evalConditions(npc.conditions ?? [], state)) out.push(npc);
  }
  return out;
}

export function endingText(ending: Ending, state: GameState): string {
  return appendMatchingText(
    reactiveText(ending.text, ending.variants, state),
    ending.append_variants,
    state,
  );
}

export function isLocked(index: RpgModelIndex, state: GameState, id: string): boolean {
  return coreIsLocked(index, state, id);
}

/** True if `id` and all containing objects satisfy their `visible_when` conditions. */
export function worldVisible(
  index: RpgModelIndex,
  state: GameState,
  id: string,
  ancestors: ReadonlySet<string> = new Set(),
): boolean {
  if (ancestors.has(id)) return false;
  const object = index.objects.get(id);
  if (!object || !evalConditions(object.visible_when ?? [], state)) return false;

  // Runtime placement wins over static containment. A moved object is no longer
  // inside its authored container, while a currently-contained object inherits
  // every containing object's world-visibility gate. Inventory is handled by
  // callers before this world-only helper and deliberately bypasses these gates.
  const location = locateObject(index, state, id);
  if (location.kind !== "container") return true;
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(id);
  return worldVisible(index, state, location.container, nextAncestors);
}

/**
 * Direct O(1) check if a specific object is visible in a room.
 * Avoids scanning all world objects via `visibleObjectIds(index, state, room).includes(id)`.
 */
export function isObjectVisibleInRoom(
  index: RpgModelIndex,
  state: GameState,
  id: string,
  room: string,
): boolean {
  let curr = id;
  const visitedContainers = new Set<string>();
  while (true) {
    const loc = locateObject(index, state, curr);
    if (loc.kind === "room") {
      if (loc.room !== room) return false;
      break;
    } else if (loc.kind === "container") {
      if (visitedContainers.has(loc.container) || !isOpen(state, loc.container)) {
        return false;
      }
      visitedContainers.add(loc.container);
      curr = loc.container;
    } else {
      return false;
    }
  }

  return worldVisible(index, state, id);
}

export function visibleObjectIds(index: RpgModelIndex, state: GameState, room: string): string[] {
  return coreVisibleObjectIds(index, state, room).filter((id) => worldVisible(index, state, id));
}

export { dlgVar, nodeByOrdinal, nodeOrdinal };

export function activeDialogue(
  index: RpgModelIndex,
  state: GameState,
): { npc: Npc; node: DialogueNode } | null {
  for (const candidate of index.npcs.values()) {
    const ordinal = state.vars[dlgVar(candidate.id)] ?? 0;
    if (ordinal <= 0) continue;
    const npc = npcForState(candidate, state);
    const node = nodeByOrdinal(npc, ordinal);
    if (node) return { npc, node };
  }
  return null;
}

function initStateForRpgModelWithOpeningFlag(
  index: RpgModelIndex,
  seed: number,
  seededOpeningFlag: string | undefined,
  campaignImport?: CampaignCharacterImportInput,
  launchOverlay?: EmbeddedLaunchOverlay,
): GameState {
  const meta = index.pack.meta;
  if (
    launchOverlay !== undefined &&
    wolfWinterDispatchOverlayFlagForPack(meta.id) !== launchOverlay.receipt.applied_flag
  ) {
    throw new Error(`RPG pack "${meta.id}" cannot consume this embedded launch overlay.`);
  }
  const startRoom = index.rooms.get(meta.start_room);
  return initRuntimeState({
    seed,
    start: meta.start_room,
    varsInit: meta.vars_init,
    flagsInit:
      seededOpeningFlag === undefined ? meta.flags_init : [...meta.flags_init, seededOpeningFlag],
    heldItems: index.pack.objects.filter((o) => o.held).map((o) => o.id),
    onEnter: startRoom?.on_enter,
    ...(campaignImport !== undefined
      ? { campaignImport: { pack: index.pack, ...campaignImport } }
      : {}),
    ...(launchOverlay !== undefined ? { launchOverlay } : {}),
  });
}

export function initStateForRpgModel(
  index: RpgModelIndex,
  seed: number,
  campaignImport?: CampaignCharacterImportInput,
  launchOverlay?: EmbeddedLaunchOverlay,
): GameState {
  const seededOpeningFlags = index.pack.meta.seeded_opening_flags;
  const selected =
    seededOpeningFlags === undefined
      ? undefined
      : seededOpeningFlagForSeed(seededOpeningFlags, seed);
  return initStateForRpgModelWithOpeningFlag(index, seed, selected, campaignImport, launchOverlay);
}

export type RpgOpeningInitialState = Readonly<{
  /** Null for a legacy pack with no seeded opening alternatives. */
  seededOpeningFlag: string | null;
  state: GameState;
}>;

/**
 * Construct each authored fresh-state alternative for static validation.
 *
 * This is not a runtime override: live games always use `initStateForRpgModel`
 * and its seed selector. Enumerating the finite authored alternatives lets the
 * validator reason soundly about every possible fresh start without searching
 * for representative seeds.
 */
export function initStatesForRpgModelOpeningAlternatives(
  index: RpgModelIndex,
): RpgOpeningInitialState[] {
  const alternatives = index.pack.meta.seeded_opening_flags;
  if (alternatives === undefined) {
    return [{ seededOpeningFlag: null, state: initStateForRpgModel(index, 0) }];
  }
  return alternatives.map((flag) => ({
    seededOpeningFlag: flag,
    state: initStateForRpgModelWithOpeningFlag(index, 0, flag),
  }));
}
