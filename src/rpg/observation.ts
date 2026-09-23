/**
 * RPG observation (spec §9.2, §13 Stage 4).
 *
 * This is the only structured view a player or agent gets for the RPG runtime:
 * room text, visible objects, exits, blocked-exit hints, inventory, dialogue,
 * score, enemies, stats, and legal actions. It owns the RPG shape directly and
 * does not delegate through the legacy parser observation layer.
 */
import type { RpgAction } from "../api/types.js";
import { evalConditions } from "../core/conditions.js";
import type { GameState } from "../core/state.js";
import { openingWorldText } from "../world/observation.js";
import type { WorldBinding } from "../world/schema.js";
import {
  activeDialogue,
  endingText as resolveEndingText,
  exitLockedMessage,
  nodeText,
  npcsInRoom,
  objectName,
  roomDescription,
  visibleObjectIds,
} from "./model.js";
import { enemyHp } from "./combat.js";
import { publicFlags, publicInventory, publicJournal, publicVars } from "./observation_state.js";
import { ATTACK_VAR, DEFENSE_VAR, HP_VAR, SCORE_VAR } from "./schema.js";
import { resolveRpgPressureTracks, type RpgPressureTrackView } from "./pressure.js";
import type { RpgActionOption } from "./legal_actions.js";
import {
  enemyActive,
  enumerateRpgActions,
  enumerateRpgBlockedActions,
  type RpgIndex,
} from "./runner.js";

export type ObservationOptions = {
  hideGraph?: boolean;
  includeWorldIntro?: boolean;
  includeAvailableActions?: boolean;
  availableActions?: readonly RpgActionOption[];
};

export type RpgObservation = {
  mode: "rpg";
  room: string;
  title: string;
  description: string;
  world?: WorldBinding | null;
  visible_objects: { id: string; name: string }[];
  npcs_present: { id: string; name: string }[];
  exits: { direction: string; to?: string }[];
  blocked_exits: { direction: string; message: string }[];
  blocked_actions: { id: string; command: string; reason: string }[];
  inventory: string[];
  pressure_tracks?: RpgPressureTrackView[];
  state: { flags: string[]; vars: Record<string, number>; journal: string[] };
  dialogue: { npc: string; npc_text: string } | null;
  enemies_present: { id: string; name: string; hp: number }[];
  stats: { hp: number; attack: number; defense: number };
  available_actions: {
    id: string;
    command: string;
    action: RpgAction;
    skill_check?: NonNullable<RpgActionOption["skill_check"]>;
    combat?: NonNullable<RpgActionOption["combat"]>;
    resources?: NonNullable<RpgActionOption["resources"]>;
  }[];
  score: number;
  max_score: number;
  ended: boolean;
  ending_id: string | null;
  ending: { id: string; title: string; text: string; death: boolean } | null;
};

export function buildRpgObservation(
  index: RpgIndex,
  state: GameState,
  opts: ObservationOptions = {},
): RpgObservation {
  const room = index.rooms.get(state.current);
  const active = activeDialogue(index, state);
  const endingDef =
    state.ended && state.endingId
      ? index.pack.endings.find((e) => e.id === state.endingId)
      : undefined;

  const maxScore = index.pack.meta.max_score ?? 0;
  const score = state.vars[SCORE_VAR] ?? 0;
  const resolvedEnding = endingDef ? resolveEndingText(endingDef, state) : undefined;
  const endingDescription =
    endingDef && resolvedEnding !== undefined
      ? maxScore > 0
        ? `${resolvedEnding.trimEnd()}\n\nFinal score: ${score} of ${maxScore}.`
        : resolvedEnding
      : undefined;
  const baseDescription = room ? roomDescription(room, state) : "";
  const world = index.pack.meta.world;

  const visibleObjects: RpgObservation["visible_objects"] = [];
  for (const id of visibleObjectIds(index, state, state.current)) {
    const object = index.objects.get(id);
    visibleObjects.push({ id, name: object ? objectName(object, state) : id });
  }

  const npcs: RpgObservation["npcs_present"] = [];
  for (const npc of npcsInRoom(index, state, state.current)) {
    npcs.push({ id: npc.id, name: npc.name });
  }

  const exits: RpgObservation["exits"] = [];
  const blockedExits: RpgObservation["blocked_exits"] = [];
  if (room) {
    for (const exit of room.exits) {
      if (evalConditions(exit.conditions, state)) {
        exits.push(
          opts.hideGraph
            ? { direction: exit.direction }
            : { direction: exit.direction, to: exit.to },
        );
      } else {
        const locked = exitLockedMessage(exit, state);
        if (locked !== undefined) {
          blockedExits.push({ direction: exit.direction, message: locked });
        }
      }
    }
    // Code-unit order, not localeCompare: rendered order must not depend on the
    // host's default locale/ICU build.
    const byDirection = (a: { direction: string }, b: { direction: string }): number =>
      a.direction < b.direction ? -1 : a.direction > b.direction ? 1 : 0;
    exits.sort(byDirection);
    blockedExits.sort(byDirection);
  }

  const enemies: RpgObservation["enemies_present"] = [];
  for (const enemy of index.enemyByRoom.get(state.current) ?? []) {
    if (enemyActive(state, enemy)) {
      enemies.push({ id: enemy.id, name: enemy.name, hp: enemyHp(state, enemy) });
    }
  }

  // Enumerated here only when the caller neither supplied the list nor opted out of it.
  // The blocked-action pass below reuses this enumeration of the same state rather than
  // running the base enumeration a second time. A caller-supplied list is not reused for
  // that: it is the caller's (possibly cached) copy, and the blocked rows stay derived
  // from the state alone exactly as before.
  const ownActions =
    opts.includeAvailableActions !== false && opts.availableActions === undefined
      ? enumerateRpgActions(index, state)
      : undefined;
  const availableActions: RpgObservation["available_actions"] = [];
  if (opts.includeAvailableActions !== false) {
    for (const option of opts.availableActions ?? ownActions ?? []) {
      availableActions.push({
        id: option.id,
        command: option.command,
        action: option.action,
        ...(option.skill_check ? { skill_check: option.skill_check } : {}),
        ...(option.combat ? { combat: option.combat } : {}),
        ...(option.resources
          ? {
              resources: {
                gains: [...option.resources.gains],
                costs: [...option.resources.costs],
              },
            }
          : {}),
      });
    }
  }

  const blockedActions: RpgObservation["blocked_actions"] = [];
  for (const option of enumerateRpgBlockedActions(index, state, ownActions)) {
    blockedActions.push({ id: option.id, command: option.command, reason: option.reason });
  }
  const pressureTracks = resolveRpgPressureTracks(index.pack.pressure_tracks, state);

  return {
    mode: "rpg",
    room: state.current,
    title: endingDef ? endingDef.title : (room?.name ?? state.current),
    description:
      endingDescription ??
      (opts.includeWorldIntro ? openingWorldText(world, state, baseDescription) : baseDescription),
    ...(opts.includeWorldIntro ? { world: world ?? null } : {}),
    visible_objects: visibleObjects,
    npcs_present: npcs,
    exits,
    blocked_exits: blockedExits,
    blocked_actions: blockedActions,
    inventory: publicInventory(state, { sort: true }),
    ...(pressureTracks.length > 0 ? { pressure_tracks: pressureTracks } : {}),
    state: {
      flags: publicFlags(state),
      vars: publicVars(state),
      journal: publicJournal(state),
    },
    dialogue: active
      ? {
          npc: active.npc.id,
          npc_text: nodeText(active.node, state),
        }
      : null,
    enemies_present: enemies,
    stats: {
      hp: state.vars[HP_VAR] ?? 0,
      attack: state.vars[ATTACK_VAR] ?? 0,
      defense: state.vars[DEFENSE_VAR] ?? 0,
    },
    available_actions: availableActions,
    score,
    max_score: maxScore,
    ended: state.ended,
    ending_id: state.endingId,
    ending: endingDef
      ? {
          id: endingDef.id,
          title: endingDef.title,
          text: resolvedEnding ?? endingDef.text,
          death: endingDef.death,
        }
      : null,
  };
}
