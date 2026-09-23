import type { RpgObservation } from "../rpg/observation.js";
import { SKILL_CHECK_STAKES_CHAR_LIMIT } from "../core/skill_check.js";
import { RPG_BLOCKED_ACTION_REASON_CHAR_LIMIT } from "../rpg/schema.js";
import {
  compactHead,
  compactRecent,
  compactText,
  compactTrailingOmissionCounts,
  omittedCount,
} from "./compact_truncation.js";
import {
  compactMcpActionLabel,
  compactMcpTranscriptSceneId,
  compactMcpTranscriptSummaryValue,
  compactMcpTranscriptTitle,
} from "./action_labels.js";
import { RPG_COMPACT_EVENT_LEGEND } from "./compact_rpg_event.js";
import { compactMcpVisibleJournalProse } from "./journal_prose.js";
const CORE_STATE_VARS = new Set(["attack", "defense", "hp", "max_score", "score"]);
export const COMPACT_ACTION_LIMIT = 24;
export const COMPACT_EXIT_LIMIT = 12;
export const COMPACT_VISIBLE_REF_LIMIT = 16;
export const COMPACT_BLOCKED_EXIT_LIMIT = 8;
export const COMPACT_BLOCKED_ACTION_LIMIT = 8;
export const COMPACT_ENEMY_LIMIT = 16;
export const COMPACT_PRESSURE_LIMIT = 8;
export const COMPACT_VAR_LIMIT = 16;
const COMPACT_INVENTORY_LIMIT = 16;
const COMPACT_FLAG_LIMIT = 16;
const COMPACT_JOURNAL_LIMIT = 5;
export const COMPACT_DESCRIPTION_CHAR_LIMIT = 720;
export const COMPACT_DIALOGUE_CHAR_LIMIT = 1120;
export const COMPACT_DIALOGUE_CHOICE_LIMIT = 12;
export const COMPACT_BLOCKED_EXIT_CHAR_LIMIT = 256;
export const COMPACT_BLOCKED_ACTION_REASON_CHAR_LIMIT = RPG_BLOCKED_ACTION_REASON_CHAR_LIMIT;
export const COMPACT_ENDING_TEXT_CHAR_LIMIT = 720;
export const RPG_COMPACT_OBSERVATION_VERSION = 21 as const;

export type RpgCompactRef = string;
export type RpgCompactNpc = readonly [id: string, displayName: string];
export type RpgCompactExit = string | readonly [direction: string, to: string];
export type RpgCompactBlockedExit = readonly [direction: string, message: string];
export type RpgCompactUnavailableAction = readonly [actionId: string, reason: string];
export type RpgCompactDialogue = readonly [npc: string, text: string];
export type RpgCompactDialogueChoice = readonly [actionId: string, prompt: string];
export type RpgCompactCheck = readonly [
  actionId: string,
  skill: string,
  modifier: number,
  die: string,
  difficulty: number,
  stakes?: string,
];
export type RpgCompactEnemy = readonly [id: string, hp: number];
export type RpgCompactPressure = readonly [
  id: string,
  title: string,
  value: number,
  bandMin: number,
  bandLabel: string,
  nextMin?: number,
  nextLabel?: string,
];
export type RpgCompactMore = readonly [
  inventory: number,
  flags?: number,
  vars?: number,
  journal?: number,
  actions?: number,
  exits?: number,
  objects?: number,
  npcs?: number,
  blocked?: number,
  enemies?: number,
  unavailable?: number,
  pressure?: number,
  choices?: number,
];
export type RpgCompactVitals = readonly [
  hp: number,
  attack: number,
  defense: number,
  score: number,
  maxScore: number,
];

export type RpgCompactObservation = {
  v?: typeof RPG_COMPACT_OBSERVATION_VERSION;
  here: readonly [room: string, title: string];
  text: string;
  exits?: RpgCompactExit[];
  vitals: RpgCompactVitals;
  actions?: string[];
  checks?: RpgCompactCheck[];
  objects?: RpgCompactRef[];
  npcs?: RpgCompactNpc[];
  blocked?: RpgCompactBlockedExit[];
  unavailable?: RpgCompactUnavailableAction[];
  inv?: string[];
  flags?: string[];
  vars?: Record<string, number>;
  journal?: string[];
  more?: RpgCompactMore;
  dialogue?: RpgCompactDialogue;
  choices?: RpgCompactDialogueChoice[];
  enemies?: RpgCompactEnemy[];
  pressure?: RpgCompactPressure[];
  ended?: true;
  ending_id?: string;
  ending?: RpgObservation["ending"];
};

/**
 * Agent-facing legend for the positional fields of RpgCompactObservation, plus the
 * compact step_action event tuples. Co-located with the encoder so they cannot
 * drift: the `satisfies` clause forces an entry for every observation field, and
 * tests/unit/compact_legend.test.ts asserts emitted contexts stay covered. Sent
 * ONCE per RPG session (new_game / start_world_quest / load_game), never repeated
 * in per-step payloads.
 *
 * The creating response sends it unconditionally, including when that response
 * itself carries a verbose observation. `compact_events` and `compact_observation`
 * default to true PER CALL and independently of how the session was created, so a
 * session started with compact_observation:false still gets tagged event tuples
 * (`[["m","barrow_mouth","entry_hall"]]`) and a positional `context` out of the very
 * next default step_action. This response is the RPG surface's only carrier — there
 * is no per-response legend_delta here the way the overworld surface has one — so
 * withholding it left those payloads permanently undecodable.
 */
export const RPG_COMPACT_LEGEND = {
  v: "compact observation version",
  here: "[room_id, room_title]",
  text: "room description",
  exits: "open exits: direction, or [direction, destination_room_id]",
  vitals: "[hp, attack, defense, score, max_score]",
  actions:
    "legal action ids. Dialogue does not block other listed actions. more counts truncation; call list_legal_actions for the complete menu",
  checks:
    "skill checks for listed actions: [[action_id, skill, modifier, die, difficulty, stakes?], ...]",
  objects: "visible object ids",
  npcs: "present NPCs: [[npc_id, display_name], ...]",
  blocked: "[[direction, reason], ...] blocked exits",
  unavailable: "visible actions currently blocked: [[action_id, reason], ...]",
  inv: "carried item ids",
  flags: "set story flags",
  vars: "story variables; stats already in vitals are omitted",
  journal: "recent journal entries",
  more: "omitted counts in this order: [inv, flags, vars, journal, actions, exits, objects, npcs, blocked, enemies, unavailable, pressure, choices]. Trailing zeros are removed",
  dialogue: "active dialogue: [npc_id, npc_line]",
  choices:
    "dialogue replies: [[action_id, authored_prompt], ...]. Use the unchanged id from actions. other listed actions remain legal; leaving the room ends the exchange",
  enemies: "present enemies: [[enemy_id, hp], ...]",
  pressure:
    "visible pressure tracks: [[track_id, title, value, band_min, band_label, next_min?, next_label?], ...]",
  ended: "true after the quest ends",
  ending_id: "ending id",
  ending: "ending details: {id, title, text}",
  events: RPG_COMPACT_EVENT_LEGEND,
} as const satisfies Record<keyof RpgCompactObservation | "events", string>;

export type RpgCompactLegend = typeof RPG_COMPACT_LEGEND;

type CompactRpgObservationOptions = {
  includeActions?: boolean;
  includeVersion?: boolean;
};

function compactProse(value: string, limit: number): string {
  return compactText(value.trimEnd(), limit);
}

/** Keep authored reasons byte-exact while they fit; only over-budget prose is shortened. */
export function compactRpgBlockedActionReason(reason: string): string {
  return compactText(reason, COMPACT_BLOCKED_ACTION_REASON_CHAR_LIMIT);
}

function compactEnding(ending: RpgObservation["ending"]): RpgObservation["ending"] {
  return ending === null
    ? null
    : {
        ...ending,
        id: compactMcpTranscriptSummaryValue(ending.id),
        title: compactMcpTranscriptTitle(ending.title),
        text: compactProse(ending.text, COMPACT_ENDING_TEXT_CHAR_LIMIT),
      };
}

type CompactVarsResult = {
  vars?: Record<string, number>;
  omitted: number;
};

type CompactRpgActionRow = string | RpgObservation["available_actions"][number];

function compactActionId(row: CompactRpgActionRow): string {
  return typeof row === "string" ? row : row.id;
}

function compactDialoguePrompt(command: string): string {
  const authoredPrompt = command.startsWith("ask: ") ? command.slice("ask: ".length) : command;
  return compactMcpActionLabel(authoredPrompt);
}

function compactCheck(row: Exclude<CompactRpgActionRow, string>): RpgCompactCheck | null {
  const check = row.skill_check;
  if (!check) return null;
  const base = [row.id, check.skill, check.modifier, check.die, check.difficulty] as const;
  return check.stakes ? [...base, compactProse(check.stakes, SKILL_CHECK_STAKES_CHAR_LIMIT)] : base;
}

function compactVars(vars: Record<string, number>): CompactVarsResult {
  const keys = Object.keys(vars)
    .filter((key) => !CORE_STATE_VARS.has(key))
    .sort();
  const compact: Record<string, number> = {};
  const capped = Math.min(keys.length, COMPACT_VAR_LIMIT);
  for (let index = 0; index < capped; index += 1) {
    const key = keys[index]!;
    compact[compactMcpTranscriptSummaryValue(key)] = vars[key]!;
  }
  return {
    ...(capped > 0 ? { vars: compact } : {}),
    omitted: keys.length - capped,
  };
}

export function compactRpgObservation(
  obs: RpgObservation,
  actionRows: readonly CompactRpgActionRow[],
  opts: CompactRpgObservationOptions = {},
): RpgCompactObservation {
  const vars = compactVars(obs.state.vars);
  const includeActions = opts.includeActions === true;
  const includeVersion = opts.includeVersion === true;
  const actionIds = actionRows.map(compactActionId);
  const actions = includeActions ? compactHead(actionIds, COMPACT_ACTION_LIMIT) : [];
  const visibleActionIds = new Set(actions);
  const checks: RpgCompactCheck[] = includeActions
    ? actionRows.flatMap((row) => {
        if (typeof row === "string" || !visibleActionIds.has(row.id)) return [];
        const check = compactCheck(row);
        return check ? [check] : [];
      })
    : [];
  const allDialogueChoices: RpgCompactDialogueChoice[] =
    includeActions && obs.dialogue
      ? actionRows.flatMap((row) =>
          typeof row !== "string" && row.action.type === "ASK"
            ? [[row.id, compactDialoguePrompt(row.command)] as const]
            : [],
        )
      : [];
  const choices = compactHead(
    allDialogueChoices.filter(([actionId]) => visibleActionIds.has(actionId)),
    COMPACT_DIALOGUE_CHOICE_LIMIT,
  );
  const inv = compactHead(obs.inventory, COMPACT_INVENTORY_LIMIT).map(
    compactMcpTranscriptSummaryValue,
  );
  const flags = compactHead(obs.state.flags, COMPACT_FLAG_LIMIT).map(
    compactMcpTranscriptSummaryValue,
  );
  const journal = compactRecent(obs.state.journal, COMPACT_JOURNAL_LIMIT).map(
    compactMcpVisibleJournalProse,
  );
  const compactExits = compactHead(obs.exits, COMPACT_EXIT_LIMIT);
  const compactObjects = compactHead(obs.visible_objects, COMPACT_VISIBLE_REF_LIMIT);
  const compactNpcs = compactHead(obs.npcs_present, COMPACT_VISIBLE_REF_LIMIT);
  const compactBlockedExits = compactHead(obs.blocked_exits, COMPACT_BLOCKED_EXIT_LIMIT);
  const compactBlockedActions = compactHead(obs.blocked_actions, COMPACT_BLOCKED_ACTION_LIMIT);
  const compactEnemies = compactHead(obs.enemies_present, COMPACT_ENEMY_LIMIT);
  const compactPressure = compactHead(obs.pressure_tracks ?? [], COMPACT_PRESSURE_LIMIT);
  const omittedActions = includeActions ? omittedCount(actionIds, actions) : 0;
  const omittedInv = omittedCount(obs.inventory, inv);
  const omittedFlags = omittedCount(obs.state.flags, flags);
  const omittedJournal = omittedCount(obs.state.journal, journal);
  const omittedExits = omittedCount(obs.exits, compactExits);
  const omittedObjects = omittedCount(obs.visible_objects, compactObjects);
  const omittedNpcs = omittedCount(obs.npcs_present, compactNpcs);
  const omittedBlocked = omittedCount(obs.blocked_exits, compactBlockedExits);
  const omittedBlockedActions = omittedCount(obs.blocked_actions, compactBlockedActions);
  const omittedEnemies = omittedCount(obs.enemies_present, compactEnemies);
  const omittedPressure = omittedCount(obs.pressure_tracks ?? [], compactPressure);
  const omittedChoices = omittedCount(allDialogueChoices, choices);
  const exits: RpgCompactExit[] = [];
  for (const exit of compactExits) {
    const direction = compactMcpTranscriptSummaryValue(exit.direction);
    exits.push(
      exit.to === undefined ? direction : [direction, compactMcpTranscriptSceneId(exit.to)],
    );
  }
  const objects: RpgCompactRef[] = [];
  for (const object of compactObjects) {
    objects.push(compactMcpTranscriptSummaryValue(object.id));
  }
  const npcs: RpgCompactNpc[] = [];
  for (const npc of compactNpcs) {
    npcs.push([compactMcpTranscriptSummaryValue(npc.id), compactMcpTranscriptTitle(npc.name)]);
  }
  const blocked: RpgCompactBlockedExit[] = [];
  for (const exit of compactBlockedExits) {
    blocked.push([
      compactMcpTranscriptSummaryValue(exit.direction),
      compactProse(exit.message, COMPACT_BLOCKED_EXIT_CHAR_LIMIT),
    ]);
  }
  const unavailable: RpgCompactUnavailableAction[] = [];
  for (const action of compactBlockedActions) {
    unavailable.push([action.id, compactRpgBlockedActionReason(action.reason)]);
  }
  const enemies: RpgCompactEnemy[] = [];
  for (const enemy of compactEnemies) {
    enemies.push([compactMcpTranscriptSummaryValue(enemy.id), enemy.hp]);
  }
  const pressure: RpgCompactPressure[] = [];
  for (const track of compactPressure) {
    const current = [
      compactMcpTranscriptSummaryValue(track.id),
      compactMcpTranscriptTitle(track.title),
      track.value,
      track.band.min,
      compactMcpTranscriptTitle(track.band.label),
    ] as const;
    pressure.push(
      track.next === null
        ? current
        : [...current, track.next.min, compactMcpTranscriptTitle(track.next.label)],
    );
  }
  const more = compactTrailingOmissionCounts([
    omittedInv ?? 0,
    omittedFlags ?? 0,
    vars.omitted,
    omittedJournal ?? 0,
    omittedActions ?? 0,
    omittedExits ?? 0,
    omittedObjects ?? 0,
    omittedNpcs ?? 0,
    omittedBlocked ?? 0,
    omittedEnemies ?? 0,
    omittedBlockedActions ?? 0,
    omittedPressure ?? 0,
    omittedChoices ?? 0,
  ]) as RpgCompactMore | undefined;
  return {
    ...(includeVersion ? { v: RPG_COMPACT_OBSERVATION_VERSION } : {}),
    here: [compactMcpTranscriptSceneId(obs.room), compactMcpTranscriptTitle(obs.title)],
    text: compactProse(obs.description, COMPACT_DESCRIPTION_CHAR_LIMIT),
    ...(exits.length > 0 ? { exits } : {}),
    vitals: [obs.stats.hp, obs.stats.attack, obs.stats.defense, obs.score, obs.max_score],
    ...(includeActions && actions.length > 0 ? { actions } : {}),
    ...(checks.length > 0 ? { checks } : {}),
    ...(objects.length > 0 ? { objects } : {}),
    ...(npcs.length > 0 ? { npcs } : {}),
    ...(blocked.length > 0 ? { blocked } : {}),
    ...(unavailable.length > 0 ? { unavailable } : {}),
    ...(inv.length > 0 ? { inv } : {}),
    ...(flags.length > 0 ? { flags } : {}),
    ...(vars.vars ? { vars: vars.vars } : {}),
    ...(journal.length > 0 ? { journal } : {}),
    ...(more ? { more } : {}),
    ...(obs.dialogue
      ? {
          dialogue: [
            compactMcpTranscriptSummaryValue(obs.dialogue.npc),
            compactProse(obs.dialogue.npc_text, COMPACT_DIALOGUE_CHAR_LIMIT),
          ] as const,
        }
      : {}),
    ...(choices.length > 0 ? { choices } : {}),
    ...(enemies.length > 0 ? { enemies } : {}),
    ...(pressure.length > 0 ? { pressure } : {}),
    ...(obs.ended ? { ended: true as const } : {}),
    ...(obs.ending_id ? { ending_id: compactMcpTranscriptSummaryValue(obs.ending_id) } : {}),
    ...(obs.ending ? { ending: compactEnding(obs.ending) } : {}),
  };
}
