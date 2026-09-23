import {
  sortedNumberMap,
  sortedStringMap,
  sortedStringSet,
  sortedStringSetMap,
} from "./session_collections.js";
import {
  cloneCampaignCharacterState,
  type CampaignCharacterState,
} from "./campaign_character_state.js";
import { cloneJourneyContractSnapshot, type JourneyContractSnapshot } from "./journey_contract.js";
import {
  OVERWORLD_SESSION_SAVE_VERSION,
  OverworldSessionSnapshotSchema,
  cloneOpeningLeadSourceDecisionTrail,
  cloneQuestCharacterDeathBoundary,
  cloneJournalEntries,
  type OverworldOpeningLeadSourceDecisionTrail,
  type OverworldQuestCharacterDeathBoundary,
  snapshotTravelLogEntries,
  type OverworldJournalEntry,
  type OverworldPendingRoadEncounter,
  type OverworldSessionSnapshot,
  type TravelLogEntry,
} from "./session_snapshot.js";

type OverworldSessionSnapshotBuildState = {
  worldId: string;
  worldHash: string;
  character: CampaignCharacterState;
  currentId: string;
  currentAreaId: string | null;
  minutes: number;
  supplies: number;
  fatigue: number;
  discoveredIds: ReadonlySet<string>;
  visitedIds: ReadonlySet<string>;
  currentAreaByTown: ReadonlyMap<string, string>;
  travelLog: readonly TravelLogEntry[];
  journalEntries: readonly OverworldJournalEntry[];
  resolvedEventIds: ReadonlySet<string>;
  discoveredAreaIds: ReadonlySet<string>;
  visitedAreaIds: ReadonlySet<string>;
  discoveredJobIds: ReadonlySet<string>;
  completedJobIds: ReadonlySet<string>;
  discoveredSiteIds: ReadonlySet<string>;
  discoveredQuestIds: ReadonlySet<string>;
  startedQuestIds: ReadonlySet<string>;
  completedQuestIds: ReadonlySet<string>;
  questOutcomes: ReadonlyMap<string, string>;
  exploredSiteIds: ReadonlySet<string>;
  regionRenown: ReadonlyMap<string, number>;
  completedRegionalArcIds: ReadonlySet<string>;
  pendingRoadEncounter: OverworldPendingRoadEncounter | null;
  openingLeadSourceDecisionTrail: OverworldOpeningLeadSourceDecisionTrail | null;
  questCharacterDeathBoundary?: OverworldQuestCharacterDeathBoundary | null;
  inspectedStoryReveals: ReadonlyMap<string, ReadonlySet<string>>;
  stationDispatchSupportReveals: ReadonlyMap<string, string>;
  journey: JourneyContractSnapshot;
};

export function buildOverworldSessionSnapshot(
  state: OverworldSessionSnapshotBuildState,
): OverworldSessionSnapshot {
  return OverworldSessionSnapshotSchema.parse({
    version: OVERWORLD_SESSION_SAVE_VERSION,
    worldId: state.worldId,
    worldHash: state.worldHash,
    character: cloneCampaignCharacterState(state.character),
    currentId: state.currentId,
    currentAreaId: state.currentAreaId,
    minutes: state.minutes,
    supplies: state.supplies,
    fatigue: state.fatigue,
    discoveredIds: sortedStringSet(state.discoveredIds),
    visitedIds: sortedStringSet(state.visitedIds),
    currentAreaByTown: sortedStringMap(state.currentAreaByTown),
    travelLog: snapshotTravelLogEntries(state.travelLog),
    journalEntries: cloneJournalEntries(state.journalEntries),
    resolvedEventIds: sortedStringSet(state.resolvedEventIds),
    discoveredAreaIds: sortedStringSet(state.discoveredAreaIds),
    visitedAreaIds: sortedStringSet(state.visitedAreaIds),
    discoveredJobIds: sortedStringSet(state.discoveredJobIds),
    completedJobIds: sortedStringSet(state.completedJobIds),
    discoveredSiteIds: sortedStringSet(state.discoveredSiteIds),
    discoveredQuestIds: sortedStringSet(state.discoveredQuestIds),
    startedQuestIds: sortedStringSet(state.startedQuestIds),
    completedQuestIds: sortedStringSet(state.completedQuestIds),
    questOutcomes: sortedStringMap(state.questOutcomes),
    exploredSiteIds: sortedStringSet(state.exploredSiteIds),
    regionRenown: sortedNumberMap(state.regionRenown),
    completedRegionalArcIds: sortedStringSet(state.completedRegionalArcIds),
    pendingRoadEncounter: state.pendingRoadEncounter
      ? { edgeId: state.pendingRoadEncounter.edgeId }
      : null,
    ...(state.openingLeadSourceDecisionTrail
      ? {
          openingLeadSourceDecisionTrail: cloneOpeningLeadSourceDecisionTrail(
            state.openingLeadSourceDecisionTrail,
          ),
        }
      : {}),
    ...(state.questCharacterDeathBoundary
      ? {
          questCharacterDeathBoundary: cloneQuestCharacterDeathBoundary(
            state.questCharacterDeathBoundary,
          ),
        }
      : {}),
    ...(state.inspectedStoryReveals.size > 0
      ? { inspectedStoryReveals: sortedStringSetMap(state.inspectedStoryReveals) }
      : {}),
    ...(state.stationDispatchSupportReveals.size > 0
      ? { stationDispatchSupportReveals: sortedStringMap(state.stationDispatchSupportReveals) }
      : {}),
    journey: cloneJourneyContractSnapshot(state.journey),
  });
}
