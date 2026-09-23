import {
  type OverworldArea,
  type OverworldAreaExit,
  type OverworldCharacterView,
  type OverworldExit,
  type OverworldExplorationSite,
  type OverworldLocalEvent,
  type OverworldLocalJob,
  type OverworldNode,
  type OverworldPoi,
} from "./overworld.js";
import { compareTownByPopulationThenName, sortedNumberRecord } from "./session_collections.js";
import { timeLabel } from "./session_journal_codec.js";
import type { OverworldQuestView } from "./session_local_discovery.js";
import type { OverworldSessionLocalJobLead } from "./session_local_view.js";
import {
  cloneOverworldRegionalArcProgress,
  type OverworldRegionalArcProgress,
} from "./session_regional_arcs.js";
import { cloneOverworldRouteOption, type OverworldSessionRoutePlan } from "./session_routes.js";
import {
  redactOverworldJournalEntryForPresentation,
  type OverworldJournalEntry,
  type OverworldPendingRoadEncounter,
  type TravelLogEntry,
} from "./session_snapshot.js";
import {
  OVERWORLD_MAX_SUPPLIES as MAX_SUPPLIES,
  travelCondition,
  type OverworldTravelLegResult,
} from "./travel_mechanics.js";
import type { CampaignCharacterView } from "./campaign_character_view.js";
import type { CampaignServiceOffer } from "./campaign_service_rules.js";
import {
  cloneOverworldServiceActionPresentation,
  type OverworldServiceActionPresentation,
} from "./session_service_presentation.js";
import type {
  OverworldCompactEventChoice,
  OverworldCompactJobChoice,
  OverworldCompactQuestStart,
} from "./compact_view.js";
import {
  overworldRoadEncounterNextAction,
  type OverworldRoadEncounterNextAction,
} from "./session_road_next_action.js";
import {
  cloneOverworldDepartureContactLead,
  cloneOverworldDepartureInteraction,
  type OverworldDepartureContactLead,
  type OverworldDepartureInteraction,
} from "./session_departure_interactions.js";
import {
  cloneOpeningDepartureRecap,
  type OpeningDepartureRecap,
} from "./opening_departure_recap.js";
import { cloneStationDispatchBoard, type StationDispatchBoard } from "./station_dispatch_board.js";

export type OverworldPendingRoadEncounterView = OverworldPendingRoadEncounter & {
  nextAction: OverworldRoadEncounterNextAction;
};

/** A direct road plus the exact resource projection travel will apply now. */
export type OverworldDirectRoadView = OverworldExit & {
  estimate: OverworldTravelLegResult;
};

export type OverworldView = {
  character: CampaignCharacterView;
  world: string;
  timeLabel: string;
  current: OverworldNode;
  currentArea: OverworldArea | null;
  areaExits: OverworldAreaExit[];
  exits: OverworldDirectRoadView[];
  areas: OverworldArea[];
  hiddenAreaCount: number;
  pois: OverworldPoi[];
  characters: OverworldCharacterView[];
  events: OverworldLocalEvent[];
  eventChoices: OverworldCompactEventChoice[];
  jobs: OverworldLocalJob[];
  jobChoices: OverworldCompactJobChoice[];
  rememberedJobs: OverworldLocalJob[];
  hiddenJobCount: number;
  jobLeads: OverworldSessionLocalJobLead[];
  sites: OverworldExplorationSite[];
  hiddenSiteCount: number;
  quests: OverworldQuestView[];
  hiddenQuestCount: number;
  routeOptions: OverworldSessionRoutePlan[];
  discovered: OverworldNode[];
  visitedCount: number;
  totalTowns: number;
  supplies: number;
  maxSupplies: number;
  fatigue: number;
  travelCondition: string;
  serviceOffers: CampaignServiceOffer[];
  serviceActions: OverworldServiceActionPresentation[];
  departureInteractions: OverworldDepartureInteraction[];
  departureContactLeads: OverworldDepartureContactLead[];
  departureRecap: OpeningDepartureRecap | null;
  stationDispatchBoard: StationDispatchBoard | null;
  journal: OverworldJournalEntry[];
  discoveredSiteIds: string[];
  discoveredAreaIds: string[];
  discoveredJobIds: string[];
  visitedAreaIds: string[];
  completedJobIds: string[];
  discoveredQuestIds: string[];
  startedQuestIds: string[];
  completedQuestIds: string[];
  questStarts: OverworldCompactQuestStart[];
  exploredSiteIds: string[];
  resolvedEventIds: string[];
  regionRenown: Record<string, number>;
  regionalArcs: OverworldRegionalArcProgress[];
  completedRegionalArcIds: string[];
  pendingRoadEncounter: OverworldPendingRoadEncounterView | null;
  log: TravelLogEntry[];
};

type OverworldSessionViewState = {
  character: CampaignCharacterView;
  worldName: string;
  worldTownCount: number;
  current: OverworldNode;
  currentArea: OverworldArea | null;
  minutes: number;
  supplies: number;
  fatigue: number;
  serviceOffers: readonly CampaignServiceOffer[];
  serviceActions: readonly OverworldServiceActionPresentation[];
  departureInteractions: readonly OverworldDepartureInteraction[];
  departureContactLeads: readonly OverworldDepartureContactLead[];
  departureRecap: OpeningDepartureRecap | null;
  stationDispatchBoard: StationDispatchBoard | null;
  roads: readonly OverworldExit[];
  directRoadTravelLegs: ReadonlyMap<string, OverworldTravelLegResult>;
  areaExits: readonly OverworldAreaExit[];
  areas: readonly OverworldArea[];
  hiddenAreaCount: number;
  poi: readonly OverworldPoi[];
  contacts: readonly OverworldCharacterView[];
  events: readonly OverworldLocalEvent[];
  eventChoices?: readonly OverworldCompactEventChoice[];
  jobs: readonly OverworldLocalJob[];
  jobChoices?: readonly OverworldCompactJobChoice[];
  rememberedJobs: readonly OverworldLocalJob[];
  hiddenJobCount: number;
  jobLeads: readonly OverworldSessionLocalJobLead[];
  sites: readonly OverworldExplorationSite[];
  hiddenSiteCount: number;
  quests: readonly OverworldQuestView[];
  hiddenQuestCount: number;
  routeOptions: readonly OverworldSessionRoutePlan[];
  discoveredIds: ReadonlySet<string>;
  nodes: ReadonlyMap<string, OverworldNode>;
  visitedCount: number;
  journalEntries: readonly OverworldJournalEntry[];
  discoveredAreaIds: ReadonlySet<string>;
  visitedAreaIds: ReadonlySet<string>;
  discoveredJobIds: ReadonlySet<string>;
  completedJobIds: ReadonlySet<string>;
  discoveredSiteIds: ReadonlySet<string>;
  discoveredQuestIds: ReadonlySet<string>;
  startedQuestIds: ReadonlySet<string>;
  completedQuestIds: ReadonlySet<string>;
  questStarts: readonly OverworldCompactQuestStart[];
  exploredSiteIds: ReadonlySet<string>;
  resolvedEventIds: ReadonlySet<string>;
  regionRenown: ReadonlyMap<string, number>;
  regionalArcs: readonly OverworldRegionalArcProgress[];
  completedRegionalArcIds: ReadonlySet<string>;
  pendingRoadEncounter: OverworldPendingRoadEncounter | null;
  travelLog: readonly TravelLogEntry[];
};

function sortedDiscoveredTownsByPopulation(
  discoveredIds: ReadonlySet<string>,
  nodes: ReadonlyMap<string, OverworldNode>,
): OverworldNode[] {
  const discoveredTowns: OverworldNode[] = [];
  for (const id of discoveredIds) {
    const town = nodes.get(id);
    if (town) discoveredTowns.push(town);
  }
  discoveredTowns.sort(compareTownByPopulationThenName);
  return discoveredTowns;
}

function routeOptionsForView(
  routeOptions: readonly OverworldSessionRoutePlan[],
): OverworldSessionRoutePlan[] {
  const options: OverworldSessionRoutePlan[] = [];
  for (const plan of routeOptions) options.push(cloneOverworldRouteOption(plan));
  return options;
}

function regionalArcProgressForView(
  progress: readonly OverworldRegionalArcProgress[],
): OverworldRegionalArcProgress[] {
  const viewProgress: OverworldRegionalArcProgress[] = [];
  for (const arc of progress) viewProgress.push(cloneOverworldRegionalArcProgress(arc));
  return viewProgress;
}

export function buildOverworldSessionView(state: OverworldSessionViewState): OverworldView {
  return {
    character: state.character,
    world: state.worldName,
    timeLabel: timeLabel(state.minutes),
    current: state.current,
    currentArea: state.currentArea,
    areaExits: [...state.areaExits],
    exits: state.roads.map((road) => {
      const estimate = state.directRoadTravelLegs.get(road.id);
      if (!estimate) throw new Error(`Direct road "${road.id}" is missing its travel estimate.`);
      return { ...road, estimate: { ...estimate } };
    }),
    areas: [...state.areas],
    hiddenAreaCount: state.hiddenAreaCount,
    pois: [...state.poi],
    characters: [...state.contacts],
    events: [...state.events],
    eventChoices: (state.eventChoices ?? []).map(([eventId, optionId]) => [eventId, optionId]),
    jobs: [...state.jobs],
    jobChoices: (state.jobChoices ?? []).map(([jobId, optionId]) => [jobId, optionId]),
    rememberedJobs: [...state.rememberedJobs],
    hiddenJobCount: state.hiddenJobCount,
    jobLeads: [...state.jobLeads],
    sites: [...state.sites],
    hiddenSiteCount: state.hiddenSiteCount,
    quests: [...state.quests],
    hiddenQuestCount: state.hiddenQuestCount,
    routeOptions: routeOptionsForView(state.routeOptions),
    discovered: sortedDiscoveredTownsByPopulation(state.discoveredIds, state.nodes),
    visitedCount: state.visitedCount,
    totalTowns: state.worldTownCount,
    supplies: state.supplies,
    maxSupplies: MAX_SUPPLIES,
    fatigue: state.fatigue,
    travelCondition: travelCondition(state.fatigue, state.supplies),
    serviceOffers: state.serviceOffers.map((offer) => ({
      id: offer.id,
      action: offer.action,
      title: offer.title,
      summary: offer.summary,
      minutes: offer.minutes,
      ...(offer.providerId && offer.providerName
        ? { providerId: offer.providerId, providerName: offer.providerName }
        : {}),
    })),
    serviceActions: state.serviceActions.map(cloneOverworldServiceActionPresentation),
    departureInteractions: state.departureInteractions.map(cloneOverworldDepartureInteraction),
    departureContactLeads: state.departureContactLeads.map(cloneOverworldDepartureContactLead),
    departureRecap: state.departureRecap ? cloneOpeningDepartureRecap(state.departureRecap) : null,
    stationDispatchBoard: state.stationDispatchBoard
      ? cloneStationDispatchBoard(state.stationDispatchBoard)
      : null,
    journal: state.journalEntries.map(redactOverworldJournalEntryForPresentation),
    discoveredAreaIds: [...state.discoveredAreaIds].sort(),
    discoveredJobIds: [...state.discoveredJobIds].sort(),
    visitedAreaIds: [...state.visitedAreaIds].sort(),
    completedJobIds: [...state.completedJobIds].sort(),
    discoveredSiteIds: [...state.discoveredSiteIds].sort(),
    discoveredQuestIds: [...state.discoveredQuestIds].sort(),
    startedQuestIds: [...state.startedQuestIds].sort(),
    completedQuestIds: [...state.completedQuestIds].sort(),
    questStarts: state.questStarts.map(([questId, approachId]) => [questId, approachId]),
    exploredSiteIds: [...state.exploredSiteIds].sort(),
    resolvedEventIds: [...state.resolvedEventIds].sort(),
    regionRenown: sortedNumberRecord(state.regionRenown),
    regionalArcs: regionalArcProgressForView(state.regionalArcs),
    completedRegionalArcIds: [...state.completedRegionalArcIds].sort(),
    pendingRoadEncounter: state.pendingRoadEncounter
      ? {
          ...state.pendingRoadEncounter,
          nextAction: overworldRoadEncounterNextAction(),
        }
      : null,
    log: [...state.travelLog],
  };
}
