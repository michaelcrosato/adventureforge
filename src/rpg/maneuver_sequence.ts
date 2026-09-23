import type { Condition } from "../core/conditions.js";
import type { Enemy, EnemyManeuver } from "./schema.js";

export type ManeuverPhase = "opening" | "follow_through";

/** Root openings share one cohort; children share the cohort of one parent. */
function maneuverCohort(enemy: Enemy, maneuver: EnemyManeuver): EnemyManeuver[] {
  return (enemy.maneuvers ?? []).filter((candidate) => candidate.after === maneuver.after);
}

export function maneuverParent(enemy: Enemy, maneuver: EnemyManeuver): EnemyManeuver | undefined {
  return maneuver.after === undefined
    ? undefined
    : enemy.maneuvers?.find((candidate) => candidate.id === maneuver.after);
}

export function maneuverChildren(enemy: Enemy, parentId: string): EnemyManeuver[] {
  return (enemy.maneuvers ?? []).filter((maneuver) => maneuver.after === parentId);
}

export function rootManeuvers(enemy: Enemy): EnemyManeuver[] {
  return (enemy.maneuvers ?? []).filter((maneuver) => maneuver.after === undefined);
}

/**
 * Runtime-only gates implied by sequence topology. A missing parent returns
 * null so even an invalid pack fails closed before semantic validation rejects
 * it. Authored conditions are deliberately not included here.
 */
export function maneuverSequenceConditions(
  enemy: Enemy,
  maneuver: EnemyManeuver,
): Condition[] | null {
  const parent = maneuverParent(enemy, maneuver);
  if (maneuver.after !== undefined && parent === undefined) return null;
  return [
    ...(parent === undefined ? [] : [{ has_flag: parent.result_flag } satisfies Condition]),
    ...maneuverCohort(enemy, maneuver).map(
      (candidate): Condition => ({ not_flag: candidate.result_flag }),
    ),
  ];
}

/** Omit phase metadata on every legacy one-beat maneuver. */
export function maneuverPhase(enemy: Enemy, maneuver: EnemyManeuver): ManeuverPhase | undefined {
  if (maneuver.after !== undefined) return "follow_through";
  return maneuverChildren(enemy, maneuver.id).length > 0 ? "opening" : undefined;
}
