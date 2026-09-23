import type { OverworldEdge, OverworldNode, OverworldRoadEvent } from "./overworld.js";
import { buildOverworldPendingRoadEncounter } from "./session_road_encounters.js";
import type {
  OverworldPendingRoadEncounter,
  TravelLogEntry,
  TravelLogEntrySnapshot,
} from "./session_snapshot.js";
import { resolveOverworldTravelLeg } from "./travel_mechanics.js";

type OverworldTravelApplicationState = {
  minutes: number;
  supplies: number;
  fatigue: number;
};

export type OverworldAppliedTravelLeg = {
  entry: TravelLogEntry;
  currentIdAfter: string;
  minutesAfter: number;
  suppliesAfter: number;
  fatigueAfter: number;
  pendingRoadEncounter: OverworldPendingRoadEncounter | null;
};

type OverworldTravelLegRecordingState = {
  travelLog: TravelLogEntry[];
};

export type OverworldRecordedTravelLeg = Omit<OverworldAppliedTravelLeg, "pendingRoadEncounter"> & {
  pendingRoadEncounterAfter: OverworldPendingRoadEncounter | null;
};

type OverworldTravelLogRestoreIndex = {
  edgesById: ReadonlyMap<string, OverworldEdge>;
  nodesById: ReadonlyMap<string, OverworldNode>;
  roadEventsByEdgeId: ReadonlyMap<string, OverworldRoadEvent>;
};

export function roadEventForTravelLogSnapshot(
  entry: TravelLogEntrySnapshot,
  indexes: Pick<OverworldTravelLogRestoreIndex, "roadEventsByEdgeId">,
): OverworldRoadEvent | null {
  const manifestEvent = indexes.roadEventsByEdgeId.get(entry.edgeId) ?? null;
  if (entry.roadEventId === undefined) return manifestEvent;
  if (entry.roadEventId === null) return null;
  if (!manifestEvent || manifestEvent.id !== entry.roadEventId) {
    throw new Error(
      `Overworld session snapshot travel road event "${entry.roadEventId}" does not match the world.`,
    );
  }
  return manifestEvent;
}

export function applyOverworldTravelLeg(
  from: OverworldNode,
  to: OverworldNode,
  edge: OverworldEdge,
  roadEvent: OverworldRoadEvent | null,
  state: OverworldTravelApplicationState,
): OverworldAppliedTravelLeg {
  const travelResult = resolveOverworldTravelLeg(edge.travel_minutes, roadEvent, {
    fatigue: state.fatigue,
    supplies: state.supplies,
  });
  const minutesAfter = state.minutes + travelResult.elapsedMinutes;
  const entry: TravelLogEntry = {
    edgeId: edge.id,
    fromId: from.id,
    toId: to.id,
    from: from.name,
    to: to.name,
    route: edge.route,
    distanceMi: edge.distance_mi,
    baseMinutes: edge.travel_minutes,
    delayMinutes: travelResult.delayMinutes,
    minutes: travelResult.elapsedMinutes,
    arrivedAt: minutesAfter,
    suppliesUsed: travelResult.suppliesUsed,
    suppliesAfter: travelResult.suppliesAfter,
    fatigueGained: travelResult.fatigueGained,
    fatigueAfter: travelResult.fatigueAfter,
    roadEvent,
  };

  return {
    entry,
    currentIdAfter: to.id,
    minutesAfter,
    suppliesAfter: travelResult.suppliesAfter,
    fatigueAfter: travelResult.fatigueAfter,
    pendingRoadEncounter:
      roadEvent?.requires_choice === true
        ? buildOverworldPendingRoadEncounter(from, to, edge, roadEvent, minutesAfter)
        : null,
  };
}

export function recordOverworldTravelLeg(
  state: OverworldTravelLegRecordingState,
  applied: OverworldAppliedTravelLeg,
): OverworldRecordedTravelLeg {
  state.travelLog.unshift(applied.entry);
  return {
    entry: applied.entry,
    currentIdAfter: applied.currentIdAfter,
    minutesAfter: applied.minutesAfter,
    suppliesAfter: applied.suppliesAfter,
    fatigueAfter: applied.fatigueAfter,
    pendingRoadEncounterAfter: applied.pendingRoadEncounter,
  };
}

export function restoreOverworldTravelLogEntry(
  entry: TravelLogEntrySnapshot,
  indexes: OverworldTravelLogRestoreIndex,
): TravelLogEntry {
  const edge = indexes.edgesById.get(entry.edgeId);
  if (!edge) {
    throw new Error(`Overworld session snapshot has unknown travel road "${entry.edgeId}".`);
  }

  const endpointsMatch =
    (edge.from === entry.fromId && edge.to === entry.toId) ||
    (edge.from === entry.toId && edge.to === entry.fromId);
  if (!endpointsMatch) {
    throw new Error("Overworld session snapshot travel road endpoints do not match the world.");
  }
  if (entry.minutes !== edge.travel_minutes + entry.delayMinutes) {
    throw new Error("Overworld session snapshot travel minutes do not match the road.");
  }

  const from = indexes.nodesById.get(entry.fromId);
  const to = indexes.nodesById.get(entry.toId);
  if (!from || !to) {
    throw new Error("Overworld session snapshot travel log references an unknown town.");
  }

  return {
    edgeId: entry.edgeId,
    fromId: entry.fromId,
    toId: entry.toId,
    from: from.name,
    to: to.name,
    route: edge.route,
    distanceMi: edge.distance_mi,
    baseMinutes: edge.travel_minutes,
    delayMinutes: entry.delayMinutes,
    minutes: entry.minutes,
    arrivedAt: entry.arrivedAt,
    suppliesUsed: entry.suppliesUsed,
    suppliesAfter: entry.suppliesAfter,
    fatigueGained: entry.fatigueGained,
    fatigueAfter: entry.fatigueAfter,
    roadEvent: roadEventForTravelLogSnapshot(entry, indexes),
  };
}

export function restoreOverworldTravelLogEntries(
  entries: readonly TravelLogEntrySnapshot[],
  indexes: OverworldTravelLogRestoreIndex,
): TravelLogEntry[] {
  const restored: TravelLogEntry[] = [];
  for (const entry of entries) restored.push(restoreOverworldTravelLogEntry(entry, indexes));
  return restored;
}
