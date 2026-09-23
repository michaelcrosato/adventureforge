/**
 * RPG runner (spec §13 Stage 4, §14) — adapts an RPG pack into the engine's pure
 * `Rules`.
 *
 * RPG owns its pack schema, indexing, fresh-state setup, command mapping, combat,
 * and skill-check resolution while preserving deterministic seeded randomness.
 */
import type { RpgAction } from "../api/types.js";
import type { Effect } from "../core/effects.js";
import type { GameState } from "../core/state.js";
import type { Resolution, Rules } from "../core/engine.js";
import {
  type RpgModelIndex,
  indexRpgModel,
  initStateForRpgModel,
  activeDialogue,
  dlgVar,
} from "./model.js";
import {
  enumerateRpgBlockedActions,
  enumerateRpgBaseActions,
  present,
  resolveRpgAction,
  useInteraction,
  withRpgDialogueInterruption,
  type RpgActionOption,
} from "./legal_actions.js";
import { evalConditions } from "../core/conditions.js";
import type { GameEvent } from "../core/events.js";
import { type RpgPack, type Enemy, type EnemyManeuver } from "./schema.js";
import { resolveAttack, enemyAlive } from "./combat.js";
import { resolveSkillCheck } from "../core/skill_check.js";
import { rngForRuntimeState, type RuntimeRngFor } from "./runtime_rng.js";
import { decorateRpgScoreEvents } from "./score_events.js";
import { endGameEffects } from "./terminal_effects.js";
import { maneuverActionId } from "./action_ids.js";
import { maneuverPhase, maneuverSequenceConditions } from "./maneuver_sequence.js";
import type { CampaignCharacterImportInput } from "./campaign_character_import.js";
import type { EmbeddedLaunchOverlay } from "../core/embedded_launch_overlay_receipt.js";

export { enumerateRpgBlockedActions };

export type RpgIndex = RpgModelIndex & {
  enemies: Map<string, Enemy>;
  enemyByRoom: Map<string, Enemy[]>;
};

export function indexRpgPack(pack: RpgPack): RpgIndex {
  const base = indexRpgModel(pack);
  const enemies = new Map(pack.enemies.map((e) => [e.id, e]));
  const enemyByRoom = new Map<string, Enemy[]>();
  for (const e of pack.enemies) {
    const list = enemyByRoom.get(e.room) ?? [];
    list.push(e);
    enemyByRoom.set(e.room, list);
  }
  return { ...base, enemies, enemyByRoom };
}

/** A foe that is alive and whose authored state gate, if any, currently holds. */
export function enemyActive(state: GameState, enemy: Enemy): boolean {
  return enemyAlive(state, enemy) && evalConditions(enemy.conditions ?? [], state);
}

/** Active enemies standing in the player's current room. */
function enemiesHere(index: RpgIndex, state: GameState): Enemy[] {
  return (index.enemyByRoom.get(state.current) ?? []).filter((e) => enemyActive(state, e));
}

/**
 * A journey checkpoint may interrupt an embedded RPG only between scenes.
 * Terminal state is always a boundary; otherwise both combat and conversation
 * must be clear in the player's current room.
 */
export function isRpgCheckpointSafeBoundary(index: RpgIndex, state: GameState): boolean {
  return (
    state.ended || (enemiesHere(index, state).length === 0 && activeDialogue(index, state) === null)
  );
}

function maneuverAvailable(state: GameState, enemy: Enemy, maneuver: EnemyManeuver): boolean {
  const sequenceConditions = maneuverSequenceConditions(enemy, maneuver);
  return (
    sequenceConditions !== null &&
    evalConditions([...maneuver.conditions, ...sequenceConditions], state)
  );
}

function enemyManeuver(enemy: Enemy, maneuverId: string): EnemyManeuver | undefined {
  return enemy.maneuvers?.find((maneuver) => maneuver.id === maneuverId);
}

export function winningRpgEnding(index: RpgIndex, state: GameState): string | null {
  for (const wc of index.pack.win_conditions) {
    if (!evalConditions(wc.conditions, state)) continue;
    const override = wc.ending_overrides?.find((candidate) =>
      evalConditions(candidate.conditions, state),
    );
    return override?.ending ?? wc.ending;
  }
  return null;
}

/** Terminal observations and saves must never retain a live conversation. */
function terminalRpgEffects(index: RpgIndex, state: GameState, ending: string): Effect[] {
  const active = activeDialogue(index, state);
  return [
    ...(active
      ? ([{ set_var: { name: dlgVar(active.npc.id), value: 0 } }] satisfies Effect[])
      : []),
    ...endGameEffects(ending),
  ];
}

/**
 * Every legal action: the base command set plus an ATTACK per living enemy in the room
 * (offered only outside conversation). Each carries the stable id/command/action
 * shape the observation and human clients consume.
 */
export function enumerateRpgActions(index: RpgIndex, state: GameState): RpgActionOption[] {
  const out = enumerateRpgBaseActions(index, state);
  if (state.ended || activeDialogue(index, state)) return out;
  for (const enemy of enemiesHere(index, state)) {
    const maneuvers = (enemy.maneuvers ?? []).filter((maneuver) =>
      maneuverAvailable(state, enemy, maneuver),
    );
    for (const maneuver of maneuvers) {
      const phase = maneuverPhase(enemy, maneuver);
      const gains = (maneuver.resource_effects ?? []).flatMap((effect) =>
        "add_item" in effect ? [effect.add_item] : [],
      );
      const costs = (maneuver.resource_effects ?? []).flatMap((effect) =>
        "remove_item" in effect ? [effect.remove_item] : [],
      );
      out.push({
        id: maneuverActionId(enemy.id, maneuver.id),
        command: maneuver.command,
        action: { type: "MANEUVER", enemy: enemy.id, maneuver: maneuver.id },
        combat: {
          attack_bonus: maneuver.attack_bonus,
          defense_bonus: maneuver.defense_bonus,
          one_shot: true,
          ...(phase !== undefined ? { phase } : {}),
        },
        ...(maneuver.resource_effects ? { resources: { gains, costs } } : {}),
      });
    }
    // Maneuvers are opening CHOICES, not free supplementary buffs: while at
    // least one is currently available, the ordinary strike is suppressed.
    // Committing a maneuver retires its cohort. A surviving enemy may expose a
    // child cohort on the next beat; otherwise ATTACK returns. If no maneuver's
    // authored and implicit conditions hold, combat remains possible through it.
    if (maneuvers.length > 0) continue;
    out.push({
      id: `attack_${enemy.id}`,
      command: `attack ${enemy.name}`,
      action: { type: "ATTACK", enemy: enemy.id },
    });
  }
  return out;
}

/**
 * `rngFor` supplies the PRNG a combat round / skill check draws from. It defaults to
 * the shared step-keyed runtime stream, so production callers pass nothing and play is
 * byte-identical. The parameter is a verification seam ONLY: the exhaustive RPG
 * ending-reachability proof builds two rule sets — one whose rng forces the player's
 * BEST rolls, one their WORST — and steps every action under both, so combat and
 * skill-check outcomes (the engine's only randomness) become enumerable rather than a
 * single seeded draw (tests/regression/rpg_all_endings_reachable.test.ts).
 */
export function buildRpgRules(
  index: RpgIndex,
  rngFor: RuntimeRngFor = rngForRuntimeState,
): Rules<RpgAction> {
  return {
    legalActions(state: GameState): RpgAction[] {
      return enumerateRpgActions(index, state).map((o) => o.action);
    },

    resolve(state: GameState, action: RpgAction): Resolution | null {
      if (action.type === "MANEUVER") {
        const enemy = index.enemies.get(action.enemy);
        const maneuver = enemy ? enemyManeuver(enemy, action.maneuver) : undefined;
        if (
          !enemy ||
          !maneuver ||
          enemy.room !== state.current ||
          !enemyActive(state, enemy) ||
          !maneuverAvailable(state, enemy, maneuver)
        ) {
          return null;
        }
        const round = resolveAttack(state, enemy, rngFor(state), {
          attackBonus: maneuver.attack_bonus,
          defenseBonus: maneuver.defense_bonus,
        });
        const sequenceConditions = maneuverSequenceConditions(enemy, maneuver);
        if (sequenceConditions === null) return null;
        return {
          // Mirror maneuverAvailable's parent/cohort gate in the declarative
          // resolution so stale or forced actions reject at the reducer seam.
          conditions: [...maneuver.conditions, ...sequenceConditions],
          effects: [
            { set_flag: maneuver.result_flag },
            ...(maneuver.resource_effects ?? []),
            { narrate: maneuver.narration },
            ...round.effects,
          ],
        };
      }
      if (action.type === "ATTACK") {
        const enemy = index.enemies.get(action.enemy);
        if (!enemy || enemy.room !== state.current || !enemyActive(state, enemy)) return null;
        return resolveAttack(state, enemy, rngFor(state));
      }
      if (action.type === "USE") {
        const it = useInteraction(index, action.target, action.item, state);
        if (it?.skill_check) {
          // Offer-legality still requires holding the item AND meeting the
          // interaction's own conditions. Enforcing the conditions here — not
          // just hiding the action during enumeration — means a gate that
          // retires the check after success (e.g. a one-shot lever) cannot be
          // re-fired by a forced/stale step, so it can never re-roll and
          // narrate a contradictory failure on an already-resolved puzzle.
          if (!present(index, state, action.target)) return null;
          if (action.item !== undefined && !state.inventory.includes(action.item)) return null;
          if (!evalConditions(it.conditions, state)) return null;
          // Base `effects` fire BEFORE the roll's outcome effects — the CYOA
          // ordering (choice.effects, then on_success/on_failure), and what
          // the validator's interactionEffects has always counted as firable.
          // Dropping them made a pack whose only win gate lived in those base
          // effects validate green yet be unwinnable at runtime (regression:
          // rpg_skill_check_base_effects.test.ts).
          const roll = resolveSkillCheck(state, it.skill_check, rngFor(state));
          return withRpgDialogueInterruption(index, state, {
            conditions: roll.conditions,
            effects: [...it.effects, ...roll.effects],
          });
        }
      }
      return resolveRpgAction(index, state, action);
    },

    onEnter(state: GameState, locationId: string): Effect[] {
      const room = index.rooms.get(locationId);
      const effects: Effect[] = room ? [...room.on_enter] : [];
      const ending = winningRpgEnding(index, state);
      if (ending) effects.push(...terminalRpgEffects(index, state, ending));
      return effects;
    },

    // A win that turns on a deliberate non-move action (claiming the Barrow-Lord's
    // circlet) fires here, against the post-effects state, rather than on bare room
    // entry. Skipped once the game has ended.
    checkWin(state: GameState): Effect[] {
      const ending = winningRpgEnding(index, state);
      return ending ? terminalRpgEffects(index, state, ending) : [];
    },

    // classic text-adventure score feedback derived from the RPG `score` var.
    decorateEvents(events: GameEvent[]): GameEvent[] {
      return decorateRpgScoreEvents(events, index.pack.meta.max_score);
    },
  };
}

/** Fresh state for an RPG pack (player stats come from meta.vars_init). */
export function initStateForRpgPack(
  index: RpgIndex,
  seed: number,
  campaignImport?: CampaignCharacterImportInput,
  launchOverlay?: EmbeddedLaunchOverlay,
): GameState {
  return initStateForRpgModel(index, seed, campaignImport, launchOverlay);
}
