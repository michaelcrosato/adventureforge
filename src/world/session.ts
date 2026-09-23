import { hashState } from "../core/hash.js";
import {
  overworldContactTalkJournalId,
  type OverworldArea,
  type OverworldAreaExit,
  type OverworldCharacter,
  type OverworldExit,
  type OverworldExplorationSite,
  type OverworldLocalJob,
  type OverworldLocalEvent,
  type OverworldManifest,
  type OverworldNode,
  type OverworldPoi,
  type OverworldQuest,
  type OverworldRegionalArc,
  type OverworldRoadEvent,
  type OverworldRoutePlan,
} from "./overworld.js";
import {
  OVERWORLD_COMPACT_LOCAL_REF_LIMIT,
  cloneOverworldCompactView,
  type OverworldCompactEventChoice,
  type OverworldCompactJobChoice,
  type OverworldCompactQuestStart,
  type OverworldCompactView,
} from "./compact_view.js";
import {
  OVERWORLD_STARTING_MINUTES as STARTING_MINUTES,
  OVERWORLD_STARTING_SUPPLIES as STARTING_SUPPLIES,
  resolveOverworldTravelLeg,
  travelCondition,
  type OverworldRoadEncounterStrategy,
  type OverworldTravelLegResult,
} from "./travel_mechanics.js";
import {
  cloneOverworldRouteOption,
  indexedOverworldRoute,
  withOverworldRouteEstimate,
  withOverworldSessionRoadEvents,
  type OverworldRoutePlannerIndex,
  type OverworldSessionRoutePlan,
} from "./session_routes.js";
import { type OverworldRoadEncounterResult } from "./session_road_encounters.js";
import {
  recordOverworldRepeatableEntry,
  type OverworldActionJournalState,
} from "./session_action_recording.js";
import {
  revealOverworldQuestAnchor,
  type OverworldLocalDiscoveryResult,
  type OverworldQuestView,
} from "./session_local_discovery.js";
import {
  questCampaignEffectGroupsForOutcomes,
  type OverworldQuestCompletionOutcome,
  type OverworldQuestCompletionResult,
  type OverworldQuestStartPreparation,
} from "./session_quests.js";
import {
  classifyQuestDispatchMinutes,
  createQuestDispatchLaunchSeal,
  deriveQuestDispatchPresentationWindow,
} from "./quest_dispatch_window.js";
import { deriveCampaignWorldFactIds } from "./campaign_consequences.js";
import {
  resolveCampaignServiceRules,
  type CampaignServiceOffer,
  type CampaignServiceLocalJobOption,
} from "./campaign_service_rules.js";
import {
  applyOverworldSessionQuestStart,
  applyOverworldSessionQuestCompletion,
  planOverworldSessionQuestStart,
  planOverworldSessionQuestCompletion,
  previewOverworldSessionQuestStart,
  type OverworldSessionQuestStartState,
} from "./session_quest_lifecycle.js";
import { type OverworldSnapshotManifestIndex } from "./session_manifest_index.js";
import {
  applyOverworldSessionTownCareFromState,
  applyOverworldSessionTownRestFromState,
  applyOverworldSessionTownResupplyFromState,
  type OverworldServiceResult,
  type OverworldSessionServiceApplication,
  type OverworldSessionTownServicePlanState,
} from "./session_service_lifecycle.js";
import { campaignServiceJourneyActionId } from "./session_services.js";
import {
  presentOverworldServiceActions,
  type OverworldServiceActionPresentation,
} from "./session_service_presentation.js";
import { type OverworldAreaTravelResult } from "./session_local_actions.js";
import {
  applyOverworldSessionAreaFromState,
  applyOverworldSessionAreaTravelFromState,
  applyOverworldSessionContactTalkFromState,
  applyOverworldSessionEventInvestigationFromState,
  applyOverworldSessionLocalJobFromState,
  applyOverworldSessionPoiScoutFromState,
  applyOverworldSessionSiteFromState,
  applyOverworldSessionTownVisit,
  planOverworldOpportunityInteractionDiscovery,
  planOverworldSessionArea,
  planOverworldSessionLocalJob,
  planOverworldSessionPoiScout,
  planOverworldSessionSite,
} from "./session_local_lifecycle.js";
import {
  cloneOpeningLeadSourceDecisionTrail,
  cloneQuestCharacterDeathBoundary,
  cloneOverworldSessionSnapshot,
  parseOverworldSessionSnapshot,
  redactOverworldJournalEntryForPresentation,
  type OverworldJournalEntry,
  type OverworldOpeningLeadSourceDecisionTrail,
  type OverworldPendingRoadEncounter,
  type OverworldQuestCharacterDeathBoundary,
  type OverworldSessionSnapshot,
  type TravelLogEntry,
} from "./session_snapshot.js";
import {
  cloneCampaignCharacterState,
  createInitialCampaignCharacterState,
  serializeCampaignCharacterState,
  type CampaignCharacterState,
} from "./campaign_character_state.js";
import {
  applyOpeningRegistrationProfile,
  type OpeningStartingDoctrine,
} from "./opening_registration.js";
import { applyOpeningAllyOption, openingAllyContactTimingSummary } from "./opening_ally.js";
import {
  openingAllyJournalEntry,
  openingAllyJournalId,
  openingAllyOfferJournalEntry,
  openingAllyOfferJournalId,
} from "./opening_ally_journal.js";
import { presentOpeningAlly } from "./opening_ally_presentation.js";
import { applyOpeningLeadSourceOption } from "./opening_lead_source.js";
import { applyOpeningPreparationProfile } from "./opening_preparation.js";
import {
  openingLeadSourceJournalEntry,
  openingLeadSourceJournalId,
  openingLeadSourceOfferJournalEntry,
  openingLeadSourceOfferJournalId,
} from "./opening_lead_source_journal.js";
import { presentOpeningLeadSource } from "./opening_lead_source_presentation.js";
import {
  openingPreparationJournalEntry,
  openingPreparationJournalId,
  openingPreparationOfferJournalEntry,
  openingPreparationOfferJournalId,
} from "./opening_preparation_journal.js";
import { presentOpeningPreparation } from "./opening_preparation_presentation.js";
import { withOpeningPreparationDispatchForecast } from "./opening_preparation_dispatch_forecast.js";
import { stripOpeningStationDispatchImpact } from "./opening_station_dispatch_impact.js";
import { applyOpeningReliefAllocationOption } from "./opening_relief_allocation.js";
import {
  openingReliefAllocationJournalEntry,
  openingReliefAllocationJournalId,
  openingReliefAllocationOfferJournalEntry,
  openingReliefAllocationOfferJournalId,
} from "./opening_relief_allocation_journal.js";
import { presentOpeningReliefAllocation } from "./opening_relief_allocation_presentation.js";
import { applyOpeningReliefOathOption } from "./opening_relief_oath.js";
import {
  openingReliefOathJournalEntry,
  openingReliefOathJournalId,
  openingReliefOathOfferJournalEntry,
  openingReliefOathOfferJournalId,
} from "./opening_relief_oath_journal.js";
import {
  presentOpeningReliefOath,
  withOpeningReliefOathFieldOutcomeCompass,
} from "./opening_relief_oath_presentation.js";
import {
  openingRegistrationJournalEntry,
  openingRegistrationJournalId,
  openingRegistrationOfferJournalEntry,
  openingRegistrationOfferJournalId,
} from "./opening_registration_journal.js";
import { presentOpeningRegistration } from "./opening_registration_presentation.js";
import {
  resolveOpeningDispatchManifestChain,
  withOpeningDispatchBriefing,
} from "./opening_dispatch_briefing.js";
import {
  deriveOpeningDepartureRecap,
  type OpeningDepartureRecap,
} from "./opening_departure_recap.js";
import { STATION_DISPATCH_SUPPORT_REVEAL_ID } from "./station_dispatch_board.js";
import {
  clearOverworldSessionCaches,
  type OverworldSessionCaches,
  type OverworldSessionSnapshotCache,
} from "./session_cache.js";
import { cloneOverworldView } from "./session_view_clone.js";
import type { OverworldView } from "./session_view.js";
import { buildOverworldSessionIndexes } from "./session_indices.js";
import {
  cloneOverworldActionResult,
  cloneOverworldAreaTravelResult,
  cloneOverworldGoalPassageResult,
  cloneOverworldQuestCompletionResult,
  cloneOverworldQuestView,
  cloneOverworldRoadEncounterResult,
  cloneOverworldServiceResult,
  cloneOverworldTravelLogEntry,
} from "./session_result_clone.js";
import {
  buildOverworldSessionSnapshotFromState,
  restoreOverworldSessionSnapshotIntoState,
  type OverworldSessionPersistenceState,
} from "./session_persistence.js";
import {
  buildOverworldSessionCompactViewFromSource,
  buildOverworldSessionViewFromSource,
  type OverworldSessionViewModelSourceState,
} from "./session_view_state.js";
import { planOverworldSessionRoadRoute } from "./session_route_lifecycle.js";
import {
  applyOverworldSessionEventResolutionFromState,
  planOverworldSessionEventResolution,
} from "./session_event_lifecycle.js";
import {
  applyOverworldSessionLocalDiscoveryForTown,
  buildOverworldSessionCurrentLocalView,
  requireOverworldSessionCurrentAreaId,
  resolveOverworldSessionCurrentArea,
  visibleOverworldSessionAreaExits,
  type MutableOverworldSessionLocalState,
} from "./session_local_state.js";
import {
  withOverworldSessionLocalDiscovery,
  type OverworldActionResult,
  type OverworldSessionActionApplication,
} from "./session_action_application.js";
import {
  applyOverworldSessionRoadEncounter,
  applyOverworldSessionRoadTravelArrival,
  roadEventForOverworldSessionTravel,
} from "./session_road_travel.js";
import {
  buildJourneyGoalPassagePresentation,
  goalPassageHitsResourceBoundary,
  goalPassageJourneyActionId,
  overworldTravelDelayTier,
  type OverworldGoalPassageResult,
  type OverworldGoalPassageStopReason,
} from "./session_goal_passage.js";
import {
  activateJourneyGoal,
  assertJourneyAcceptingDecision as assertJourneyContractAcceptingDecision,
  chooseJourney as chooseJourneyContract,
  createInitialJourneyContractSnapshot,
  INITIAL_JOURNEY_GOAL,
  journeyExitReceipt,
  journeyPresentation,
  journeyStoryChoiceOptionsForPresentation,
  recordJourneyCharacterDied,
  recordJourneyDecision,
  recordJourneyGoalCompleted,
  type JourneyChoice,
  type JourneyChoiceResult,
  type JourneyContractSnapshot,
  type JourneyDecisionClassification,
  type JourneyExitReceipt,
  type JourneyGoalDefinition,
  type JourneyGoalPresentation,
  type JourneyOpportunityPresentation,
  type JourneyPresentation,
  type JourneyPresentationContext,
  type JourneyStoryChoiceOption,
  type JourneyStoryChoicePresentationKind,
  type JourneyStoryChoicePrompt,
} from "./journey_contract.js";
import {
  deferJourneyOpportunityDetails,
  projectJourneyOpportunities,
} from "./journey_opportunity_leads.js";
import {
  explainJourneyOpportunity,
  OPPORTUNITY_EXPLORE_AREA_TOOL,
  OPPORTUNITY_EXPLORE_SITE_TOOL,
  OPPORTUNITY_INVESTIGATE_EVENT_TOOL,
  OPPORTUNITY_RESOLVE_EVENT_TOOL,
  OPPORTUNITY_SCOUT_POI_TOOL,
  OPPORTUNITY_TALK_CONTACT_TOOL,
  OPPORTUNITY_WORK_JOB_TOOL,
  type JourneyOpportunityExplanation,
  type JourneyOpportunityIdentity,
  type JourneyOpportunityNextAction,
  type JourneyOpportunityRoadStep,
} from "./journey_opportunity_explainer.js";
import {
  assertJourneyCampaignQuestOutcome,
  journeyCampaignGoalIsComplete,
  journeyCampaignGoalJournalCopy,
  journeyCampaignGoalDefinition,
  journeyCampaignPresentationContext,
  journeyCampaignSelectedStoryChoiceRefs,
  journeyCampaignStoryChoiceSelection,
  materializeJourneyCampaignGoal,
  nextJourneyCampaignGoal,
  type JourneyCampaignGoalDefinition,
} from "./journey_campaign.js";
import {
  classifyOverworldJourneyDecision,
  withJourneyDecision,
  type JourneyDecisionAnnotated,
  type OverworldJourneyActionKind,
} from "./journey_decision.js";
import { addOverworldJournalEntry } from "./session_journal_store.js";
import { timeLabel } from "./session_journal_codec.js";
import {
  campaignStoryChoiceRefKey,
  type CampaignStoryChoiceRef,
} from "./campaign_story_choices.js";
import {
  overworldDepartureContactLead,
  overworldDepartureInteraction,
  type OverworldDepartureContactLead,
  type OverworldDepartureInteraction,
} from "./session_departure_interactions.js";

export type { OverworldRoadEncounterStrategy } from "./travel_mechanics.js";
export type { OverworldRouteEstimate, OverworldSessionRoutePlan } from "./session_routes.js";
export type { OverworldRoadEncounterResult } from "./session_road_encounters.js";
export type { OverworldServiceResult } from "./session_service_lifecycle.js";
export type { OverworldQuestView } from "./session_local_discovery.js";
export type { OverworldQuestCompletionResult } from "./session_quests.js";
export type { OverworldAreaTravelResult } from "./session_local_actions.js";
export type {
  OverworldJournalEntry,
  OverworldPendingRoadEncounter,
  OverworldSessionSnapshot,
  TravelLogEntry,
} from "./session_snapshot.js";
export type { OverworldActionResult } from "./session_action_application.js";
export type { OverworldGoalPassageResult } from "./session_goal_passage.js";
export type { OverworldView } from "./session_view.js";

type OverworldJourneyActionResult = JourneyDecisionAnnotated<OverworldActionResult>;
type OverworldJourneyAreaTravelResult = JourneyDecisionAnnotated<OverworldAreaTravelResult>;
export type OverworldJourneyQuestCompletionResult =
  JourneyDecisionAnnotated<OverworldQuestCompletionResult>;
export type OverworldJourneyQuestStartResult = JourneyDecisionAnnotated<OverworldQuestView>;
type OverworldJourneyRoadEncounterResult = JourneyDecisionAnnotated<OverworldRoadEncounterResult>;
type OverworldJourneyServiceResult = JourneyDecisionAnnotated<OverworldServiceResult>;
type OverworldJourneyTravelResult = JourneyDecisionAnnotated<TravelLogEntry>;
export type OverworldJourneyGoalPassageResult =
  JourneyDecisionAnnotated<OverworldGoalPassageResult>;

export type OverworldJourneyStoryChoiceResult = Readonly<{
  storyChoiceId: string;
  choiceId: string;
  /** Optional player-first projection; consequence remains the exact authoritative receipt. */
  displaySummary?: string;
  consequence: string;
  goal: JourneyGoalPresentation;
  entry: OverworldJournalEntry;
  journeyDecision: JourneyDecisionClassification;
}>;

/**
 * Keep the durable journal mechanically complete while ensuring ordinary
 * roleplay-first responses do not re-expand deferred setup mechanics. Opening
 * registration retains its existing presented journal bytes; legacy and
 * unfamiliar summaries retain their authored text.
 */
function storyChoiceEntryForPresentation(
  entry: OverworldJournalEntry,
  option: JourneyStoryChoiceOption,
): OverworldJournalEntry {
  const presented = redactOverworldJournalEntryForPresentation(entry);
  return entry.kind !== "registration" &&
    option.summary?.fieldTrigger === undefined &&
    option.summary !== undefined
    ? { ...presented, text: option.consequence }
    : presented;
}

const OPENING_STORY_CHOICE_DISPLAY_PREFIX: Readonly<
  Record<JourneyStoryChoicePresentationKind, string>
> = Object.freeze({
  registration: "Background chosen",
  relief_oath: "Wolf-Winter promise chosen",
  lead_source: "Report chosen",
  preparation: "Field kit chosen",
  relief_allocation: "Relief wagon choice made",
  ally: "Riding choice made",
});

const OPENING_STORY_CHOICE_PLAIN_OUTCOME: Readonly<Record<string, string>> = Object.freeze({
  "albany:ally_june_cattle_first": "June joined you as the second rider.",
  "albany:ally_june_relay_only": "June would not accept your orders and stayed at the Station.",
  "albany:ally_travel_solo": "June remained at the Station; you will ride alone.",
});

/**
 * Lead ordinary Albany opening results with the same player-language terms the
 * accepted card showed. Exact mechanical consequence and journal bytes remain
 * separate and unchanged; legacy field-trigger summaries retain their old
 * response shape rather than receiving an incomplete projection. The accepted
 * receipt intentionally does not concatenate authored commitments/tradeoffs:
 * some are exact field mechanics whose proper home is the consequence.
 */
function openingStoryChoiceDisplaySummary(
  kind: JourneyStoryChoicePresentationKind | undefined,
  option: JourneyStoryChoiceOption,
): string | undefined {
  const summary = option.summary;
  if (kind === undefined || summary === undefined || summary.fieldTrigger !== undefined) {
    return undefined;
  }
  const cost = summary.immediateCost.replace(/\.$/u, "");
  const plainOutcome = OPENING_STORY_CHOICE_PLAIN_OUTCOME[option.id];
  return `${OPENING_STORY_CHOICE_DISPLAY_PREFIX[kind]} — ${option.label}. ${plainOutcome ? `${plainOutcome} ` : ""}Cost: ${cost}.`;
}

const DEFAULT_CAMPAIGN_CHARACTER_SERIALIZED = serializeCampaignCharacterState(
  createInitialCampaignCharacterState(),
);

const authenticatedQuestStartPreparations = new WeakMap<
  object,
  Readonly<{ session: object; preparationHash: string }>
>();

function authenticateQuestStartPreparation(
  session: OverworldSession,
  preparation: OverworldQuestStartPreparation,
): OverworldQuestStartPreparation {
  authenticatedQuestStartPreparations.set(
    preparation,
    Object.freeze({
      session,
      preparationHash: hashState(preparation),
    }),
  );
  return preparation;
}

/**
 * Proves that an unchanged quest-start preparation came directly from this
 * live session. The module-private WeakMap is the capability: structural
 * lookalikes and mutated preparations cannot mint embedded launch state.
 */
export function assertAuthenticatedQuestStartPreparation(
  session: OverworldSession,
  preparation: OverworldQuestStartPreparation,
): void {
  const authority = authenticatedQuestStartPreparations.get(preparation);
  if (authority?.session !== session || authority.preparationHash !== hashState(preparation)) {
    throw new Error("Quest start preparation lacks live session provenance.");
  }
}

type OverworldClockState = {
  minutesAfter: number;
};

type OverworldResourceClockState = OverworldClockState & {
  suppliesAfter: number;
  fatigueAfter: number;
};

type OverworldCurrentTownState = {
  currentIdAfter: string;
};

type OverworldCurrentAreaState = {
  currentAreaIdAfter: string | null;
};

type OverworldCurrentAreaTravelState = OverworldCurrentAreaState & OverworldClockState;

type OverworldPendingRoadEncounterState = {
  pendingRoadEncounterAfter: OverworldPendingRoadEncounter | null;
};

export class OverworldSession {
  private readonly nodes: Map<string, OverworldNode>;
  private readonly roadExitsByTown: Map<string, OverworldExit[]>;
  private readonly roadExitsByTownAndId: Map<string, Map<string, OverworldExit>>;
  private readonly roadEventsByEdgeId: Map<string, OverworldRoadEvent>;
  private readonly areasById: Map<string, OverworldArea>;
  private readonly areasByTown: Map<string, OverworldArea[]>;
  private readonly areaExitsByArea: Map<string, OverworldAreaExit[]>;
  private readonly areaExitsByAreaAndId: Map<string, Map<string, OverworldAreaExit>>;
  private readonly poisById: Map<string, OverworldPoi>;
  private readonly poisByArea: Map<string, OverworldPoi[]>;
  private readonly charactersById: Map<string, OverworldCharacter>;
  private readonly charactersByArea: Map<string, OverworldCharacter[]>;
  private readonly eventsByArea: Map<string, OverworldLocalEvent[]>;
  private readonly localEventsById: Map<string, OverworldLocalEvent>;
  private readonly jobsById: Map<string, OverworldLocalJob>;
  private readonly jobsByTown: Map<string, OverworldLocalJob[]>;
  private readonly sitesById: Map<string, OverworldExplorationSite>;
  private readonly sitesByArea: Map<string, OverworldExplorationSite[]>;
  private readonly questsById: Map<string, OverworldQuest>;
  private readonly questsByTown: Map<string, OverworldQuest[]>;
  private readonly regionalArcsByRegion: Map<string, OverworldRegionalArc[]>;
  private readonly regionalArcAnchorTownsById: Map<string, OverworldNode[]>;
  private readonly routePlannerIndex: OverworldRoutePlannerIndex;
  private readonly snapshotManifestIndex: OverworldSnapshotManifestIndex;
  private readonly worldHash: string;
  private currentId: string;
  private currentAreaId: string | null = null;
  private minutes = STARTING_MINUTES;
  private supplies = STARTING_SUPPLIES;
  private fatigue = 0;
  private readonly discoveredIds = new Set<string>();
  private readonly visitedIds = new Set<string>();
  private readonly currentAreaByTown = new Map<string, string>();
  private readonly travelLog: TravelLogEntry[] = [];
  private readonly journalEntries: OverworldJournalEntry[] = [];
  private readonly journalEntriesById = new Map<string, OverworldJournalEntry>();
  private readonly resolvedEventIds = new Set<string>();
  private readonly resolvedEventHomeIds = new Set<string>();
  private readonly discoveredAreaIds = new Set<string>();
  private readonly visitedAreaIds = new Set<string>();
  private readonly discoveredJobIds = new Set<string>();
  private readonly completedJobIds = new Set<string>();
  private readonly discoveredSiteIds = new Set<string>();
  private readonly discoveredQuestIds = new Set<string>();
  private readonly startedQuestIds = new Set<string>();
  private readonly completedQuestIds = new Set<string>();
  private readonly questLaunchCharacters = new Map<string, CampaignCharacterState>();
  private readonly questOutcomeIds = new Map<string, string>();
  private readonly exploredSiteIds = new Set<string>();
  private readonly regionRenown = new Map<string, number>();
  private readonly completedRegionalArcIds = new Set<string>();
  private pendingRoadEncounter: OverworldPendingRoadEncounter | null = null;
  private characterState: CampaignCharacterState = createInitialCampaignCharacterState();
  private journeyState: JourneyContractSnapshot = createInitialJourneyContractSnapshot();
  private openingLeadSourceDecisionTrail: OverworldOpeningLeadSourceDecisionTrail | null = null;
  private questCharacterDeathBoundary: OverworldQuestCharacterDeathBoundary | null = null;
  /**
   * Story-choice reveals the player has already opened, as ordinary session state.
   *
   * The MCP layer gates duty selection on this and hard-throws when it is absent, so
   * it is LEGALITY, not presentation — and this engine's whole contract is that legality
   * is a function of state. It lived in a WeakMap keyed by the live session object,
   * deliberately outside the snapshot, which meant exporting and restoring a session
   * silently revoked a gate the player had already satisfied: they had opened the
   * compass, and after a restore they could no longer take the choice it unlocked.
   * Persisting it makes an exported session fully resumable and keeps legality derivable.
   */
  private inspectedStoryReveals = new Map<string, Set<string>>();
  /** Read-only compact Station support reveals, persisted independently of story legality. */
  private stationDispatchSupportReveals = new Map<string, string>();
  private restoreWarningList: readonly string[] = Object.freeze([]);
  private readonly journeyGoalBaseRouteByEndpoints = new Map<string, OverworldRoutePlan>();
  private readonly journeyGoalGuidanceByRoute = new Map<string, string>();
  private readonly caches: OverworldSessionCaches = {};

  constructor(private readonly world: OverworldManifest) {
    const indexes = buildOverworldSessionIndexes(world);
    this.nodes = indexes.nodes;
    this.roadExitsByTown = indexes.roadExitsByTown;
    this.roadExitsByTownAndId = indexes.roadExitsByTownAndId;
    this.roadEventsByEdgeId = indexes.roadEventsByEdgeId;
    this.areasById = indexes.areasById;
    this.areasByTown = indexes.areasByTown;
    this.areaExitsByArea = indexes.areaExitsByArea;
    this.areaExitsByAreaAndId = indexes.areaExitsByAreaAndId;
    this.poisById = indexes.poisById;
    this.poisByArea = indexes.poisByArea;
    this.charactersById = indexes.charactersById;
    this.charactersByArea = indexes.charactersByArea;
    this.eventsByArea = indexes.eventsByArea;
    this.localEventsById = indexes.localEventsById;
    this.jobsById = indexes.jobsById;
    this.jobsByTown = indexes.jobsByTown;
    this.sitesById = indexes.sitesById;
    this.sitesByArea = indexes.sitesByArea;
    this.questsById = indexes.questsById;
    this.questsByTown = indexes.questsByTown;
    this.regionalArcsByRegion = indexes.regionalArcsByRegion;
    this.regionalArcAnchorTownsById = indexes.regionalArcAnchorTownsById;
    this.routePlannerIndex = indexes.routePlannerIndex;
    this.snapshotManifestIndex = indexes.snapshotManifestIndex;
    this.worldHash = indexes.worldHash;
    this.currentId = world.start;
    this.markSeen(world.start);
  }

  static restore(world: OverworldManifest, rawSnapshot: unknown): OverworldSession {
    const snapshot = parseOverworldSessionSnapshot(rawSnapshot);
    const session = new OverworldSession(world);
    session.applySnapshot(snapshot);
    return session;
  }

  private clearSessionCaches(): void {
    clearOverworldSessionCaches(this.caches);
  }

  private applyClockState(state: OverworldClockState): void {
    this.minutes = state.minutesAfter;
  }

  private applyResourceClockState(state: OverworldResourceClockState): void {
    this.supplies = state.suppliesAfter;
    this.fatigue = state.fatigueAfter;
    this.applyClockState(state);
  }

  private applyCurrentTownState(state: OverworldCurrentTownState): void {
    this.currentId = state.currentIdAfter;
  }

  private applyCurrentAreaState(state: OverworldCurrentAreaState): void {
    this.currentAreaId = state.currentAreaIdAfter;
  }

  private applyCurrentAreaTravelState(state: OverworldCurrentAreaTravelState): void {
    this.applyClockState(state);
    this.applyCurrentAreaState(state);
  }

  private applyPendingRoadEncounterState(state: OverworldPendingRoadEncounterState): void {
    this.pendingRoadEncounter = state.pendingRoadEncounterAfter;
  }

  private assertNoPendingRoadEncounter(action: string): void {
    if (this.pendingRoadEncounter) {
      throw new Error(`Resolve the pending road encounter before ${action}.`);
    }
  }

  private cachedSnapshot(): OverworldSessionSnapshotCache {
    if (this.caches.snapshot) return this.caches.snapshot;
    const snapshot = this.buildSnapshot();
    const hash = hashState(snapshot);
    this.caches.snapshot = { snapshot, hash };
    return this.caches.snapshot;
  }

  snapshotHash(): string {
    return this.cachedSnapshot().hash;
  }

  snapshot(): OverworldSessionSnapshot {
    return cloneOverworldSessionSnapshot(this.cachedSnapshot().snapshot);
  }

  /** Non-fatal compatibility notices emitted while restoring this session. */
  restoreWarnings(): readonly string[] {
    return [...this.restoreWarningList];
  }

  /**
   * Trusted quest-launch input. The clone keeps the persistent character owned
   * by this session; an embedded RPG can project it without gaining a mutable
   * reference back into the overworld.
   */
  campaignCharacterState(): CampaignCharacterState {
    return cloneCampaignCharacterState(this.characterState);
  }

  /** Character proven at this quest's authored launch boundary. */
  questLaunchCharacterState(questId: string): CampaignCharacterState | null {
    const character = this.questLaunchCharacters.get(questId);
    return character ? cloneCampaignCharacterState(character) : null;
  }

  /** Derived historical world truth; detached so callers cannot mutate session state. */
  campaignWorldFactIds(): string[] {
    return deriveCampaignWorldFactIds(
      questCampaignEffectGroupsForOutcomes(this.questsById, this.questOutcomeIds),
    );
  }

  private consumedCampaignServiceRuleIds(): Set<string> {
    return new Set(
      this.journalEntries.flatMap((entry) =>
        entry.kind === "service" && entry.serviceRuleId ? [entry.serviceRuleId] : [],
      ),
    );
  }

  /** Only exact authored option proofs can activate a local-job service. */
  private completedLocalJobOptions(): CampaignServiceLocalJobOption[] {
    return this.journalEntries.flatMap((entry) => {
      if (entry.kind !== "job" || !entry.id.startsWith("job:")) return [];
      const jobId = entry.id.slice("job:".length);
      const job = this.jobsById.get(jobId);
      const proof = entry.localSceneProof;
      if (
        !job?.authored_scene ||
        !proof ||
        proof.sceneId !== job.authored_scene.id ||
        !job.authored_scene.options.some((option) => option.id === proof.optionId)
      ) {
        return [];
      }
      return [{ job_id: jobId, option_id: proof.optionId }];
    });
  }

  private campaignServiceOffers(currentAreaId: string): CampaignServiceOffer[] {
    return resolveCampaignServiceRules({
      rules: this.world.campaign_service_rules ?? [],
      currentTownId: this.currentId,
      currentAreaId,
      worldFactIds: this.campaignWorldFactIds(),
      selectedStoryChoices: this.selectedCampaignStoryChoiceRefs(),
      consumedRuleIds: this.consumedCampaignServiceRuleIds(),
      completedLocalJobOptions: this.completedLocalJobOptions(),
      character: this.characterState,
      regionRenown: this.regionRenown,
      providersById: this.charactersById,
    });
  }

  private townServicePlanState(currentAreaId: string): OverworldSessionTownServicePlanState {
    return {
      currentTown: this.currentNode(),
      currentAreaId,
      campaignServiceRules: this.world.campaign_service_rules ?? [],
      campaignWorldFactIds: this.campaignWorldFactIds(),
      campaignStoryChoiceRefs: this.selectedCampaignStoryChoiceRefs(),
      consumedCampaignServiceRuleIds: this.consumedCampaignServiceRuleIds(),
      completedLocalJobOptions: this.completedLocalJobOptions(),
      campaignCharacter: this.characterState,
      regionRenown: this.regionRenown,
      fatigue: this.fatigue,
      supplies: this.supplies,
    };
  }

  private currentServiceActions(currentAreaId: string): OverworldServiceActionPresentation[] {
    if (
      this.pendingRoadEncounter !== null ||
      this.journeyState.status !== "active" ||
      this.journey().storyChoice !== null
    ) {
      return [];
    }
    return presentOverworldServiceActions(this.townServicePlanState(currentAreaId));
  }

  private currentGoalRoute(): OverworldSessionRoutePlan | null {
    const goal = this.journeyState.goal;
    if (goal.version === INITIAL_JOURNEY_GOAL.version || goal.status !== "active") return null;
    const definition = journeyCampaignGoalDefinition(goal);
    if (!definition) return null;
    const destination = this.nodes.get(definition.targetTownId);
    if (!destination) return null;
    const cacheKey = `${this.currentId}->${destination.id}`;
    let route = this.journeyGoalBaseRouteByEndpoints.get(cacheKey);
    if (!route) {
      route =
        indexedOverworldRoute(this.routePlannerIndex, this.currentId, destination.id) ?? undefined;
      if (!route) return null;
      this.journeyGoalBaseRouteByEndpoints.set(cacheKey, route);
    }
    return withOverworldRouteEstimate(
      withOverworldSessionRoadEvents(route, {
        activeGoalId: this.journeyState.goal.id,
        completedQuestIds: this.completedQuestIds,
        travelLog: this.travelLog,
      }),
      { fatigue: this.fatigue, supplies: this.supplies },
    );
  }

  private journeyGoalGuidance(route: OverworldSessionRoutePlan | null): string | null {
    const goal = this.journeyState.goal;
    const definition = journeyCampaignGoalDefinition(goal);
    if (!definition || !route) return null;
    const destination = route.destination;
    const area = this.areasById.get(definition.targetAreaId);
    if (!area) return null;
    if (this.currentId === destination.id) {
      return this.currentAreaId === area.id
        ? `You reached the goal location: ${area.name}. Use the visible lead here.`
        : `You reached the goal town. Move toward ${area.name} to find the lead.`;
    }

    const cacheKey = `${this.currentId}->${destination.id}`;
    const cached = this.journeyGoalGuidanceByRoute.get(cacheKey);
    if (cached) return cached;
    const next = route?.steps[0]?.to;
    if (!next) return null;
    const roadCount = route.steps.length;
    const guidance = `Next road: ${next.name}. ${destination.name} is ${String(roadCount)} ${roadCount === 1 ? "road" : "roads"} away, about ${String(route.totalMinutes)} travel minutes.`;
    this.journeyGoalGuidanceByRoute.set(cacheKey, guidance);
    return guidance;
  }

  private journeyGoalPassage(
    route: OverworldSessionRoutePlan | null,
    storyChoice: JourneyPresentationContext["storyChoice"],
  ): JourneyPresentationContext["goalPassage"] {
    if (
      !route ||
      route.steps.length === 0 ||
      this.journeyState.status !== "active" ||
      this.pendingRoadEncounter !== null ||
      storyChoice
    ) {
      return null;
    }
    return buildJourneyGoalPassagePresentation(route);
  }

  private openingRegistrationEligible(): NonNullable<
    OverworldManifest["opening_registration"]
  > | null {
    const registration = this.world.opening_registration;
    if (
      !registration ||
      this.journeyState.status === "ended" ||
      this.currentId !== registration.home ||
      this.currentAreaId !== registration.area ||
      this.startedQuestIds.size > 0 ||
      this.completedQuestIds.size > 0 ||
      serializeCampaignCharacterState(this.characterState) !== DEFAULT_CAMPAIGN_CHARACTER_SERIALIZED
    ) {
      return null;
    }
    return registration;
  }

  private openingRegistrationAvailable(): NonNullable<
    OverworldManifest["opening_registration"]
  > | null {
    if (this.journeyState.status !== "active") return null;
    const registration = this.openingRegistrationEligible();
    if (!registration) return null;
    const latestEntry = this.journalEntries[0];
    if (
      latestEntry?.kind !== "registration_offer" ||
      latestEntry.id !== openingRegistrationOfferJournalId(registration.id)
    ) {
      return null;
    }
    return registration;
  }

  /**
   * Resolve every authored reference before a role-anchored quick setup
   * starts the canonical oath → source sequence. The sequence itself deliberately
   * reuses chooseJourneyStory so its durable proof boundaries remain identical
   * to two ordinary selections after the already-recorded role choice.
   */
  private preflightOpeningReliefOathStandardPacket(
    registration: NonNullable<OverworldManifest["opening_registration"]>,
    reliefOath: NonNullable<OverworldManifest["opening_relief_oath"]>,
    doctrineId: string,
  ) {
    const doctrine = registration.doctrines?.find((candidate) => candidate.id === doctrineId);
    if (!doctrine) return null;

    const profile = registration.profiles.find((candidate) => candidate.id === doctrine.profile_id);
    if (!profile) {
      throw new Error(
        `Opening doctrine "${doctrine.id}" references unknown registration profile "${doctrine.profile_id}".`,
      );
    }
    if (this.characterState.background !== profile.id) {
      throw new Error(
        `Opening quick setup "${doctrine.id}" does not match registered role "${String(this.characterState.background)}".`,
      );
    }

    if (
      reliefOath.after_registration !== registration.id ||
      reliefOath.home !== registration.home ||
      reliefOath.area !== registration.area
    ) {
      throw new Error(`Opening doctrine "${doctrine.id}" requires a compatible relief-oath scene.`);
    }
    const reliefOathOption = reliefOath.options.find(
      (candidate) => candidate.id === doctrine.relief_oath_option_id,
    );
    if (!reliefOathOption) {
      throw new Error(
        `Opening doctrine "${doctrine.id}" references unknown relief-oath option "${doctrine.relief_oath_option_id}".`,
      );
    }

    const leadSource = this.world.opening_lead_source;
    if (
      !leadSource ||
      leadSource.after_registration !== registration.id ||
      leadSource.home !== registration.home ||
      leadSource.area !== registration.area ||
      leadSource.target_quest !== reliefOath.target_quest ||
      !this.questsById.has(leadSource.target_quest)
    ) {
      throw new Error(`Opening doctrine "${doctrine.id}" requires a compatible lead-source scene.`);
    }
    const leadSourceOption = leadSource.options.find(
      (candidate) => candidate.id === doctrine.lead_source_option_id,
    );
    if (!leadSourceOption) {
      throw new Error(
        `Opening doctrine "${doctrine.id}" references unknown lead-source option "${doctrine.lead_source_option_id}".`,
      );
    }

    // Validate the canonical state transformations before mutating this
    // session. The live sequence below still owns the durable journals and
    // accepted-decision proofs.
    const swornCharacter = applyOpeningReliefOathOption({
      scene: reliefOath,
      character: this.characterState,
      optionId: reliefOathOption.id,
    }).characterAfter;
    applyOpeningLeadSourceOption({
      scene: leadSource,
      character: swornCharacter,
      optionId: leadSourceOption.id,
    });

    return Object.freeze({
      doctrine,
      profile,
      reliefOath,
      reliefOathOption,
      leadSource,
      leadSourceOption,
    });
  }

  private openingStandardPacketReceipt(args: {
    doctrine: OpeningStartingDoctrine;
    profileTitle: string;
    reliefOathTitle: string;
    leadSourceTitle: string;
  }): string {
    return (
      `${args.doctrine.preview} Cost: ${args.doctrine.immediate_cost}. ` +
      `${args.doctrine.consequence} Background: ${args.profileTitle}. ` +
      `Promise: ${args.reliefOathTitle}. Report: ${args.leadSourceTitle}.`
    );
  }

  private openingStandardPacketPlayerSummary(args: {
    profileTitle: string;
    reliefOathTitle: string;
    leadSourceTitle: string;
  }): string {
    const promiseTitle = args.reliefOathTitle.replace(/\bDuty\b/gu, "Promise");
    return (
      `Quick setup chosen. Background: ${args.profileTitle}. ` +
      `Wolf-Winter promise: ${promiseTitle}. Report: ${args.leadSourceTitle}. ` +
      "You can still choose a field kit, relief wagon, second rider, and route."
    );
  }

  private openingLeadSourceResolved(): boolean {
    return this.journalEntries.some((entry) => entry.kind === "lead_source");
  }

  private openingReliefOathResolved(): boolean {
    return this.journalEntries.some((entry) => entry.kind === "relief_oath");
  }

  private openingPreparationResolved(): boolean {
    return this.journalEntries.some((entry) => entry.kind === "preparation");
  }

  private openingReliefAllocationResolved(): boolean {
    return this.journalEntries.some((entry) => entry.kind === "relief_allocation");
  }

  /**
   * Read-only terminal affordance truth for the two authored optional Station
   * decisions. Exact scene ids alone may inherit the current-or-legacy journal
   * authority above; mandatory story ids, option ids, and unknown ids do not.
   */
  isDepartureStoryChoiceResolved(storyChoiceId: string): boolean {
    if (this.world.opening_preparation?.id === storyChoiceId) {
      return this.openingPreparationResolved();
    }
    if (this.world.opening_relief_allocation?.id === storyChoiceId) {
      return this.openingReliefAllocationResolved();
    }
    return false;
  }

  private openingAllyResolved(): boolean {
    return this.journalEntries.some((entry) => entry.kind === "ally");
  }

  private openingDispatchHubAvailable(): ReturnType<typeof resolveOpeningDispatchManifestChain> {
    const chain = resolveOpeningDispatchManifestChain(this.world);
    if (
      !chain ||
      !this.openingLeadSourceResolved() ||
      this.journeyState.status !== "active" ||
      this.journeyState.pendingChoice !== null ||
      this.pendingRoadEncounter !== null ||
      this.currentId !== chain.preparation.home ||
      this.currentAreaId !== chain.preparation.area ||
      !this.discoveredQuestIds.has(chain.quest.id) ||
      this.startedQuestIds.has(chain.quest.id) ||
      this.completedQuestIds.has(chain.quest.id)
    ) {
      return null;
    }
    return chain;
  }

  private openingDispatchSupportChoicePending(): boolean {
    return (
      this.openingPreparationAvailable() !== null ||
      this.openingReliefAllocationAvailable() !== null ||
      this.openingAllyAvailable() !== null
    );
  }

  private openingAllyAvailable(): NonNullable<OverworldManifest["opening_ally"]> | null {
    const scene = this.world.opening_ally;
    if (!scene || this.journeyState.status !== "active" || this.openingAllyResolved()) {
      return null;
    }
    const latestEntry = this.journalEntries[0];
    if (
      latestEntry?.kind !== "ally_offer" ||
      latestEntry.id !== openingAllyOfferJournalId(scene.id)
    ) {
      return null;
    }
    return scene;
  }

  private openingPreparationAvailable(): NonNullable<
    OverworldManifest["opening_preparation"]
  > | null {
    const scene = this.world.opening_preparation;
    if (!scene || this.journeyState.status !== "active" || this.openingPreparationResolved()) {
      return null;
    }
    const latestEntry = this.journalEntries[0];
    if (
      latestEntry?.kind !== "preparation_offer" ||
      latestEntry.id !== openingPreparationOfferJournalId(scene.id)
    ) {
      return null;
    }
    return scene;
  }

  private openingReliefAllocationAvailable(): NonNullable<
    OverworldManifest["opening_relief_allocation"]
  > | null {
    const scene = this.world.opening_relief_allocation;
    if (!scene || this.journeyState.status !== "active" || this.openingReliefAllocationResolved()) {
      return null;
    }
    const latestEntry = this.journalEntries[0];
    if (
      latestEntry?.kind !== "relief_allocation_offer" ||
      latestEntry.id !== openingReliefAllocationOfferJournalId(scene.id)
    ) {
      return null;
    }
    return scene;
  }

  private openingPreparationDepartureInteractionAvailable(): NonNullable<
    OverworldManifest["opening_preparation"]
  > | null {
    const chain = this.openingDispatchHubAvailable();
    if (chain) {
      return this.openingPreparationResolved() || this.openingDispatchSupportChoicePending()
        ? null
        : chain.preparation;
    }
    // Trusted predecessor manifests retain their original sequential runtime;
    // only the complete current chain opts into the order-neutral hub.
    const scene = this.world.opening_preparation;
    const leadSource = this.world.opening_lead_source;
    return scene &&
      leadSource &&
      scene.after_lead_source === leadSource.id &&
      this.openingLeadSourceResolved() &&
      !this.openingPreparationResolved() &&
      this.openingPreparationAvailable() === null &&
      this.journeyState.status === "active" &&
      this.journeyState.pendingChoice === null &&
      this.pendingRoadEncounter === null &&
      this.currentId === scene.home &&
      this.currentAreaId === scene.area &&
      !this.startedQuestIds.has(scene.target_quest) &&
      !this.completedQuestIds.has(scene.target_quest)
      ? scene
      : null;
  }

  private openingReliefAllocationDepartureInteractionAvailable(): NonNullable<
    OverworldManifest["opening_relief_allocation"]
  > | null {
    const chain = this.openingDispatchHubAvailable();
    if (chain) {
      return this.openingReliefAllocationResolved() || this.openingDispatchSupportChoicePending()
        ? null
        : chain.reliefAllocation;
    }
    const scene = this.world.opening_relief_allocation;
    const preparation = this.world.opening_preparation;
    return scene &&
      preparation &&
      scene.after_preparation === preparation.id &&
      this.openingPreparationResolved() &&
      !this.openingReliefAllocationResolved() &&
      this.openingReliefAllocationAvailable() === null &&
      this.journeyState.status === "active" &&
      this.journeyState.pendingChoice === null &&
      this.pendingRoadEncounter === null &&
      this.currentId === scene.home &&
      this.currentAreaId === scene.area &&
      !this.startedQuestIds.has(scene.target_quest) &&
      !this.completedQuestIds.has(scene.target_quest) &&
      this.openingAllyAvailable() === null
      ? scene
      : null;
  }

  private departureInteractions(): OverworldDepartureInteraction[] {
    const interactions: OverworldDepartureInteraction[] = [];
    const preparation = this.openingPreparationDepartureInteractionAvailable();
    if (preparation) {
      interactions.push(
        overworldDepartureInteraction({
          id: preparation.id,
          kind: "preparation",
          title: "Field kit",
        }),
      );
    }
    const allocation = this.openingReliefAllocationDepartureInteractionAvailable();
    if (allocation) {
      interactions.push(
        overworldDepartureInteraction({
          id: allocation.id,
          kind: "relief_allocation",
          title: "Relief wagon",
        }),
      );
    }
    return interactions;
  }

  private departureContactLeads(): OverworldDepartureContactLead[] {
    const chain = this.openingDispatchHubAvailable();
    const scene = chain?.ally ?? this.world.opening_ally;
    if (!scene) return [];
    if (chain) {
      if (this.openingAllyResolved() || this.openingDispatchSupportChoicePending()) return [];
    } else {
      const preparation = this.world.opening_preparation;
      if (
        !preparation ||
        scene.after_preparation !== preparation.id ||
        !this.openingLeadSourceResolved() ||
        this.openingAllyResolved() ||
        this.openingAllyAvailable() !== null ||
        this.openingPreparationAvailable() !== null ||
        this.journeyState.status !== "active" ||
        this.journeyState.pendingChoice !== null ||
        this.pendingRoadEncounter !== null ||
        this.currentId !== scene.home ||
        this.currentAreaId !== scene.area ||
        this.startedQuestIds.size > 0 ||
        this.completedQuestIds.size > 0
      ) {
        return [];
      }
    }
    const contact = this.charactersById.get(scene.contact);
    const quest = this.questsById.get(scene.target_quest);
    if (!contact || !quest) return [];
    return [
      overworldDepartureContactLead({
        id: scene.id,
        title: "Second rider",
        contactId: contact.id,
        contactName: contact.name,
        questId: quest.id,
        questTitle: quest.title,
        status: chain || this.openingPreparationResolved() ? "ready" : "requires_preparation",
        timing: openingAllyContactTimingSummary(
          scene,
          this.journalEntriesById.has(overworldContactTalkJournalId(scene.contact, null)),
        ),
      }),
    ];
  }

  private departureRecap(): OpeningDepartureRecap | null {
    const preparation = this.world.opening_preparation;
    if (
      !preparation ||
      this.journeyState.status !== "active" ||
      this.journeyState.pendingChoice !== null ||
      this.pendingRoadEncounter !== null ||
      this.currentId !== preparation.home ||
      this.currentAreaId !== preparation.area ||
      !this.discoveredQuestIds.has(preparation.target_quest) ||
      this.startedQuestIds.has(preparation.target_quest) ||
      this.completedQuestIds.has(preparation.target_quest)
    ) {
      return null;
    }
    return deriveOpeningDepartureRecap({
      world: this.world,
      journalEntries: this.journalEntries,
    });
  }

  private presentOpeningPreparationAtCurrentBoundary(
    preparation: NonNullable<OverworldManifest["opening_preparation"]>,
  ): JourneyStoryChoicePrompt {
    return withOpeningPreparationDispatchForecast({
      prompt: presentOpeningPreparation(preparation, this.characterState),
      inputs: {
        world: this.world,
        journalEntries: this.journalEntries,
        currentTownId: this.currentId,
        currentAreaId: this.currentAreaId,
        journeyActive: this.journeyState.status === "active",
        acceptedDecisions: this.journeyState.acceptedDecisions,
        decisionProofHash: this.journeyState.decisionProof.hash,
        currentMinutes: this.minutes,
        targetQuestStarted: this.startedQuestIds.has(preparation.target_quest),
        targetQuestCompleted: this.completedQuestIds.has(preparation.target_quest),
      },
    });
  }

  private withOpeningStationDispatchImpact(
    prompt: JourneyStoryChoicePrompt | null | undefined,
  ): JourneyStoryChoicePrompt | null | undefined {
    if (!prompt) return prompt;
    const sanitized = () => stripOpeningStationDispatchImpact(prompt)!;
    const kind = prompt.kind;
    if (kind !== "relief_allocation" && kind !== "ally") return sanitized();
    const chain = resolveOpeningDispatchManifestChain(this.world);
    if (
      !chain ||
      (kind === "relief_allocation" && prompt.id !== chain.reliefAllocation.id) ||
      (kind === "ally" && (!chain.ally || prompt.id !== chain.ally.id)) ||
      this.journeyState.status !== "active" ||
      this.startedQuestIds.has(chain?.quest.id ?? "") ||
      this.completedQuestIds.has(chain?.quest.id ?? "") ||
      this.currentId !== chain.preparation.home ||
      this.currentAreaId !== chain.preparation.area
    ) {
      return sanitized();
    }
    const boundary = Object.freeze({
      acceptedDecisions: this.journeyState.acceptedDecisions,
      decisionProofHash: this.journeyState.decisionProof.hash,
      townId: this.currentId,
      areaId: this.currentAreaIdOrThrow(),
      minutes: this.minutes,
    });
    try {
      const journalEntries =
        kind === "relief_allocation" &&
        !this.journalEntries.some((entry) => entry.kind === "relief_allocation_offer")
          ? [
              openingReliefAllocationOfferJournalEntry({
                scene: chain.reliefAllocation,
                town: this.currentNode().name,
                recordedAt: timeLabel(boundary.minutes),
                storyChoiceBoundary: boundary,
              }),
              ...this.journalEntries,
            ]
          : this.journalEntries;
      const window = deriveQuestDispatchPresentationWindow({
        questId: chain.quest.id,
        journalEntries,
        openingRegistration: chain.registration,
        openingReliefOath: chain.reliefOath,
        openingLeadSource: chain.leadSource,
        openingPreparation: chain.preparation,
        openingReliefAllocation: chain.reliefAllocation,
        openingAlly: chain.ally,
      });
      const baseline =
        window.status === "support_choices_open" &&
        ((kind === "relief_allocation" &&
          window.receipt.reliefAllocation.kind === "open_optional") ||
          (kind === "ally" && window.receipt.juneCommitment.kind === "open_optional"))
          ? window.committedMinutes
          : undefined;
      if (baseline === undefined) return sanitized();
      const sourceOptions =
        kind === "relief_allocation" ? chain.reliefAllocation.options : chain.ally!.options;
      if (
        sourceOptions.length !== prompt.options.length ||
        sourceOptions.some((source) => !prompt.options.some((option) => option.id === source.id))
      ) {
        return sanitized();
      }
      return Object.freeze({
        ...prompt,
        options: Object.freeze(
          prompt.options.map((option) => {
            const source = sourceOptions.find((candidate) => candidate.id === option.id)!;
            const addedMinutes = source.terms.minutes;
            const resultingMinutes = baseline + addedMinutes;
            const timing = classifyQuestDispatchMinutes(resultingMinutes);
            const line = `Dispatch: ${
              addedMinutes === 0 ? "no added delay" : `+${String(addedMinutes)}m delay`
            } → ${String(resultingMinutes)}m committed (${timing === "on_time" ? "on time" : "delayed"}).`;
            if (line.length > 78)
              throw new Error("Opening Station dispatch impact exceeds card limit.");
            return Object.freeze({
              ...option,
              dispatchImpact: Object.freeze({
                schemaVersion: 1 as const,
                resultingMinutes,
                timing,
                addedMinutes,
                line,
                proofHash: hashState({
                  schemaVersion: 1,
                  promptId: prompt.id,
                  kind,
                  optionId: option.id,
                  baseline,
                  addedMinutes,
                  resultingMinutes,
                  timing,
                  dispatchProofHash: window.proofHash,
                }),
              }),
            });
          }),
        ),
      }) as JourneyStoryChoicePrompt;
    } catch {
      return sanitized();
    }
  }

  /**
   * Record that the player has opened a story choice's progressive-disclosure reveal.
   * The single accessor pair the MCP gate reads and writes, so reveal legality is
   * derived from session state rather than from where the call happened to arrive.
   */
  private rememberStoryReveal(storyChoiceId: string, revealId: string): void {
    let reveals = this.inspectedStoryReveals.get(storyChoiceId);
    if (!reveals) {
      reveals = new Set<string>();
      this.inspectedStoryReveals.set(storyChoiceId, reveals);
    }
    if (reveals.has(revealId)) return;
    reveals.add(revealId);
    this.clearSessionCaches();
  }

  private storyRevealWasInspected(storyChoiceId: string, revealId: string): boolean {
    return this.inspectedStoryReveals.get(storyChoiceId)?.has(revealId) === true;
  }

  private stationDispatchSupportWasRevealed(questId: string): boolean {
    return this.stationDispatchSupportReveals.get(questId) === STATION_DISPATCH_SUPPORT_REVEAL_ID;
  }

  private currentStationDispatchSupportWasRevealed(): boolean {
    const chain = resolveOpeningDispatchManifestChain(this.world);
    return chain ? this.stationDispatchSupportWasRevealed(chain.quest.id) : false;
  }

  /**
   * Record the exact compact Station disclosure without accepting a decision.
   * The current authenticated hub supplies the quest key; unknown or stale ids fail closed.
   */
  revealStationDispatchSupport(revealId: string): void {
    const chain = this.openingDispatchHubAvailable();
    const board = chain ? this.view().stationDispatchBoard : null;
    if (!chain || !board || board.questId !== chain.quest.id) {
      throw new Error("Station optional support is not reviewable at the current boundary.");
    }
    if (revealId !== STATION_DISPATCH_SUPPORT_REVEAL_ID) {
      throw new Error(`Unknown Station optional-support reveal "${revealId}".`);
    }
    if (!board.support.some((entry) => entry.status === "open_optional")) {
      throw new Error("Station optional support is already sealed.");
    }
    const prior = this.stationDispatchSupportReveals.get(chain.quest.id);
    if (prior === revealId) return;
    if (prior !== undefined) {
      throw new Error(`Station dispatch "${chain.quest.id}" has a different reveal receipt.`);
    }
    this.stationDispatchSupportReveals.set(chain.quest.id, revealId);
    this.clearSessionCaches();
  }

  /**
   * Reveal receipts are authority for hidden story options, so restoring them
   * requires more than schema-valid strings. Every tuple must name a story that
   * is inspectable at this exact boundary and must contain exactly that story's
   * one authored progressive-disclosure id.
   */
  private assertSnapshotStoryRevealReceipts(snapshot: OverworldSessionSnapshot): void {
    const seenStoryChoiceIds = new Set<string>();
    for (const [storyChoiceId, revealIds] of snapshot.inspectedStoryReveals ?? []) {
      if (seenStoryChoiceIds.has(storyChoiceId)) {
        throw new Error(
          `Overworld session snapshot repeats story reveal receipt "${storyChoiceId}".`,
        );
      }
      seenStoryChoiceIds.add(storyChoiceId);
      if (new Set(revealIds).size !== revealIds.length) {
        throw new Error(
          `Overworld session snapshot repeats a reveal id for story "${storyChoiceId}".`,
        );
      }

      let story: JourneyStoryChoicePrompt;
      try {
        story = this.inspectJourneyStory(storyChoiceId);
      } catch {
        throw new Error(
          `Overworld session snapshot story reveal receipt "${storyChoiceId}" is not currently inspectable.`,
        );
      }
      const authoredRevealId = story.progressiveDisclosure?.reveal.id;
      if (
        authoredRevealId === undefined ||
        revealIds.length !== 1 ||
        revealIds[0] !== authoredRevealId
      ) {
        throw new Error(
          `Overworld session snapshot story reveal receipt "${storyChoiceId}" must contain exactly its authored progressive-disclosure id.`,
        );
      }
    }
  }

  /** Authenticate additive compact Station receipts against the exact opening lifecycle. */
  private assertSnapshotStationDispatchSupportReveals(snapshot: OverworldSessionSnapshot): void {
    const receipts = snapshot.stationDispatchSupportReveals ?? [];
    if (new Set(receipts.map(([questId]) => questId)).size !== receipts.length) {
      throw new Error("Overworld session snapshot repeats a Station support reveal receipt.");
    }
    if (receipts.length === 0) return;
    const chain = resolveOpeningDispatchManifestChain(this.world);
    const supportStillOpen =
      !this.openingPreparationResolved() ||
      !this.openingReliefAllocationResolved() ||
      (chain?.ally !== null && !this.openingAllyResolved());
    const exactLifecycle =
      chain !== null &&
      this.journeyState.status !== "ended" &&
      this.discoveredQuestIds.has(chain.quest.id) &&
      !this.startedQuestIds.has(chain.quest.id) &&
      !this.completedQuestIds.has(chain.quest.id) &&
      supportStillOpen;
    if (
      receipts.length !== 1 ||
      !chain ||
      !exactLifecycle ||
      receipts[0]![0] !== chain.quest.id ||
      receipts[0]![1] !== STATION_DISPATCH_SUPPORT_REVEAL_ID
    ) {
      throw new Error(
        "Overworld session snapshot Station support reveal must match its exact open dispatch.",
      );
    }
  }

  private forgetStationDispatchSupportReveal(questId: string): void {
    if (!this.stationDispatchSupportReveals.delete(questId)) return;
    this.clearSessionCaches();
  }

  private forgetSealedStationDispatchSupportReveal(): void {
    const chain = resolveOpeningDispatchManifestChain(this.world);
    if (!chain) return;
    const supportSealed =
      this.openingPreparationResolved() &&
      this.openingReliefAllocationResolved() &&
      (chain.ally === null || this.openingAllyResolved());
    if (supportSealed) this.forgetStationDispatchSupportReveal(chain.quest.id);
  }

  /** Drop every reveal receipt — the story is decided, so the gate has no more work. */
  private forgetStoryReveals(): void {
    if (this.inspectedStoryReveals.size === 0) return;
    this.inspectedStoryReveals.clear();
    this.clearSessionCaches();
  }

  inspectJourneyStory(storyChoiceId: string): JourneyStoryChoicePrompt {
    assertJourneyContractAcceptingDecision(this.journeyState);
    const presented = this.journey().storyChoice;
    if (presented) {
      if (presented.id !== storyChoiceId) {
        throw new Error(
          `Finish the presented story choice "${presented.id}" before inspecting "${storyChoiceId}".`,
        );
      }
      return presented;
    }
    const preparation = this.openingPreparationDepartureInteractionAvailable();
    if (preparation?.id === storyChoiceId) {
      return this.withOpeningStationDispatchImpact(
        withOpeningDispatchBriefing(
          this.world,
          this.presentOpeningPreparationAtCurrentBoundary(preparation),
        ),
      )!;
    }
    const allocation = this.openingReliefAllocationDepartureInteractionAvailable();
    if (allocation?.id === storyChoiceId) {
      return this.withOpeningStationDispatchImpact(
        withOpeningDispatchBriefing(
          this.world,
          presentOpeningReliefAllocation(allocation, this.characterState),
        ),
      )!;
    }
    throw new Error(
      `Departure story choice "${storyChoiceId}" is not available at the current location and journey boundary.`,
    );
  }

  /**
   * Open a progressive-disclosure branch and persist that receipt with the session.
   * Every transport calls this method; no UI or protocol adapter owns legality.
   */
  revealJourneyStory(storyChoiceId: string, revealId: string): JourneyStoryChoicePrompt {
    const story = this.inspectJourneyStory(storyChoiceId);
    if (this.storyRevealWasInspected(storyChoiceId, revealId)) return story;
    journeyStoryChoiceOptionsForPresentation(story, revealId);
    this.rememberStoryReveal(storyChoiceId, revealId);
    return this.inspectJourneyStory(storyChoiceId);
  }

  /** Validate an option-detail request against the session's durable reveal receipt. */
  inspectJourneyStoryOption(storyChoiceId: string, optionId: string): JourneyStoryChoicePrompt {
    const story = this.inspectJourneyStory(storyChoiceId);
    this.assertJourneyStoryOptionVisible(story, optionId);
    return story;
  }

  /** The only presentation projection for options unlocked in this session. */
  journeyStoryOptionsForPresentation(storyChoiceId: string): readonly JourneyStoryChoiceOption[] {
    const story = this.inspectJourneyStory(storyChoiceId);
    const disclosure = story.progressiveDisclosure;
    const revealId =
      disclosure && this.storyRevealWasInspected(story.id, disclosure.reveal.id)
        ? disclosure.reveal.id
        : undefined;
    return journeyStoryChoiceOptionsForPresentation(story, revealId);
  }

  private assertJourneyStoryOptionVisible(
    story: JourneyStoryChoicePrompt,
    optionId: string,
  ): JourneyStoryChoiceOption {
    const option = story.options.find((candidate) => candidate.id === optionId);
    if (!option) {
      throw new Error(`Story choice "${story.id}" does not offer option "${optionId}".`);
    }
    const disclosure = story.progressiveDisclosure;
    if (!disclosure || disclosure.initialOptionIds.includes(optionId)) return option;
    if (this.storyRevealWasInspected(story.id, disclosure.reveal.id)) return option;
    throw new Error(
      `Story option "${optionId}" is hidden. Inspect story "${story.id}" with reveal_id "${disclosure.reveal.id}" in this session before inspecting or choosing it.`,
    );
  }

  private departureStoryChoiceForOption(choiceId: string): JourneyStoryChoicePrompt | null {
    const preparation = this.openingPreparationDepartureInteractionAvailable();
    const allocation = this.openingReliefAllocationDepartureInteractionAvailable();
    const storyChoices = [
      preparation
        ? this.withOpeningStationDispatchImpact(
            withOpeningDispatchBriefing(
              this.world,
              this.presentOpeningPreparationAtCurrentBoundary(preparation),
            ),
          )
        : null,
      allocation
        ? this.withOpeningStationDispatchImpact(
            withOpeningDispatchBriefing(
              this.world,
              presentOpeningReliefAllocation(allocation, this.characterState),
            ),
          )
        : null,
    ];
    const matchingStoryChoices = storyChoices.filter(
      (storyChoice): storyChoice is JourneyStoryChoicePrompt =>
        storyChoice?.options.some((option) => option.id === choiceId) === true,
    );
    if (matchingStoryChoices.length > 1) {
      throw new Error(
        `Departure story option "${choiceId}" is ambiguous; provide story_choice_id.`,
      );
    }
    return matchingStoryChoices[0] ?? null;
  }

  private openingReliefOathAvailable(): NonNullable<
    OverworldManifest["opening_relief_oath"]
  > | null {
    const scene = this.world.opening_relief_oath;
    if (!scene || this.journeyState.status !== "active" || this.openingReliefOathResolved()) {
      return null;
    }
    const latestEntry = this.journalEntries[0];
    if (
      latestEntry?.kind !== "relief_oath_offer" ||
      latestEntry.id !== openingReliefOathOfferJournalId(scene.id)
    ) {
      return null;
    }
    return scene;
  }

  private selectedCampaignStoryChoiceRefs(): CampaignStoryChoiceRef[] {
    const selected = [...journeyCampaignSelectedStoryChoiceRefs(this.journeyState)];
    const reliefOath = this.world.opening_relief_oath;
    const oathOption = reliefOath?.options.find((candidate) =>
      this.journalEntriesById.has(openingReliefOathJournalId(reliefOath.id, candidate.id)),
    );
    if (reliefOath && oathOption) {
      selected.push({ story_choice_id: reliefOath.id, choice_id: oathOption.id });
    }
    const preparation = this.world.opening_preparation;
    const profile = preparation?.profiles.find((candidate) =>
      this.journalEntriesById.has(openingPreparationJournalId(preparation.id, candidate.id)),
    );
    if (preparation && profile) {
      selected.push({ story_choice_id: preparation.id, choice_id: profile.id });
    }
    const reliefAllocation = this.world.opening_relief_allocation;
    const allocationOption = reliefAllocation?.options.find((candidate) =>
      this.journalEntriesById.has(
        openingReliefAllocationJournalId(reliefAllocation.id, candidate.id),
      ),
    );
    if (reliefAllocation && allocationOption) {
      selected.push({
        story_choice_id: reliefAllocation.id,
        choice_id: allocationOption.id,
      });
    }
    const ally = this.world.opening_ally;
    const option = ally?.options.find((candidate) =>
      this.journalEntriesById.has(openingAllyJournalId(ally.id, candidate.id)),
    );
    if (ally && option) {
      selected.push({ story_choice_id: ally.id, choice_id: option.id });
    }
    return selected;
  }

  private openingLeadSourceAvailable(): NonNullable<
    OverworldManifest["opening_lead_source"]
  > | null {
    const scene = this.world.opening_lead_source;
    if (!scene || this.journeyState.status !== "active" || this.openingLeadSourceResolved()) {
      return null;
    }
    const latestEntry = this.journalEntries[0];
    if (
      latestEntry?.kind !== "lead_source_offer" ||
      latestEntry.id !== openingLeadSourceOfferJournalId(scene.id)
    ) {
      return null;
    }
    return scene;
  }

  private offerOpeningReliefOathAfterRegistration(): void {
    const scene = this.world.opening_relief_oath;
    const registration = this.world.opening_registration;
    if (
      !scene ||
      !registration ||
      scene.after_registration !== registration.id ||
      this.openingReliefOathResolved() ||
      this.currentId !== scene.home ||
      this.currentAreaId !== scene.area
    ) {
      return;
    }
    const entryId = openingReliefOathOfferJournalId(scene.id);
    if (this.journalEntriesById.has(entryId)) return;
    const offer = openingReliefOathOfferJournalEntry({
      scene,
      town: this.currentNode().name,
      recordedAt: timeLabel(this.minutes),
      storyChoiceBoundary: {
        acceptedDecisions: this.journeyState.acceptedDecisions,
        decisionProofHash: this.journeyState.decisionProof.hash,
        townId: this.currentId,
        areaId: this.currentAreaIdOrThrow(),
        minutes: this.minutes,
      },
    });
    addOverworldJournalEntry(this.journalEntries, this.journalEntriesById, offer);
    this.clearSessionCaches();
  }

  private offerOpeningLeadSourceAfterRegistration(): void {
    const scene = this.world.opening_lead_source;
    const registration = this.world.opening_registration;
    const reliefOath = this.world.opening_relief_oath;
    if (
      !scene ||
      !registration ||
      scene.after_registration !== registration.id ||
      (reliefOath !== undefined &&
        reliefOath.after_registration === registration.id &&
        !this.openingReliefOathResolved()) ||
      this.openingLeadSourceResolved() ||
      this.currentId !== scene.home ||
      this.currentAreaId !== scene.area
    ) {
      return;
    }
    const entryId = openingLeadSourceOfferJournalId(scene.id);
    if (this.journalEntriesById.has(entryId)) return;
    const offer = openingLeadSourceOfferJournalEntry({
      scene,
      town: this.currentNode().name,
      recordedAt: timeLabel(this.minutes),
      storyChoiceBoundary: {
        acceptedDecisions: this.journeyState.acceptedDecisions,
        decisionProofHash: this.journeyState.decisionProof.hash,
        townId: this.currentId,
        areaId: this.currentAreaIdOrThrow(),
        minutes: this.minutes,
      },
    });
    addOverworldJournalEntry(this.journalEntries, this.journalEntriesById, offer);
    this.openingLeadSourceDecisionTrail = {
      anchorId: offer.id,
      baseAcceptedDecisions: this.journeyState.acceptedDecisions,
      baseDecisionProofHash: this.journeyState.decisionProof.hash,
      decisions: [],
    };
    this.clearSessionCaches();
  }

  private offerOpeningPreparationAtDeparture(): void {
    const scene = this.world.opening_preparation;
    const leadSource = this.world.opening_lead_source;
    if (
      !scene ||
      !leadSource ||
      scene.after_lead_source !== leadSource.id ||
      !this.openingLeadSourceResolved() ||
      this.openingPreparationResolved() ||
      this.currentId !== scene.home ||
      this.currentAreaId !== scene.area ||
      this.startedQuestIds.has(scene.target_quest) ||
      this.completedQuestIds.has(scene.target_quest) ||
      this.journeyState.status !== "active"
    ) {
      return;
    }
    const entryId = openingPreparationOfferJournalId(scene.id);
    if (this.journalEntriesById.has(entryId)) return;
    const offer = openingPreparationOfferJournalEntry({
      scene,
      town: this.currentNode().name,
      recordedAt: timeLabel(this.minutes),
      storyChoiceBoundary: {
        acceptedDecisions: this.journeyState.acceptedDecisions,
        decisionProofHash: this.journeyState.decisionProof.hash,
        townId: this.currentId,
        areaId: this.currentAreaIdOrThrow(),
        minutes: this.minutes,
      },
    });
    addOverworldJournalEntry(this.journalEntries, this.journalEntriesById, offer);
    this.clearSessionCaches();
  }

  private offerOpeningReliefAllocationAtDeparture(): void {
    const chain = this.openingDispatchHubAvailable();
    const scene = chain?.reliefAllocation ?? this.world.opening_relief_allocation;
    const preparation = this.world.opening_preparation;
    if (
      !scene ||
      (!chain &&
        (!preparation ||
          scene.after_preparation !== preparation.id ||
          !this.openingPreparationResolved() ||
          this.startedQuestIds.has(scene.target_quest) ||
          this.completedQuestIds.has(scene.target_quest) ||
          this.journeyState.status !== "active" ||
          this.currentId !== scene.home ||
          this.currentAreaId !== scene.area)) ||
      this.openingReliefAllocationResolved() ||
      this.openingAllyAvailable() !== null
    ) {
      return;
    }
    const entryId = openingReliefAllocationOfferJournalId(scene.id);
    if (this.journalEntriesById.has(entryId)) return;
    const offer = openingReliefAllocationOfferJournalEntry({
      scene,
      town: this.currentNode().name,
      recordedAt: timeLabel(this.minutes),
      storyChoiceBoundary: {
        acceptedDecisions: this.journeyState.acceptedDecisions,
        decisionProofHash: this.journeyState.decisionProof.hash,
        townId: this.currentId,
        areaId: this.currentAreaIdOrThrow(),
        minutes: this.minutes,
      },
    });
    addOverworldJournalEntry(this.journalEntries, this.journalEntriesById, offer);
    this.clearSessionCaches();
  }

  private openingAllyOfferAfterContact(
    characterId: string,
  ): NonNullable<OverworldManifest["opening_ally"]> | null {
    const chain = this.openingDispatchHubAvailable();
    const scene = chain?.ally ?? this.world.opening_ally;
    const preparation = this.world.opening_preparation;
    if (
      !scene ||
      characterId !== scene.contact ||
      (!chain &&
        (!preparation ||
          scene.after_preparation !== preparation.id ||
          !this.openingPreparationResolved() ||
          this.startedQuestIds.size > 0 ||
          this.completedQuestIds.size > 0 ||
          this.journeyState.status !== "active" ||
          this.currentId !== scene.home ||
          this.currentAreaId !== scene.area)) ||
      this.openingAllyResolved() ||
      this.openingPreparationAvailable() !== null ||
      this.openingReliefAllocationAvailable() !== null
    ) {
      return null;
    }
    const entryId = openingAllyOfferJournalId(scene.id);
    return this.journalEntriesById.has(entryId) ? null : scene;
  }

  private offerOpeningAllyAfterContact(characterId: string): void {
    const scene = this.openingAllyOfferAfterContact(characterId);
    if (!scene) return;
    const offer = openingAllyOfferJournalEntry({
      scene,
      town: this.currentNode().name,
      recordedAt: timeLabel(this.minutes),
      storyChoiceBoundary: {
        acceptedDecisions: this.journeyState.acceptedDecisions,
        decisionProofHash: this.journeyState.decisionProof.hash,
        townId: this.currentId,
        areaId: this.currentAreaIdOrThrow(),
        minutes: this.minutes,
      },
    });
    addOverworldJournalEntry(this.journalEntries, this.journalEntriesById, offer);
    this.clearSessionCaches();
  }

  private openingStoryBlockedQuestIds(): ReadonlySet<string> {
    const reliefOath = this.world.opening_relief_oath;
    if (reliefOath && !this.openingReliefOathResolved()) {
      return new Set([reliefOath.target_quest]);
    }
    const scene = this.world.opening_lead_source;
    return scene && !this.openingLeadSourceResolved()
      ? new Set([scene.target_quest])
      : new Set<string>();
  }

  private offerOpeningRegistrationAfterContact(characterId: string): void {
    const registration = this.openingRegistrationEligible();
    if (!registration || characterId !== registration.contact) return;
    const baseContactId = overworldContactTalkJournalId(registration.contact, null);
    if (!this.journalEntriesById.has(baseContactId)) return;
    const offer = openingRegistrationOfferJournalEntry({
      registration,
      town: this.currentNode().name,
      recordedAt: timeLabel(this.minutes),
      registrationBoundary: {
        acceptedDecisions: this.journeyState.acceptedDecisions,
        decisionProofHash: this.journeyState.decisionProof.hash,
        townId: this.currentId,
        areaId: this.currentAreaIdOrThrow(),
        minutes: this.minutes,
      },
    });
    if (this.journalEntriesById.has(offer.id)) return;
    addOverworldJournalEntry(this.journalEntries, this.journalEntriesById, offer);
    this.clearSessionCaches();
  }

  private journeyPresentationContext(): JourneyPresentationContext | undefined {
    const campaign = journeyCampaignPresentationContext({
      journey: this.journeyState,
      questOutcomeIds: this.questOutcomeIds,
      completedQuestIds: this.completedQuestIds,
    });
    const pending = this.journeyState.pendingChoice;
    const pendingGoalCompletion = pending?.reasons.includes("goal_completed") === true;
    const goalRoute = this.currentGoalRoute();
    const goalGuidance = this.journeyGoalGuidance(goalRoute);
    const opportunityDetails = this.journeyOpportunities();
    let goalCompletion: JourneyPresentationContext["goalCompletion"];
    const registration = this.openingRegistrationAvailable();
    const reliefOath = this.openingReliefOathAvailable();
    const leadSource = this.openingLeadSourceAvailable();
    const preparation = this.openingPreparationAvailable();
    const reliefAllocation = this.openingReliefAllocationAvailable();
    const ally = this.openingAllyAvailable();
    let storyChoice: JourneyPresentationContext["storyChoice"] = registration
      ? presentOpeningRegistration(registration)
      : reliefOath
        ? presentOpeningReliefOath(
            reliefOath,
            this.characterState,
            this.world.opening_registration && this.world.opening_lead_source
              ? {
                  registration: this.world.opening_registration,
                  leadSource: this.world.opening_lead_source,
                }
              : undefined,
          )
        : leadSource
          ? presentOpeningLeadSource(leadSource, this.characterState)
          : preparation
            ? this.presentOpeningPreparationAtCurrentBoundary(preparation)
            : reliefAllocation
              ? presentOpeningReliefAllocation(reliefAllocation, this.characterState)
              : ally
                ? presentOpeningAlly(ally, this.characterState)
                : undefined;

    storyChoice = withOpeningDispatchBriefing(this.world, storyChoice);
    storyChoice = this.withOpeningStationDispatchImpact(storyChoice);

    if (campaign) {
      if (pendingGoalCompletion && campaign.preRetentionTeaser) {
        goalCompletion = {
          goalVersion: pending!.goalVersion!,
          goalId: pending!.goalId!,
          messagePrefix: campaign.completionContext,
          messageSuffix: campaign.preRetentionTeaser,
          ...(campaign.continueLabel ? { continueLabel: campaign.continueLabel } : {}),
          ...(campaign.continueConsequencePrefix
            ? { continueConsequencePrefix: campaign.continueConsequencePrefix }
            : {}),
          ...(campaign.continuationPreview
            ? { continuationPreview: campaign.continuationPreview }
            : {}),
        };
      }
      if (campaign.storyChoice && !storyChoice) {
        storyChoice = {
          ...campaign.storyChoice,
          message: `${campaign.completionContext} ${campaign.storyChoice.message}`,
        };
      }
    } else if (pendingGoalCompletion) {
      const nextGoal = nextJourneyCampaignGoal({ completedQuestIds: this.completedQuestIds });
      if (nextGoal) {
        goalCompletion = {
          goalVersion: pending!.goalVersion!,
          goalId: pending!.goalId!,
          messageSuffix: `Next goal: ${nextGoal.text}`,
          continueConsequencePrefix: `Continue to the next goal: ${nextGoal.text}`,
        };
      }
    }
    const opportunities =
      pending || storyChoice
        ? deferJourneyOpportunityDetails(opportunityDetails)
        : opportunityDetails;
    const goalPassage = this.journeyGoalPassage(goalRoute, storyChoice);
    if (!goalCompletion && !storyChoice && !goalGuidance && !goalPassage && !opportunities) {
      return undefined;
    }
    return {
      ...(goalCompletion ? { goalCompletion } : {}),
      ...(goalGuidance ? { goalGuidance } : {}),
      ...(goalPassage ? { goalPassage } : {}),
      ...(opportunities ? { opportunities } : {}),
      ...(storyChoice ? { storyChoice } : {}),
    };
  }

  journey(): JourneyPresentation {
    const journey = journeyPresentation(this.journeyState, this.journeyPresentationContext());
    const story = journey.storyChoice;
    const disclosure = story?.progressiveDisclosure;
    if (!story || !disclosure || !this.storyRevealWasInspected(story.id, disclosure.reveal.id)) {
      return journey;
    }
    const revealedStory = withOpeningReliefOathFieldOutcomeCompass(story, disclosure.reveal.id);
    return revealedStory === story
      ? journey
      : Object.freeze({ ...journey, storyChoice: revealedStory });
  }

  journeyExitReceipt(): JourneyExitReceipt | null {
    return journeyExitReceipt(this.journeyState);
  }

  assertJourneyAcceptingDecision(): void {
    assertJourneyContractAcceptingDecision(this.journeyState);
    if (this.journey().storyChoice) {
      throw new Error("Choose the open story option before taking another action.");
    }
  }

  recordQuestDecision(
    actionId: string,
    classification: JourneyDecisionClassification,
    checkpointSafeBoundary: boolean,
  ): JourneyPresentation {
    this.assertJourneyAcceptingDecision();
    const before = this.journeyState;
    const next = recordJourneyDecision(
      before,
      {
        surface: "quest",
        actionId,
      },
      classification,
      checkpointSafeBoundary,
    );
    this.appendOpeningLeadSourceDecisionTrail(before, next);
    if (next !== this.journeyState) {
      this.journeyState = next;
      this.clearSessionCaches();
    }
    return this.journey();
  }

  recordQuestCharacterDeath(
    questId: string,
    outcome: Pick<OverworldQuestCompletionOutcome, "endingId" | "death">,
  ): JourneyPresentation {
    if (!this.startedQuestIds.has(questId) || this.completedQuestIds.has(questId)) {
      throw new Error(`Character death requires the exact unfinished started quest "${questId}".`);
    }
    if (!outcome.death || outcome.endingId.trim().length === 0) {
      throw new Error("A quest character-death boundary requires an identified death ending.");
    }
    if (this.questCharacterDeathBoundary !== null) {
      throw new Error("This journey already has a quest character-death boundary.");
    }
    const nextJourneyState = recordJourneyCharacterDied(this.journeyState);
    this.questCharacterDeathBoundary = {
      questId,
      endingId: outcome.endingId,
      acceptedDecisions: this.journeyState.acceptedDecisions,
      journeyDecisionProof: {
        hash: this.journeyState.decisionProof.hash,
        last: this.journeyState.decisionProof.last
          ? { ...this.journeyState.decisionProof.last }
          : null,
      },
    };
    this.journeyState = nextJourneyState;
    this.clearSessionCaches();
    return this.journey();
  }

  chooseJourney(choice: JourneyChoice): JourneyChoiceResult {
    const chosen = chooseJourneyContract(this.journeyState, choice);
    this.journeyState = chosen.state;
    if (choice === "end" && this.stationDispatchSupportReveals.size > 0) {
      this.stationDispatchSupportReveals.clear();
    }
    if (
      choice === "continue" &&
      chosen.result.retentionEvent.reasons.includes("goal_completed") &&
      this.journeyState.goal.id !== INITIAL_JOURNEY_GOAL.id
    ) {
      const nextGoal = nextJourneyCampaignGoal({ completedQuestIds: this.completedQuestIds });
      if (nextGoal) {
        this.activateCampaignGoal(nextGoal);
      }
    }
    this.clearSessionCaches();
    return Object.freeze({ ...chosen.result, journey: this.journey() });
  }

  private activateCampaignGoal(definition: JourneyCampaignGoalDefinition): OverworldJournalEntry {
    const goal: JourneyGoalDefinition = materializeJourneyCampaignGoal(
      definition,
      this.journeyState.goal.version,
    );
    this.journeyState = activateJourneyGoal(this.journeyState, goal);
    // A campaign goal is an authenticated direct lead: its canonical
    // definition names both the quest and the district where that quest can be
    // acted on. Reveal exactly that anchor without spending or reordering
    // ordinary local discovery.
    revealOverworldQuestAnchor(
      {
        discoveredAreaIds: this.discoveredAreaIds,
        discoveredQuestIds: this.discoveredQuestIds,
      },
      this.questsById,
      definition.targetQuestId,
    );
    const journalCopy = journeyCampaignGoalJournalCopy(definition, this.questOutcomeIds);
    const entry: OverworldJournalEntry = {
      id: `campaign_goal:${String(goal.version)}:${goal.id}`,
      kind: "campaign",
      town: this.currentNode().name,
      ...journalCopy,
      recordedAt: timeLabel(this.minutes),
    };
    addOverworldJournalEntry(this.journalEntries, this.journalEntriesById, entry);
    this.clearSessionCaches();
    return entry;
  }

  chooseJourneyStory(choiceId: string, storyChoiceId?: string): OverworldJourneyStoryChoiceResult {
    const result = this.chooseJourneyStoryInternal(choiceId, storyChoiceId, true, "player");
    // The story is decided, so the reveal gate has nothing left to guard. Clearing here
    // also keeps a revealed branch and an unrevealed one converging on the same snapshot
    // hash once both have chosen, which several parity proofs depend on.
    this.forgetStoryReveals();
    this.forgetSealedStationDispatchSupportReveal();
    return result;
  }

  private chooseJourneyStoryInternal(
    choiceId: string,
    storyChoiceId: string | undefined,
    checkpointSafeBoundary: boolean,
    selectionAuthority: "player" | "derived",
  ): OverworldJourneyStoryChoiceResult {
    assertJourneyContractAcceptingDecision(this.journeyState);
    const presentedStoryChoice = this.journey().storyChoice;
    const inferredDepartureStoryChoice =
      storyChoiceId === undefined && presentedStoryChoice === null
        ? this.departureStoryChoiceForOption(choiceId)
        : null;
    const pullBased =
      presentedStoryChoice === null &&
      (storyChoiceId !== undefined || inferredDepartureStoryChoice !== null);
    const storyChoice =
      storyChoiceId === undefined
        ? (presentedStoryChoice ?? inferredDepartureStoryChoice)
        : presentedStoryChoice
          ? (() => {
              if (presentedStoryChoice.id !== storyChoiceId) {
                throw new Error(
                  `Finish the presented story choice "${presentedStoryChoice.id}" before choosing "${storyChoiceId}".`,
                );
              }
              return presentedStoryChoice;
            })()
          : this.inspectJourneyStory(storyChoiceId);
    if (!storyChoice) throw new Error("There is no story consequence to choose right now.");
    const option =
      selectionAuthority === "player"
        ? this.assertJourneyStoryOptionVisible(storyChoice, choiceId)
        : storyChoice.options.find((candidate) => candidate.id === choiceId);
    if (!option) {
      throw new Error(`Story choice "${storyChoice.id}" does not offer option "${choiceId}".`);
    }
    const displaySummary = openingStoryChoiceDisplaySummary(storyChoice.kind, option);
    if (pullBased && storyChoice.kind === "preparation") {
      this.offerOpeningPreparationAtDeparture();
    } else if (pullBased && storyChoice.kind === "relief_allocation") {
      this.offerOpeningReliefAllocationAtDeparture();
    }
    if (storyChoice.kind === "registration") {
      const registration = this.openingRegistrationAvailable();
      if (!registration || storyChoice.id !== registration.id) {
        throw new Error("The presented background choice is no longer available.");
      }
      const characterAfter = applyOpeningRegistrationProfile({
        registration,
        character: this.characterState,
        profileId: choiceId,
      });
      const entryId = openingRegistrationJournalId(registration.id, choiceId);
      if (this.journalEntriesById.has(entryId)) {
        throw new Error(`Opening registration journal entry "${entryId}" already exists.`);
      }
      const journeyDecision = this.recordOverworldDecision(
        `campaign_story:${storyChoice.id}:${choiceId}`,
        "progress",
        true,
      );
      const entry = openingRegistrationJournalEntry({
        registration,
        profileId: choiceId,
        town: this.currentNode().name,
        recordedAt: timeLabel(this.minutes),
        registrationBoundary: {
          acceptedDecisions: this.journeyState.acceptedDecisions,
          decisionProofHash: this.journeyState.decisionProof.hash,
          townId: this.currentId,
          areaId: this.currentAreaIdOrThrow(),
          minutes: this.minutes,
        },
      });
      this.characterState = characterAfter;
      addOverworldJournalEntry(this.journalEntries, this.journalEntriesById, entry);
      if (this.world.opening_relief_oath?.after_registration === registration.id) {
        this.offerOpeningReliefOathAfterRegistration();
      } else {
        this.offerOpeningLeadSourceAfterRegistration();
      }
      this.clearSessionCaches();
      return Object.freeze({
        storyChoiceId: storyChoice.id,
        choiceId,
        ...(displaySummary ? { displaySummary } : {}),
        consequence: option.consequence,
        goal: this.journey().goal,
        entry: Object.freeze(storyChoiceEntryForPresentation(entry, option)),
        journeyDecision,
      });
    }
    if (storyChoice.kind === "relief_oath") {
      const scene = this.openingReliefOathAvailable();
      if (!scene || storyChoice.id !== scene.id) {
        throw new Error("The presented Wolf-Winter promise is no longer available.");
      }
      const registration = this.world.opening_registration;
      const standardPacket = registration
        ? this.preflightOpeningReliefOathStandardPacket(registration, scene, choiceId)
        : null;
      if (standardPacket) {
        this.chooseJourneyStoryInternal(
          standardPacket.reliefOathOption.id,
          storyChoice.id,
          false,
          "derived",
        );
        const leadSourceSelection = this.chooseJourneyStoryInternal(
          standardPacket.leadSourceOption.id,
          undefined,
          true,
          "derived",
        );
        const consequence = this.openingStandardPacketReceipt({
          doctrine: standardPacket.doctrine,
          profileTitle: standardPacket.profile.title,
          reliefOathTitle: standardPacket.reliefOathOption.title,
          leadSourceTitle: standardPacket.leadSourceOption.title,
        });
        const playerSummary = this.openingStandardPacketPlayerSummary({
          profileTitle: standardPacket.profile.title,
          reliefOathTitle: standardPacket.reliefOathOption.title,
          leadSourceTitle: standardPacket.leadSourceOption.title,
        });
        return Object.freeze({
          storyChoiceId: storyChoice.id,
          choiceId,
          displaySummary: playerSummary,
          consequence,
          goal: leadSourceSelection.goal,
          entry: Object.freeze({
            ...leadSourceSelection.entry,
            title: `Quick setup confirmed: ${standardPacket.doctrine.title}`,
            text: consequence,
          }),
          // The two canonical calls above each record their own counted
          // decision. The returned classification represents their final source
          // certification, which is the immediate visible outcome.
          journeyDecision: leadSourceSelection.journeyDecision,
        });
      }
      const application = applyOpeningReliefOathOption({
        scene,
        character: this.characterState,
        optionId: choiceId,
      });
      const entryId = openingReliefOathJournalId(scene.id, choiceId);
      if (this.journalEntriesById.has(entryId)) {
        throw new Error(`Opening relief-oath journal entry "${entryId}" already exists.`);
      }
      const characterBefore = this.characterState;
      const journeyDecision = this.recordOverworldDecision(
        `campaign_story:${storyChoice.id}:${choiceId}`,
        "progress",
        true,
        checkpointSafeBoundary,
      );
      this.minutes += application.terms.minutes;
      const entry = openingReliefOathJournalEntry({
        scene,
        character: characterBefore,
        optionId: choiceId,
        town: this.currentNode().name,
        recordedAt: timeLabel(this.minutes),
        storyChoiceBoundary: {
          acceptedDecisions: this.journeyState.acceptedDecisions,
          decisionProofHash: this.journeyState.decisionProof.hash,
          townId: this.currentId,
          areaId: this.currentAreaIdOrThrow(),
          minutes: this.minutes,
        },
      });
      this.characterState = application.characterAfter;
      addOverworldJournalEntry(this.journalEntries, this.journalEntriesById, entry);
      this.offerOpeningLeadSourceAfterRegistration();
      this.clearSessionCaches();
      return Object.freeze({
        storyChoiceId: storyChoice.id,
        choiceId,
        ...(displaySummary ? { displaySummary } : {}),
        consequence: option.consequence,
        goal: this.journey().goal,
        entry: Object.freeze(storyChoiceEntryForPresentation(entry, option)),
        journeyDecision,
      });
    }
    if (storyChoice.kind === "lead_source") {
      const scene = this.openingLeadSourceAvailable();
      if (!scene || storyChoice.id !== scene.id) {
        throw new Error("The presented report choice is no longer available.");
      }
      const application = applyOpeningLeadSourceOption({
        scene,
        character: this.characterState,
        optionId: choiceId,
      });
      const entryId = openingLeadSourceJournalId(scene.id, choiceId);
      if (this.journalEntriesById.has(entryId)) {
        throw new Error(`Opening lead-source journal entry "${entryId}" already exists.`);
      }
      const characterBefore = this.characterState;
      const journeyDecision = this.recordOverworldDecision(
        `campaign_story:${storyChoice.id}:${choiceId}`,
        "progress",
        true,
      );
      this.minutes += application.terms.minutes;
      const entry = openingLeadSourceJournalEntry({
        scene,
        character: characterBefore,
        optionId: choiceId,
        town: this.currentNode().name,
        recordedAt: timeLabel(this.minutes),
        storyChoiceBoundary: {
          acceptedDecisions: this.journeyState.acceptedDecisions,
          decisionProofHash: this.journeyState.decisionProof.hash,
          townId: this.currentId,
          areaId: this.currentAreaIdOrThrow(),
          minutes: this.minutes,
        },
      });
      this.characterState = application.characterAfter;
      addOverworldJournalEntry(this.journalEntries, this.journalEntriesById, entry);
      // Source certification is the point at which Wolf-Winter becomes a real,
      // inspectable mission. Its finite preparation remains available from the
      // departure board without blocking a player who chooses to leave at once.
      revealOverworldQuestAnchor(
        {
          discoveredAreaIds: this.discoveredAreaIds,
          discoveredQuestIds: this.discoveredQuestIds,
        },
        this.questsById,
        scene.target_quest,
      );
      this.clearSessionCaches();
      return Object.freeze({
        storyChoiceId: storyChoice.id,
        choiceId,
        ...(displaySummary ? { displaySummary } : {}),
        consequence: option.consequence,
        goal: this.journey().goal,
        entry: Object.freeze(storyChoiceEntryForPresentation(entry, option)),
        journeyDecision,
      });
    }
    if (storyChoice.kind === "preparation") {
      const scene = this.openingPreparationAvailable();
      if (!scene || storyChoice.id !== scene.id) {
        throw new Error("The presented field-kit choice is no longer available.");
      }
      const application = applyOpeningPreparationProfile({
        scene,
        character: this.characterState,
        profileId: choiceId,
      });
      const entryId = openingPreparationJournalId(scene.id, choiceId);
      if (this.journalEntriesById.has(entryId)) {
        throw new Error(`Opening preparation journal entry "${entryId}" already exists.`);
      }
      const characterBefore = this.characterState;
      const journeyDecision = this.recordOverworldDecision(
        `campaign_story:${storyChoice.id}:${choiceId}`,
        "progress",
        true,
      );
      this.minutes += application.terms.minutes;
      const entry = openingPreparationJournalEntry({
        scene,
        character: characterBefore,
        profileId: choiceId,
        town: this.currentNode().name,
        recordedAt: timeLabel(this.minutes),
        storyChoiceBoundary: {
          acceptedDecisions: this.journeyState.acceptedDecisions,
          decisionProofHash: this.journeyState.decisionProof.hash,
          townId: this.currentId,
          areaId: this.currentAreaIdOrThrow(),
          minutes: this.minutes,
        },
      });
      this.characterState = application.characterAfter;
      revealOverworldQuestAnchor(
        {
          discoveredAreaIds: this.discoveredAreaIds,
          discoveredQuestIds: this.discoveredQuestIds,
        },
        this.questsById,
        scene.target_quest,
      );
      addOverworldJournalEntry(this.journalEntries, this.journalEntriesById, entry);
      this.clearSessionCaches();
      return Object.freeze({
        storyChoiceId: storyChoice.id,
        choiceId,
        ...(displaySummary ? { displaySummary } : {}),
        consequence: option.consequence,
        goal: this.journey().goal,
        entry: Object.freeze(storyChoiceEntryForPresentation(entry, option)),
        journeyDecision,
      });
    }
    if (storyChoice.kind === "relief_allocation") {
      const scene = this.openingReliefAllocationAvailable();
      if (!scene || storyChoice.id !== scene.id) {
        throw new Error("The presented relief-wagon choice is no longer available.");
      }
      const application = applyOpeningReliefAllocationOption({
        scene,
        character: this.characterState,
        optionId: choiceId,
      });
      const entryId = openingReliefAllocationJournalId(scene.id, choiceId);
      if (this.journalEntriesById.has(entryId)) {
        throw new Error(`Opening relief allocation journal entry "${entryId}" already exists.`);
      }
      const characterBefore = this.characterState;
      const journeyDecision = this.recordOverworldDecision(
        `campaign_story:${storyChoice.id}:${choiceId}`,
        "progress",
        true,
      );
      this.minutes += application.terms.minutes;
      const entry = openingReliefAllocationJournalEntry({
        scene,
        character: characterBefore,
        optionId: choiceId,
        town: this.currentNode().name,
        recordedAt: timeLabel(this.minutes),
        storyChoiceBoundary: {
          acceptedDecisions: this.journeyState.acceptedDecisions,
          decisionProofHash: this.journeyState.decisionProof.hash,
          townId: this.currentId,
          areaId: this.currentAreaIdOrThrow(),
          minutes: this.minutes,
        },
      });
      this.characterState = application.characterAfter;
      addOverworldJournalEntry(this.journalEntries, this.journalEntriesById, entry);
      this.clearSessionCaches();
      return Object.freeze({
        storyChoiceId: storyChoice.id,
        choiceId,
        ...(displaySummary ? { displaySummary } : {}),
        consequence: option.consequence,
        goal: this.journey().goal,
        entry: Object.freeze(storyChoiceEntryForPresentation(entry, option)),
        journeyDecision,
      });
    }
    if (storyChoice.kind === "ally") {
      const scene = this.openingAllyAvailable();
      if (!scene || storyChoice.id !== scene.id) {
        throw new Error("The presented riding choice is no longer available.");
      }
      const application = applyOpeningAllyOption({
        scene,
        character: this.characterState,
        optionId: choiceId,
      });
      const entryId = openingAllyJournalId(scene.id, choiceId);
      if (this.journalEntriesById.has(entryId)) {
        throw new Error(`Opening ally journal entry "${entryId}" already exists.`);
      }
      const characterBefore = this.characterState;
      const journeyDecision = this.recordOverworldDecision(
        `campaign_story:${storyChoice.id}:${choiceId}`,
        "progress",
        true,
      );
      this.minutes += application.terms.minutes;
      const entry = openingAllyJournalEntry({
        scene,
        character: characterBefore,
        optionId: choiceId,
        town: this.currentNode().name,
        recordedAt: timeLabel(this.minutes),
        storyChoiceBoundary: {
          acceptedDecisions: this.journeyState.acceptedDecisions,
          decisionProofHash: this.journeyState.decisionProof.hash,
          townId: this.currentId,
          areaId: this.currentAreaIdOrThrow(),
          minutes: this.minutes,
        },
      });
      this.characterState = application.characterAfter;
      addOverworldJournalEntry(this.journalEntries, this.journalEntriesById, entry);
      this.clearSessionCaches();
      return Object.freeze({
        storyChoiceId: storyChoice.id,
        choiceId,
        ...(displaySummary ? { displaySummary } : {}),
        consequence: option.consequence,
        goal: this.journey().goal,
        entry: Object.freeze(storyChoiceEntryForPresentation(entry, option)),
        journeyDecision,
      });
    }
    const selection = journeyCampaignStoryChoiceSelection(storyChoice.id, choiceId);

    const entry = this.activateCampaignGoal(selection.goal);
    const journeyDecision = this.recordOverworldDecision(
      `campaign_story:${selection.storyChoiceId}:${selection.choiceId}`,
      "progress",
      true,
    );
    if (journeyCampaignGoalIsComplete(this.journeyState.goal, this.completedQuestIds)) {
      this.journeyState = recordJourneyGoalCompleted(this.journeyState);
    }
    this.clearSessionCaches();
    return Object.freeze({
      storyChoiceId: selection.storyChoiceId,
      choiceId: selection.choiceId,
      consequence: option.consequence,
      goal: this.journey().goal,
      entry: Object.freeze({ ...entry }),
      journeyDecision,
    });
  }

  private persistenceState(): OverworldSessionPersistenceState {
    return {
      worldId: this.world.id,
      worldHash: this.worldHash,
      character: this.characterState,
      currentId: this.currentId,
      currentAreaId: this.currentAreaId,
      minutes: this.minutes,
      supplies: this.supplies,
      fatigue: this.fatigue,
      discoveredIds: this.discoveredIds,
      visitedIds: this.visitedIds,
      currentAreaByTown: this.currentAreaByTown,
      travelLog: this.travelLog,
      journalEntries: this.journalEntries,
      journalEntriesById: this.journalEntriesById,
      resolvedEventIds: this.resolvedEventIds,
      resolvedEventHomeIds: this.resolvedEventHomeIds,
      discoveredAreaIds: this.discoveredAreaIds,
      visitedAreaIds: this.visitedAreaIds,
      discoveredJobIds: this.discoveredJobIds,
      completedJobIds: this.completedJobIds,
      discoveredSiteIds: this.discoveredSiteIds,
      discoveredQuestIds: this.discoveredQuestIds,
      startedQuestIds: this.startedQuestIds,
      completedQuestIds: this.completedQuestIds,
      questLaunchCharacters: this.questLaunchCharacters,
      questOutcomeIds: this.questOutcomeIds,
      exploredSiteIds: this.exploredSiteIds,
      regionRenown: this.regionRenown,
      completedRegionalArcIds: this.completedRegionalArcIds,
      pendingRoadEncounter: this.pendingRoadEncounter,
      openingLeadSourceDecisionTrail: this.openingLeadSourceDecisionTrail,
      questCharacterDeathBoundary: this.questCharacterDeathBoundary,
      inspectedStoryReveals: this.inspectedStoryReveals,
      stationDispatchSupportReveals: this.stationDispatchSupportReveals,
      journey: this.journeyState,
    };
  }

  private buildSnapshot(): OverworldSessionSnapshot {
    return buildOverworldSessionSnapshotFromState(this.persistenceState());
  }

  private applySnapshot(snapshot: OverworldSessionSnapshot): void {
    const applied = restoreOverworldSessionSnapshotIntoState({
      indexes: this.snapshotManifestIndex,
      snapshot,
      startTownId: this.world.start,
      state: this.persistenceState(),
      worldHash: this.worldHash,
      worldId: this.world.id,
    });
    this.applyCurrentTownState(applied);
    this.applyCurrentAreaState(applied);
    this.applyResourceClockState(applied);
    this.applyPendingRoadEncounterState(applied);
    this.characterState = applied.characterAfter;
    this.journeyState = applied.journeyAfter;
    this.questCharacterDeathBoundary = snapshot.questCharacterDeathBoundary
      ? cloneQuestCharacterDeathBoundary(snapshot.questCharacterDeathBoundary)
      : null;
    this.openingLeadSourceDecisionTrail = applied.openingLeadSourceDecisionTrailAfter
      ? cloneOpeningLeadSourceDecisionTrail(applied.openingLeadSourceDecisionTrailAfter)
      : null;
    this.assertQuestCharacterDeathBoundary();
    this.clearSessionCaches();
    this.assertSnapshotStoryRevealReceipts(snapshot);
    this.assertSnapshotStationDispatchSupportReveals(snapshot);
    this.inspectedStoryReveals = new Map(
      (snapshot.inspectedStoryReveals ?? []).map(([storyChoiceId, revealIds]) => [
        storyChoiceId,
        new Set(revealIds),
      ]),
    );
    this.stationDispatchSupportReveals = new Map(snapshot.stationDispatchSupportReveals ?? []);
    this.restoreWarningList = applied.restoreWarnings;
    this.clearSessionCaches();
  }

  private assertQuestCharacterDeathBoundary(): void {
    const pendingDeath =
      this.journeyState.pendingChoice?.reasons.includes("character_died") === true;
    const endedDeath =
      this.journeyState.retentionHistory.at(-1)?.reasons.includes("character_died") === true;
    const boundary = this.questCharacterDeathBoundary;
    if (!pendingDeath && !endedDeath) {
      if (boundary !== null) {
        throw new Error(
          "Overworld session quest character-death boundary exists without a death journey.",
        );
      }
      return;
    }
    if (boundary === null) {
      throw new Error("Overworld session character death has no durable quest death boundary.");
    }
    if (
      !this.startedQuestIds.has(boundary.questId) ||
      this.completedQuestIds.has(boundary.questId)
    ) {
      throw new Error(
        `Overworld session character death is not bound to its exact unfinished quest "${boundary.questId}".`,
      );
    }
    if (boundary.acceptedDecisions !== this.journeyState.acceptedDecisions) {
      throw new Error(
        "Overworld session character death does not match its accepted journey decision.",
      );
    }
    if (boundary.journeyDecisionProof.hash !== this.journeyState.decisionProof.hash) {
      throw new Error(
        "Overworld session character death does not match its journey decision proof hash.",
      );
    }
    if (
      hashState(boundary.journeyDecisionProof.last) !==
      hashState(this.journeyState.decisionProof.last)
    ) {
      throw new Error(
        "Overworld session character death does not match its last journey decision proof.",
      );
    }
  }

  private markSeen(nodeId: string): void {
    const applied = applyOverworldSessionTownVisit({
      nodeId,
      currentAreaId: this.currentAreaId,
      currentAreaByTown: this.currentAreaByTown,
      areasByTown: this.areasByTown,
      discoveredAreaIds: this.discoveredAreaIds,
      discoveredIds: this.discoveredIds,
      roadExitsByTown: this.roadExitsByTown,
      visitedIds: this.visitedIds,
    });
    this.applyCurrentAreaState(applied);
    if (applied.stateChanged) this.clearSessionCaches();
  }

  private currentNode(): OverworldNode {
    const current = this.nodes.get(this.currentId);
    if (!current) throw new Error(`Current overworld node "${this.currentId}" is missing.`);
    return current;
  }

  private roadsFrom(nodeId: string): OverworldExit[] {
    return this.roadExitsByTown.get(nodeId) ?? [];
  }

  private localState(): MutableOverworldSessionLocalState {
    return {
      currentTownId: this.currentId,
      currentAreaId: this.currentAreaId,
      areasById: this.areasById,
      areasByTown: this.areasByTown,
      currentAreaByTown: this.currentAreaByTown,
      areaExitsByArea: this.areaExitsByArea,
      poisByArea: this.poisByArea,
      charactersByArea: this.charactersByArea,
      eventsByArea: this.eventsByArea,
      sitesByArea: this.sitesByArea,
      jobsByTown: this.jobsByTown,
      questsByTown: this.questsByTown,
      discoveredAreaIds: this.discoveredAreaIds,
      discoveredJobIds: this.discoveredJobIds,
      completedJobIds: this.completedJobIds,
      discoveredSiteIds: this.discoveredSiteIds,
      discoveredQuestIds: this.discoveredQuestIds,
      completedQuestIds: this.completedQuestIds,
      resolvedEventIds: this.resolvedEventIds,
      campaignWorldFactIds: new Set(this.campaignWorldFactIds()),
      campaignStoryChoiceKeys: new Set(
        this.selectedCampaignStoryChoiceRefs().map(campaignStoryChoiceRefKey),
      ),
      campaignCharacter: this.characterState,
      journalEntries: this.journalEntriesById,
      questsById: this.questsById,
      eventsById: this.localEventsById,
    };
  }

  private actionJournalState(): OverworldActionJournalState {
    return {
      minutes: this.minutes,
      journalEntries: this.journalEntries,
      journalEntriesById: this.journalEntriesById,
    };
  }

  private recordOverworldDecision(
    actionId: string,
    kind: OverworldJourneyActionKind,
    stateChanged: boolean,
    checkpointSafeBoundary = true,
  ): JourneyDecisionClassification {
    const classification = classifyOverworldJourneyDecision(kind, stateChanged);
    const before = this.journeyState;
    const after = recordJourneyDecision(
      before,
      { surface: "overworld", actionId },
      classification,
      checkpointSafeBoundary,
    );
    this.appendOpeningLeadSourceDecisionTrail(before, after);
    this.journeyState = after;
    return classification;
  }

  private appendOpeningLeadSourceDecisionTrail(
    before: JourneyContractSnapshot,
    after: JourneyContractSnapshot,
  ): void {
    const trail = this.openingLeadSourceDecisionTrail;
    if (!trail || after.acceptedDecisions !== before.acceptedDecisions + 1) return;
    const decision = after.decisionProof.last;
    if (!decision) {
      throw new Error("An accepted opening lead-source decision is missing its journey proof.");
    }
    this.openingLeadSourceDecisionTrail = {
      ...trail,
      decisions: [...trail.decisions, { ...decision }],
    };
  }

  private applyActionApplication(
    applied: OverworldSessionActionApplication,
    actionId: string,
    kind: OverworldJourneyActionKind,
  ): OverworldJourneyActionResult {
    this.applyClockState(applied);
    const journeyDecision = this.recordOverworldDecision(actionId, kind, applied.stateChanged);
    const localSceneProof = applied.result.entry.localSceneProof;
    if (localSceneProof && !localSceneProof.boundary) {
      if (!journeyDecision.countsTowardJourney) {
        throw new Error("An authored local scene is missing its accepted decision proof.");
      }
      localSceneProof.boundary = {
        acceptedDecisions: this.journeyState.acceptedDecisions,
        decisionProofHash: this.journeyState.decisionProof.hash,
        townId: this.currentId,
        areaId: this.currentAreaIdOrThrow(),
        minutes: this.minutes,
      };
    }
    if (applied.stateChanged || journeyDecision.countsTowardJourney) this.clearSessionCaches();
    return withJourneyDecision(applied.result, journeyDecision);
  }

  private applyServiceApplication(
    applied: OverworldSessionServiceApplication,
    actionId: string,
  ): OverworldJourneyServiceResult {
    if (applied.stateChanged) {
      this.applyResourceClockState(applied);
      if (applied.characterAfter) {
        this.characterState = cloneCampaignCharacterState(applied.characterAfter);
      }
    }
    const serviceEntry = applied.result.entry;
    const serviceRuleId = serviceEntry?.serviceRuleId;
    const journeyActionId = serviceRuleId
      ? campaignServiceJourneyActionId(serviceRuleId, applied.result.action)
      : actionId;
    const journeyDecision = this.recordOverworldDecision(
      journeyActionId,
      "preparation",
      applied.stateChanged,
    );
    if (serviceRuleId) {
      const currentAreaId = this.currentAreaIdOrThrow();
      if (
        !serviceEntry ||
        serviceEntry.serviceAreaId !== currentAreaId ||
        !journeyDecision.countsTowardJourney
      ) {
        throw new Error("A campaign service is missing its accepted location decision proof.");
      }
      serviceEntry.serviceBoundary = {
        acceptedDecisions: this.journeyState.acceptedDecisions,
        decisionProofHash: this.journeyState.decisionProof.hash,
        townId: this.currentId,
        areaId: currentAreaId,
        minutes: this.minutes,
      };
    }
    if (applied.stateChanged || journeyDecision.countsTowardJourney) this.clearSessionCaches();
    return withJourneyDecision(cloneOverworldServiceResult(applied.result), journeyDecision);
  }

  private currentArea(): OverworldArea | null {
    const resolution = resolveOverworldSessionCurrentArea(this.localState());
    if (resolution.applied) {
      this.applyCurrentAreaState(resolution.applied);
      if (resolution.applied.stateChanged) this.clearSessionCaches();
    }
    return resolution.area;
  }

  private currentAreaIdOrThrow(): string {
    return requireOverworldSessionCurrentAreaId(this.currentArea());
  }

  private journeyOpportunities(): JourneyOpportunityPresentation | null {
    if (
      this.journeyState.status === "ended" ||
      this.journeyState.pendingChoice?.reasons.includes("character_died") === true
    ) {
      return null;
    }
    return projectJourneyOpportunities({
      currentAreaId: this.pendingRoadEncounter ? null : this.currentAreaId,
      areasById: this.areasById,
      events: this.world.local_events,
      jobs: this.world.local_jobs,
      visitedTownIds: this.visitedIds,
      completedQuestIds: this.completedQuestIds,
      resolvedEventIds: this.resolvedEventIds,
      discoveredAreaIds: this.discoveredAreaIds,
      discoveredJobIds: this.discoveredJobIds,
      completedJobIds: this.completedJobIds,
      worldFactIds: new Set(this.campaignWorldFactIds()),
      storyChoiceKeys: new Set(
        this.selectedCampaignStoryChoiceRefs().map(campaignStoryChoiceRefKey),
      ),
      character: this.characterState,
      eventOptionIdFor: (eventId) =>
        this.journalEntriesById.get(`resolve:${eventId}`)?.localSceneProof?.optionId ?? null,
    });
  }

  private nextOpportunityRoadStep(townId: string): JourneyOpportunityRoadStep | null {
    const route = indexedOverworldRoute(this.routePlannerIndex, this.currentId, townId);
    const first = route?.steps[0];
    return first
      ? {
          roadId: first.edge.id,
          destinationId: first.to.id,
          destinationName: first.to.name,
        }
      : null;
  }

  private currentOpportunityDiscoveryAction(): JourneyOpportunityNextAction | null {
    const currentAreaId = this.currentAreaId;
    const currentArea = currentAreaId ? this.areasById.get(currentAreaId) : null;
    if (
      !currentArea ||
      !(this.areasByTown.get(this.currentId) ?? []).some(
        (area) => !this.discoveredAreaIds.has(area.id),
      )
    ) {
      return null;
    }
    const campaignWorldFactIds = new Set(this.campaignWorldFactIds());
    const eventOptionIdFor = (eventId: string): string | null =>
      this.journalEntriesById.get(`resolve:${eventId}`)?.localSceneProof?.optionId ?? null;

    const areaPlan = planOverworldSessionArea({
      areaId: currentArea.id,
      areasById: this.areasById,
      currentTownId: this.currentId,
      currentAreaId,
      discoveredAreaIds: this.discoveredAreaIds,
      visitedAreaIds: this.visitedAreaIds,
      journalEntries: this.journalEntriesById,
    });
    if (!areaPlan.alreadyKnown) {
      return {
        tool: OPPORTUNITY_EXPLORE_AREA_TOOL,
        arguments: { area_id: currentArea.id },
        command: `explore ${currentArea.id}`,
        label: `Explore ${currentArea.name} to reveal more local leads.`,
      };
    }

    const current = this.currentNode();
    for (const poi of this.poisByArea.get(currentArea.id) ?? []) {
      const plan = planOverworldSessionPoiScout({
        poiId: poi.id,
        poisById: this.poisById,
        currentTown: current,
        currentAreaId: () => currentArea.id,
      });
      if (!this.journalEntriesById.has(plan.action.id)) {
        return {
          tool: OPPORTUNITY_SCOUT_POI_TOOL,
          arguments: { poi_id: poi.id },
          command: `scout ${poi.id}`,
          label: "Scout a visible point of interest to reveal more local leads.",
        };
      }
    }
    for (const site of this.sitesByArea.get(currentArea.id) ?? []) {
      try {
        const plan = planOverworldSessionSite({
          siteId: site.id,
          sitesById: this.sitesById,
          currentTownId: this.currentId,
          currentAreaId,
          discoveredSiteIds: this.discoveredSiteIds,
          exploredSiteIds: this.exploredSiteIds,
          journalEntries: this.journalEntriesById,
        });
        if (!plan.alreadyKnown) {
          return {
            tool: OPPORTUNITY_EXPLORE_SITE_TOOL,
            arguments: { site_id: site.id },
            command: `explore site ${site.id}`,
            label: "Explore a visible site to reveal more local leads.",
          };
        }
      } catch {
        // Canonical planning remains the authority for whether this visible site is lawful now.
      }
    }
    const interaction = planOverworldOpportunityInteractionDiscovery({
      character: this.characterState,
      characters: this.charactersByArea.get(currentArea.id) ?? [],
      charactersById: this.charactersById,
      events: this.eventsByArea.get(currentArea.id) ?? [],
      eventsById: this.localEventsById,
      completedQuestIds: this.completedQuestIds,
      completedJobIds: this.completedJobIds,
      campaignWorldFactIds,
      eventOptionIdFor,
      currentTownId: this.currentId,
      currentAreaId: currentArea.id,
      journalEntryIds: new Set(this.journalEntriesById.keys()),
    });
    if (interaction?.plan.action.kind === "contact") {
      const characterId = interaction.sourceId;
      return {
        tool: OPPORTUNITY_TALK_CONTACT_TOOL,
        arguments: { character_id: characterId },
        command: `talk ${characterId}`,
        label: "Talk to a visible contact to reveal more local leads.",
      };
    }
    if (interaction?.plan.action.kind === "event") {
      const eventId = interaction.sourceId;
      return {
        tool: OPPORTUNITY_INVESTIGATE_EVENT_TOOL,
        arguments: { event_id: eventId },
        command: `investigate ${eventId}`,
        label: "Investigate a visible event to reveal more local leads.",
      };
    }
    const eventChoice = this.liveEventChoices(this.eventsByArea.get(currentArea.id) ?? [])[0];
    if (eventChoice) {
      return {
        tool: OPPORTUNITY_RESOLVE_EVENT_TOOL,
        arguments: { event_id: eventChoice[0], option_id: eventChoice[1] },
        command: `resolve ${eventChoice[0]} ${eventChoice[1]}`,
        label: "Choose a visible event option to reveal more local leads.",
      };
    }
    const jobChoice = this.liveJobChoices(
      (this.jobsByTown.get(this.currentId) ?? []).filter((job) => job.area === currentArea.id),
    )[0];
    if (jobChoice) {
      return {
        tool: OPPORTUNITY_WORK_JOB_TOOL,
        arguments: { job_id: jobChoice[0], option_id: jobChoice[1] },
        command: `work ${jobChoice[0]} ${jobChoice[1]}`,
        label: "Choose a visible job option to reveal more local leads.",
      };
    }
    return null;
  }

  /** Revalidate one projected lead and return one existing lawful action without mutating state. */
  explainOpportunity(identity: JourneyOpportunityIdentity): JourneyOpportunityExplanation {
    this.assertJourneyAcceptingDecision();
    this.assertNoPendingRoadEncounter("explaining an opportunity");
    return explainJourneyOpportunity(
      {
        opportunities: this.journeyOpportunities(),
        currentTownId: this.currentId,
        currentAreaId: this.currentAreaId,
        areasById: this.areasById,
        areaExitsByArea: this.areaExitsByArea,
        discoveredAreaIds: this.discoveredAreaIds,
        visitedAreaIds: this.visitedAreaIds,
        eventsById: this.localEventsById,
        jobsById: this.jobsById,
        journalEntryIds: new Set(this.journalEntriesById.keys()),
        eventChoices: this.liveEventChoices(
          this.currentAreaId ? (this.eventsByArea.get(this.currentAreaId) ?? []) : [],
        ),
        jobChoices: this.liveJobChoices(
          this.currentAreaId
            ? (this.jobsByTown.get(this.currentId) ?? []).filter(
                (job) => job.area === this.currentAreaId,
              )
            : [],
        ),
        nextRoadToward: (townId) => this.nextOpportunityRoadStep(townId),
        currentAreaDiscoveryAction: () => this.currentOpportunityDiscoveryAction(),
      },
      identity,
    );
  }

  private discoverLocalProgressForTown(nodeId: string): OverworldLocalDiscoveryResult {
    const applied = applyOverworldSessionLocalDiscoveryForTown(
      this.localState(),
      nodeId,
      this.openingStoryBlockedQuestIds(),
    );
    if (applied.stateChanged) this.clearSessionCaches();
    return applied.discovery;
  }

  private withLocalDiscovery(result: OverworldActionResult, nodeId: string): OverworldActionResult {
    return withOverworldSessionLocalDiscovery(
      result,
      result.alreadyKnown ? null : this.discoverLocalProgressForTown(nodeId),
    );
  }

  private applyLocalActionWithDiscovery(
    current: OverworldNode,
    applied: OverworldSessionActionApplication,
    actionId: string,
    kind: OverworldJourneyActionKind,
  ): OverworldJourneyActionResult {
    return cloneOverworldActionResult(
      this.withLocalDiscovery(this.applyActionApplication(applied, actionId, kind), current.id),
    ) as OverworldJourneyActionResult;
  }

  private cachedCompactView(): OverworldCompactView {
    if (this.caches.compactView) return this.caches.compactView;
    this.caches.compactView = this.buildCompactView();
    return this.caches.compactView;
  }

  compactView(): OverworldCompactView {
    return cloneOverworldCompactView(this.cachedCompactView());
  }

  private viewModelSourceState(): OverworldSessionViewModelSourceState {
    const current = this.currentNode();
    const currentArea = this.currentArea();
    const localState = this.localState();
    const currentAreaId = requireOverworldSessionCurrentAreaId(currentArea);
    const localView = buildOverworldSessionCurrentLocalView(localState, currentAreaId);
    const questDispatchWindows = new Map(
      localView.quests.map(
        (quest) =>
          [
            quest.id,
            deriveQuestDispatchPresentationWindow({
              questId: quest.id,
              journalEntries: this.journalEntries,
              openingRegistration: this.world.opening_registration ?? null,
              openingReliefOath: this.world.opening_relief_oath ?? null,
              openingLeadSource: this.world.opening_lead_source ?? null,
              openingPreparation: this.world.opening_preparation ?? null,
              openingReliefAllocation: this.world.opening_relief_allocation ?? null,
              openingAlly: this.world.opening_ally ?? null,
            }),
          ] as const,
      ),
    );
    const serviceOffers = this.campaignServiceOffers(currentAreaId);
    return {
      caches: this.caches,
      character: this.characterState,
      worldName: this.world.name,
      worldTownCount: this.world.nodes.length,
      current,
      currentArea,
      currentId: this.currentId,
      minutes: this.minutes,
      supplies: this.supplies,
      fatigue: this.fatigue,
      opportunities: this.journey().opportunities,
      serviceOffers,
      serviceActions: this.currentServiceActions(currentAreaId),
      departureInteractions: this.departureInteractions(),
      departureContactLeads: this.departureContactLeads(),
      departureRecap: this.departureRecap(),
      stationDispatchSupportRevealed: this.currentStationDispatchSupportWasRevealed(),
      roads: this.roadsFrom(this.currentId),
      areaExits: visibleOverworldSessionAreaExits(localState, currentArea),
      localState,
      localView,
      eventChoices: this.liveEventChoices(
        currentArea ? (this.eventsByArea.get(currentArea.id) ?? []) : [],
      ),
      jobChoices: this.liveJobChoices(localView.jobs),
      questStarts: this.liveQuestStarts(localView.quests),
      questDispatchWindows,
      routePlannerIndex: this.routePlannerIndex,
      roadEventState: {
        activeGoalId: this.journeyState.goal.id,
        completedQuestIds: this.completedQuestIds,
        travelLog: this.travelLog,
      },
      completedQuestIds: this.completedQuestIds,
      campaignWorldFactIds: new Set(this.campaignWorldFactIds()),
      journalEntries: this.journalEntries,
      travelLog: this.travelLog,
      visitedCount: this.visitedIds.size,
      regionRenown: this.regionRenown,
      completedRegionalArcIds: this.completedRegionalArcIds,
      pendingRoadEncounter: this.pendingRoadEncounter,
      ids: {
        discoveredIds: this.discoveredIds,
        nodes: this.nodes,
        discoveredAreaIds: this.discoveredAreaIds,
        visitedAreaIds: this.visitedAreaIds,
        discoveredJobIds: this.discoveredJobIds,
        completedJobIds: this.completedJobIds,
        discoveredSiteIds: this.discoveredSiteIds,
        exploredSiteIds: this.exploredSiteIds,
        discoveredQuestIds: this.discoveredQuestIds,
        startedQuestIds: this.startedQuestIds,
        completedQuestIds: this.completedQuestIds,
        resolvedEventIds: this.resolvedEventIds,
      },
    };
  }

  private liveJobChoices(jobs: readonly OverworldLocalJob[]): OverworldCompactJobChoice[] {
    try {
      this.assertJourneyAcceptingDecision();
      this.assertNoPendingRoadEncounter("working a local job");
    } catch {
      return [];
    }

    const choices: OverworldCompactJobChoice[] = [];
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index]!;
      if (!job.authored_scene) continue;
      for (const option of job.authored_scene.options) {
        try {
          const plan = planOverworldSessionLocalJob({
            jobId: job.id,
            optionId: option.id,
            jobsById: this.jobsById,
            areasById: this.areasById,
            currentTownId: this.currentId,
            currentRegion: this.currentNode().region,
            currentAreaId: this.currentAreaIdOrThrow(),
            discoveredJobIds: this.discoveredJobIds,
            completedJobIds: this.completedJobIds,
            completedQuestIds: this.completedQuestIds,
            resolvedEventIds: this.resolvedEventIds,
            campaignWorldFactIds: new Set(this.campaignWorldFactIds()),
            campaignStoryChoiceKeys: new Set(
              this.selectedCampaignStoryChoiceRefs().map(campaignStoryChoiceRefKey),
            ),
            campaignCharacter: this.characterState,
            journalEntries: this.journalEntriesById,
          });
          if (!plan.alreadyKnown) choices.push([job.id, option.id]);
        } catch {
          // Canonical preparation is the sole authority for executable job choices.
        }
      }
    }
    return choices;
  }

  private liveEventChoices(events: readonly OverworldLocalEvent[]): OverworldCompactEventChoice[] {
    try {
      this.assertJourneyAcceptingDecision();
      this.assertNoPendingRoadEncounter("resolving a local event");
    } catch {
      return [];
    }

    const choices: OverworldCompactEventChoice[] = [];
    for (const event of events) {
      if (!event.authored_scene || this.resolvedEventIds.has(event.id)) continue;
      for (const option of event.authored_scene.options) {
        try {
          const plan = planOverworldSessionEventResolution({
            eventId: event.id,
            optionId: option.id,
            eventsById: this.localEventsById,
            currentTownId: this.currentId,
            currentTownName: this.currentNode().name,
            currentRegion: this.currentNode().region,
            currentAreaId: this.currentAreaIdOrThrow(),
            completedQuestIds: this.completedQuestIds,
            completedJobIds: this.completedJobIds,
            campaignWorldFactIds: new Set(this.campaignWorldFactIds()),
            resolvedEventIds: this.resolvedEventIds,
            journalEntries: this.journalEntriesById,
            poisByArea: this.poisByArea,
            charactersByArea: this.charactersByArea,
          });
          if (!plan.alreadyKnown) choices.push([event.id, option.id]);
        } catch {
          // Canonical preparation is the sole authority for executable event choices.
        }
      }
    }
    return choices;
  }

  private liveQuestStarts(quests: readonly OverworldQuestView[]): OverworldCompactQuestStart[] {
    try {
      this.assertJourneyAcceptingDecision();
    } catch {
      return [];
    }

    const starts: OverworldCompactQuestStart[] = [];
    const capped = Math.min(quests.length, OVERWORLD_COMPACT_LOCAL_REF_LIMIT);
    for (let index = 0; index < capped; index += 1) {
      const quest = quests[index]!;
      const approachIds = quest.launch
        ? quest.launch.options.map((option) => option.id)
        : [undefined];
      for (const approachId of approachIds) {
        try {
          const plan = this.prepareQuestStart(quest.id, approachId);
          starts.push([plan.quest.id, plan.approachId]);
        } catch {
          // Canonical preparation is the sole authority for executable quest starts.
        }
      }
    }
    return starts;
  }

  private buildCompactView(): OverworldCompactView {
    return buildOverworldSessionCompactViewFromSource(this.viewModelSourceState());
  }

  private cachedView(): OverworldView {
    if (this.caches.view) return this.caches.view;
    this.caches.view = this.buildView();
    return this.caches.view;
  }

  view(): OverworldView {
    return cloneOverworldView(this.cachedView());
  }

  private buildView(): OverworldView {
    return buildOverworldSessionViewFromSource({
      ...this.viewModelSourceState(),
      regionalArcs: this.world.regional_arcs,
      regionalArcAnchorTownsById: this.regionalArcAnchorTownsById,
      resolvedEventHomeIds: this.resolvedEventHomeIds,
    });
  }

  private questStartState(questId: string, approachId?: string): OverworldSessionQuestStartState {
    this.assertNoPendingRoadEncounter("starting a quest");
    const unfinishedQuestId = [...this.startedQuestIds].find(
      (startedQuestId) => !this.completedQuestIds.has(startedQuestId),
    );
    if (unfinishedQuestId && unfinishedQuestId !== questId) {
      const unfinishedQuest = this.questsById.get(unfinishedQuestId);
      throw new Error(
        `Finish the active quest ${unfinishedQuest?.title ?? unfinishedQuestId} before starting another quest.`,
      );
    }
    const registration = this.world.opening_registration;
    if (
      registration &&
      this.startedQuestIds.size === 0 &&
      this.completedQuestIds.size === 0 &&
      serializeCampaignCharacterState(this.characterState) === DEFAULT_CAMPAIGN_CHARACTER_SERIALIZED
    ) {
      const contact = this.charactersById.get(registration.contact);
      const area = this.areasById.get(registration.area);
      throw new Error(
        `Before starting the first quest, complete ${registration.title} with ${contact?.name ?? "the registration contact"} in ${area?.name ?? "the registration area"}.`,
      );
    }
    const reliefOath = this.world.opening_relief_oath;
    if (reliefOath?.target_quest === questId && !this.openingReliefOathResolved()) {
      throw new Error(`Choose ${reliefOath.title} before starting the first relief dispatch.`);
    }
    const leadSource = this.world.opening_lead_source;
    if (leadSource?.target_quest === questId && !this.openingLeadSourceResolved()) {
      throw new Error(`Choose ${leadSource.title} before starting the first relief dispatch.`);
    }
    return {
      ...this.actionJournalState(),
      questId,
      ...(approachId !== undefined ? { approachId } : {}),
      sessionFingerprint: this.snapshotHash(),
      supplies: this.supplies,
      fatigue: this.fatigue,
      character: this.characterState,
      journalEntries: this.journalEntries,
      openingRegistration: this.world.opening_registration ?? null,
      openingReliefOath: this.world.opening_relief_oath ?? null,
      openingLeadSource: this.world.opening_lead_source ?? null,
      openingPreparation: this.world.opening_preparation ?? null,
      openingReliefAllocation: this.world.opening_relief_allocation ?? null,
      openingAlly: this.world.opening_ally ?? null,
      questsById: this.questsById,
      areasById: this.areasById,
      currentTownId: this.currentId,
      currentTownName: this.currentNode().name,
      currentAreaId: this.currentArea()?.id ?? null,
      discoveredQuestIds: this.discoveredQuestIds,
      startedQuestIds: this.startedQuestIds,
    };
  }

  previewQuestStart(questId: string): OverworldQuestView {
    return cloneOverworldQuestView(
      previewOverworldSessionQuestStart(this.questStartState(questId)),
    );
  }

  prepareQuestStart(questId: string, approachId?: string): OverworldQuestStartPreparation {
    return authenticateQuestStartPreparation(
      this,
      planOverworldSessionQuestStart(this.questStartState(questId, approachId)),
    );
  }

  commitQuestStart(plan: OverworldQuestStartPreparation): OverworldJourneyQuestStartResult {
    this.assertJourneyAcceptingDecision();
    const canonicalPlan = planOverworldSessionQuestStart(
      this.questStartState(plan.quest.id, plan.approachId === null ? undefined : plan.approachId),
    );
    if (
      canonicalPlan.preconditionFingerprint !== plan.preconditionFingerprint ||
      hashState(canonicalPlan) !== hashState(plan)
    ) {
      throw new Error("Quest start plan is stale; prepare the quest start again.");
    }
    const requiresCurrentDispatchSeal =
      canonicalPlan.quest.id === "wolf_winter" &&
      Boolean(resolveOpeningDispatchManifestChain(this.world)?.ally);
    if (
      requiresCurrentDispatchSeal &&
      (canonicalPlan.approachId === null ||
        createQuestDispatchLaunchSeal({
          window: canonicalPlan.dispatchWindow,
          approachId: canonicalPlan.approachId,
          // This probe checks receipt completeness before any session mutation;
          // the durable seal below binds the actual post-decision boundary.
          launchBoundary: {
            acceptedDecisions: this.journeyState.acceptedDecisions,
            decisionProofHash: this.journeyState.decisionProof.hash,
            townId: this.currentId,
            areaId: this.currentAreaIdOrThrow(),
            minutes: this.minutes,
          },
        }) === null)
    ) {
      throw new Error("Wolf-Winter launch lacks an authenticated current dispatch receipt.");
    }
    const applied = applyOverworldSessionQuestStart(
      this.questStartState(
        canonicalPlan.quest.id,
        canonicalPlan.approachId === null ? undefined : canonicalPlan.approachId,
      ),
      canonicalPlan,
    );
    this.applyResourceClockState(applied);
    this.characterState = cloneCampaignCharacterState(applied.characterAfter);
    this.questLaunchCharacters.set(
      canonicalPlan.quest.id,
      cloneCampaignCharacterState(applied.characterAfter),
    );
    const journeyDecision = this.recordOverworldDecision(
      canonicalPlan.journeyActionId,
      "progress",
      applied.stateChanged,
      // Launch hands control to the embedded opening scene. Let the first
      // genuinely safe in-quest boundary surface an overdue checkpoint.
      false,
    );
    if (canonicalPlan.approachId !== null) {
      const boundary = {
        acceptedDecisions: this.journeyState.acceptedDecisions,
        decisionProofHash: this.journeyState.decisionProof.hash,
        townId: this.currentId,
        areaId: this.currentAreaIdOrThrow(),
        minutes: this.minutes,
      };
      const dispatchSeal = requiresCurrentDispatchSeal
        ? createQuestDispatchLaunchSeal({
            window: canonicalPlan.dispatchWindow,
            approachId: canonicalPlan.approachId,
            launchBoundary: boundary,
          })
        : null;
      if (requiresCurrentDispatchSeal && !dispatchSeal) {
        throw new Error("Wolf-Winter launch lacks an authenticated current dispatch receipt.");
      }
      applied.result.entry.questStartProof = {
        kind: "approach",
        approachId: canonicalPlan.approachId,
        boundary,
        ...(dispatchSeal ? { dispatchSeal } : {}),
      };
    }
    this.forgetStationDispatchSupportReveal(canonicalPlan.quest.id);
    this.clearSessionCaches();
    return withJourneyDecision(cloneOverworldQuestView(applied.quest), journeyDecision);
  }

  startQuest(questId: string, approachId?: string): OverworldJourneyQuestStartResult {
    return this.commitQuestStart(this.prepareQuestStart(questId, approachId));
  }

  completeQuest(
    questId: string,
    outcome: OverworldQuestCompletionOutcome,
  ): OverworldJourneyQuestCompletionResult {
    if (this.journeyState.status === "ended") throw new Error("This journey has ended.");
    this.assertNoPendingRoadEncounter("completing a quest");
    const completionState = {
      ...this.actionJournalState(),
      character: this.characterState,
      completedQuestIds: this.completedQuestIds,
      questOutcomeIds: this.questOutcomeIds,
      regionRenown: this.regionRenown,
      questId,
      outcome,
      questsById: this.questsById,
      areasById: this.areasById,
      nodesById: this.nodes,
      startedQuestIds: this.startedQuestIds,
      openingRegistration: this.world.opening_registration ?? null,
      openingReliefOath: this.world.opening_relief_oath ?? null,
      openingLeadSource: this.world.opening_lead_source ?? null,
    };
    const completionPlan = planOverworldSessionQuestCompletion(completionState);
    if (this.questsById.get(questId)?.campaign_exports === undefined) {
      assertJourneyCampaignQuestOutcome(questId, outcome.endingId);
    }
    const applied = applyOverworldSessionQuestCompletion(completionState, completionPlan);
    this.applyClockState(applied);
    if (applied.stateChanged) {
      applied.result.entry.questCompletionBoundary = {
        acceptedDecisions: this.journeyState.acceptedDecisions,
        decisionProofHash: this.journeyState.decisionProof.hash,
        townId: this.currentId,
        areaId: this.currentAreaIdOrThrow(),
        minutes: this.minutes,
      };
    }
    if (applied.stateChanged && !outcome.death) {
      this.characterState = applied.characterAfter;
      this.questOutcomeIds.set(questId, outcome.endingId);
    }
    if (
      applied.stateChanged &&
      !outcome.death &&
      journeyCampaignGoalIsComplete(this.journeyState.goal, this.completedQuestIds)
    ) {
      this.journeyState = recordJourneyGoalCompleted(this.journeyState);
    }
    if (applied.stateChanged) {
      this.clearSessionCaches();
    }
    return withJourneyDecision(
      cloneOverworldQuestCompletionResult(applied.result),
      classifyOverworldJourneyDecision("technical_quest_foldback", applied.stateChanged),
    );
  }

  scoutPoi(poiId: string): OverworldJourneyActionResult {
    this.assertJourneyAcceptingDecision();
    this.assertNoPendingRoadEncounter("scouting a point of interest");
    const current = this.currentNode();
    return this.applyLocalActionWithDiscovery(
      current,
      applyOverworldSessionPoiScoutFromState({
        ...this.actionJournalState(),
        poiId,
        poisById: this.poisById,
        currentTown: current,
        currentAreaId: () => this.currentAreaIdOrThrow(),
      }),
      `scout:${poiId}`,
      "clue",
    );
  }

  exploreArea(areaId: string): OverworldJourneyActionResult {
    this.assertJourneyAcceptingDecision();
    this.assertNoPendingRoadEncounter("exploring a local area");
    const current = this.currentNode();
    return this.applyLocalActionWithDiscovery(
      current,
      applyOverworldSessionAreaFromState({
        ...this.actionJournalState(),
        areaId,
        areasById: this.areasById,
        currentTownId: this.currentId,
        currentAreaId: this.currentArea()?.id ?? null,
        discoveredAreaIds: this.discoveredAreaIds,
        visitedAreaIds: this.visitedAreaIds,
        journalEntriesById: this.journalEntriesById,
        currentTownName: current.name,
      }),
      `explore_area:${areaId}`,
      "clue",
    );
  }

  moveArea(areaRouteId: string): OverworldJourneyAreaTravelResult {
    this.assertJourneyAcceptingDecision();
    this.assertNoPendingRoadEncounter("moving between local areas");
    const applied = applyOverworldSessionAreaTravelFromState({
      currentAreaByTown: this.currentAreaByTown,
      currentTownId: this.currentId,
      minutes: this.minutes,
      areaRouteId,
      currentArea: this.currentArea(),
      areaExitsByAreaAndId: this.areaExitsByAreaAndId,
      discoveredAreaIds: this.discoveredAreaIds,
    });
    this.applyCurrentAreaTravelState(applied);
    const journeyDecision = this.recordOverworldDecision(
      `move_area:${areaRouteId}`,
      "movement",
      true,
    );
    this.clearSessionCaches();
    return withJourneyDecision(
      cloneOverworldAreaTravelResult({
        from: applied.from,
        to: applied.to,
        route: applied.route,
        minutes: applied.minutes,
        arrivedAt: applied.arrivedAt,
      }),
      journeyDecision,
    );
  }

  workLocalJob(jobId: string, optionId?: string): OverworldJourneyActionResult {
    this.assertJourneyAcceptingDecision();
    this.assertNoPendingRoadEncounter("working a local job");
    const current = this.currentNode();
    return this.applyLocalActionWithDiscovery(
      current,
      applyOverworldSessionLocalJobFromState({
        ...this.actionJournalState(),
        jobId,
        optionId,
        jobsById: this.jobsById,
        areasById: this.areasById,
        currentTownId: this.currentId,
        currentRegion: current.region,
        currentAreaId: this.currentAreaIdOrThrow(),
        discoveredJobIds: this.discoveredJobIds,
        completedJobIds: this.completedJobIds,
        completedQuestIds: this.completedQuestIds,
        resolvedEventIds: this.resolvedEventIds,
        campaignWorldFactIds: new Set(this.campaignWorldFactIds()),
        campaignStoryChoiceKeys: new Set(
          this.selectedCampaignStoryChoiceRefs().map(campaignStoryChoiceRefKey),
        ),
        campaignCharacter: this.characterState,
        questsById: this.questsById,
        eventsById: this.localEventsById,
        journalEntriesById: this.journalEntriesById,
        regionRenown: this.regionRenown,
        currentTownName: current.name,
      }),
      optionId ? `work_job:${jobId}:${optionId}` : `work_job:${jobId}`,
      "progress",
    );
  }

  talkToCharacter(characterId: string): OverworldJourneyActionResult {
    this.assertJourneyAcceptingDecision();
    this.assertNoPendingRoadEncounter("talking to a contact");
    const current = this.currentNode();
    let applied = applyOverworldSessionContactTalkFromState({
      ...this.actionJournalState(),
      character: this.characterState,
      characterId,
      charactersById: this.charactersById,
      completedQuestIds: this.completedQuestIds,
      campaignWorldFactIds: new Set(this.campaignWorldFactIds()),
      eventOptionIdFor: (eventId) =>
        this.journalEntriesById.get(`resolve:${eventId}`)?.localSceneProof?.optionId ?? null,
      currentTownId: this.currentId,
      currentAreaId: () => this.currentAreaIdOrThrow(),
      currentTownName: current.name,
    });
    if (!applied.stateChanged && this.openingAllyOfferAfterContact(characterId)) {
      const { recordedAt: _recordedAt, ...contactDraft } = applied.result.entry;
      const repeated = recordOverworldRepeatableEntry(this.actionJournalState(), contactDraft, 0);
      applied = {
        ...applied,
        result: { ...applied.result, entry: repeated.entry },
        stateChanged: true,
      };
    }
    const result = this.applyLocalActionWithDiscovery(
      current,
      applied,
      `talk:${characterId}`,
      "dialogue",
    );
    this.offerOpeningRegistrationAfterContact(characterId);
    this.offerOpeningAllyAfterContact(characterId);
    return result;
  }

  investigateEvent(eventId: string): OverworldJourneyActionResult {
    this.assertJourneyAcceptingDecision();
    this.assertNoPendingRoadEncounter("investigating a local event");
    const current = this.currentNode();
    return this.applyLocalActionWithDiscovery(
      current,
      applyOverworldSessionEventInvestigationFromState({
        ...this.actionJournalState(),
        eventId,
        eventsById: this.localEventsById,
        completedQuestIds: this.completedQuestIds,
        completedJobIds: this.completedJobIds,
        campaignWorldFactIds: new Set(this.campaignWorldFactIds()),
        currentTownId: this.currentId,
        currentAreaId: () => this.currentAreaIdOrThrow(),
        currentTownName: current.name,
      }),
      `investigate_event:${eventId}`,
      "clue",
    );
  }

  resolveEvent(eventId: string, optionId?: string): OverworldJourneyActionResult {
    this.assertJourneyAcceptingDecision();
    this.assertNoPendingRoadEncounter("resolving a local event");
    const current = this.currentNode();
    return this.applyLocalActionWithDiscovery(
      current,
      applyOverworldSessionEventResolutionFromState({
        ...this.actionJournalState(),
        eventId,
        optionId,
        eventsById: this.localEventsById,
        currentTownId: this.currentId,
        currentTownName: current.name,
        currentRegion: current.region,
        currentAreaId: this.currentAreaIdOrThrow(),
        completedQuestIds: this.completedQuestIds,
        completedJobIds: this.completedJobIds,
        campaignWorldFactIds: new Set(this.campaignWorldFactIds()),
        resolvedEventIds: this.resolvedEventIds,
        resolvedEventHomeIds: this.resolvedEventHomeIds,
        regionRenown: this.regionRenown,
        regionalArcsByRegion: this.regionalArcsByRegion,
        completedRegionalArcIds: this.completedRegionalArcIds,
        poisByArea: this.poisByArea,
        charactersByArea: this.charactersByArea,
      }),
      optionId ? `resolve_event:${eventId}:${optionId}` : `resolve_event:${eventId}`,
      "progress",
    );
  }

  exploreSite(siteId: string): OverworldJourneyActionResult {
    this.assertJourneyAcceptingDecision();
    this.assertNoPendingRoadEncounter("exploring a site");
    const current = this.currentNode();
    return this.applyLocalActionWithDiscovery(
      current,
      applyOverworldSessionSiteFromState({
        ...this.actionJournalState(),
        siteId,
        sitesById: this.sitesById,
        currentTownId: this.currentId,
        currentAreaId: this.currentAreaIdOrThrow(),
        discoveredSiteIds: this.discoveredSiteIds,
        exploredSiteIds: this.exploredSiteIds,
        journalEntriesById: this.journalEntriesById,
        regionRenown: this.regionRenown,
        currentTownName: current.name,
      }),
      `explore_site:${siteId}`,
      "progress",
    );
  }

  restAtTown(): OverworldJourneyServiceResult {
    this.assertJourneyAcceptingDecision();
    this.assertNoPendingRoadEncounter("resting at town");
    return this.applyServiceApplication(
      applyOverworldSessionTownRestFromState({
        ...this.actionJournalState(),
        ...this.townServicePlanState(this.currentAreaIdOrThrow()),
      }),
      "rest",
    );
  }

  careAtTown(): OverworldJourneyServiceResult {
    this.assertJourneyAcceptingDecision();
    this.assertNoPendingRoadEncounter("receiving care at town");
    return this.applyServiceApplication(
      applyOverworldSessionTownCareFromState({
        ...this.actionJournalState(),
        ...this.townServicePlanState(this.currentAreaIdOrThrow()),
      }),
      "care",
    );
  }

  resupplyAtTown(): OverworldJourneyServiceResult {
    this.assertJourneyAcceptingDecision();
    this.assertNoPendingRoadEncounter("resupplying at town");
    return this.applyServiceApplication(
      applyOverworldSessionTownResupplyFromState({
        ...this.actionJournalState(),
        ...this.townServicePlanState(this.currentAreaIdOrThrow()),
      }),
      "resupply",
    );
  }

  planRoute(destinationId: string): OverworldSessionRoutePlan {
    this.assertNoPendingRoadEncounter("planning another road route");
    return cloneOverworldRouteOption(
      planOverworldSessionRoadRoute({
        destinationId,
        routePlannerIndex: this.routePlannerIndex,
        currentId: this.currentId,
        discoveredIds: this.discoveredIds,
        roadEventState: {
          activeGoalId: this.journeyState.goal.id,
          completedQuestIds: this.completedQuestIds,
          travelLog: this.travelLog,
        },
        resources: {
          fatigue: this.fatigue,
          supplies: this.supplies,
        },
      }),
    );
  }

  resolveRoadEncounter(
    strategy: OverworldRoadEncounterStrategy,
  ): OverworldJourneyRoadEncounterResult {
    this.assertJourneyAcceptingDecision();
    const applied = applyOverworldSessionRoadEncounter(
      {
        pendingRoadEncounter: this.pendingRoadEncounter,
        current: this.currentNode(),
        minutes: this.minutes,
        supplies: this.supplies,
        fatigue: this.fatigue,
        regionRenown: this.regionRenown,
        journalEntries: this.journalEntries,
        journalEntriesById: this.journalEntriesById,
      },
      strategy,
    );
    this.applyResourceClockState(applied);
    this.applyPendingRoadEncounterState(applied);
    const journeyDecision = this.recordOverworldDecision(
      `road_encounter:${strategy}`,
      "progress",
      true,
    );
    this.clearSessionCaches();
    return withJourneyDecision(cloneOverworldRoadEncounterResult(applied.result), journeyDecision);
  }

  private previewRoadTravelLeg(edgeId: string): OverworldTravelLegResult {
    const edge = this.roadExitsByTownAndId.get(this.currentId)?.get(edgeId);
    if (!edge) throw new Error("That road is not reachable from here.");
    const roadEvent = roadEventForOverworldSessionTravel(
      this.roadEventsByEdgeId.get(edge.id) ?? null,
      {
        activeGoalId: this.journeyState.goal.id,
        completedQuestIds: this.completedQuestIds,
        travelLog: this.travelLog,
      },
    );
    return resolveOverworldTravelLeg(edge.travel_minutes, roadEvent, {
      fatigue: this.fatigue,
      supplies: this.supplies,
    });
  }

  /** Apply one real road leg without assigning a journey-decision boundary. */
  private applyRoadTravelLeg(edgeId: string): TravelLogEntry {
    const recorded = applyOverworldSessionRoadTravelArrival(
      {
        activeGoalId: this.journeyState.goal.id,
        completedQuestIds: this.completedQuestIds,
        pendingRoadEncounter: this.pendingRoadEncounter,
        current: this.currentNode(),
        currentId: this.currentId,
        roadExitsByTownAndId: this.roadExitsByTownAndId,
        roadEventsByEdgeId: this.roadEventsByEdgeId,
        areasByTown: this.areasByTown,
        roadExitsByTown: this.roadExitsByTown,
        currentAreaId: this.currentAreaId,
        currentAreaByTown: this.currentAreaByTown,
        discoveredAreaIds: this.discoveredAreaIds,
        discoveredIds: this.discoveredIds,
        visitedIds: this.visitedIds,
        minutes: this.minutes,
        supplies: this.supplies,
        fatigue: this.fatigue,
        travelLog: this.travelLog,
      },
      edgeId,
    );
    this.applyResourceClockState(recorded);
    this.applyCurrentTownState(recorded);
    this.applyCurrentAreaState(recorded);
    this.applyPendingRoadEncounterState(recorded);
    this.clearSessionCaches();
    return recorded.entry;
  }

  /**
   * The overworld analogue of the quest surface's `isRpgCheckpointSafeBoundary`:
   * an arrival that raised a road encounter is mid-scene, not a break. Letting
   * the Continue/End checkpoint materialize there tells the player they reached
   * a "safe break" while the very next action they can take —
   * `resolveRoadEncounter` — throws "Choose whether to continue or end this
   * journey before taking another gameplay action", and ending there freezes the
   * journey read-only with the encounter still live and still asking to be
   * resolved. A due checkpoint is not lost: `nextCheckpoint` survives, and the
   * encounter's own resolution decision is a safe boundary that materializes it
   * one decision later as "the first safe break after decision N".
   */
  private overworldCheckpointSafeBoundary(): boolean {
    return this.pendingRoadEncounter === null;
  }

  travel(edgeId: string): OverworldJourneyTravelResult {
    this.assertJourneyAcceptingDecision();
    const entry = this.applyRoadTravelLeg(edgeId);
    const journeyDecision = this.recordOverworldDecision(
      `travel:${edgeId}`,
      "movement",
      true,
      this.overworldCheckpointSafeBoundary(),
    );
    this.clearSessionCaches();
    return withJourneyDecision(cloneOverworldTravelLogEntry(entry), journeyDecision);
  }

  followGoalPassage(): OverworldJourneyGoalPassageResult {
    this.assertJourneyAcceptingDecision();
    this.assertNoPendingRoadEncounter("following the current goal passage");
    const route = this.currentGoalRoute();
    if (!route || route.steps.length === 0) {
      throw new Error("No goal route is available from here.");
    }

    const goalId = this.journeyState.goal.id;
    const destinationId = route.destination.id;
    const destination = route.destination.name;
    const selectionDelayTier = overworldTravelDelayTier(this.fatigue);
    const selectionSupplies = this.supplies;
    const legs: TravelLogEntry[] = [];
    let stopReason: OverworldGoalPassageStopReason | null = null;

    for (const step of route.steps) {
      const preview = this.previewRoadTravelLeg(step.edge.id);
      if (
        goalPassageHitsResourceBoundary({
          traversedRoadCount: legs.length,
          selectionDelayTier,
          selectionSupplies,
          currentFatigue: this.fatigue,
          preview,
        })
      ) {
        stopReason = "resource_boundary";
        break;
      }

      legs.push(this.applyRoadTravelLeg(step.edge.id));
      if (this.pendingRoadEncounter) {
        stopReason = "road_encounter";
        break;
      }
      if (this.currentId === destinationId) {
        stopReason = "objective";
        break;
      }
    }

    if (legs.length === 0 || stopReason === null) {
      throw new Error("The goal route cannot advance from here.");
    }

    const journeyDecision = this.recordOverworldDecision(
      goalPassageJourneyActionId(
        goalId,
        legs.map((leg) => leg.edgeId),
      ),
      "movement",
      true,
      this.overworldCheckpointSafeBoundary(),
    );
    this.clearSessionCaches();
    const result: OverworldGoalPassageResult = {
      goalId,
      destination,
      stoppedAt: this.currentNode().name,
      stopReason,
      legs,
      baseMinutes: legs.reduce((sum, leg) => sum + leg.baseMinutes, 0),
      delayMinutes: legs.reduce((sum, leg) => sum + leg.delayMinutes, 0),
      minutes: legs.reduce((sum, leg) => sum + leg.minutes, 0),
      suppliesUsed: legs.reduce((sum, leg) => sum + leg.suppliesUsed, 0),
      suppliesAfter: this.supplies,
      fatigueGained: legs.reduce((sum, leg) => sum + leg.fatigueGained, 0),
      fatigueAfter: this.fatigue,
      travelConditionAfter: travelCondition(this.fatigue, this.supplies),
    };
    return withJourneyDecision(cloneOverworldGoalPassageResult(result), journeyDecision);
  }

  travelTo(destinationTownId: string): OverworldJourneyTravelResult {
    const matchingRoads = this.roadsFrom(this.currentId).filter(
      (road) => road.destination.id === destinationTownId,
    );
    if (matchingRoads.length === 0) {
      throw new Error(
        `No road from "${this.currentId}" reaches destination town "${destinationTownId}".`,
      );
    }
    if (matchingRoads.length > 1) {
      throw new Error(
        `Multiple roads from "${this.currentId}" reach "${destinationTownId}"; use road_id.`,
      );
    }
    return this.travel(matchingRoads[0]!.id);
  }
}
