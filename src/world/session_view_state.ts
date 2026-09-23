import type {
  OverworldCompactEventChoice,
  OverworldCompactJobChoice,
  OverworldCompactQuestStart,
  OverworldCompactView,
} from "./compact_view.js";
import type {
  OverworldArea,
  OverworldAreaExit,
  OverworldCharacterView,
  OverworldExit,
  OverworldLocalEvent,
  OverworldNode,
  OverworldPoi,
  OverworldRegionalArc,
} from "./overworld.js";
import type { OverworldSessionCaches } from "./session_cache.js";
import { presentOverworldContact } from "./session_contact_presentation.js";
import {
  buildOverworldSessionCompactView,
  type OverworldSessionCompactViewState,
} from "./session_compact_view.js";
import type { OverworldCompactSessionIdState } from "./session_compact_ids.js";
import {
  currentOverworldSessionAreaContent,
  type MutableOverworldSessionLocalState,
  type OverworldSessionAreaContent,
} from "./session_local_state.js";
import type { OverworldSessionLocalView } from "./session_local_view.js";
import { availableLocalEventSceneOptions } from "./local_event_scene.js";
import type { OverworldRegionalArcProgress } from "./session_regional_arcs.js";
import {
  cachedOverworldSessionDiscoveredRouteOptions,
  cachedOverworldSessionRegionalArcProgress,
} from "./session_route_progress.js";
import type { OverworldRoutePlannerIndex, OverworldSessionRoutePlan } from "./session_routes.js";
import type { OverworldRouteRoadEventState } from "./session_routes.js";
import { roadEventForOverworldSessionTravel } from "./session_road_travel.js";
import type {
  OverworldJournalEntry,
  OverworldPendingRoadEncounter,
  TravelLogEntry,
} from "./session_snapshot.js";
import { buildOverworldSessionView, type OverworldView } from "./session_view.js";
import type { CampaignCharacterState } from "./campaign_character_state.js";
import {
  buildCampaignCharacterView,
  type CampaignCharacterView,
} from "./campaign_character_view.js";
import type { CampaignServiceOffer } from "./campaign_service_rules.js";
import {
  cloneOverworldServiceActionPresentation,
  type OverworldServiceActionPresentation,
} from "./session_service_presentation.js";
import { projectOverworldQuestView } from "./session_local_discovery.js";
import type {
  OverworldDepartureContactLead,
  OverworldDepartureInteraction,
} from "./session_departure_interactions.js";
import type { JourneyOpportunityPresentation } from "./journey_contract.js";
import type { QuestDispatchPresentationWindow } from "./quest_dispatch_window.js";
import type { OpeningDepartureRecap } from "./opening_departure_recap.js";
import { deriveStationDispatchBoard, type StationDispatchBoard } from "./station_dispatch_board.js";
import { resolveOverworldTravelLeg, type OverworldTravelLegResult } from "./travel_mechanics.js";

type OverworldSessionViewLocalContentState = Pick<
  MutableOverworldSessionLocalState,
  "poisByArea" | "charactersByArea" | "eventsByArea" | "sitesByArea"
>;

type OverworldSessionViewModelState = {
  character: CampaignCharacterView;
  worldName: string;
  worldTownCount: number;
  current: OverworldNode;
  currentArea: OverworldArea | null;
  minutes: number;
  supplies: number;
  fatigue: number;
  opportunities: JourneyOpportunityPresentation | null;
  serviceOffers: readonly CampaignServiceOffer[];
  serviceActions: readonly OverworldServiceActionPresentation[];
  departureInteractions: readonly OverworldDepartureInteraction[];
  departureContactLeads: readonly OverworldDepartureContactLead[];
  departureRecap: OpeningDepartureRecap | null;
  stationDispatchBoard: StationDispatchBoard | null;
  stationDispatchSupportRevealed: boolean;
  roads: readonly OverworldExit[];
  directRoadTravelLegs: ReadonlyMap<string, OverworldTravelLegResult>;
  areaExits: readonly OverworldAreaExit[];
  routeOptions: readonly OverworldSessionRoutePlan[];
  localView: OverworldSessionLocalView;
  poi: readonly OverworldPoi[];
  contacts: readonly OverworldCharacterView[];
  events: readonly OverworldLocalEvent[];
  eventChoices: readonly OverworldCompactEventChoice[];
  journalEntries: readonly OverworldJournalEntry[];
  travelLog: readonly TravelLogEntry[];
  visitedCount: number;
  regionRenown: ReadonlyMap<string, number>;
  completedRegionalArcIds: ReadonlySet<string>;
  pendingRoadEncounter: OverworldPendingRoadEncounter | null;
  jobChoices: readonly OverworldCompactJobChoice[];
  questStarts: readonly OverworldCompactQuestStart[];
  ids: OverworldCompactSessionIdState;
};

type OverworldSessionFullViewModelState = OverworldSessionViewModelState & {
  regionalArcs: readonly OverworldRegionalArcProgress[];
};

export type OverworldSessionViewModelSourceState = {
  character: CampaignCharacterState;
  caches: OverworldSessionCaches;
  worldName: string;
  worldTownCount: number;
  current: OverworldNode;
  currentArea: OverworldArea | null;
  currentId: string;
  minutes: number;
  supplies: number;
  fatigue: number;
  opportunities: JourneyOpportunityPresentation | null;
  serviceOffers: readonly CampaignServiceOffer[];
  serviceActions: readonly OverworldServiceActionPresentation[];
  departureInteractions: readonly OverworldDepartureInteraction[];
  departureContactLeads: readonly OverworldDepartureContactLead[];
  departureRecap: OpeningDepartureRecap | null;
  stationDispatchSupportRevealed?: boolean;
  roads: readonly OverworldExit[];
  areaExits: readonly OverworldAreaExit[];
  localState: OverworldSessionViewLocalContentState;
  localView: OverworldSessionLocalView;
  routePlannerIndex: OverworldRoutePlannerIndex;
  roadEventState?: OverworldRouteRoadEventState;
  completedQuestIds: ReadonlySet<string>;
  campaignWorldFactIds: ReadonlySet<string>;
  journalEntries: readonly OverworldJournalEntry[];
  travelLog: readonly TravelLogEntry[];
  visitedCount: number;
  regionRenown: ReadonlyMap<string, number>;
  completedRegionalArcIds: ReadonlySet<string>;
  pendingRoadEncounter: OverworldPendingRoadEncounter | null;
  jobChoices: readonly OverworldCompactJobChoice[];
  eventChoices: readonly OverworldCompactEventChoice[];
  questStarts: readonly OverworldCompactQuestStart[];
  questDispatchWindows?: ReadonlyMap<string, QuestDispatchPresentationWindow>;
  ids: OverworldCompactSessionIdState;
};

type OverworldSessionFullViewModelSourceState = OverworldSessionViewModelSourceState & {
  regionalArcs: readonly OverworldRegionalArc[];
  regionalArcAnchorTownsById: ReadonlyMap<string, readonly OverworldNode[]>;
  resolvedEventHomeIds: ReadonlySet<string>;
};

const EMPTY_AREA_CONTENT: OverworldSessionAreaContent = {
  characters: [],
  events: [],
  poi: [],
  sites: [],
};

const EMPTY_LOCAL_VIEW: OverworldSessionLocalView = {
  areas: [],
  hiddenAreaCount: 0,
  jobs: [],
  rememberedJobs: [],
  hiddenJobCount: 0,
  jobLeads: [],
  quests: [],
  hiddenQuestCount: 0,
  sites: [],
  hiddenSiteCount: 0,
};

function pendingRoadLocationNode(
  encounter: OverworldPendingRoadEncounter,
  destination: OverworldNode,
): OverworldNode {
  return {
    ...destination,
    id: `road:${encounter.edgeId}`,
    name: `On ${encounter.route}: ${encounter.from} to ${encounter.to}`,
    services: [],
    description: `${encounter.event.summary} You are between ${encounter.from} and ${encounter.to}. Resolve this encounter before taking actions in ${encounter.to}.`,
  };
}

export function projectActiveOverworldEvent(
  event: OverworldLocalEvent,
  state: Readonly<{
    resolvedEventIds: ReadonlySet<string>;
    completedQuestIds: ReadonlySet<string>;
    completedJobIds: ReadonlySet<string>;
    campaignWorldFactIds: ReadonlySet<string>;
  }>,
): OverworldLocalEvent | null {
  if (state.resolvedEventIds.has(event.id)) return null;
  if (!event.authored_scene) return event;
  const options = availableLocalEventSceneOptions(event.authored_scene, {
    completedQuestIds: state.completedQuestIds,
    completedJobIds: state.completedJobIds,
    worldFactIds: state.campaignWorldFactIds,
  });
  if (options.length === 0) return null;
  const projectedOptions = options.map(
    ({ requires_all_world_facts: _requires, forbids_any_world_facts: _forbids, ...option }) =>
      option,
  );
  const hasPlayerHiddenPredicates = options.some(
    (option) =>
      option.requires_all_world_facts !== undefined || option.forbids_any_world_facts !== undefined,
  );
  if (!hasPlayerHiddenPredicates && options.length === event.authored_scene.options.length) {
    return event;
  }
  return {
    ...event,
    authored_scene: {
      ...event.authored_scene,
      options: projectedOptions,
    },
  };
}

function activeOverworldEvents(
  events: readonly OverworldLocalEvent[],
  resolvedEventIds: ReadonlySet<string>,
  completedQuestIds: ReadonlySet<string>,
  completedJobIds: ReadonlySet<string>,
  campaignWorldFactIds: ReadonlySet<string>,
): OverworldLocalEvent[] {
  return events.flatMap((event) => {
    const projected = projectActiveOverworldEvent(event, {
      resolvedEventIds,
      completedQuestIds,
      completedJobIds,
      campaignWorldFactIds,
    });
    return projected ? [projected] : [];
  });
}

export function buildOverworldSessionViewModelState(
  source: OverworldSessionViewModelSourceState,
): OverworldSessionViewModelState {
  if (source.pendingRoadEncounter) {
    return {
      character: buildCampaignCharacterView(source.character),
      worldName: source.worldName,
      worldTownCount: source.worldTownCount,
      current: pendingRoadLocationNode(source.pendingRoadEncounter, source.current),
      currentArea: null,
      minutes: source.minutes,
      supplies: source.supplies,
      fatigue: source.fatigue,
      opportunities: source.opportunities,
      serviceOffers: [],
      serviceActions: [],
      departureInteractions: [],
      departureContactLeads: [],
      departureRecap: null,
      stationDispatchBoard: null,
      stationDispatchSupportRevealed: false,
      roads: [],
      directRoadTravelLegs: new Map(),
      areaExits: [],
      routeOptions: [],
      localView: EMPTY_LOCAL_VIEW,
      poi: [],
      contacts: [],
      events: [],
      eventChoices: [],
      journalEntries: source.journalEntries,
      travelLog: source.travelLog,
      visitedCount: source.visitedCount,
      regionRenown: source.regionRenown,
      completedRegionalArcIds: source.completedRegionalArcIds,
      pendingRoadEncounter: source.pendingRoadEncounter,
      jobChoices: [],
      questStarts: [],
      ids: source.ids,
    };
  }

  const currentAreaContent = source.currentArea
    ? currentOverworldSessionAreaContent(source.localState, source.currentArea.id)
    : EMPTY_AREA_CONTENT;
  const events = activeOverworldEvents(
    currentAreaContent.events,
    source.ids.resolvedEventIds,
    source.completedQuestIds,
    source.ids.completedJobIds,
    source.campaignWorldFactIds,
  );
  const contacts = currentAreaContent.characters.map(
    (character) =>
      presentOverworldContact(character, {
        character: source.character,
        completedQuestIds: source.completedQuestIds,
        worldFactIds: source.campaignWorldFactIds,
        eventOptionIdFor: (eventId) =>
          source.journalEntries.find((entry) => entry.id === `resolve:${eventId}`)?.localSceneProof
            ?.optionId ?? null,
      }).contact,
  );
  const routeOptions = cachedOverworldSessionDiscoveredRouteOptions({
    caches: source.caches,
    routePlannerIndex: source.routePlannerIndex,
    current: source.current,
    currentId: source.currentId,
    discoveredIds: source.ids.discoveredIds,
    resources: {
      fatigue: source.fatigue,
      supplies: source.supplies,
    },
    ...(source.roadEventState ? { roadEventState: source.roadEventState } : {}),
  });
  const directRoadTravelLegs = new Map<string, OverworldTravelLegResult>();
  for (const road of source.roads) {
    const manifestRoadEvent = source.routePlannerIndex.roadEventsByEdgeId.get(road.id) ?? null;
    const roadEvent = source.roadEventState
      ? roadEventForOverworldSessionTravel(manifestRoadEvent, source.roadEventState)
      : manifestRoadEvent;
    directRoadTravelLegs.set(
      road.id,
      resolveOverworldTravelLeg(road.travel_minutes, roadEvent, {
        fatigue: source.fatigue,
        supplies: source.supplies,
      }),
    );
  }
  const localView: OverworldSessionLocalView = {
    ...source.localView,
    quests: source.localView.quests.map((quest) =>
      projectOverworldQuestView(
        quest,
        {
          minutes: source.minutes,
          supplies: source.supplies,
          fatigue: source.fatigue,
        },
        source.character.knowledge,
        source.questDispatchWindows?.get(quest.id),
      ),
    ),
  };
  const stationDispatchBoard = deriveStationDispatchBoard({
    recap: source.departureRecap,
    quests: localView.quests,
    questStarts: source.questStarts,
    departureInteractions: source.departureInteractions,
    departureContactLeads: source.departureContactLeads,
  });

  return {
    character: buildCampaignCharacterView(source.character),
    worldName: source.worldName,
    worldTownCount: source.worldTownCount,
    current: source.current,
    currentArea: source.currentArea,
    minutes: source.minutes,
    supplies: source.supplies,
    fatigue: source.fatigue,
    opportunities: source.opportunities,
    serviceOffers: source.serviceOffers.map((offer) => ({
      id: offer.id,
      action: offer.action,
      title: offer.title,
      summary: offer.summary,
      minutes: offer.minutes,
      ...(offer.providerId && offer.providerName
        ? { providerId: offer.providerId, providerName: offer.providerName }
        : {}),
    })),
    serviceActions: source.serviceActions.map(cloneOverworldServiceActionPresentation),
    departureInteractions: source.departureInteractions,
    departureContactLeads: source.departureContactLeads,
    departureRecap: source.departureRecap,
    stationDispatchBoard,
    stationDispatchSupportRevealed: source.stationDispatchSupportRevealed === true,
    roads: source.roads,
    directRoadTravelLegs,
    areaExits: source.areaExits,
    routeOptions,
    localView,
    poi: currentAreaContent.poi,
    contacts,
    events,
    eventChoices: source.eventChoices,
    journalEntries: source.journalEntries,
    travelLog: source.travelLog,
    visitedCount: source.visitedCount,
    regionRenown: source.regionRenown,
    completedRegionalArcIds: source.completedRegionalArcIds,
    pendingRoadEncounter: source.pendingRoadEncounter,
    jobChoices: source.jobChoices,
    questStarts: source.questStarts,
    ids: source.ids,
  };
}

function buildOverworldSessionFullViewModelState(
  source: OverworldSessionFullViewModelSourceState,
): OverworldSessionFullViewModelState {
  const state = buildOverworldSessionViewModelState(source);
  return {
    ...state,
    regionalArcs: cachedOverworldSessionRegionalArcProgress({
      caches: source.caches,
      regionalArcs: source.regionalArcs,
      currentRegion: source.current.region,
      regionalArcAnchorTownsById: source.regionalArcAnchorTownsById,
      resolvedEventHomeIds: source.resolvedEventHomeIds,
      completedRegionalArcIds: source.completedRegionalArcIds,
    }),
  };
}

function compactViewState(state: OverworldSessionViewModelState): OverworldSessionCompactViewState {
  return {
    character: state.character,
    worldName: state.worldName,
    worldTownCount: state.worldTownCount,
    current: state.current,
    currentArea: state.currentArea,
    minutes: state.minutes,
    supplies: state.supplies,
    fatigue: state.fatigue,
    opportunities: state.opportunities,
    serviceOffers: state.serviceOffers,
    serviceActions: state.serviceActions,
    departureInteractions: state.departureInteractions,
    departureContactLeads: state.departureContactLeads,
    departureRecap: state.departureRecap,
    stationDispatchBoard: state.stationDispatchBoard,
    stationDispatchSupportRevealed: state.stationDispatchSupportRevealed,
    roads: state.roads,
    directRoadTravelLegs: state.directRoadTravelLegs,
    areaExits: state.areaExits,
    routeOptions: state.routeOptions,
    areas: state.localView.areas,
    poi: state.poi,
    contacts: state.contacts,
    events: state.events,
    eventChoices: state.eventChoices,
    jobs: state.localView.jobs,
    jobChoices: state.jobChoices,
    rememberedJobs: state.localView.rememberedJobs,
    jobLeads: state.localView.jobLeads,
    sites: state.localView.sites,
    quests: state.localView.quests,
    questStarts: state.questStarts,
    hiddenAreaCount: state.localView.hiddenAreaCount,
    hiddenJobCount: state.localView.hiddenJobCount,
    hiddenSiteCount: state.localView.hiddenSiteCount,
    hiddenQuestCount: state.localView.hiddenQuestCount,
    journalEntries: state.journalEntries,
    travelLog: state.travelLog,
    visitedCount: state.visitedCount,
    regionRenown: state.regionRenown,
    completedRegionalArcIds: state.completedRegionalArcIds,
    pendingRoadEncounter: state.pendingRoadEncounter,
    ids: state.ids,
  };
}

export function buildOverworldSessionCompactViewFromState(
  state: OverworldSessionViewModelState,
): OverworldCompactView {
  return buildOverworldSessionCompactView(compactViewState(state));
}

export function buildOverworldSessionCompactViewFromSource(
  source: OverworldSessionViewModelSourceState,
): OverworldCompactView {
  return buildOverworldSessionCompactViewFromState(buildOverworldSessionViewModelState(source));
}

function buildOverworldSessionViewFromState(
  state: OverworldSessionFullViewModelState,
): OverworldView {
  return buildOverworldSessionView({
    character: state.character,
    worldName: state.worldName,
    worldTownCount: state.worldTownCount,
    current: state.current,
    currentArea: state.currentArea,
    minutes: state.minutes,
    supplies: state.supplies,
    fatigue: state.fatigue,
    serviceOffers: state.serviceOffers,
    serviceActions: state.serviceActions,
    departureInteractions: state.departureInteractions,
    departureContactLeads: state.departureContactLeads,
    departureRecap: state.departureRecap,
    stationDispatchBoard: state.stationDispatchBoard,
    roads: state.roads,
    directRoadTravelLegs: state.directRoadTravelLegs,
    areaExits: state.areaExits,
    areas: state.localView.areas,
    hiddenAreaCount: state.localView.hiddenAreaCount,
    poi: state.poi,
    contacts: state.contacts,
    events: state.events,
    eventChoices: state.eventChoices,
    jobs: state.localView.jobs,
    jobChoices: state.jobChoices,
    rememberedJobs: state.localView.rememberedJobs,
    hiddenJobCount: state.localView.hiddenJobCount,
    jobLeads: state.localView.jobLeads,
    sites: state.localView.sites,
    hiddenSiteCount: state.localView.hiddenSiteCount,
    quests: state.localView.quests,
    hiddenQuestCount: state.localView.hiddenQuestCount,
    routeOptions: state.routeOptions,
    discoveredIds: state.ids.discoveredIds,
    nodes: state.ids.nodes,
    visitedCount: state.visitedCount,
    journalEntries: state.journalEntries,
    discoveredAreaIds: state.ids.discoveredAreaIds,
    visitedAreaIds: state.ids.visitedAreaIds,
    discoveredJobIds: state.ids.discoveredJobIds,
    completedJobIds: state.ids.completedJobIds,
    discoveredSiteIds: state.ids.discoveredSiteIds,
    discoveredQuestIds: state.ids.discoveredQuestIds,
    startedQuestIds: state.ids.startedQuestIds,
    completedQuestIds: state.ids.completedQuestIds,
    questStarts: state.questStarts,
    exploredSiteIds: state.ids.exploredSiteIds,
    resolvedEventIds: state.ids.resolvedEventIds,
    regionRenown: state.regionRenown,
    regionalArcs: state.regionalArcs,
    completedRegionalArcIds: state.completedRegionalArcIds,
    pendingRoadEncounter: state.pendingRoadEncounter,
    travelLog: state.travelLog,
  });
}

export function buildOverworldSessionViewFromSource(
  source: OverworldSessionFullViewModelSourceState,
): OverworldView {
  return buildOverworldSessionViewFromState(buildOverworldSessionFullViewModelState(source));
}
