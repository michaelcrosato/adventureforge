/**
 * RPG validator (spec §10, §13 Stage 4, §14).
 *
 * We first run the RPG foundation validator (§10.2) — feeding it the flags and
 * items that combat and skill checks provide at runtime, so a gate legitimately
 * opened by a fight or a successful check is not mis-flagged impossible. Then we
 * add Stage-4 invariants:
 *  - the player has the conventional stat vars (HP/attack/defense), HP > 0;
 *  - every enemy stands in a real room and names a declared DEATH ending;
 *  - every fight is WINNABLE — on the player's BEST reachable HP/attack/defense and
 *    the LUCKIEST rolls (player max damage, enemy min damage), the player must still
 *    be standing when the enemy falls. Authored maneuvers contribute their lucky
 *    opening routes, and a maneuver whose guard is provably inevitable suppresses the
 *    otherwise-illegal standard opening. This is a deliberately CONSERVATIVE lower
 *    bound: an ERROR fires only on a fight that is impossible even then. It is NOT a
 *    worst-case-roll survival guarantee — a deliberately luck-dependent fight that a
 *    fully-prepared player can still LOSE on bad rolls (cold_forge/sunken_barrow's
 *    intentional "preparation is a real gamble" tuning, bug_0101/0102) is PERMITTED,
 *    not flagged. (bug_0113: this proof once claimed a worst-case guarantee it never
 *    computed — the contract now matches the code.)
 *  - OPT-IN FAIRNESS (bug_0114): a pack may set `meta.combat_guaranteed: true` to
 *    PROMISE its fights are not a gamble. Then each fight must also clear the UPPER
 *    bound — best reachable stats but the player's WORST rolls (player min damage,
 *    enemy max damage): if even a fully-prepared player can be felled on the unluckiest
 *    rolls, the promise is broken (`COMBAT_NOT_GUARANTEED`). For an enemy with authored
 *    maneuvers this upper bound checks ordinary ATTACK and every forced maneuver opening
 *    (temporary modifiers for the first exchange, ordinary rounds thereafter), taking
 *    the most damaging legal route. Unlike the lower bound it is measured against the
 *    HP the player is GUARANTEED to have — reachable HP less any unavoidable opening
 *    HP cost (a `dec_var`/`set_var` on hp in the start room's on_enter), because a
 *    promise cannot be proved against health the pack itself takes away.
 *    The gamble packs above do NOT set the flag and stay
 *    unflagged; this is the sound next-shape bug_0113 named,
 *    closing the player-experience gap every RPG playtest raises by making "this fight
 *    is fair" a DECLARED, AUDITED property instead of an unverifiable hope.
 *  - every skill check is PASSABLE — d20 + the best reachable skill can meet the
 *    difficulty;
 *  - every enemy on_defeat end_game is declared.
 */
import { type Effect } from "../core/effects.js";
import type { Condition } from "../core/conditions.js";
import { wolfWinterDispatchOverlayFlagForPack } from "../core/embedded_launch_overlay_receipt.js";
import { validateRpgFoundation } from "./rpg_foundation_validator.js";
import { type Finding, type ValidationReport, makeReport } from "./report.js";
import {
  type RpgPack,
  type Enemy,
  type EnemyManeuver,
  HP_VAR,
  ATTACK_VAR,
  DEFENSE_VAR,
  SCORE_VAR,
  enemyHpVar,
} from "../rpg/schema.js";
import { maneuverActionId } from "../rpg/action_ids.js";
import { maneuverChildren, rootManeuvers } from "../rpg/maneuver_sequence.js";

type CombatRoute = {
  damageTaken: number;
  roundsToKill: number;
  maneuverId: string | null;
};

/** Worst-d6 upper bound for ordinary ATTACK rounds with best persistent stats. */
function worstStandardCombatRoute(
  playerAttack: number,
  playerDefense: number,
  enemy: Enemy,
): CombatRoute {
  const playerDamage = Math.max(1, 1 + playerAttack - enemy.defense);
  const roundsToKill = Math.ceil(enemy.hp / playerDamage);
  const enemyDamage = Math.max(1, 6 + enemy.attack - playerDefense);
  return {
    damageTaken: enemyDamage * (roundsToKill - 1),
    roundsToKill,
    maneuverId: null,
  };
}

/**
 * Worst-d6 upper bound for the forced MANEUVER opening, followed by ordinary
 * ATTACK rounds. Temporary modifiers are clamped exactly as combat.ts clamps
 * them and affect only the first strike/counterattack.
 */
function worstManeuverCombatRoute(
  playerAttack: number,
  playerDefense: number,
  enemy: Enemy,
  maneuver: EnemyManeuver,
): CombatRoute {
  const openingAttack = Math.max(0, playerAttack + maneuver.attack_bonus);
  const openingDefense = Math.max(0, playerDefense + maneuver.defense_bonus);
  const openingDamage = Math.max(1, 1 + openingAttack - enemy.defense);
  const remainingHp = enemy.hp - openingDamage;
  if (remainingHp <= 0) {
    return { damageTaken: 0, roundsToKill: 1, maneuverId: maneuver.id };
  }

  const openingReply = Math.max(1, 6 + enemy.attack - openingDefense);
  const ordinaryDamage = Math.max(1, 1 + playerAttack - enemy.defense);
  const ordinaryRounds = Math.ceil(remainingHp / ordinaryDamage);
  const ordinaryReply = Math.max(1, 6 + enemy.attack - playerDefense);
  return {
    damageTaken: openingReply + ordinaryReply * Math.max(0, ordinaryRounds - 1),
    roundsToKill: 1 + ordinaryRounds,
    maneuverId: maneuver.id,
  };
}

/** Best-d6 lower bound for ordinary ATTACK rounds with best persistent stats. */
function bestStandardCombatRoute(
  playerAttack: number,
  playerDefense: number,
  enemy: Enemy,
): CombatRoute {
  const playerDamage = Math.max(1, 6 + playerAttack - enemy.defense);
  const roundsToKill = Math.ceil(enemy.hp / playerDamage);
  const enemyDamage = Math.max(1, 1 + enemy.attack - playerDefense);
  return {
    damageTaken: enemyDamage * (roundsToKill - 1),
    roundsToKill,
    maneuverId: null,
  };
}

/**
 * Best-d6 lower bound for a MANEUVER opening followed by legacy ordinary
 * ATTACK rounds. Only the opening's temporary effective stats are clamped,
 * exactly matching combat.ts.
 */
function bestManeuverCombatRoute(
  playerAttack: number,
  playerDefense: number,
  enemy: Enemy,
  maneuver: EnemyManeuver,
): CombatRoute {
  const openingAttack = Math.max(0, playerAttack + maneuver.attack_bonus);
  const openingDefense = Math.max(0, playerDefense + maneuver.defense_bonus);
  const openingDamage = Math.max(1, 6 + openingAttack - enemy.defense);
  const remainingHp = enemy.hp - openingDamage;
  if (remainingHp <= 0) {
    return { damageTaken: 0, roundsToKill: 1, maneuverId: maneuver.id };
  }

  const openingReply = Math.max(1, 1 + enemy.attack - openingDefense);
  const ordinaryDamage = Math.max(1, 6 + playerAttack - enemy.defense);
  const ordinaryRounds = Math.ceil(remainingHp / ordinaryDamage);
  const ordinaryReply = Math.max(1, 1 + enemy.attack - playerDefense);
  return {
    damageTaken: openingReply + ordinaryReply * Math.max(0, ordinaryRounds - 1),
    roundsToKill: 1 + ordinaryRounds,
    maneuverId: maneuver.id,
  };
}

/**
 * A shallow opening/follow-through path at one fixed roll extreme, followed by
 * ordinary ATTACK only if the authored beats leave the enemy standing.
 */
function boundedManeuverSequenceRoute(
  playerAttack: number,
  playerDefense: number,
  enemy: Enemy,
  maneuvers: readonly EnemyManeuver[],
  playerRoll: 1 | 6,
  enemyRoll: 1 | 6,
): CombatRoute & { maneuverPath: string[] } {
  let remainingHp = enemy.hp;
  let damageTaken = 0;
  let roundsToKill = 0;
  for (const maneuver of maneuvers) {
    roundsToKill += 1;
    const effectiveAttack = Math.max(0, playerAttack + maneuver.attack_bonus);
    const effectiveDefense = Math.max(0, playerDefense + maneuver.defense_bonus);
    remainingHp -= Math.max(1, playerRoll + effectiveAttack - enemy.defense);
    if (remainingHp <= 0) {
      return {
        damageTaken,
        roundsToKill,
        maneuverId: maneuvers[0]?.id ?? null,
        maneuverPath: maneuvers.map((candidate) => candidate.id),
      };
    }
    damageTaken += Math.max(1, enemyRoll + enemy.attack - effectiveDefense);
  }

  const ordinaryDamage = Math.max(1, playerRoll + playerAttack - enemy.defense);
  const ordinaryRounds = Math.ceil(remainingHp / ordinaryDamage);
  const ordinaryReply = Math.max(1, enemyRoll + enemy.attack - playerDefense);
  return {
    damageTaken: damageTaken + ordinaryReply * Math.max(0, ordinaryRounds - 1),
    roundsToKill: roundsToKill + ordinaryRounds,
    maneuverId: maneuvers[0]?.id ?? null,
    maneuverPath: maneuvers.map((candidate) => candidate.id),
  };
}

/** String-valued effect targets, recursively covering every authored effect site. */
function authoredStringEffectTargets(
  node: unknown,
  effectKey: "clear_flag" | "remove_item",
  out = new Set<string>(),
): Set<string> {
  if (Array.isArray(node)) {
    for (const value of node) authoredStringEffectTargets(value, effectKey, out);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === effectKey && typeof value === "string") out.add(value);
      authoredStringEffectTargets(value, effectKey, out);
    }
  }
  return out;
}

/**
 * Item facts guaranteed by an authored maneuver guard. Only top-level atoms
 * and `all_of` descendants are conjunctive requirements; a fact inside
 * `any_of`/`none_of` is not guaranteed on every legal commitment.
 */
function guaranteedManeuverItems(conditions: readonly Condition[]): {
  held: Set<string>;
  absent: Set<string>;
} {
  const held = new Set<string>();
  const absent = new Set<string>();
  const walk = (condition: Condition): void => {
    if ("has_item" in condition) held.add(condition.has_item);
    else if ("not_item" in condition) absent.add(condition.not_item);
    else if ("all_of" in condition) condition.all_of.forEach(walk);
  };
  conditions.forEach(walk);
  return { held, absent };
}

/** Every authored effect that can set a runtime flag true. */
function authoredFlagSetTargets(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const value of node) authoredFlagSetTargets(value, out);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "set_flag" && typeof value === "string") {
        out.add(value);
      }
      authoredFlagSetTargets(value, out);
    }
  }
  return out;
}

/**
 * Conservative proof that a maneuver guard is always true whenever this enemy
 * can be fought. Only monotonic facts are claimed: immutable initialized flags,
 * non-removable held items, and rooms necessarily visited/current at encounter.
 * Unknown or mutable atoms return false, keeping standard ATTACK as a possible
 * fallback rather than creating a false COMBAT_UNWINNABLE error.
 */
function conditionGuaranteedAtEnemy(
  condition: Condition,
  pack: RpgPack,
  enemy: Enemy,
  clearedFlags: ReadonlySet<string>,
  removedItems: ReadonlySet<string>,
): boolean {
  if ("has_flag" in condition) {
    return (
      pack.meta.flags_init.includes(condition.has_flag) && !clearedFlags.has(condition.has_flag)
    );
  }
  if ("has_item" in condition) {
    return (
      pack.objects.some((object) => object.id === condition.has_item && object.held === true) &&
      !removedItems.has(condition.has_item)
    );
  }
  if ("visited" in condition) {
    return condition.visited === pack.meta.start_room || condition.visited === enemy.room;
  }
  if ("in_room" in condition) return condition.in_room === enemy.room;
  if ("all_of" in condition) {
    return condition.all_of.every((child) =>
      conditionGuaranteedAtEnemy(child, pack, enemy, clearedFlags, removedItems),
    );
  }
  if ("any_of" in condition) {
    return condition.any_of.some((child) =>
      conditionGuaranteedAtEnemy(child, pack, enemy, clearedFlags, removedItems),
    );
  }
  return false;
}

function maneuverGuaranteedAtEnemy(
  maneuver: EnemyManeuver,
  pack: RpgPack,
  enemy: Enemy,
  clearedFlags: ReadonlySet<string>,
  removedItems: ReadonlySet<string>,
): boolean {
  return maneuver.conditions.every((condition) =>
    conditionGuaranteedAtEnemy(condition, pack, enemy, clearedFlags, removedItems),
  );
}

const MAX_MANEUVER_COVERAGE_ATOMS = 12;

type BooleanConditionAtom = { key: string; negated: boolean };

/**
 * Normalize the DSL's exact complement pairs onto one Boolean atom. All other
 * atomic predicates remain independent. That enlarges the truth-table state
 * space, so a tautology proven over it is conservative for real GameStates.
 */
function booleanConditionAtom(condition: Condition): BooleanConditionAtom {
  if ("has_flag" in condition)
    return { key: JSON.stringify(["flag", condition.has_flag]), negated: false };
  if ("not_flag" in condition)
    return { key: JSON.stringify(["flag", condition.not_flag]), negated: true };
  if ("has_item" in condition)
    return { key: JSON.stringify(["item", condition.has_item]), negated: false };
  if ("not_item" in condition)
    return { key: JSON.stringify(["item", condition.not_item]), negated: true };
  if ("visited" in condition)
    return { key: JSON.stringify(["visited", condition.visited]), negated: false };
  if ("not_visited" in condition)
    return { key: JSON.stringify(["visited", condition.not_visited]), negated: true };
  if ("in_room" in condition)
    return { key: JSON.stringify(["room", condition.in_room]), negated: false };
  // none_of supplies an exact negation for every remaining atom. Keep distinct
  // predicates independent rather than assuming numeric, room, object-state,
  // or quest-stage relationships the truth table cannot prove soundly.
  return { key: JSON.stringify(["predicate", condition]), negated: false };
}

function collectBooleanConditionAtoms(condition: Condition, atoms: Set<string>): void {
  if ("all_of" in condition) {
    for (const child of condition.all_of) collectBooleanConditionAtoms(child, atoms);
  } else if ("any_of" in condition) {
    for (const child of condition.any_of) collectBooleanConditionAtoms(child, atoms);
  } else if ("none_of" in condition) {
    for (const child of condition.none_of) collectBooleanConditionAtoms(child, atoms);
  } else {
    atoms.add(booleanConditionAtom(condition).key);
  }
}

function evalBooleanCondition(condition: Condition, values: ReadonlyMap<string, boolean>): boolean {
  if ("all_of" in condition)
    return condition.all_of.every((child) => evalBooleanCondition(child, values));
  if ("any_of" in condition)
    return condition.any_of.some((child) => evalBooleanCondition(child, values));
  if ("none_of" in condition)
    return !condition.none_of.some((child) => evalBooleanCondition(child, values));
  const atom = booleanConditionAtom(condition);
  const value = values.get(atom.key) ?? false;
  return atom.negated ? !value : value;
}

function conditionSome(condition: Condition, predicate: (leaf: Condition) => boolean): boolean {
  if ("all_of" in condition)
    return condition.all_of.some((child) => conditionSome(child, predicate));
  if ("any_of" in condition)
    return condition.any_of.some((child) => conditionSome(child, predicate));
  if ("none_of" in condition)
    return condition.none_of.some((child) => conditionSome(child, predicate));
  return predicate(condition);
}

function conditionReadsCombatHp(condition: Condition): boolean {
  return conditionSome(condition, (leaf) => {
    const name =
      "var_gte" in leaf
        ? leaf.var_gte.name
        : "var_lte" in leaf
          ? leaf.var_lte.name
          : "var_eq" in leaf
            ? leaf.var_eq.name
            : null;
    return name === HP_VAR || name?.startsWith("__enemy_hp_") === true;
  });
}

function conditionReadsAnyFlag(condition: Condition, flags: ReadonlySet<string>): boolean {
  return conditionSome(condition, (leaf) => {
    const flag =
      "has_flag" in leaf ? leaf.has_flag : "not_flag" in leaf ? leaf.not_flag : undefined;
    return flag !== undefined && flags.has(flag);
  });
}

function maneuverEncounterAtoms(enemy: Enemy, maneuvers: readonly EnemyManeuver[]): Set<string> {
  const atoms = new Set<string>();
  for (const condition of enemy.conditions ?? []) collectBooleanConditionAtoms(condition, atoms);
  for (const maneuver of maneuvers) {
    for (const condition of maneuver.conditions) collectBooleanConditionAtoms(condition, atoms);
  }
  return atoms;
}

function maneuverEncounterKnownValues(
  pack: RpgPack,
  enemy: Enemy,
  maneuvers: readonly EnemyManeuver[],
  clearedFlags: ReadonlySet<string>,
  removedItems: ReadonlySet<string>,
  dedicatedDefeatFlag: boolean,
): Map<string, boolean> {
  const values = new Map<string, boolean>();
  for (const flag of pack.meta.flags_init) {
    if (!clearedFlags.has(flag)) {
      values.set(booleanConditionAtom({ has_flag: flag }).key, true);
    }
  }
  for (const object of pack.objects) {
    if (object.held === true && !removedItems.has(object.id)) {
      values.set(booleanConditionAtom({ has_item: object.id }).key, true);
    }
  }
  values.set(booleanConditionAtom({ visited: pack.meta.start_room }).key, true);
  values.set(booleanConditionAtom({ visited: enemy.room }).key, true);
  for (const room of pack.rooms) {
    values.set(booleanConditionAtom({ in_room: room.id }).key, room.id === enemy.room);
  }
  for (const maneuver of maneuvers) {
    values.set(booleanConditionAtom({ has_flag: maneuver.result_flag }).key, false);
  }
  if (dedicatedDefeatFlag && enemy.defeat_flag !== undefined) {
    values.set(booleanConditionAtom({ has_flag: enemy.defeat_flag }).key, false);
  }
  return values;
}

type ManeuverEncounterAnalysis = {
  possibleManeuvers: ReadonlySet<EnemyManeuver>;
  collectivelyCovers: boolean;
};

function unknownManeuverEncounterAnalysis(
  maneuvers: readonly EnemyManeuver[],
): ManeuverEncounterAnalysis {
  return {
    possibleManeuvers: new Set(maneuvers),
    collectivelyCovers: false,
  };
}

/**
 * Bounded abstract interpretation of the enemy's first combat opening. Every
 * enumerated assignment satisfies proven encounter facts and the enemy's own
 * active-state conditions. The remaining Boolean atoms deliberately
 * over-approximate real GameStates, so both conclusions are sound:
 *
 * - a maneuver absent from every assignment is impossible at this encounter;
 * - collective coverage across every assignment means ATTACK cannot open.
 *
 * If ownership is ambiguous, the free-atom cap is exceeded, or the abstract
 * encounter itself has no assignment, return unknown: retain every maneuver
 * route and standard ATTACK.
 */
function analyzeManeuverEncounter(
  pack: RpgPack,
  enemy: Enemy,
  maneuvers: readonly EnemyManeuver[],
  clearedFlags: ReadonlySet<string>,
  removedItems: ReadonlySet<string>,
  resultOwnershipValid: boolean,
  dedicatedDefeatFlag: boolean,
): ManeuverEncounterAnalysis {
  if (maneuvers.length === 0 || !resultOwnershipValid) {
    return unknownManeuverEncounterAnalysis(maneuvers);
  }

  const atomSet = maneuverEncounterAtoms(enemy, maneuvers);
  const knownValues = maneuverEncounterKnownValues(
    pack,
    enemy,
    maneuvers,
    clearedFlags,
    removedItems,
    dedicatedDefeatFlag,
  );

  const freeAtoms = [...atomSet].filter((atom) => !knownValues.has(atom));
  if (freeAtoms.length > MAX_MANEUVER_COVERAGE_ATOMS) {
    return unknownManeuverEncounterAnalysis(maneuvers);
  }

  const assignmentCount = 2 ** freeAtoms.length;
  const possibleManeuvers = new Set<EnemyManeuver>();
  let collectivelyCovers = true;
  let encounterAssignments = 0;
  for (let assignment = 0; assignment < assignmentCount; assignment++) {
    const values = new Map(knownValues);
    for (let index = 0; index < freeAtoms.length; index++) {
      values.set(freeAtoms[index]!, (assignment & (2 ** index)) !== 0);
    }
    if (!(enemy.conditions ?? []).every((condition) => evalBooleanCondition(condition, values))) {
      continue;
    }
    encounterAssignments += 1;
    const available = maneuvers.filter((maneuver) =>
      maneuver.conditions.every((condition) => evalBooleanCondition(condition, values)),
    );
    for (const maneuver of available) possibleManeuvers.add(maneuver);
    if (available.length === 0) collectivelyCovers = false;
  }
  if (encounterAssignments === 0) {
    return unknownManeuverEncounterAnalysis(maneuvers);
  }
  return { possibleManeuvers, collectivelyCovers };
}

const MAX_MANEUVER_SEQUENCE_ROUTES = 64;

type SequencedCombatRoute = CombatRoute & { maneuverPath?: string[] };

type ManeuverSequenceAnalysis =
  | { analyzed: true; bestRoute: SequencedCombatRoute; worstRoute: SequencedCombatRoute }
  | { analyzed: false; reason: "ownership" | "limit" | "no_encounter" };

function maneuverOpeningRemainingHp(
  playerAttack: number,
  enemy: Enemy,
  maneuver: EnemyManeuver,
  playerRoll: 1 | 6,
): number {
  const effectiveAttack = Math.max(0, playerAttack + maneuver.attack_bonus);
  return enemy.hp - Math.max(1, playerRoll + effectiveAttack - enemy.defense);
}

/**
 * Exact two-beat route analysis over the same bounded encounter assignments as
 * the legacy opening proof. The sequence topology is shallow by validation, so
 * every legal path is opening, optional follow-through, then ordinary ATTACK.
 */
function analyzeManeuverSequences(
  pack: RpgPack,
  enemy: Enemy,
  maneuvers: readonly EnemyManeuver[],
  playerAttack: number,
  playerDefense: number,
  clearedFlags: ReadonlySet<string>,
  removedItems: ReadonlySet<string>,
  resultOwnershipValid: boolean,
  dedicatedDefeatFlag: boolean,
): ManeuverSequenceAnalysis {
  if (!resultOwnershipValid) return { analyzed: false, reason: "ownership" };
  const roots = rootManeuvers(enemy);
  const declaredRouteCount = roots.reduce(
    (count, root) => count + Math.max(1, maneuverChildren(enemy, root.id).length),
    0,
  );
  if (declaredRouteCount > MAX_MANEUVER_SEQUENCE_ROUTES) {
    return { analyzed: false, reason: "limit" };
  }

  const atomSet = maneuverEncounterAtoms(enemy, maneuvers);
  const knownValues = maneuverEncounterKnownValues(
    pack,
    enemy,
    maneuvers,
    clearedFlags,
    removedItems,
    dedicatedDefeatFlag,
  );
  const freeAtoms = [...atomSet].filter((atom) => !knownValues.has(atom));
  if (freeAtoms.length > MAX_MANEUVER_COVERAGE_ATOMS) {
    return { analyzed: false, reason: "limit" };
  }

  let encounterAssignments = 0;
  let bestRoute: SequencedCombatRoute | undefined;
  let worstRoute: SequencedCombatRoute | undefined;
  const noteBest = (route: SequencedCombatRoute): void => {
    if (bestRoute === undefined || route.damageTaken < bestRoute.damageTaken) bestRoute = route;
  };
  const noteWorst = (route: SequencedCombatRoute): void => {
    if (worstRoute === undefined || route.damageTaken > worstRoute.damageTaken) worstRoute = route;
  };
  const assignmentCount = 2 ** freeAtoms.length;
  for (let assignment = 0; assignment < assignmentCount; assignment++) {
    const values = new Map(knownValues);
    for (let index = 0; index < freeAtoms.length; index++) {
      values.set(freeAtoms[index]!, (assignment & (2 ** index)) !== 0);
    }
    if (!(enemy.conditions ?? []).every((condition) => evalBooleanCondition(condition, values))) {
      continue;
    }
    encounterAssignments += 1;
    const availableRoots = roots.filter((maneuver) =>
      maneuver.conditions.every((condition) => evalBooleanCondition(condition, values)),
    );
    if (availableRoots.length === 0) {
      noteBest(bestStandardCombatRoute(playerAttack, playerDefense, enemy));
      noteWorst(worstStandardCombatRoute(playerAttack, playerDefense, enemy));
      continue;
    }

    for (const root of availableRoots) {
      const childValues = new Map(values);
      childValues.set(booleanConditionAtom({ has_flag: root.result_flag }).key, true);
      const availableChildren = maneuverChildren(enemy, root.id).filter((maneuver) =>
        maneuver.conditions.every((condition) => evalBooleanCondition(condition, childValues)),
      );

      if (maneuverOpeningRemainingHp(playerAttack, enemy, root, 6) <= 0) {
        noteBest(boundedManeuverSequenceRoute(playerAttack, playerDefense, enemy, [root], 6, 1));
      } else if (availableChildren.length === 0) {
        noteBest(boundedManeuverSequenceRoute(playerAttack, playerDefense, enemy, [root], 6, 1));
      } else {
        for (const child of availableChildren) {
          noteBest(
            boundedManeuverSequenceRoute(playerAttack, playerDefense, enemy, [root, child], 6, 1),
          );
        }
      }

      if (maneuverOpeningRemainingHp(playerAttack, enemy, root, 1) <= 0) {
        noteWorst(boundedManeuverSequenceRoute(playerAttack, playerDefense, enemy, [root], 1, 6));
      } else if (availableChildren.length === 0) {
        noteWorst(boundedManeuverSequenceRoute(playerAttack, playerDefense, enemy, [root], 1, 6));
      } else {
        for (const child of availableChildren) {
          noteWorst(
            boundedManeuverSequenceRoute(playerAttack, playerDefense, enemy, [root, child], 1, 6),
          );
        }
      }
    }
  }

  if (encounterAssignments === 0 || bestRoute === undefined || worstRoute === undefined) {
    return { analyzed: false, reason: "no_encounter" };
  }
  return { analyzed: true, bestRoute, worstRoute };
}

const err = (code: string, message: string, where: string[]): Finding => ({
  severity: "error",
  code,
  message,
  where,
});

const warn = (code: string, message: string, where: string[]): Finding => ({
  severity: "warning",
  code,
  message,
  where,
});

function flagMayBeInitializedAtOpening(pack: RpgPack, flag: string): boolean {
  return (
    pack.meta.flags_init.includes(flag) || (pack.meta.seeded_opening_flags?.includes(flag) ?? false)
  );
}

function enemyRuntimeEffects(pack: RpgPack): Effect[] {
  const out: Effect[] = [];
  for (const e of pack.enemies) out.push(...e.on_defeat);
  return out;
}

/** Effects the runner emits when a maneuver is committed, in runtime order. */
function maneuverRuntimeEffectList(maneuver: EnemyManeuver): Effect[] {
  return [{ set_flag: maneuver.result_flag }, ...(maneuver.resource_effects ?? [])];
}

function maneuverRuntimeEffects(pack: RpgPack): Effect[] {
  return pack.enemies.flatMap((enemy) =>
    (enemy.maneuvers ?? []).flatMap((maneuver) => maneuverRuntimeEffectList(maneuver)),
  );
}

function skillCheckEffects(pack: RpgPack): Effect[] {
  const out: Effect[] = [];
  for (const o of pack.objects)
    for (const it of o.interactions)
      if (it.skill_check)
        out.push(
          ...it.skill_check.on_success,
          ...it.skill_check.on_failure,
          ...(it.skill_check.on_failure_when ?? []).flatMap((branch) => branch.effects),
        );
  return out;
}

function rpgRuntimeEffects(pack: RpgPack): Effect[] {
  return [
    ...enemyRuntimeEffects(pack),
    ...maneuverRuntimeEffects(pack),
    ...skillCheckEffects(pack),
  ];
}

export type ValidateRpgOptions = {
  /** Flags a trusted higher-level boundary can set before the first RPG turn. */
  extraSettableFlags?: readonly string[];
  /** Pack-local objects a trusted higher-level boundary can place in starting inventory. */
  extraObtainable?: readonly string[];
  /** Bounded values a trusted higher-level boundary can install before the first RPG turn. */
  extraInitialVarRanges?: ReadonlyMap<string, Readonly<{ min: number; max: number }>>;
};

export function validateRpg(pack: RpgPack, opts: ValidateRpgOptions = {}): ValidationReport {
  // Flags/items that combat provides to the foundation validator. Authored
  // skill-check branch effects are scanned by the RPG foundation validator, so do
  // not inject them here again (score/list extras would double-count them).
  const enemyEffects = enemyRuntimeEffects(pack);
  const maneuverEffects = maneuverRuntimeEffects(pack);
  const extraSettableFlags: string[] = [...(opts.extraSettableFlags ?? [])];
  const launchOverlayFlag = wolfWinterDispatchOverlayFlagForPack(pack.meta.id);
  if (launchOverlayFlag !== undefined) extraSettableFlags.push(launchOverlayFlag);
  const extraObtainable: string[] = [...(opts.extraObtainable ?? [])];
  for (const enemy of pack.enemies) {
    if (enemy.defeat_flag) extraSettableFlags.push(enemy.defeat_flag);
    for (const maneuver of enemy.maneuvers ?? []) {
      extraSettableFlags.push(maneuver.result_flag);
    }
  }
  // Quest stages set through RPG-only combat branches. Keyed with the SAME NUL
  // separator the foundation validator's questStageKey uses, so the keys match.
  // Mirrors extraSettableFlags.
  const extraSettableQuestStages: string[] = [];
  for (const e of [...enemyEffects, ...maneuverEffects]) {
    if ("set_flag" in e) extraSettableFlags.push(e.set_flag);
    if ("add_item" in e) extraObtainable.push(e.add_item);
    if ("set_quest_stage" in e)
      extraSettableQuestStages.push(`${e.set_quest_stage.quest}\0${e.set_quest_stage.stage}`);
  }

  // Score awarded through RPG-only combat branches, which the foundation
  // SCORE_UNREACHABLE bound does not scan — fold it in so a
  // score earned by winning a fight counts as reachable.
  let extraScoreAwards = 0;
  for (const e of enemyEffects)
    if ("inc_var" in e && e.inc_var.name === SCORE_VAR) extraScoreAwards += e.inc_var.by;

  // The grouped RPG-only combat effect lists, handed to the foundation validator's
  // SCORE_PEAKS_BEFORE_WIN check so a score award co-located with a combat act that
  // sets a win-trigger flag is seen as such.
  const extraEffectLists: Effect[][] = [];
  for (const enemy of pack.enemies) extraEffectLists.push(enemy.on_defeat);
  for (const enemy of pack.enemies)
    for (const maneuver of enemy.maneuvers ?? [])
      extraEffectLists.push(maneuverRuntimeEffectList(maneuver));

  // The WIN_FIRES_AT_START stability proof must also see RPG-only falsifiers:
  // combat branches can falsify a start-true win (extraFalsifierEffects), and
  // combat mutates HP via dynamic set_var the authored-effect scan never sees, so the player
  // + enemy HP vars are volatile (a win condition on them is escapable).
  const extraVolatileVars = [
    HP_VAR,
    ATTACK_VAR,
    DEFENSE_VAR,
    ...pack.enemies.map((e) => enemyHpVar(e.id)),
  ];
  const base = validateRpgFoundation(pack, {
    extraSettableFlags,
    extraReadFlags: pack.enemies.flatMap((enemy) =>
      (enemy.maneuvers ?? []).map((maneuver) => maneuver.result_flag),
    ),
    extraObtainable,
    ...(opts.extraInitialVarRanges === undefined
      ? {}
      : { extraInitialVarRanges: opts.extraInitialVarRanges }),
    extraEffects: maneuverEffects,
    extraScoreAwards,
    extraFalsifierEffects: enemyEffects,
    extraVolatileVars,
    extraEffectLists,
    extraSettableQuestStages,
  });
  const findings: Finding[] = [...base.findings];

  const roomIds = new Set(pack.rooms.map((r) => r.id));
  const itemIds = new Set(pack.objects.map((object) => object.id));
  const endings = new Map(pack.endings.map((e) => [e.id, e]));

  // ── Player stats ─────────────────────────────────────────────────────────────
  const vi = pack.meta.vars_init;
  for (const stat of [HP_VAR, ATTACK_VAR, DEFENSE_VAR]) {
    if (vi[stat] === undefined)
      findings.push(
        err(
          "MISSING_STAT",
          `meta.vars_init is missing the "${stat}" stat (Stage 4 requires HP/attack/defense).`,
          ["meta:vars_init"],
        ),
      );
  }
  if ((vi[HP_VAR] ?? 0) <= 0)
    findings.push(
      err("BAD_HP", `meta.vars_init.${HP_VAR} must start positive.`, ["meta:vars_init"]),
    );

  // buffEffects also answers a narrower liveness question the pressure-track loop
  // below needs: does ANY effect in the pack ever write a given var? Declared here
  // (moved up from just above the stat-ceiling below, which is still its other
  // consumer) so the loop can consult it too.
  const buffEffects = [...rpgRuntimeEffects(pack), ...allAuthoredEffects(pack)];
  const writesVar = (name: string): boolean =>
    buffEffects.some(
      (e) =>
        ("inc_var" in e && e.inc_var.name === name) ||
        ("dec_var" in e && e.dec_var.name === name) ||
        ("set_var" in e && e.set_var.name === name),
    );

  // ── Visible pressure tracks ─────────────────────────────────────────────────
  // A track is a read-only semantic projection over one ordinary var. Require
  // that source to exist and that the fresh value lies inside the authored
  // threshold domain; runtime effects remain the generic, deterministic var DSL.
  // A track whose var no effect anywhere ever writes is DEAD: it silently sits at
  // its initial band forever, invisible to a blind playtester from inside the
  // game. This is the write-side liveness dual of INERT_FLAG/INERT_OBJECT_STATE
  // (rpg_foundation_validator.ts) — those flag a WRITE nothing ever READS; this
  // flags a projected READ nothing ever WRITES.
  for (const track of pack.pressure_tracks ?? []) {
    const initial = vi[track.var];
    if (initial === undefined) {
      findings.push(
        err(
          "PRESSURE_VAR_UNDECLARED",
          `pressure track "${track.id}" reads var "${track.var}", which is not declared in meta.vars_init.`,
          [`pressure:${track.id}`, `var:${track.var}`],
        ),
      );
    } else if (initial < track.bands[0]!.min) {
      findings.push(
        err(
          "PRESSURE_INITIAL_BELOW_MIN",
          `pressure track "${track.id}" starts at ${initial}, below its first band minimum ${track.bands[0]!.min}.`,
          [`pressure:${track.id}`, `var:${track.var}`],
        ),
      );
    } else if (!writesVar(track.var)) {
      findings.push(
        warn(
          "DEAD_PRESSURE_TRACK",
          `pressure track "${track.id}" projects var "${track.var}", but no effect in the pack ever writes it — the track is frozen at its initial band forever.`,
          [`pressure:${track.id}`, `var:${track.var}`],
        ),
      );
    }
  }

  // Best reachable value of a stat/skill = init + every positive inc_var that
  // targets it, across all reachable effect sources (room on_enter, object
  // interactions, NPC dialogue, combat on_defeat, and skill-check branches). This
  // mirrors the skill-check ceiling used below: the combat-winnability proof must
  // credit the player the SAME buffs a skill check does, or a fight winnable only
  // after a reachable +attack weapon / +defense ward (e.g. cold_forge's lantern-
  // spirit +2 attack and founder's-plate +2 defense, sunken_barrow's shade ward)
  // is wrongly flagged COMBAT_UNWINNABLE. COMBAT_UNWINNABLE means "only a TRULY
  // impossible fight is an error", so over-approximating player power (assume every
  // buff obtained) is the sound direction — it can only REMOVE false positives,
  // never add one. A negative inc_var (a debuff) is ignored (Math.max(0, by)),
  // exactly as the skill ceiling does, so it never over-credits.
  const statCeiling = (name: string): number => {
    let v = vi[name] ?? 0;
    for (const e of buffEffects)
      if ("inc_var" in e && e.inc_var.name === name) v += Math.max(0, e.inc_var.by);
    return v;
  };

  const playerHp = statCeiling(HP_VAR);
  const playerAtk = statCeiling(ATTACK_VAR);
  const playerDef = statCeiling(DEFENSE_VAR);

  // The fairness PROMISE needs a floor, not the ceiling above. `statCeiling` reads
  // `inc_var` and nothing else, so an authored `dec_var` or `set_var` on hp is
  // invisible to it. Over-crediting HP is the SOUND direction for COMBAT_UNWINNABLE
  // (a route-EXISTENCE proof: too much HP can only withdraw a false "impossible"),
  // but it is the UNSOUND direction for the `combat_guaranteed` promises below —
  // there it grants a guarantee the runtime cannot keep. Measured before this guard:
  // dawn_beacon (hp 26, cumulative worst-case gauntlet 21) with an unconditional
  // `{dec_var: {name: hp, by: 20}}` — or `{set_var: {name: hp, value: 1}}`, the
  // sharper case, since HP_VAR is already a normal set_var target for combat —
  // pushed onto its START ROOM's on_enter validated ok with ZERO findings, certifying
  // a fair-fight promise for a player who meets a 21-damage gauntlet with 6 HP (or 1).
  //
  // Which costs count: only the ones the "best-prepared player" these bounds are
  // written against CANNOT refuse. A room they may walk around, an object they need
  // not touch and a dialogue node they need not open are all avoidable, and charging
  // the promise for them would reject legitimate content (a trap corridor a careful
  // player skips) — that is the same reason the ceiling credits every buff. The start
  // room's `on_enter` is the one effect list every playthrough runs, applied at init
  // before the player has made a single choice (src/rpg/model.ts:228 hands it to
  // initRuntimeState), so it is exactly the unavoidable set. Costs on any other path
  // stay uncharged, deliberately: making THEM count needs per-fight reachability, not
  // a ceiling tweak, and would change what content is legal.
  //
  // Buffs reachable AFTER the opening are still credited (a heal undoes an opening
  // cost), and the result is capped at `playerHp` so this can only ever TIGHTEN the
  // promise — an unavoidable `set_var` that RAISES hp must not buy a bigger guarantee
  // than the declared stats and reachable buffs already prove.
  const openingEffects =
    pack.rooms.find((room) => room.id === pack.meta.start_room)?.on_enter ?? [];
  const openingEffectSet = new Set<Effect>(openingEffects);
  let openingHp = vi[HP_VAR] ?? 0;
  for (const e of openingEffects) {
    if ("set_var" in e && e.set_var.name === HP_VAR) openingHp = e.set_var.value;
    else if ("inc_var" in e && e.inc_var.name === HP_VAR) openingHp += e.inc_var.by;
    else if ("dec_var" in e && e.dec_var.name === HP_VAR) openingHp -= e.dec_var.by;
  }
  let recoverableHp = 0;
  for (const e of buffEffects)
    if ("inc_var" in e && e.inc_var.name === HP_VAR && !openingEffectSet.has(e))
      recoverableHp += Math.max(0, e.inc_var.by);
  const guaranteedHp = Math.min(playerHp, openingHp + recoverableHp);
  // Packs with no unavoidable hp write (every shipped and generated pack today) get
  // guaranteedHp === playerHp, so the diagnostics below stay byte-identical for them.
  const guaranteedHpPhrase =
    guaranteedHp === playerHp
      ? `${playerHp} reachable HP`
      : `${guaranteedHp} guaranteed HP (${playerHp} reachable, less ${playerHp - guaranteedHp} unavoidable opening cost)`;

  // ── Enemies ──────────────────────────────────────────────────────────────────
  // Cumulative worst-case damage across the whole opt-in `combat_guaranteed`
  // gauntlet (bug_0172). Only meaningful when the pack PROMISES fair fights: it
  // sums each enemy's worst route across plain ATTACK and every maneuver opening so a multi-fight
  // guarantee can be audited JOINTLY, not just per-fight. See the post-loop check.
  let cumulativeWorstDamage = 0;
  const clearedFlags = authoredStringEffectTargets(pack, "clear_flag");
  const removedItems = authoredStringEffectTargets(pack, "remove_item");
  const authoredSetFlags = authoredFlagSetTargets(pack);
  const maneuverActionIdOwners = new Map<string, { enemyId: string; maneuverId: string }>();
  const maneuverResultFlagOwners = new Map<string, { enemyId: string; maneuverId: string }[]>();
  const defeatFlagOwners = new Map<string, string[]>();
  for (const candidate of pack.enemies) {
    if (candidate.defeat_flag === undefined) continue;
    const owners = defeatFlagOwners.get(candidate.defeat_flag) ?? [];
    owners.push(candidate.id);
    defeatFlagOwners.set(candidate.defeat_flag, owners);
  }
  for (const candidate of pack.enemies) {
    for (const maneuver of candidate.maneuvers ?? []) {
      const owners = maneuverResultFlagOwners.get(maneuver.result_flag) ?? [];
      owners.push({ enemyId: candidate.id, maneuverId: maneuver.id });
      maneuverResultFlagOwners.set(maneuver.result_flag, owners);
    }
  }
  for (const [flag, owners] of maneuverResultFlagOwners) {
    if (owners.length <= 1) continue;
    findings.push(
      err(
        "DUPLICATE_MANEUVER_RESULT_FLAG",
        `maneuver result flag "${flag}" has multiple owners (${owners.map((owner) => `enemy "${owner.enemyId}" maneuver "${owner.maneuverId}"`).join(", ")}); a result flag must identify exactly one committed maneuver.`,
        [
          `flag:${flag}`,
          ...owners.map((owner) => `enemy:${owner.enemyId}:maneuver:${owner.maneuverId}`),
        ],
      ),
    );
  }
  for (const enemy of pack.enemies) {
    const maneuvers = enemy.maneuvers ?? [];
    const maneuverById = new Map<string, EnemyManeuver>();
    for (const maneuver of maneuvers) {
      if (!maneuverById.has(maneuver.id)) maneuverById.set(maneuver.id, maneuver);
    }
    const hasSequence = maneuvers.some((maneuver) => maneuver.after !== undefined);
    let sequenceCycle: string[] | null = null;
    for (const start of maneuvers) {
      if (sequenceCycle !== null) break;
      const positions = new Map<string, number>();
      const path: string[] = [];
      let current: EnemyManeuver | undefined = start;
      while (current !== undefined && current.after !== undefined) {
        const prior = positions.get(current.id);
        if (prior !== undefined) {
          const cycle = path.slice(prior);
          if (cycle.length > 1) sequenceCycle = cycle;
          break;
        }
        positions.set(current.id, path.length);
        path.push(current.id);
        current = maneuverById.get(current.after);
      }
    }
    if (sequenceCycle !== null) {
      findings.push(
        err(
          "MANEUVER_AFTER_CYCLE",
          `enemy "${enemy.id}" declares a maneuver follow-through cycle (${sequenceCycle.map((id) => `"${id}"`).join(" -> ")}).`,
          [`enemy:${enemy.id}`, ...sequenceCycle.map((id) => `maneuver:${id}`)],
        ),
      );
    }
    if (hasSequence && rootManeuvers(enemy).length === 0) {
      findings.push(
        err(
          "MANEUVER_SEQUENCE_NO_ROOT",
          `enemy "${enemy.id}" declares follow-through maneuvers but no root opening maneuver.`,
          [`enemy:${enemy.id}`],
        ),
      );
    }
    for (const maneuver of maneuvers) {
      if (maneuver.after === undefined) continue;
      if (maneuver.after === maneuver.id) {
        findings.push(
          err(
            "MANEUVER_AFTER_SELF",
            `enemy "${enemy.id}" maneuver "${maneuver.id}" cannot follow itself.`,
            [`enemy:${enemy.id}`, `maneuver:${maneuver.id}`],
          ),
        );
        continue;
      }
      const parent = maneuverById.get(maneuver.after);
      if (parent === undefined) {
        findings.push(
          err(
            "MANEUVER_AFTER_MISSING",
            `enemy "${enemy.id}" maneuver "${maneuver.id}" follows missing same-enemy maneuver "${maneuver.after}".`,
            [`enemy:${enemy.id}`, `maneuver:${maneuver.id}`],
          ),
        );
      } else if (parent.after !== undefined) {
        findings.push(
          err(
            "MANEUVER_AFTER_NOT_ROOT",
            `enemy "${enemy.id}" maneuver "${maneuver.id}" follows "${parent.id}", but follow-through depth is limited to one layer and the parent is not a root opening.`,
            [`enemy:${enemy.id}`, `maneuver:${maneuver.id}`, `parent:${parent.id}`],
          ),
        );
      }
    }
    if (hasSequence) {
      const resultFlags = new Set(maneuvers.map((maneuver) => maneuver.result_flag));
      if (
        (enemy.conditions ?? []).some((condition) => conditionReadsAnyFlag(condition, resultFlags))
      ) {
        findings.push(
          err(
            "MANEUVER_SEQUENCE_ENEMY_GATE_VOLATILE",
            `enemy "${enemy.id}" has an active-state condition that reads one of its maneuver result flags, so committing an opening could make the live foe disappear between sequence beats.`,
            [`enemy:${enemy.id}`],
          ),
        );
      }
      if ((enemy.conditions ?? []).some(conditionReadsCombatHp)) {
        findings.push(
          err(
            "MANEUVER_SEQUENCE_HP_CONDITION",
            `enemy "${enemy.id}" has a combat-HP condition that can change between maneuver sequence beats and cannot be soundly treated as an encounter constant.`,
            [`enemy:${enemy.id}`],
          ),
        );
      }
      for (const maneuver of maneuvers) {
        if (!maneuver.conditions.some(conditionReadsCombatHp)) continue;
        findings.push(
          err(
            "MANEUVER_SEQUENCE_HP_CONDITION",
            `enemy "${enemy.id}" maneuver "${maneuver.id}" has a combat-HP condition that can change between sequence beats and cannot be soundly treated as an encounter constant.`,
            [`enemy:${enemy.id}`, `maneuver:${maneuver.id}`],
          ),
        );
      }
    }
    const maneuverIds = new Set<string>();
    const maneuverCommands = new Set<string>();
    for (const maneuver of enemy.maneuvers ?? []) {
      if (maneuverIds.has(maneuver.id)) {
        findings.push(
          err(
            "DUPLICATE_MANEUVER_ID",
            `enemy "${enemy.id}" declares maneuver id "${maneuver.id}" more than once.`,
            [`enemy:${enemy.id}`, `maneuver:${maneuver.id}`],
          ),
        );
      }
      maneuverIds.add(maneuver.id);
      const actionId = maneuverActionId(enemy.id, maneuver.id);
      const actionIdOwner = maneuverActionIdOwners.get(actionId);
      if (
        actionIdOwner !== undefined &&
        (actionIdOwner.enemyId !== enemy.id || actionIdOwner.maneuverId !== maneuver.id)
      ) {
        findings.push(
          err(
            "MANEUVER_ACTION_ID_COLLISION",
            `enemy "${enemy.id}" maneuver "${maneuver.id}" generates action id "${actionId}", which is already generated by enemy "${actionIdOwner.enemyId}" maneuver "${actionIdOwner.maneuverId}". Rename one id so every public action remains selectable.`,
            [`enemy:${enemy.id}`, `maneuver:${maneuver.id}`, `action:${actionId}`],
          ),
        );
      } else if (actionIdOwner === undefined) {
        maneuverActionIdOwners.set(actionId, { enemyId: enemy.id, maneuverId: maneuver.id });
      }
      const command = maneuver.command.trim().toLowerCase();
      if (maneuverCommands.has(command)) {
        findings.push(
          err(
            "DUPLICATE_MANEUVER_COMMAND",
            `enemy "${enemy.id}" declares maneuver command "${maneuver.command}" more than once.`,
            [`enemy:${enemy.id}`, `maneuver:${maneuver.id}`],
          ),
        );
      }
      maneuverCommands.add(command);
      if (maneuver.attack_bonus === 0 && maneuver.defense_bonus === 0) {
        findings.push(
          err(
            "MANEUVER_NO_MODIFIER",
            `enemy "${enemy.id}" maneuver "${maneuver.id}" changes neither attack nor defense, so it is only a cosmetic alias for ATTACK.`,
            [`enemy:${enemy.id}`, `maneuver:${maneuver.id}`],
          ),
        );
      }
      const guaranteedItems = guaranteedManeuverItems(maneuver.conditions);
      const addedItems = new Set<string>();
      const spentItems = new Set<string>();
      for (const effect of maneuver.resource_effects ?? []) {
        const kind = "add_item" in effect ? "add" : "remove";
        const item = "add_item" in effect ? effect.add_item : effect.remove_item;
        const seen = kind === "add" ? addedItems : spentItems;
        if (seen.has(item)) {
          findings.push(
            err(
              "MANEUVER_RESOURCE_EFFECT_DUPLICATE",
              `enemy "${enemy.id}" maneuver "${maneuver.id}" ${kind === "add" ? "adds" : "removes"} item "${item}" more than once on one commitment.`,
              [`enemy:${enemy.id}`, `maneuver:${maneuver.id}`, `item:${item}`],
            ),
          );
        }
        seen.add(item);
        if (!itemIds.has(item)) {
          // The foundation pass emits ITEM_REF_MISSING for the dangling target;
          // keep the maneuver-specific checks focused on ownership dataflow.
          continue;
        }
        const guarded =
          kind === "add" ? guaranteedItems.absent.has(item) : guaranteedItems.held.has(item);
        if (!guarded) {
          findings.push(
            err(
              "MANEUVER_RESOURCE_EFFECT_UNGUARDED",
              `enemy "${enemy.id}" maneuver "${maneuver.id}" ${kind === "add" ? "adds" : "removes"} item "${item}" without a guaranteed ${kind === "add" ? "not_item" : "has_item"} guard in its conditions.`,
              [`enemy:${enemy.id}`, `maneuver:${maneuver.id}`, `item:${item}`],
            ),
          );
        }
      }
      for (const item of addedItems) {
        if (!spentItems.has(item)) continue;
        findings.push(
          err(
            "MANEUVER_RESOURCE_EFFECT_CONFLICT",
            `enemy "${enemy.id}" maneuver "${maneuver.id}" both adds and removes item "${item}" on one commitment; a resource delta must have one direction.`,
            [`enemy:${enemy.id}`, `maneuver:${maneuver.id}`, `item:${item}`],
          ),
        );
      }
      if (flagMayBeInitializedAtOpening(pack, maneuver.result_flag)) {
        findings.push(
          err(
            "MANEUVER_RESULT_FLAG_INITIALIZED",
            `enemy "${enemy.id}" maneuver "${maneuver.id}" uses initialized flag "${maneuver.result_flag}" as its one-shot result, so the maneuver can never be offered.`,
            [`enemy:${enemy.id}`, `maneuver:${maneuver.id}`],
          ),
        );
      }
      if (authoredSetFlags.has(maneuver.result_flag)) {
        findings.push(
          err(
            "MANEUVER_RESULT_FLAG_FOREIGN_WRITER",
            `enemy "${enemy.id}" maneuver "${maneuver.id}" uses result flag "${maneuver.result_flag}", but an authored effect can set it before this maneuver commits and silently restore standard ATTACK. Maneuver result flags must have exactly one implicit writer.`,
            [`enemy:${enemy.id}`, `maneuver:${maneuver.id}`, `flag:${maneuver.result_flag}`],
          ),
        );
      }
      if (clearedFlags.has(maneuver.result_flag)) {
        findings.push(
          err(
            "MANEUVER_RESULT_FLAG_CLEARED",
            `enemy "${enemy.id}" maneuver "${maneuver.id}" uses result flag "${maneuver.result_flag}", but an authored clear_flag can reset it and re-enable an action declared one-shot. Maneuver result flags must be monotonic.`,
            [`enemy:${enemy.id}`, `maneuver:${maneuver.id}`, `flag:${maneuver.result_flag}`],
          ),
        );
      }
      const collidingEnemies = defeatFlagOwners.get(maneuver.result_flag);
      if (collidingEnemies !== undefined) {
        findings.push(
          err(
            "MANEUVER_DEFEAT_FLAG_COLLISION",
            `enemy "${enemy.id}" maneuver "${maneuver.id}" reuses defeat_flag "${maneuver.result_flag}" declared by ${collidingEnemies.map((id) => `enemy "${id}"`).join(", ")}, which would publish defeat progress while a foe still has HP.`,
            [`enemy:${enemy.id}`, `maneuver:${maneuver.id}`],
          ),
        );
      }
    }
    if (!roomIds.has(enemy.room))
      findings.push(
        err(
          "ENEMY_ROOM_MISSING",
          `enemy "${enemy.id}" stands in room "${enemy.room}" that does not exist.`,
          [`enemy:${enemy.id}`],
        ),
      );
    const ending = endings.get(enemy.death_ending);
    if (!ending)
      findings.push(
        err(
          "ENEMY_DEATH_ENDING_UNDECLARED",
          `enemy "${enemy.id}" death_ending "${enemy.death_ending}" is not a declared ending.`,
          [`enemy:${enemy.id}`],
        ),
      );
    else if (!ending.death)
      findings.push(
        err(
          "ENEMY_DEATH_NOT_DEATH",
          `enemy "${enemy.id}" death_ending "${enemy.death_ending}" is not flagged as a death ending.`,
          [`enemy:${enemy.id}`],
        ),
      );

    // Winnability is proved on the LUCKIEST rolls for the player: max player damage
    // (d6 = 6, with best reachable attack) ends the fight in the FEWEST rounds, and
    // min enemy damage (d6 = 1, against best reachable defense) is the LEAST the
    // player can take per surviving round — so `minDamageTaken` is the smallest total
    // damage any run could inflict. The player attacks first each round, so the enemy
    // retaliates only on the rounds it survives (roundsToKill - 1). If even that
    // best-case total would drop the player, NO sequence of rolls can win → the fight
    // is truly impossible (an ERROR). A fight winnable here but lethal on WORSE rolls
    // is a permitted gamble, deliberately NOT flagged (see the file docstring).
    const standardBestRoute = bestStandardCombatRoute(playerAtk, playerDef, enemy);
    const resultOwnershipValid = maneuvers.every((maneuver) => {
      const owners = maneuverResultFlagOwners.get(maneuver.result_flag) ?? [];
      return (
        owners.length === 1 &&
        !authoredSetFlags.has(maneuver.result_flag) &&
        !flagMayBeInitializedAtOpening(pack, maneuver.result_flag) &&
        !clearedFlags.has(maneuver.result_flag) &&
        !defeatFlagOwners.has(maneuver.result_flag)
      );
    });
    const defeatOwners =
      enemy.defeat_flag === undefined ? [] : (defeatFlagOwners.get(enemy.defeat_flag) ?? []);
    const dedicatedDefeatFlag =
      enemy.defeat_flag !== undefined &&
      defeatOwners.length === 1 &&
      defeatOwners[0] === enemy.id &&
      !authoredSetFlags.has(enemy.defeat_flag) &&
      !flagMayBeInitializedAtOpening(pack, enemy.defeat_flag) &&
      !maneuverResultFlagOwners.has(enemy.defeat_flag);
    const encounterAnalysis = hasSequence
      ? null
      : analyzeManeuverEncounter(
          pack,
          enemy,
          maneuvers,
          clearedFlags,
          removedItems,
          resultOwnershipValid,
          dedicatedDefeatFlag,
        );
    const possibleManeuvers = [
      ...(encounterAnalysis?.possibleManeuvers ?? new Set<EnemyManeuver>()),
    ];
    const maneuverOpeningForced =
      encounterAnalysis !== null &&
      resultOwnershipValid &&
      (possibleManeuvers.some((maneuver) =>
        maneuverGuaranteedAtEnemy(maneuver, pack, enemy, clearedFlags, removedItems),
      ) ||
        encounterAnalysis.collectivelyCovers);
    const sequenceAnalysis = hasSequence
      ? analyzeManeuverSequences(
          pack,
          enemy,
          maneuvers,
          playerAtk,
          playerDef,
          clearedFlags,
          removedItems,
          resultOwnershipValid,
          dedicatedDefeatFlag,
        )
      : null;
    if (sequenceAnalysis?.analyzed === false && sequenceAnalysis.reason === "limit") {
      findings.push(
        err(
          "MANEUVER_SEQUENCE_ANALYSIS_LIMIT",
          `enemy "${enemy.id}" exceeds the bounded maneuver-sequence proof (${MAX_MANEUVER_COVERAGE_ATOMS} free condition atoms or ${MAX_MANEUVER_SEQUENCE_ROUTES} declared routes); combat safety cannot be certified.`,
          [`enemy:${enemy.id}`],
        ),
      );
    }
    if (sequenceAnalysis?.analyzed === false && sequenceAnalysis.reason === "no_encounter") {
      findings.push(
        err(
          "MANEUVER_SEQUENCE_ENCOUNTER_UNPROVEN",
          `enemy "${enemy.id}" has no assignment satisfying the bounded encounter facts and its active-state conditions, so its maneuver sequence cannot be certified.`,
          [`enemy:${enemy.id}`],
        ),
      );
    }

    let bestRoute: SequencedCombatRoute;
    if (sequenceAnalysis?.analyzed === true) {
      bestRoute = sequenceAnalysis.bestRoute;
    } else {
      const bestRoutes: SequencedCombatRoute[] = (hasSequence ? maneuvers : possibleManeuvers).map(
        (maneuver) => bestManeuverCombatRoute(playerAtk, playerDef, enemy, maneuver),
      );
      if (hasSequence || !maneuverOpeningForced) bestRoutes.unshift(standardBestRoute);
      bestRoute =
        bestRoutes.reduce<SequencedCombatRoute | undefined>(
          (best, route) =>
            best === undefined || route.damageTaken < best.damageTaken ? route : best,
          undefined,
        ) ?? standardBestRoute;
    }
    if (bestRoute.damageTaken >= playerHp) {
      if (maneuvers.length === 0 || bestRoute.maneuverId === null) {
        // Preserve the established no-maneuver/standard-route diagnostic byte-for-byte.
        findings.push(
          err(
            "COMBAT_UNWINNABLE",
            `enemy "${enemy.id}" cannot be beaten even with best-case rolls and the player's best reachable stats (needs ${bestRoute.roundsToKill} rounds; would take ≥${bestRoute.damageTaken} damage vs ${playerHp} reachable HP).`,
            [`enemy:${enemy.id}`],
          ),
        );
      } else if ((bestRoute.maneuverPath?.length ?? 0) > 1) {
        const path = bestRoute.maneuverPath!;
        findings.push(
          err(
            "COMBAT_UNWINNABLE",
            `enemy "${enemy.id}" cannot be beaten even with best-case rolls and the player's best reachable stats after its least damaging available maneuver sequence, ${path.map((id) => `"${id}"`).join(" -> ")} (needs ${bestRoute.roundsToKill} rounds; would take ≥${bestRoute.damageTaken} damage vs ${playerHp} reachable HP).`,
            [`enemy:${enemy.id}`, ...path.map((id) => `maneuver:${id}`)],
          ),
        );
      } else {
        findings.push(
          err(
            "COMBAT_UNWINNABLE",
            `enemy "${enemy.id}" cannot be beaten even with best-case rolls and the player's best reachable stats after its least damaging available opening, maneuver "${bestRoute.maneuverId}" (needs ${bestRoute.roundsToKill} rounds; would take ≥${bestRoute.damageTaken} damage vs ${playerHp} reachable HP).`,
            [`enemy:${enemy.id}`, `maneuver:${bestRoute.maneuverId}`],
          ),
        );
      }
    }

    // Opt-in fairness guarantee (bug_0114). The check above is a LOWER bound that
    // permits a luck-dependent gamble; a pack that PROMISES fair fights declares
    // `meta.combat_guaranteed: true` and must also clear the UPPER bound — best
    // reachable stats but the player's UNLUCKIEST rolls (player min damage d6=1,
    // enemy max damage d6=6). This is the exact mirror of the best-case math, rolls
    // flipped: min player damage MAXIMISES rounds-to-kill, so the enemy retaliates
    // the MOST times (worstRoundsToKill - 1, the player still striking first), each
    // for the MOST it can deal — the true maximum total damage any roll sequence can
    // inflict. If that still drops a best-prepared player, the fight is a gamble and
    // the promise is false (ERROR). When it does NOT, the player survives on EVERY
    // possible sequence, so the guarantee is sound.
    if (pack.meta.combat_guaranteed) {
      const standardRoute = worstStandardCombatRoute(playerAtk, playerDef, enemy);
      let worstRoute: SequencedCombatRoute;
      if (sequenceAnalysis?.analyzed === true) {
        worstRoute = sequenceAnalysis.worstRoute;
      } else {
        const worstRoutes: SequencedCombatRoute[] = (
          hasSequence ? maneuvers : possibleManeuvers
        ).map((maneuver) => worstManeuverCombatRoute(playerAtk, playerDef, enemy, maneuver));
        if (hasSequence || !maneuverOpeningForced) worstRoutes.unshift(standardRoute);
        worstRoute =
          worstRoutes.reduce<SequencedCombatRoute | undefined>(
            (worst, route) =>
              worst === undefined || route.damageTaken > worst.damageTaken ? route : worst,
            undefined,
          ) ?? standardRoute;
      }
      cumulativeWorstDamage += worstRoute.damageTaken;
      if (worstRoute.damageTaken >= guaranteedHp) {
        if (worstRoute.maneuverId === null) {
          // Preserve the established no-maneuver diagnostic byte-for-byte.
          findings.push(
            err(
              "COMBAT_NOT_GUARANTEED",
              `meta.combat_guaranteed is set, but enemy "${enemy.id}" can still fell a best-prepared player on worst-case rolls (needs ${standardRoute.roundsToKill} rounds; would take up to ${standardRoute.damageTaken} damage vs ${guaranteedHpPhrase}). Make the fight winnable on every roll, or drop the guarantee and let it stand as a declared gamble.`,
              [`enemy:${enemy.id}`],
            ),
          );
        } else if ((worstRoute.maneuverPath?.length ?? 0) > 1) {
          const path = worstRoute.maneuverPath!;
          findings.push(
            err(
              "COMBAT_NOT_GUARANTEED",
              `meta.combat_guaranteed is set, but enemy "${enemy.id}" can still fell a best-prepared player after maneuver sequence ${path.map((id) => `"${id}"`).join(" -> ")} on worst-case rolls (needs ${worstRoute.roundsToKill} rounds; would take up to ${worstRoute.damageTaken} damage vs ${guaranteedHpPhrase}). Make every forced maneuver sequence safe on every roll, or drop the guarantee and let it stand as a declared gamble.`,
              [`enemy:${enemy.id}`, ...path.map((id) => `maneuver:${id}`)],
            ),
          );
        } else {
          findings.push(
            err(
              "COMBAT_NOT_GUARANTEED",
              `meta.combat_guaranteed is set, but enemy "${enemy.id}" can still fell a best-prepared player after opening with maneuver "${worstRoute.maneuverId}" on worst-case rolls (needs ${worstRoute.roundsToKill} rounds; would take up to ${worstRoute.damageTaken} damage vs ${guaranteedHpPhrase}). Make every forced maneuver opening safe on every roll, or drop the guarantee and let it stand as a declared gamble.`,
              [`enemy:${enemy.id}`, `maneuver:${worstRoute.maneuverId}`],
            ),
          );
        }
      }
    }
  }

  // Cumulative-HP-aware gauntlet guarantee (bug_0172). The per-fight upper bound
  // above proves each fight survivable against the player's FULL reachable HP, but
  // never threads HP across SEQUENTIAL fights — so two fights that each clear the
  // bound alone can still jointly fell a best-prepared player on worst cumulative
  // rolls. When a pack PROMISES fair fights (`meta.combat_guaranteed`), that safety
  // promise must hold across the WHOLE gauntlet, not just each fight in isolation.
  //
  // The sum of every enemy's worst-case `maxDamageTaken` is an order-independent
  // OVER-approximation of the worst total damage a player can take: it ignores fight
  // order and treats optional/mutually-exclusive enemies as all-fought. That is the
  // correct-conservative direction for a SAFETY promise — it can only REFUSE an
  // unsafe guarantee, never falsely grant one. It is therefore tied to the UPPER /
  // guarantee bound ONLY. Do NOT move or "tighten" this into the lower
  // COMBAT_UNWINNABLE bound: that bound is a route-EXISTENCE proof (some roll
  // sequence wins), and summing it would forbid a legitimate gamble gauntlet a lucky
  // player CAN clear — i.e. it would be UNSOUND. Keep it post-loop and upper-only.
  if (pack.meta.combat_guaranteed && cumulativeWorstDamage >= guaranteedHp) {
    findings.push(
      err(
        "COMBAT_GAUNTLET_NOT_GUARANTEED",
        `meta.combat_guaranteed is set, but the fights are not jointly survivable: across the gauntlet the player can take up to ${cumulativeWorstDamage} cumulative damage on worst-case rolls vs ${guaranteedHpPhrase}, so a best-prepared player can fall over the sequence even though each fight passes alone. Make the gauntlet survivable on every roll, or drop the guarantee and let it stand as a declared gamble.`,
        ["meta:combat_guaranteed"],
      ),
    );
  }

  // ── Skill checks ─────────────────────────────────────────────────────────────
  // Best reachable value of a skill uses the same statCeiling as combat above.
  for (const o of pack.objects) {
    for (const it of o.interactions) {
      const sc = it.skill_check;
      if (!sc) continue;
      if (sc.difficulty > 20 + statCeiling(sc.skill)) {
        findings.push(
          err(
            "SKILL_CHECK_IMPOSSIBLE",
            `skill check on "${o.id}" needs ${sc.difficulty} but d20 + best "${sc.skill}" tops out at ${20 + statCeiling(sc.skill)}.`,
            [`object:${o.id}`],
          ),
        );
      }
    }
  }

  // ── end_game targets inside RPG-only combat branches must be declared ─────────
  for (const e of enemyEffects) {
    if ("end_game" in e && !endings.has(e.end_game)) {
      findings.push(
        err(
          "END_GAME_UNDECLARED",
          `an RPG effect (on_defeat/skill check) targets undeclared ending "${e.end_game}".`,
          [`ending:${e.end_game}`],
        ),
      );
    }
  }

  return makeReport(pack.meta.id, findings);
}

function allAuthoredEffects(pack: RpgPack): Effect[] {
  const out: Effect[] = [];
  for (const r of pack.rooms) out.push(...r.on_enter);
  for (const o of pack.objects) {
    // An object carries effects in three slots, not one: UNLOCK fires
    // unlock_effects and the first pickup fires take_effects (legal_actions.ts,
    // bug_0077/bug_0107), both outside interactions[]. Omitting them
    // UNDER-counts writes, and every consumer of this set treats a missing
    // write as evidence of absence — so the omission reads as a false positive
    // rather than a missed finding. rpg_foundation_validator.ts's equivalent
    // walk already learned this (bug_0077).
    if (o.unlock_effects) out.push(...o.unlock_effects);
    if (o.take_effects) out.push(...o.take_effects);
    for (const it of o.interactions) out.push(...it.effects);
  }
  for (const n of pack.npcs) for (const node of n.dialogue.nodes) out.push(...node.effects);
  return out;
}
