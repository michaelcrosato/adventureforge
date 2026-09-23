import type { OverworldEdge, OverworldNode, OverworldRoadEvent } from "./overworld.js";
import { addOverworldJournalEntry } from "./session_journal_store.js";
import { timeLabel } from "./session_journal_codec.js";
import type {
  OverworldJournalEntry,
  OverworldPendingRoadEncounter,
  OverworldPendingRoadEncounterSnapshot,
  TravelLogEntrySnapshot,
} from "./session_snapshot.js";
import {
  assertSnapshotPendingRoadEncounterBinding,
  assertSnapshotPendingRoadEncounterUnresolved,
} from "./session_snapshot_proofs.js";
import {
  OVERWORLD_MAX_FATIGUE as MAX_FATIGUE,
  roadEncounterOptionsFor,
  type OverworldRoadEncounterStrategy,
} from "./travel_mechanics.js";

export type OverworldRoadEncounterResult = {
  strategy: OverworldRoadEncounterStrategy;
  minutes: number;
  suppliesUsed: number;
  fatigueGained: number;
  renownGained: number;
  encounter: OverworldPendingRoadEncounter;
  entry: OverworldJournalEntry;
};

type OverworldRoadEncounterResourceState = {
  supplies: number;
  fatigue: number;
  minutes: number;
  townName: string;
};

export type OverworldRoadEncounterResolution = {
  result: OverworldRoadEncounterResult;
  suppliesAfter: number;
  fatigueAfter: number;
  minutesAfter: number;
};

type OverworldRoadEncounterApplicationState = OverworldRoadEncounterResourceState & {
  region: string;
  regionRenown: Map<string, number>;
  journalEntries: OverworldJournalEntry[];
  journalEntriesById: Map<string, OverworldJournalEntry>;
};

export type OverworldAppliedRoadEncounter = OverworldRoadEncounterResolution & {
  pendingRoadEncounterAfter: null;
  regionRenownAfter: number;
};

type OverworldPendingRoadEncounterRestoreIndex = {
  activeGoalId: string;
  completedQuestIds: ReadonlySet<string>;
  currentId: string;
  edgeIds: ReadonlySet<string>;
  edgesById: ReadonlyMap<string, OverworldEdge>;
  latestTravel: TravelLogEntrySnapshot | null;
  minutes: number;
  nodesById: ReadonlyMap<string, OverworldNode>;
  roadEventsByEdgeId: ReadonlyMap<string, OverworldRoadEvent>;
  roadJournal: { byKey: ReadonlyMap<string, unknown> };
};

export function buildOverworldPendingRoadEncounter(
  from: OverworldNode,
  to: OverworldNode,
  edge: OverworldEdge,
  roadEvent: OverworldRoadEvent,
  arrivedAtMinutes: number,
): OverworldPendingRoadEncounter {
  if (roadEvent.requires_choice !== true) {
    throw new Error(`Road event "${roadEvent.id}" is ambient and cannot become an encounter.`);
  }
  const arrivedAt = timeLabel(arrivedAtMinutes);
  return {
    id: `road:${edge.id}:${arrivedAtMinutes}`,
    edgeId: edge.id,
    from: from.name,
    to: to.name,
    route: edge.route,
    arrivedAt,
    timing: `Road encounter from ${from.name} to ${to.name} at ${arrivedAt}. Resolve it before taking actions in ${to.name}.`,
    event: roadEvent,
    options: roadEncounterOptionsFor(roadEvent),
  };
}

export function restoreOverworldPendingRoadEncounter(
  pendingRoadEncounter: OverworldPendingRoadEncounterSnapshot | null,
  indexes: OverworldPendingRoadEncounterRestoreIndex,
): OverworldPendingRoadEncounter | null {
  if (!pendingRoadEncounter) return null;

  const pendingEdge = indexes.edgesById.get(pendingRoadEncounter.edgeId);
  if (!pendingEdge) {
    throw new Error(
      `Overworld session snapshot has unknown pending road "${pendingRoadEncounter.edgeId}".`,
    );
  }
  if (pendingEdge.from !== indexes.currentId && pendingEdge.to !== indexes.currentId) {
    throw new Error("Overworld session snapshot pending road is not at the current town.");
  }

  const manifestEvent = indexes.roadEventsByEdgeId.get(pendingRoadEncounter.edgeId);
  if (!manifestEvent) {
    throw new Error(
      `Overworld session snapshot has no road event for "${pendingRoadEncounter.edgeId}".`,
    );
  }
  if (manifestEvent.requires_choice !== true) {
    throw new Error(
      `Overworld session snapshot pending road "${pendingRoadEncounter.edgeId}" is an ambient report, not a choice.`,
    );
  }
  if (
    manifestEvent.active_goal_ids !== undefined &&
    !manifestEvent.active_goal_ids.includes(indexes.activeGoalId)
  ) {
    throw new Error(
      `Overworld session snapshot pending road "${pendingRoadEncounter.edgeId}" is not active for the current goal.`,
    );
  }
  if (
    manifestEvent.retire_after_quest !== undefined &&
    indexes.completedQuestIds.has(manifestEvent.retire_after_quest)
  ) {
    throw new Error(
      `Overworld session snapshot pending road "${pendingRoadEncounter.edgeId}" is retired by a completed quest.`,
    );
  }
  if (indexes.latestTravel?.roadEventId === null) {
    throw new Error(
      `Overworld session snapshot pending road encounter "${pendingRoadEncounter.edgeId}" did not fire on the latest travel log.`,
    );
  }
  if (
    indexes.latestTravel?.roadEventId !== undefined &&
    indexes.latestTravel.roadEventId !== manifestEvent.id
  ) {
    throw new Error(
      `Overworld session snapshot pending road encounter "${pendingRoadEncounter.edgeId}" does not match latest travel road event "${indexes.latestTravel.roadEventId}".`,
    );
  }

  assertSnapshotPendingRoadEncounterBinding(
    pendingRoadEncounter,
    indexes.latestTravel,
    indexes.edgeIds,
  );
  assertSnapshotPendingRoadEncounterUnresolved(
    pendingRoadEncounter,
    indexes.latestTravel,
    indexes.roadJournal,
  );

  const fromId = pendingEdge.from === indexes.currentId ? pendingEdge.to : pendingEdge.from;
  const from = indexes.nodesById.get(fromId);
  const to = indexes.nodesById.get(indexes.currentId);
  if (!from || !to) {
    throw new Error("Overworld session snapshot pending road references an unknown town.");
  }

  return buildOverworldPendingRoadEncounter(from, to, pendingEdge, manifestEvent, indexes.minutes);
}

export function resolveOverworldRoadEncounter(
  encounter: OverworldPendingRoadEncounter,
  strategy: OverworldRoadEncounterStrategy,
  state: OverworldRoadEncounterResourceState,
): OverworldRoadEncounterResolution {
  const option = encounter.options.find((candidate) => candidate.strategy === strategy);
  if (!option) throw new Error(`Unknown road encounter strategy "${strategy}".`);
  if (option.outcome === undefined) {
    throw new Error("Road encounter resolution requires the live encounter's outcome prose.");
  }

  const suppliesUsed = Math.min(state.supplies, option.suppliesCost);
  const supplyDeficit = option.suppliesCost - suppliesUsed;
  const fatigueGained = option.fatigueGained + supplyDeficit * 3;
  const suppliesAfter = state.supplies - suppliesUsed;
  const fatigueAfter = Math.min(MAX_FATIGUE, state.fatigue + fatigueGained);
  const minutesAfter = state.minutes + option.minutes;
  const entry: OverworldJournalEntry = {
    id: `${encounter.id}:${strategy}`,
    kind: "road",
    town: state.townName,
    title: `${option.label}: ${encounter.event.title}`,
    text: `${encounter.timing} ${encounter.event.summary} ${option.outcome} You arrive in ${encounter.to}.${supplyDeficit > 0 ? ` Supply shortage: +${String(supplyDeficit * 3)} fatigue.` : ""}`,
    recordedAt: timeLabel(minutesAfter),
  };

  return {
    result: {
      strategy,
      minutes: option.minutes,
      suppliesUsed,
      fatigueGained,
      renownGained: option.renownGained,
      encounter,
      entry,
    },
    suppliesAfter,
    fatigueAfter,
    minutesAfter,
  };
}

export function applyOverworldRoadEncounter(
  encounter: OverworldPendingRoadEncounter,
  strategy: OverworldRoadEncounterStrategy,
  state: OverworldRoadEncounterApplicationState,
): OverworldAppliedRoadEncounter {
  const resolution = resolveOverworldRoadEncounter(encounter, strategy, state);
  if (resolution.result.renownGained > 0) {
    state.regionRenown.set(
      state.region,
      (state.regionRenown.get(state.region) ?? 0) + resolution.result.renownGained,
    );
  }
  addOverworldJournalEntry(state.journalEntries, state.journalEntriesById, resolution.result.entry);

  return {
    ...resolution,
    pendingRoadEncounterAfter: null,
    regionRenownAfter: state.regionRenown.get(state.region) ?? 0,
  };
}
