import type {
  OverworldArea,
  OverworldAreaExit,
  OverworldCharacter,
  OverworldExplorationSite,
  OverworldLocalEvent,
  OverworldLocalJob,
  OverworldPoi,
  OverworldQuest,
} from "./overworld.js";
import {
  applyOverworldCurrentAreaSelection,
  type OverworldAppliedCurrentAreaSelection,
} from "./session_local_actions.js";
import {
  applyOverworldLocalDiscovery,
  planOverworldLocalDiscovery,
  type OverworldLocalDiscoveryResult,
} from "./session_local_discovery.js";
import {
  buildOverworldSessionLocalView,
  projectOverworldSessionLocalJob,
  type OverworldSessionLocalView,
} from "./session_local_view.js";
import type { CampaignCharacterState } from "./campaign_character_state.js";

export type MutableOverworldSessionLocalState = {
  currentTownId: string;
  currentAreaId: string | null;
  areasById: ReadonlyMap<string, OverworldArea>;
  areasByTown: ReadonlyMap<string, readonly OverworldArea[]>;
  currentAreaByTown: Map<string, string>;
  areaExitsByArea: ReadonlyMap<string, readonly OverworldAreaExit[]>;
  poisByArea: ReadonlyMap<string, readonly OverworldPoi[]>;
  charactersByArea: ReadonlyMap<string, readonly OverworldCharacter[]>;
  eventsByArea: ReadonlyMap<string, readonly OverworldLocalEvent[]>;
  sitesByArea: ReadonlyMap<string, readonly OverworldExplorationSite[]>;
  jobsByTown: ReadonlyMap<string, readonly OverworldLocalJob[]>;
  questsByTown: ReadonlyMap<string, readonly OverworldQuest[]>;
  discoveredAreaIds: Set<string>;
  discoveredJobIds: Set<string>;
  completedJobIds: Set<string>;
  discoveredSiteIds: Set<string>;
  discoveredQuestIds: Set<string>;
  completedQuestIds: Set<string>;
  resolvedEventIds?: ReadonlySet<string>;
  campaignWorldFactIds?: ReadonlySet<string>;
  campaignStoryChoiceKeys?: ReadonlySet<string>;
  campaignCharacter?: CampaignCharacterState;
  journalEntries?: ReadonlyMap<string, import("./session_snapshot.js").OverworldJournalEntry>;
  /** Title lookups for job leads' chronology-gate text; ids are shown when absent. */
  questsById?: ReadonlyMap<string, Pick<OverworldQuest, "title">>;
  eventsById?: ReadonlyMap<string, Pick<OverworldLocalEvent, "title">>;
};

export type OverworldSessionAreaContent = {
  poi: readonly OverworldPoi[];
  characters: readonly OverworldCharacter[];
  events: readonly OverworldLocalEvent[];
  sites: readonly OverworldExplorationSite[];
};

type OverworldSessionCurrentAreaResolution = {
  area: OverworldArea | null;
  applied: OverworldAppliedCurrentAreaSelection | null;
};

type OverworldSessionLocalDiscoveryApplication = {
  discovery: OverworldLocalDiscoveryResult;
  stateChanged: boolean;
};

function overworldSessionLocalAreas(
  state: Pick<MutableOverworldSessionLocalState, "areasByTown">,
  nodeId: string,
): readonly OverworldArea[] {
  return state.areasByTown.get(nodeId) ?? [];
}

function overworldSessionAreaById(
  state: Pick<MutableOverworldSessionLocalState, "areasById">,
  areaId: string,
): OverworldArea | null {
  return state.areasById.get(areaId) ?? null;
}

function applyOverworldSessionCurrentAreaForTown(
  state: MutableOverworldSessionLocalState,
  nodeId: string,
): OverworldAppliedCurrentAreaSelection {
  return applyOverworldCurrentAreaSelection({
    nodeId,
    localAreas: overworldSessionLocalAreas(state, nodeId),
    currentAreaId: state.currentAreaId,
    currentAreaByTown: state.currentAreaByTown,
    discoveredAreaIds: state.discoveredAreaIds,
  });
}

export function resolveOverworldSessionCurrentArea(
  state: MutableOverworldSessionLocalState,
): OverworldSessionCurrentAreaResolution {
  if (state.currentAreaId) {
    const area = overworldSessionAreaById(state, state.currentAreaId);
    if (area?.home === state.currentTownId) return { area, applied: null };
  }

  const applied = applyOverworldSessionCurrentAreaForTown(state, state.currentTownId);
  return {
    applied,
    area: applied.currentAreaIdAfter
      ? overworldSessionAreaById(state, applied.currentAreaIdAfter)
      : null,
  };
}

export function visibleOverworldSessionAreaExits(
  state: Pick<MutableOverworldSessionLocalState, "areaExitsByArea" | "discoveredAreaIds">,
  area: OverworldArea | null,
): OverworldAreaExit[] {
  if (!area) return [];
  const exits: OverworldAreaExit[] = [];
  for (const exit of state.areaExitsByArea.get(area.id) ?? []) {
    if (state.discoveredAreaIds.has(exit.destination.id)) exits.push(exit);
  }
  return exits;
}

export function requireOverworldSessionCurrentAreaId(area: OverworldArea | null): string {
  if (!area) throw new Error("There is no current local area in this town.");
  return area.id;
}

function currentOverworldSessionAreaPois(
  state: Pick<MutableOverworldSessionLocalState, "poisByArea">,
  currentAreaId: string,
): readonly OverworldPoi[] {
  return state.poisByArea.get(currentAreaId) ?? [];
}

function currentOverworldSessionAreaCharacters(
  state: Pick<MutableOverworldSessionLocalState, "charactersByArea">,
  currentAreaId: string,
): readonly OverworldCharacter[] {
  return state.charactersByArea.get(currentAreaId) ?? [];
}

function currentOverworldSessionAreaEvents(
  state: Pick<MutableOverworldSessionLocalState, "eventsByArea">,
  currentAreaId: string,
): readonly OverworldLocalEvent[] {
  return state.eventsByArea.get(currentAreaId) ?? [];
}

function currentOverworldSessionAreaSites(
  state: Pick<MutableOverworldSessionLocalState, "sitesByArea">,
  currentAreaId: string,
): readonly OverworldExplorationSite[] {
  return state.sitesByArea.get(currentAreaId) ?? [];
}

export function currentOverworldSessionAreaContent(
  state: Pick<
    MutableOverworldSessionLocalState,
    "poisByArea" | "charactersByArea" | "eventsByArea" | "sitesByArea"
  >,
  currentAreaId: string,
): OverworldSessionAreaContent {
  return {
    poi: currentOverworldSessionAreaPois(state, currentAreaId),
    characters: currentOverworldSessionAreaCharacters(state, currentAreaId),
    events: currentOverworldSessionAreaEvents(state, currentAreaId),
    sites: currentOverworldSessionAreaSites(state, currentAreaId),
  };
}

export function buildOverworldSessionCurrentLocalView(
  state: MutableOverworldSessionLocalState,
  currentAreaId: string,
): OverworldSessionLocalView {
  return buildOverworldSessionLocalView({
    currentAreaId,
    localAreas: overworldSessionLocalAreas(state, state.currentTownId),
    localJobs: state.jobsByTown.get(state.currentTownId) ?? [],
    currentAreaSites: currentOverworldSessionAreaContent(state, currentAreaId).sites,
    localQuests: state.questsByTown.get(state.currentTownId) ?? [],
    discoveredAreaIds: state.discoveredAreaIds,
    discoveredJobIds: state.discoveredJobIds,
    completedJobIds: state.completedJobIds,
    discoveredSiteIds: state.discoveredSiteIds,
    discoveredQuestIds: state.discoveredQuestIds,
    completedQuestIds: state.completedQuestIds,
    ...(state.resolvedEventIds ? { resolvedEventIds: state.resolvedEventIds } : {}),
    ...(state.campaignWorldFactIds ? { campaignWorldFactIds: state.campaignWorldFactIds } : {}),
    ...(state.campaignStoryChoiceKeys
      ? { campaignStoryChoiceKeys: state.campaignStoryChoiceKeys }
      : {}),
    ...(state.campaignCharacter ? { campaignCharacter: state.campaignCharacter } : {}),
    ...(state.journalEntries ? { journalEntries: state.journalEntries } : {}),
    ...(state.questsById ? { questsById: state.questsById } : {}),
    ...(state.eventsById ? { eventsById: state.eventsById } : {}),
  });
}

export function applyOverworldSessionLocalDiscoveryForTown(
  state: MutableOverworldSessionLocalState,
  townId: string,
  excludedQuestIds: ReadonlySet<string> = new Set(),
): OverworldSessionLocalDiscoveryApplication {
  const discovery = planOverworldLocalDiscovery({
    townId,
    currentTownId: state.currentTownId,
    areasByTown: state.areasByTown,
    jobsByTown: state.jobsByTown,
    currentAreaSites:
      townId === state.currentTownId && state.currentAreaId
        ? currentOverworldSessionAreaSites(state, state.currentAreaId)
        : [],
    questsByTown: state.questsByTown,
    discoveredAreaIds: state.discoveredAreaIds,
    discoveredJobIds: state.discoveredJobIds,
    discoveredSiteIds: state.discoveredSiteIds,
    discoveredQuestIds: state.discoveredQuestIds,
    excludedQuestIds,
  });
  const stateChanged = applyOverworldLocalDiscovery(state, discovery);
  return {
    discovery: {
      ...discovery,
      discoveredJobs: discovery.discoveredJobs.map((job) =>
        projectOverworldSessionLocalJob(job, state, true),
      ),
    },
    stateChanged,
  };
}
