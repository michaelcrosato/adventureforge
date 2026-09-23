import type { OverworldExit, OverworldNode, OverworldRoadEvent } from "./overworld.js";
import {
  applyOverworldRoadEncounter,
  type OverworldAppliedRoadEncounter,
} from "./session_road_encounters.js";
import {
  applyOverworldSessionTownVisit,
  type MutableOverworldSessionTownVisitState,
} from "./session_local_lifecycle.js";
import type { OverworldJournalEntry, OverworldPendingRoadEncounter } from "./session_snapshot.js";
import {
  applyOverworldTravelLeg,
  recordOverworldTravelLeg,
  type OverworldRecordedTravelLeg,
} from "./session_travel_log.js";
import type { OverworldRoadEncounterStrategy } from "./travel_mechanics.js";

type OverworldSessionRoadEncounterState = {
  pendingRoadEncounter: OverworldPendingRoadEncounter | null;
  current: OverworldNode;
  minutes: number;
  supplies: number;
  fatigue: number;
  regionRenown: Map<string, number>;
  journalEntries: OverworldJournalEntry[];
  journalEntriesById: Map<string, OverworldJournalEntry>;
};

type OverworldSessionRoadTravelState = {
  activeGoalId: string;
  completedQuestIds: ReadonlySet<string>;
  pendingRoadEncounter: OverworldPendingRoadEncounter | null;
  current: OverworldNode;
  currentId: string;
  roadExitsByTownAndId: ReadonlyMap<string, ReadonlyMap<string, OverworldExit>>;
  roadEventsByEdgeId: ReadonlyMap<string, OverworldRoadEvent>;
  minutes: number;
  supplies: number;
  fatigue: number;
  travelLog: OverworldRecordedTravelLeg["entry"][];
};

type OverworldSessionRoadTravelArrivalState = OverworldSessionRoadTravelState &
  Omit<MutableOverworldSessionTownVisitState, "nodeId">;

type OverworldRecordedRoadTravelArrival = OverworldRecordedTravelLeg & {
  currentAreaIdAfter: string | null;
  stateChanged: true;
};

function suppressImmediateRepeatRoadEvent(
  edgeId: string,
  travelLog: readonly OverworldRecordedTravelLeg["entry"][],
): boolean {
  return travelLog[0]?.edgeId === edgeId;
}

/**
 * Select the road scene that is true for this journey now. Generic reports are
 * ambient and may recur after the player has travelled elsewhere. Authored
 * choices are one-shot, while goal-bound scenes exist only during that goal and
 * disappear once their linked quest is complete.
 */
export function roadEventForOverworldSessionTravel(
  manifestRoadEvent: OverworldRoadEvent | null,
  state: {
    activeGoalId: string;
    completedQuestIds: ReadonlySet<string>;
    travelLog: readonly OverworldRecordedTravelLeg["entry"][];
  },
): OverworldRoadEvent | null {
  if (!manifestRoadEvent) return null;
  if (
    manifestRoadEvent.retire_after_quest !== undefined &&
    state.completedQuestIds.has(manifestRoadEvent.retire_after_quest)
  ) {
    return null;
  }
  if (
    manifestRoadEvent.active_goal_ids !== undefined &&
    !manifestRoadEvent.active_goal_ids.includes(state.activeGoalId)
  ) {
    return null;
  }
  if (
    manifestRoadEvent.requires_choice === true &&
    state.travelLog.some((entry) => entry.roadEvent?.id === manifestRoadEvent.id)
  ) {
    return null;
  }
  if (suppressImmediateRepeatRoadEvent(manifestRoadEvent.edge, state.travelLog)) return null;
  return manifestRoadEvent;
}

export function applyOverworldSessionRoadEncounter(
  state: OverworldSessionRoadEncounterState,
  strategy: OverworldRoadEncounterStrategy,
): OverworldAppliedRoadEncounter {
  if (!state.pendingRoadEncounter) throw new Error("There is no pending road encounter.");
  return applyOverworldRoadEncounter(state.pendingRoadEncounter, strategy, {
    fatigue: state.fatigue,
    journalEntries: state.journalEntries,
    journalEntriesById: state.journalEntriesById,
    minutes: state.minutes,
    region: state.current.region,
    regionRenown: state.regionRenown,
    supplies: state.supplies,
    townName: state.current.name,
  });
}

function applyOverworldSessionRoadTravel(
  state: OverworldSessionRoadTravelState,
  edgeId: string,
): OverworldRecordedTravelLeg {
  if (state.pendingRoadEncounter) {
    throw new Error("Resolve the pending road encounter before choosing another road.");
  }
  const edge = state.roadExitsByTownAndId.get(state.currentId)?.get(edgeId);
  if (!edge) throw new Error("That road is not reachable from here.");
  const manifestRoadEvent = state.roadEventsByEdgeId.get(edge.id) ?? null;
  const roadEvent = roadEventForOverworldSessionTravel(manifestRoadEvent, state);
  const applied = applyOverworldTravelLeg(state.current, edge.destination, edge, roadEvent, {
    minutes: state.minutes,
    fatigue: state.fatigue,
    supplies: state.supplies,
  });
  return recordOverworldTravelLeg({ travelLog: state.travelLog }, applied);
}

export function applyOverworldSessionRoadTravelArrival(
  state: OverworldSessionRoadTravelArrivalState,
  edgeId: string,
): OverworldRecordedRoadTravelArrival {
  const recorded = applyOverworldSessionRoadTravel(state, edgeId);
  const arrival = applyOverworldSessionTownVisit({
    nodeId: recorded.currentIdAfter,
    areasByTown: state.areasByTown,
    roadExitsByTown: state.roadExitsByTown,
    currentAreaId: state.currentAreaId,
    currentAreaByTown: state.currentAreaByTown,
    discoveredAreaIds: state.discoveredAreaIds,
    discoveredIds: state.discoveredIds,
    visitedIds: state.visitedIds,
  });
  return {
    ...recorded,
    currentAreaIdAfter: arrival.currentAreaIdAfter,
    stateChanged: true,
  };
}
