import {
  describeOverworldContactAction,
  describeOverworldEventAction,
  describeOverworldPoiAction,
  type OverworldLocalActionDescriptor,
  type OverworldLocalActionKind,
} from "./local_actions.js";
import type {
  OverworldArea,
  OverworldAreaExit,
  OverworldCharacter,
  OverworldExplorationSite,
  OverworldExit,
  OverworldLocalEvent,
  OverworldLocalJob,
  OverworldNode,
  OverworldPoi,
  OverworldQuest,
} from "./overworld.js";
import {
  recordOverworldSessionLocalAction,
  type OverworldSessionActionApplication,
} from "./session_action_application.js";
import type { OverworldActionJournalState } from "./session_action_recording.js";
import { presentOverworldContact } from "./session_contact_presentation.js";
import {
  applyOverworldAreaExploration,
  applyOverworldAreaTravel,
  applyOverworldLocalJobCompletion,
  applyOverworldSiteExploration,
  applyOverworldTownVisit,
  planOverworldAreaExploration,
  planOverworldLocalJobCompletion,
  planOverworldSiteExploration,
  type OverworldAppliedAreaTravel,
  type OverworldAppliedTownVisit,
  type OverworldAreaExplorationPlan,
  type OverworldLocalJobCompletionPlan,
  type OverworldSiteExplorationPlan,
} from "./session_local_actions.js";
import type { OverworldJournalEntry } from "./session_snapshot.js";
import type { CampaignCharacterState } from "./campaign_character_state.js";
import {
  availableLocalEventSceneOptions,
  localEventSceneRequirementError,
  localEventSceneRequirementsMet,
} from "./local_event_scene.js";

type OverworldSessionAreaPlanState = {
  areaId: string;
  areasById: ReadonlyMap<string, OverworldArea>;
  currentTownId: string;
  currentAreaId: string | null;
  discoveredAreaIds: ReadonlySet<string>;
  visitedAreaIds: ReadonlySet<string>;
  journalEntries: ReadonlyMap<string, OverworldJournalEntry>;
};

type OverworldSessionAreaTravelPlanState = {
  areaRouteId: string;
  currentArea: OverworldArea | null;
  areaExitsByAreaAndId: ReadonlyMap<string, ReadonlyMap<string, OverworldAreaExit>>;
  discoveredAreaIds: ReadonlySet<string>;
};

type OverworldSessionAreaTravelPlan = {
  currentArea: OverworldArea;
  edge: OverworldAreaExit;
};

export type MutableOverworldSessionTownVisitState = {
  nodeId: string;
  areasByTown: ReadonlyMap<string, readonly OverworldArea[]>;
  roadExitsByTown: ReadonlyMap<string, readonly OverworldExit[]>;
  currentAreaId: string | null;
  currentAreaByTown: Map<string, string>;
  discoveredAreaIds: Set<string>;
  discoveredIds: Set<string>;
  visitedIds: Set<string>;
};

type OverworldSessionLocalJobPlanState = {
  jobId: string;
  optionId?: string | undefined;
  jobsById: ReadonlyMap<string, OverworldLocalJob>;
  areasById: ReadonlyMap<string, OverworldArea>;
  currentTownId: string;
  currentRegion: string;
  currentAreaId: string | null;
  discoveredJobIds: ReadonlySet<string>;
  completedJobIds: ReadonlySet<string>;
  completedQuestIds?: ReadonlySet<string> | undefined;
  resolvedEventIds?: ReadonlySet<string> | undefined;
  campaignWorldFactIds?: ReadonlySet<string> | undefined;
  campaignStoryChoiceKeys?: ReadonlySet<string> | undefined;
  campaignCharacter?: CampaignCharacterState | undefined;
  questsById?: ReadonlyMap<string, Pick<OverworldQuest, "title">> | undefined;
  eventsById?: ReadonlyMap<string, Pick<OverworldLocalEvent, "title">> | undefined;
  journalEntries: ReadonlyMap<string, OverworldJournalEntry>;
};

type OverworldSessionSitePlanState = {
  siteId: string;
  sitesById: ReadonlyMap<string, OverworldExplorationSite>;
  currentTownId: string;
  currentAreaId: string | null;
  discoveredSiteIds: ReadonlySet<string>;
  exploredSiteIds: ReadonlySet<string>;
  journalEntries: ReadonlyMap<string, OverworldJournalEntry>;
};

type OverworldSessionPoiScoutPlanState = {
  poiId: string;
  poisById: ReadonlyMap<string, OverworldPoi>;
  currentTown: OverworldNode;
  currentAreaId: () => string;
};

type OverworldSessionContactTalkPlanState = {
  character: CampaignCharacterState;
  characterId: string;
  charactersById: ReadonlyMap<string, OverworldCharacter>;
  completedQuestIds: ReadonlySet<string>;
  campaignWorldFactIds?: ReadonlySet<string>;
  eventOptionIdFor?: (eventId: string) => string | null;
  currentTownId: string;
  currentAreaId: () => string;
};

type OverworldSessionEventInvestigationPlanState = {
  eventId: string;
  eventsById: ReadonlyMap<string, OverworldLocalEvent>;
  completedQuestIds: ReadonlySet<string>;
  completedJobIds?: ReadonlySet<string> | undefined;
  campaignWorldFactIds?: ReadonlySet<string> | undefined;
  currentTownId: string;
  currentAreaId: () => string;
};

type OverworldSessionLocalInteractionPlan<
  Kind extends OverworldLocalActionKind = OverworldLocalActionKind,
> = {
  action: OverworldLocalActionDescriptor<Kind>;
};

type MutableOverworldSessionLocalJobState = OverworldActionJournalState & {
  completedJobIds: Set<string>;
  regionRenown: Map<string, number>;
};

type MutableOverworldSessionAreaState = OverworldActionJournalState & {
  visitedAreaIds: Set<string>;
};

type MutableOverworldSessionAreaTravelState = {
  currentAreaByTown: Map<string, string>;
  currentTownId: string;
  minutes: number;
};

type MutableOverworldSessionSiteState = OverworldActionJournalState & {
  exploredSiteIds: Set<string>;
  regionRenown: Map<string, number>;
};

type OverworldSessionPoiScoutState = OverworldActionJournalState &
  OverworldSessionPoiScoutPlanState;

type OverworldSessionContactTalkState = OverworldActionJournalState &
  OverworldSessionContactTalkPlanState & {
    currentTownName: string;
  };

type OverworldSessionEventInvestigationState = OverworldActionJournalState &
  OverworldSessionEventInvestigationPlanState & {
    currentTownName: string;
  };

type OverworldSessionAreaState = Omit<OverworldSessionAreaPlanState, "journalEntries"> &
  MutableOverworldSessionAreaState & {
    currentTownName: string;
    journalEntriesById: ReadonlyMap<string, OverworldJournalEntry>;
  };

type OverworldSessionLocalJobState = Omit<OverworldSessionLocalJobPlanState, "journalEntries"> &
  MutableOverworldSessionLocalJobState & {
    currentTownName: string;
    journalEntriesById: ReadonlyMap<string, OverworldJournalEntry>;
  };

type OverworldSessionSiteState = Omit<OverworldSessionSitePlanState, "journalEntries"> &
  MutableOverworldSessionSiteState & {
    currentTownName: string;
    journalEntriesById: ReadonlyMap<string, OverworldJournalEntry>;
  };

type OverworldSessionAreaTravelState = OverworldSessionAreaTravelPlanState &
  MutableOverworldSessionAreaTravelState;

export function planOverworldSessionArea(
  state: OverworldSessionAreaPlanState,
): OverworldAreaExplorationPlan {
  return planOverworldAreaExploration(state);
}

function planOverworldSessionAreaTravel(
  state: OverworldSessionAreaTravelPlanState,
): OverworldSessionAreaTravelPlan {
  if (!state.currentArea) throw new Error("There is no current local area in this town.");

  const edge = state.areaExitsByAreaAndId.get(state.currentArea.id)?.get(state.areaRouteId);
  if (!edge) throw new Error("That local route is not reachable from here.");
  if (!state.discoveredAreaIds.has(edge.destination.id)) {
    throw new Error("Map that local area before moving there.");
  }

  return {
    currentArea: state.currentArea,
    edge,
  };
}

export function planOverworldSessionLocalJob(
  state: OverworldSessionLocalJobPlanState,
): OverworldLocalJobCompletionPlan {
  return planOverworldLocalJobCompletion(state);
}

export function planOverworldSessionSite(
  state: OverworldSessionSitePlanState,
): OverworldSiteExplorationPlan {
  return planOverworldSiteExploration(state);
}

export function planOverworldSessionPoiScout(
  state: OverworldSessionPoiScoutPlanState,
): OverworldSessionLocalInteractionPlan<"poi"> {
  const poi = state.poisById.get(state.poiId);
  if (!poi || poi.home !== state.currentTown.id) {
    throw new Error("That point of interest is not in this town.");
  }
  if (poi.area !== state.currentAreaId()) {
    throw new Error("Move to that local area before scouting this point of interest.");
  }
  return { action: describeOverworldPoiAction(poi, state.currentTown) };
}

export function planOverworldSessionContactTalk(
  state: OverworldSessionContactTalkPlanState,
): OverworldSessionLocalInteractionPlan<"contact"> {
  const character = state.charactersById.get(state.characterId);
  if (!character || character.home !== state.currentTownId) {
    throw new Error("That contact is not in this town.");
  }
  if (character.area !== state.currentAreaId()) {
    throw new Error("Move to that local area before talking to that contact.");
  }
  const presentation = presentOverworldContact(character, {
    character: state.character,
    completedQuestIds: state.completedQuestIds,
    ...(state.campaignWorldFactIds ? { worldFactIds: state.campaignWorldFactIds } : {}),
    ...(state.eventOptionIdFor ? { eventOptionIdFor: state.eventOptionIdFor } : {}),
  });
  return {
    action: describeOverworldContactAction(presentation.contact, presentation.presentationId),
  };
}

export function planOverworldSessionEventInvestigation(
  state: OverworldSessionEventInvestigationPlanState,
): OverworldSessionLocalInteractionPlan<"event"> {
  const event = state.eventsById.get(state.eventId);
  if (!event || event.home !== state.currentTownId) {
    throw new Error("That event is not active in this town.");
  }
  if (event.area !== state.currentAreaId()) {
    throw new Error("Move to that local area before investigating that event.");
  }
  if (
    event.authored_scene &&
    !localEventSceneRequirementsMet(event.authored_scene, {
      completedQuestIds: state.completedQuestIds,
      completedJobIds: state.completedJobIds,
      worldFactIds: state.campaignWorldFactIds,
    })
  ) {
    throw new Error(
      `${event.title}: ${
        localEventSceneRequirementError(event.authored_scene, {
          completedQuestIds: state.completedQuestIds,
          completedJobIds: state.completedJobIds,
          worldFactIds: state.campaignWorldFactIds,
        }) ?? "Its authored requirements are not met."
      }`,
    );
  }
  if (
    event.authored_scene &&
    availableLocalEventSceneOptions(event.authored_scene, {
      completedQuestIds: state.completedQuestIds,
      completedJobIds: state.completedJobIds,
      worldFactIds: state.campaignWorldFactIds,
    }).length === 0
  ) {
    throw new Error(`No authored option for ${event.title} is available in this journey.`);
  }
  return { action: describeOverworldEventAction(event) };
}

type OverworldOpportunityInteractionDiscoveryState = Readonly<{
  character: CampaignCharacterState;
  characters: readonly OverworldCharacter[];
  charactersById: ReadonlyMap<string, OverworldCharacter>;
  events: readonly OverworldLocalEvent[];
  eventsById: ReadonlyMap<string, OverworldLocalEvent>;
  completedQuestIds: ReadonlySet<string>;
  completedJobIds: ReadonlySet<string>;
  campaignWorldFactIds: ReadonlySet<string>;
  eventOptionIdFor: (eventId: string) => string | null;
  currentTownId: string;
  currentAreaId: string;
  journalEntryIds: ReadonlySet<string>;
}>;

type OverworldOpportunityInteractionDiscoveryPlan = Readonly<{
  sourceId: string;
  plan: OverworldSessionLocalInteractionPlan<"contact" | "event">;
}>;

/** First lawful contact or event interaction that can advance local opportunity discovery. */
export function planOverworldOpportunityInteractionDiscovery(
  state: OverworldOpportunityInteractionDiscoveryState,
): OverworldOpportunityInteractionDiscoveryPlan | null {
  for (const character of state.characters) {
    const plan = planOverworldSessionContactTalk({
      character: state.character,
      characterId: character.id,
      charactersById: state.charactersById,
      completedQuestIds: state.completedQuestIds,
      campaignWorldFactIds: state.campaignWorldFactIds,
      eventOptionIdFor: state.eventOptionIdFor,
      currentTownId: state.currentTownId,
      currentAreaId: () => state.currentAreaId,
    });
    if (!state.journalEntryIds.has(plan.action.id)) {
      return { sourceId: character.id, plan };
    }
  }
  for (const event of state.events) {
    try {
      const plan = planOverworldSessionEventInvestigation({
        eventId: event.id,
        eventsById: state.eventsById,
        completedQuestIds: state.completedQuestIds,
        completedJobIds: state.completedJobIds,
        campaignWorldFactIds: state.campaignWorldFactIds,
        currentTownId: state.currentTownId,
        currentAreaId: () => state.currentAreaId,
      });
      if (!state.journalEntryIds.has(plan.action.id)) {
        return { sourceId: event.id, plan };
      }
    } catch {
      // Canonical planning remains the authority for whether this visible event is lawful now.
    }
  }
  return null;
}

function applyOverworldSessionLocalInteraction(
  state: OverworldActionJournalState,
  plan: OverworldSessionLocalInteractionPlan,
  townName: string,
): OverworldSessionActionApplication {
  return recordOverworldSessionLocalAction(state, plan.action, townName);
}

export function applyOverworldSessionPoiScoutFromState(
  state: OverworldSessionPoiScoutState,
): OverworldSessionActionApplication {
  return applyOverworldSessionLocalInteraction(
    state,
    planOverworldSessionPoiScout(state),
    state.currentTown.name,
  );
}

export function applyOverworldSessionContactTalkFromState(
  state: OverworldSessionContactTalkState,
): OverworldSessionActionApplication {
  return applyOverworldSessionLocalInteraction(
    state,
    planOverworldSessionContactTalk(state),
    state.currentTownName,
  );
}

export function applyOverworldSessionEventInvestigationFromState(
  state: OverworldSessionEventInvestigationState,
): OverworldSessionActionApplication {
  return applyOverworldSessionLocalInteraction(
    state,
    planOverworldSessionEventInvestigation(state),
    state.currentTownName,
  );
}

function applyOverworldSessionAreaTravel(
  state: MutableOverworldSessionAreaTravelState,
  plan: OverworldSessionAreaTravelPlan,
): OverworldAppliedAreaTravel {
  return applyOverworldAreaTravel(plan.currentArea, plan.edge, state);
}

export function applyOverworldSessionAreaTravelFromState(
  state: OverworldSessionAreaTravelState,
): OverworldAppliedAreaTravel {
  return applyOverworldSessionAreaTravel(state, planOverworldSessionAreaTravel(state));
}

export function applyOverworldSessionTownVisit(
  state: MutableOverworldSessionTownVisitState,
): OverworldAppliedTownVisit {
  return applyOverworldTownVisit({
    nodeId: state.nodeId,
    localAreas: state.areasByTown.get(state.nodeId) ?? [],
    currentAreaId: state.currentAreaId,
    currentAreaByTown: state.currentAreaByTown,
    discoveredAreaIds: state.discoveredAreaIds,
    discoveredIds: state.discoveredIds,
    roadDestinationIds: (state.roadExitsByTown.get(state.nodeId) ?? []).map(
      (edge) => edge.destination.id,
    ),
    visitedIds: state.visitedIds,
  });
}

function applyOverworldSessionArea(
  state: MutableOverworldSessionAreaState,
  plan: OverworldAreaExplorationPlan,
  townName: string,
): OverworldSessionActionApplication {
  if (plan.alreadyKnown) {
    return {
      result: {
        minutes: 0,
        alreadyKnown: true,
        entry: plan.entry,
      },
      minutesAfter: state.minutes,
      stateChanged: false,
    };
  }

  const applied = recordOverworldSessionLocalAction(state, plan.action, townName);
  if (!applied.result.alreadyKnown) {
    applyOverworldAreaExploration({ visitedAreaIds: state.visitedAreaIds }, plan);
  }
  return applied;
}

export function applyOverworldSessionAreaFromState(
  state: OverworldSessionAreaState,
): OverworldSessionActionApplication {
  return applyOverworldSessionArea(
    state,
    planOverworldSessionArea({
      ...state,
      journalEntries: state.journalEntriesById,
    }),
    state.currentTownName,
  );
}

function applyOverworldSessionLocalJob(
  state: MutableOverworldSessionLocalJobState,
  plan: OverworldLocalJobCompletionPlan,
  townName: string,
): OverworldSessionActionApplication {
  if (plan.alreadyKnown) {
    return {
      result: {
        minutes: 0,
        alreadyKnown: true,
        entry: plan.entry,
      },
      minutesAfter: state.minutes,
      stateChanged: false,
    };
  }

  const applied = recordOverworldSessionLocalAction(state, plan.action, townName);
  if (!applied.result.alreadyKnown) {
    if (plan.localScene) {
      applied.result.entry.localSceneProof = {
        sceneId: plan.localScene.scene.id,
        optionId: plan.localScene.option.id,
      };
    }
    applyOverworldLocalJobCompletion(
      {
        completedJobIds: state.completedJobIds,
        regionRenown: state.regionRenown,
      },
      plan,
    );
  }
  return applied;
}

export function applyOverworldSessionLocalJobFromState(
  state: OverworldSessionLocalJobState,
): OverworldSessionActionApplication {
  return applyOverworldSessionLocalJob(
    state,
    planOverworldSessionLocalJob({
      ...state,
      journalEntries: state.journalEntriesById,
    }),
    state.currentTownName,
  );
}

function applyOverworldSessionSite(
  state: MutableOverworldSessionSiteState,
  plan: OverworldSiteExplorationPlan,
  townName: string,
): OverworldSessionActionApplication {
  if (plan.alreadyKnown) {
    return {
      result: {
        minutes: 0,
        alreadyKnown: true,
        entry: plan.entry,
      },
      minutesAfter: state.minutes,
      stateChanged: false,
    };
  }

  const applied = recordOverworldSessionLocalAction(state, plan.action, townName);
  if (!applied.result.alreadyKnown) {
    applyOverworldSiteExploration(
      {
        exploredSiteIds: state.exploredSiteIds,
        regionRenown: state.regionRenown,
      },
      plan,
    );
  }
  return applied;
}

export function applyOverworldSessionSiteFromState(
  state: OverworldSessionSiteState,
): OverworldSessionActionApplication {
  return applyOverworldSessionSite(
    state,
    planOverworldSessionSite({
      ...state,
      journalEntries: state.journalEntriesById,
    }),
    state.currentTownName,
  );
}
