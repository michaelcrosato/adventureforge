import type {
  OverworldExit,
  OverworldNode,
  OverworldRoadEvent,
  OverworldRoutePlan,
  OverworldRouteStep,
} from "./overworld.js";
import {
  cloneOverworldEdge,
  cloneOverworldNode,
  redactOverworldRoadEventForPresentation,
} from "./overworld_clone.js";
import {
  resolveOverworldTravelLeg,
  travelCondition,
  type OverworldTravelResourceState,
} from "./travel_mechanics.js";
import { roadEventForOverworldSessionTravel } from "./session_road_travel.js";
import type { TravelLogEntry } from "./session_snapshot.js";
import { compareCaseFoldedCodeUnits } from "./string_order.js";

export type OverworldRouteEstimate = {
  baseMinutes: number;
  delayMinutes: number;
  elapsedMinutes: number;
  suppliesNeeded: number;
  suppliesUsed: number;
  supplyDeficit: number;
  suppliesAfter: number;
  fatigueGained: number;
  fatigueAfter: number;
  travelConditionAfter: string;
};

export type OverworldSessionRoutePlan = OverworldRoutePlan & {
  estimate: OverworldRouteEstimate;
};

export type OverworldRoutePlannerIndex = {
  nodes: ReadonlyMap<string, OverworldNode>;
  roadExitsByTown: ReadonlyMap<string, readonly OverworldExit[]>;
  roadEventsByEdgeId: ReadonlyMap<string, OverworldRoadEvent>;
};

export type OverworldRouteResourceState = OverworldTravelResourceState;

export type OverworldRouteRoadEventState = {
  activeGoalId: string;
  completedQuestIds: ReadonlySet<string>;
  travelLog: readonly TravelLogEntry[];
};

type OverworldDiscoveredRouteOptionsState = {
  routePlannerIndex: OverworldRoutePlannerIndex;
  current: OverworldNode;
  currentId: string;
  discoveredIds: ReadonlySet<string>;
  resources: OverworldRouteResourceState;
  roadEventState?: OverworldRouteRoadEventState;
};

export function withOverworldSessionRoadEvents(
  plan: OverworldRoutePlan,
  state: OverworldRouteRoadEventState,
): OverworldRoutePlan {
  return {
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      roadEvent: roadEventForOverworldSessionTravel(step.roadEvent, state),
    })),
  };
}

export function estimateOverworldRoute(
  plan: OverworldRoutePlan,
  resources: OverworldRouteResourceState,
): OverworldRouteEstimate {
  let supplies = resources.supplies;
  let fatigue = resources.fatigue;
  let baseMinutes = 0;
  let delayMinutes = 0;
  let suppliesNeeded = 0;
  let suppliesUsed = 0;
  let supplyDeficit = 0;
  let fatigueGained = 0;

  for (const step of plan.steps) {
    const stepResult = resolveOverworldTravelLeg(step.edge.travel_minutes, step.roadEvent, {
      fatigue,
      supplies,
    });

    baseMinutes += stepResult.baseMinutes;
    delayMinutes += stepResult.delayMinutes;
    suppliesNeeded += stepResult.suppliesNeeded;
    suppliesUsed += stepResult.suppliesUsed;
    supplyDeficit += stepResult.supplyDeficit;
    fatigueGained += stepResult.fatigueGained;
    supplies = stepResult.suppliesAfter;
    fatigue = stepResult.fatigueAfter;
  }

  return {
    baseMinutes,
    delayMinutes,
    elapsedMinutes: baseMinutes + delayMinutes,
    suppliesNeeded,
    suppliesUsed,
    supplyDeficit,
    suppliesAfter: supplies,
    fatigueGained,
    fatigueAfter: fatigue,
    travelConditionAfter: travelCondition(fatigue, supplies),
  };
}

export function withOverworldRouteEstimate(
  plan: OverworldRoutePlan,
  resources: OverworldRouteResourceState,
): OverworldSessionRoutePlan {
  return {
    ...plan,
    estimate: estimateOverworldRoute(plan, resources),
  };
}

export function indexedOverworldRoute(
  index: OverworldRoutePlannerIndex,
  fromId: string,
  destinationId: string,
  allowedNodeIds?: ReadonlySet<string>,
): OverworldRoutePlan | null {
  const from = index.nodes.get(fromId);
  if (!from) throw new Error(`Unknown overworld route start "${fromId}".`);
  const destination = index.nodes.get(destinationId);
  if (!destination) {
    throw new Error(`Unknown overworld route destination "${destinationId}".`);
  }
  if (allowedNodeIds && (!allowedNodeIds.has(fromId) || !allowedNodeIds.has(destinationId))) {
    return null;
  }
  if (fromId === destinationId) {
    return { from, destination, steps: [], totalDistanceMi: 0, totalMinutes: 0 };
  }

  const distance = new Map<string, number>([[fromId, 0]]);
  const previous = new Map<string, { from: string; edge: OverworldExit }>();
  const unsettled = new Set<string>(allowedNodeIds ?? index.nodes.keys());

  while (unsettled.size > 0) {
    let current: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of unsettled) {
      const candidateDistance = distance.get(candidate) ?? Number.POSITIVE_INFINITY;
      if (candidateDistance < best) {
        current = candidate;
        best = candidateDistance;
      }
    }
    if (current === null || best === Number.POSITIVE_INFINITY) break;
    unsettled.delete(current);
    if (current === destinationId) break;

    for (const edge of index.roadExitsByTown.get(current) ?? []) {
      const next = edge.destination.id;
      if (!unsettled.has(next)) continue;
      const nextDistance = best + edge.travel_minutes;
      if (nextDistance >= (distance.get(next) ?? Number.POSITIVE_INFINITY)) continue;
      distance.set(next, nextDistance);
      previous.set(next, { from: current, edge });
    }
  }

  if (!previous.has(destinationId)) return null;
  const steps: OverworldRouteStep[] = [];
  for (let cursor = destinationId; cursor !== fromId; ) {
    const prev = previous.get(cursor);
    if (!prev) return null;
    const stepFrom = index.nodes.get(prev.from);
    const stepTo = index.nodes.get(cursor);
    if (!stepFrom || !stepTo) return null;
    steps.unshift({
      from: stepFrom,
      to: stepTo,
      edge: prev.edge,
      roadEvent: index.roadEventsByEdgeId.get(prev.edge.id) ?? null,
    });
    cursor = prev.from;
  }

  return {
    from,
    destination,
    steps,
    totalDistanceMi: steps.reduce((sum, step) => sum + step.edge.distance_mi, 0),
    totalMinutes: steps.reduce((sum, step) => sum + step.edge.travel_minutes, 0),
  };
}

export function cloneOverworldRouteOption(
  plan: OverworldSessionRoutePlan,
): OverworldSessionRoutePlan {
  return {
    ...plan,
    from: cloneOverworldNode(plan.from),
    destination: cloneOverworldNode(plan.destination),
    steps: plan.steps.map((step) => ({
      ...step,
      from: cloneOverworldNode(step.from),
      to: cloneOverworldNode(step.to),
      edge: cloneOverworldEdge(step.edge),
      roadEvent: step.roadEvent ? redactOverworldRoadEventForPresentation(step.roadEvent) : null,
    })),
    estimate: { ...plan.estimate },
  };
}

export function buildOverworldDiscoveredRouteOptions(
  state: OverworldDiscoveredRouteOptionsState,
): OverworldSessionRoutePlan[] {
  const options: OverworldSessionRoutePlan[] = [];
  for (const id of state.discoveredIds) {
    if (id === state.currentId) continue;
    const plan = indexedOverworldRoute(
      state.routePlannerIndex,
      state.currentId,
      id,
      state.discoveredIds,
    );
    if (!plan || plan.steps.length === 0) continue;
    const contextualPlan = state.roadEventState
      ? withOverworldSessionRoadEvents(plan, state.roadEventState)
      : plan;
    options.push(withOverworldRouteEstimate(contextualPlan, state.resources));
  }
  options.sort((left, right) => compareOverworldRouteOptions(left, right, state.current.region));
  return options;
}

function compareOverworldRouteOptions(
  left: OverworldSessionRoutePlan,
  right: OverworldSessionRoutePlan,
  currentRegion: string,
): number {
  return (
    Number(right.destination.region === currentRegion) -
      Number(left.destination.region === currentRegion) ||
    left.estimate.elapsedMinutes - right.estimate.elapsedMinutes ||
    left.totalMinutes - right.totalMinutes ||
    right.destination.population_2025 - left.destination.population_2025 ||
    compareCaseFoldedCodeUnits(left.destination.name, right.destination.name)
  );
}
