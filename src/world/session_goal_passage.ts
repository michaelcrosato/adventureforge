import type { JourneyGoalPassagePresentation } from "./journey_contract.js";
import type { OverworldSessionRoutePlan } from "./session_routes.js";
import type { TravelLogEntry } from "./session_snapshot.js";
import type { OverworldTravelLegResult } from "./travel_mechanics.js";

export type OverworldGoalPassageStopReason = "objective" | "road_encounter" | "resource_boundary";

export type OverworldGoalPassageResult = {
  goalId: string;
  destination: string;
  stoppedAt: string;
  stopReason: OverworldGoalPassageStopReason;
  legs: readonly TravelLogEntry[];
  baseMinutes: number;
  delayMinutes: number;
  minutes: number;
  suppliesUsed: number;
  suppliesAfter: number;
  fatigueGained: number;
  fatigueAfter: number;
  travelConditionAfter: string;
};

type GoalPassageJourneyAction = Readonly<{
  goalId: string;
  edgeIds: readonly string[];
}>;

const GOAL_PASSAGE_VIA_MARKER = ":via:";

export function goalPassageJourneyActionId(goalId: string, edgeIds: readonly string[]): string {
  if (goalId.length === 0) throw new Error("Goal passage requires a current goal id.");
  if (
    edgeIds.length === 0 ||
    edgeIds.some((edgeId) => edgeId.length === 0 || edgeId.includes(","))
  ) {
    throw new Error("Goal passage journey proof requires every traversed road id.");
  }
  return `follow_current_goal:${goalId}${GOAL_PASSAGE_VIA_MARKER}${edgeIds.join(",")}`;
}

export function parseGoalPassageJourneyActionId(actionId: string): GoalPassageJourneyAction | null {
  const prefix = "follow_current_goal:";
  if (!actionId.startsWith(prefix)) return null;
  const payload = actionId.slice(prefix.length);
  const markerIndex = payload.indexOf(GOAL_PASSAGE_VIA_MARKER);
  if (markerIndex <= 0) {
    throw new Error(`Unreplayable legacy goal-passage journey action "${actionId}".`);
  }
  const goalId = payload.slice(0, markerIndex);
  const edgeIds = payload.slice(markerIndex + GOAL_PASSAGE_VIA_MARKER.length).split(",");
  if (edgeIds.length === 0 || edgeIds.some((edgeId) => edgeId.length === 0)) {
    throw new Error(`Malformed goal-passage journey action "${actionId}".`);
  }
  return { goalId, edgeIds };
}

export function buildJourneyGoalPassagePresentation(
  route: OverworldSessionRoutePlan,
): JourneyGoalPassagePresentation {
  if (route.steps.length === 0) {
    throw new Error("A goal passage requires at least one road.");
  }
  const destination = route.destination.name;
  const roadUnit = route.steps.length === 1 ? "road" : "roads";
  return {
    id: "follow_current_goal",
    label: `Follow the ${roadUnit} to ${destination}`,
    destination,
    roadCount: route.steps.length,
    baseMinutes: route.estimate.baseMinutes,
    estimatedMinutes: route.estimate.elapsedMinutes,
    suppliesNeeded: route.estimate.suppliesNeeded,
    supplyDeficit: route.estimate.supplyDeficit,
    suppliesAfter: route.estimate.suppliesAfter,
    fatigueAfter: route.estimate.fatigueAfter,
    travelConditionAfter: route.estimate.travelConditionAfter,
    consequence: `Travel toward ${destination}. Each road still uses its shown time and supplies, adds fatigue, reveals places, and may trigger an encounter.`,
    stopRule:
      "You always take the first road. After that, travel stops at the goal, at a road encounter, or before a road that would cause a new supply shortage or worse fatigue delay.",
  };
}

/** The four starting-fatigue bands used by travelDelayMinutes. */
export function overworldTravelDelayTier(fatigue: number): 0 | 1 | 2 | 3 {
  if (fatigue >= 80) return 3;
  if (fatigue >= 50) return 2;
  if (fatigue >= 25) return 1;
  return 0;
}

/**
 * The first road is the condition the player explicitly accepts. Thereafter a
 * passage pauses before a road that would newly run short of supplies or would
 * begin in a worse fatigue-delay band than the selection began in. Starting
 * undersupplied explicitly accepts that existing condition.
 */
export function goalPassageHitsResourceBoundary(args: {
  traversedRoadCount: number;
  selectionDelayTier: 0 | 1 | 2 | 3;
  selectionSupplies: number;
  currentFatigue: number;
  preview: OverworldTravelLegResult;
}): boolean {
  if (args.traversedRoadCount === 0) return false;
  return (
    (args.selectionSupplies > 0 && args.preview.supplyDeficit > 0) ||
    overworldTravelDelayTier(args.currentFatigue) > args.selectionDelayTier
  );
}
