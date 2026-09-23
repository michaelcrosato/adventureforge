import {
  describeOverworldAreaAction,
  describeOverworldJobAction,
  describeOverworldSiteAction,
  type OverworldLocalActionDescriptor,
} from "./local_actions.js";
import type {
  OverworldArea,
  OverworldAreaExit,
  OverworldExplorationSite,
  OverworldLocalEvent,
  OverworldLocalJob,
  OverworldQuest,
} from "./overworld.js";
import {
  availableLocalJobSceneOptions,
  describeUnmetLocalJobSceneOptionGates,
  localJobSceneChronologyBlockedReason,
  localJobSceneOptionRequirementsMet,
  resolveLocalJobSceneOption,
  type LocalJobScene,
  type LocalJobSceneOption,
} from "./local_job_scene.js";
import { timeLabel } from "./session_journal_codec.js";
import type { OverworldJournalEntry } from "./session_snapshot.js";
import type { CampaignCharacterState } from "./campaign_character_state.js";

type OverworldJournalEntryLookup = {
  get(id: string): OverworldJournalEntry | undefined;
};

export type OverworldLocalActionKnownPlan = {
  alreadyKnown: true;
  minutes: 0;
  entry: OverworldJournalEntry;
};

export type OverworldAreaExplorationPlan =
  | OverworldLocalActionKnownPlan
  | {
      alreadyKnown: false;
      areaId: string;
      action: OverworldLocalActionDescriptor<"area">;
    };

type OverworldPlannedAreaExploration = Extract<
  OverworldAreaExplorationPlan,
  { alreadyKnown: false }
>;

export type OverworldLocalJobCompletionPlan =
  | OverworldLocalActionKnownPlan
  | {
      alreadyKnown: false;
      jobId: string;
      action: OverworldLocalActionDescriptor<"job">;
      renownRegion: string;
      renown: number;
      localScene?: {
        scene: LocalJobScene;
        option: LocalJobSceneOption;
      };
    };

type OverworldPlannedLocalJobCompletion = Extract<
  OverworldLocalJobCompletionPlan,
  { alreadyKnown: false }
>;

export type OverworldSiteExplorationPlan =
  | OverworldLocalActionKnownPlan
  | {
      alreadyKnown: false;
      siteId: string;
      action: OverworldLocalActionDescriptor<"site">;
      renownRegion: string;
      renown: number;
    };

type OverworldPlannedSiteExploration = Extract<
  OverworldSiteExplorationPlan,
  { alreadyKnown: false }
>;

export type OverworldAreaTravelResult = {
  from: OverworldArea;
  to: OverworldArea;
  route: string;
  minutes: number;
  arrivedAt: string;
};

type OverworldAreaTravelApplicationState = {
  currentAreaByTown: Map<string, string>;
  currentTownId: string;
  minutes: number;
};

export type OverworldAppliedAreaTravel = OverworldAreaTravelResult & {
  currentAreaIdAfter: string;
  currentAreaByTownEntry: readonly [string, string];
  minutesAfter: number;
};

type OverworldLocalRenownCompletionState = {
  completedIds: Set<string>;
  regionRenown: Map<string, number>;
};

type OverworldAppliedLocalRenownCompletion = {
  completedId: string;
  renownRegion: string;
  renownGained: number;
  renownAfter: number;
};

type OverworldAreaExplorationApplicationState = {
  visitedAreaIds: Set<string>;
};

type OverworldAppliedAreaExploration = {
  areaId: string;
};

type OverworldCurrentAreaSelectionState = {
  nodeId: string;
  localAreas: readonly Pick<OverworldArea, "id">[];
  currentAreaId: string | null;
  currentAreaByTown: Map<string, string>;
  discoveredAreaIds: Set<string>;
};

export type OverworldAppliedCurrentAreaSelection = {
  currentAreaIdAfter: string | null;
  stateChanged: boolean;
};

type OverworldTownVisitApplicationState = OverworldCurrentAreaSelectionState & {
  discoveredIds: Set<string>;
  roadDestinationIds: readonly string[];
  visitedIds: Set<string>;
};

export type OverworldAppliedTownVisit = {
  currentAreaIdAfter: string | null;
  stateChanged: boolean;
};

type OverworldAreaExplorationState = {
  areaId: string;
  areasById: ReadonlyMap<string, OverworldArea>;
  currentTownId: string;
  currentAreaId: string | null;
  discoveredAreaIds: ReadonlySet<string>;
  visitedAreaIds: ReadonlySet<string>;
  journalEntries: OverworldJournalEntryLookup;
};

type OverworldLocalJobCompletionState = {
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
  /** Title lookups for the chronology-gate rejection; ids are shown when absent. */
  questsById?: ReadonlyMap<string, Pick<OverworldQuest, "title">> | undefined;
  eventsById?: ReadonlyMap<string, Pick<OverworldLocalEvent, "title">> | undefined;
  journalEntries: ReadonlyMap<string, OverworldJournalEntry>;
};

type OverworldSiteExplorationState = {
  siteId: string;
  sitesById: ReadonlyMap<string, OverworldExplorationSite>;
  currentTownId: string;
  currentAreaId: string | null;
  discoveredSiteIds: ReadonlySet<string>;
  exploredSiteIds: ReadonlySet<string>;
  journalEntries: OverworldJournalEntryLookup;
};

function addStringId(target: Set<string>, value: string): boolean {
  const changed = !target.has(value);
  target.add(value);
  return changed;
}

export function applyOverworldAreaTravel(
  currentArea: OverworldArea,
  edge: OverworldAreaExit,
  state: OverworldAreaTravelApplicationState,
): OverworldAppliedAreaTravel {
  const minutesAfter = state.minutes + edge.travel_minutes;
  const currentAreaByTownEntry: readonly [string, string] = [
    state.currentTownId,
    edge.destination.id,
  ];
  state.currentAreaByTown.set(...currentAreaByTownEntry);
  return {
    from: currentArea,
    to: edge.destination,
    route: edge.route,
    minutes: edge.travel_minutes,
    arrivedAt: timeLabel(minutesAfter),
    currentAreaIdAfter: edge.destination.id,
    currentAreaByTownEntry,
    minutesAfter,
  };
}

export function applyOverworldAreaExploration(
  state: OverworldAreaExplorationApplicationState,
  plan: OverworldPlannedAreaExploration,
): OverworldAppliedAreaExploration {
  state.visitedAreaIds.add(plan.areaId);
  return { areaId: plan.areaId };
}

export function applyOverworldCurrentAreaSelection(
  state: OverworldCurrentAreaSelectionState,
): OverworldAppliedCurrentAreaSelection {
  const saved = state.currentAreaByTown.get(state.nodeId);
  const next =
    saved && state.localAreas.some((area) => area.id === saved)
      ? saved
      : (state.localAreas[0]?.id ?? null);
  const hadSaved = next ? state.currentAreaByTown.get(state.nodeId) === next : true;
  const alreadyDiscovered = next ? state.discoveredAreaIds.has(next) : true;

  if (next) {
    state.currentAreaByTown.set(state.nodeId, next);
    state.discoveredAreaIds.add(next);
  }

  return {
    currentAreaIdAfter: next,
    stateChanged: state.currentAreaId !== next || !hadSaved || !alreadyDiscovered,
  };
}

export function applyOverworldTownVisit(
  state: OverworldTownVisitApplicationState,
): OverworldAppliedTownVisit {
  let stateChanged = addStringId(state.discoveredIds, state.nodeId);
  stateChanged = addStringId(state.visitedIds, state.nodeId) || stateChanged;

  const initialAreaId = state.localAreas[0]?.id;
  if (initialAreaId) {
    stateChanged = addStringId(state.discoveredAreaIds, initialAreaId) || stateChanged;
  }

  const areaSelection = applyOverworldCurrentAreaSelection(state);
  stateChanged = areaSelection.stateChanged || stateChanged;

  for (const destinationId of state.roadDestinationIds) {
    stateChanged = addStringId(state.discoveredIds, destinationId) || stateChanged;
  }

  return {
    currentAreaIdAfter: areaSelection.currentAreaIdAfter,
    stateChanged,
  };
}

function applyOverworldLocalRenownCompletion(
  state: OverworldLocalRenownCompletionState,
  completedId: string,
  renownRegion: string,
  renownGained: number,
): OverworldAppliedLocalRenownCompletion {
  state.completedIds.add(completedId);
  state.regionRenown.set(renownRegion, (state.regionRenown.get(renownRegion) ?? 0) + renownGained);
  return {
    completedId,
    renownRegion,
    renownGained,
    renownAfter: state.regionRenown.get(renownRegion) ?? 0,
  };
}

export function applyOverworldLocalJobCompletion(
  state: {
    completedJobIds: Set<string>;
    regionRenown: Map<string, number>;
  },
  plan: OverworldPlannedLocalJobCompletion,
): OverworldAppliedLocalRenownCompletion {
  return applyOverworldLocalRenownCompletion(
    {
      completedIds: state.completedJobIds,
      regionRenown: state.regionRenown,
    },
    plan.jobId,
    plan.renownRegion,
    plan.renown,
  );
}

export function applyOverworldSiteExploration(
  state: {
    exploredSiteIds: Set<string>;
    regionRenown: Map<string, number>;
  },
  plan: OverworldPlannedSiteExploration,
): OverworldAppliedLocalRenownCompletion {
  return applyOverworldLocalRenownCompletion(
    {
      completedIds: state.exploredSiteIds,
      regionRenown: state.regionRenown,
    },
    plan.siteId,
    plan.renownRegion,
    plan.renown,
  );
}

export function planOverworldAreaExploration(
  state: OverworldAreaExplorationState,
): OverworldAreaExplorationPlan {
  const area = state.areasById.get(state.areaId);
  if (!area || area.home !== state.currentTownId) throw new Error("That area is not in this town.");
  if (!state.discoveredAreaIds.has(area.id)) {
    throw new Error(
      "This area is not mapped. Explore a known area, scout a point of interest, talk to a contact, or investigate an event to reveal it.",
    );
  }
  if (state.currentAreaId !== area.id) {
    throw new Error("Move to that local area before exploring it.");
  }
  if (state.visitedAreaIds.has(area.id)) {
    const existing = state.journalEntries.get(`area:${area.id}`);
    if (existing) return { alreadyKnown: true, minutes: 0, entry: existing };
  }

  return {
    alreadyKnown: false,
    areaId: area.id,
    action: describeOverworldAreaAction(area),
  };
}

export function planOverworldLocalJobCompletion(
  state: OverworldLocalJobCompletionState,
): OverworldLocalJobCompletionPlan {
  const job = state.jobsById.get(state.jobId);
  if (!job || job.home !== state.currentTownId) {
    throw new Error("That local job is not in this town.");
  }
  if (!state.discoveredJobIds.has(job.id)) {
    throw new Error("This job is not discovered. Take fresh local actions to reveal jobs.");
  }
  if (job.area !== state.currentAreaId) {
    throw new Error("Move to that local area before working that job.");
  }
  const scene = job.authored_scene;
  let sceneOption: LocalJobSceneOption | null = null;
  if (scene) {
    if (!state.journalEntries.has(`scout:${scene.required_poi_id}`)) {
      throw new Error(`Scout the required point of interest before working ${job.title}.`);
    }
    const baseContactJournalId = `talk:${scene.required_contact_id}`;
    const talkedToRequiredContact = [...state.journalEntries.keys()].some(
      (entryId) =>
        entryId === baseContactJournalId || entryId.startsWith(`${baseContactJournalId}@`),
    );
    if (!talkedToRequiredContact) {
      throw new Error(`Talk to the required contact before working ${job.title}.`);
    }
    const conditionState = {
      completedQuestIds: state.completedQuestIds ?? new Set<string>(),
      resolvedEventIds: state.resolvedEventIds ?? new Set<string>(),
      worldFactIds: state.campaignWorldFactIds ?? new Set<string>(),
      storyChoiceKeys: state.campaignStoryChoiceKeys ?? new Set<string>(),
      ...(state.campaignCharacter ? { character: state.campaignCharacter } : {}),
      eventOptionIdFor: (eventId: string) =>
        state.journalEntries.get(`resolve:${eventId}`)?.localSceneProof?.optionId ?? null,
    };
    // Shared with the listing's blocked reason (session_local_view.ts) so the two
    // surfaces cannot describe the same unmet gate two different ways.
    const chronologyBlockedReason = localJobSceneChronologyBlockedReason(
      scene,
      job.title,
      conditionState,
      {
        questTitle: (questId) => state.questsById?.get(questId)?.title ?? questId,
        eventTitle: (eventId) => state.eventsById?.get(eventId)?.title ?? eventId,
      },
    );
    if (chronologyBlockedReason) {
      throw new Error(chronologyBlockedReason);
    }
    if (!state.optionId) {
      // Every scene-level gate above already passed, so each id named here is
      // immediately workable rather than a guess the caller has to resolve elsewhere.
      const availableIds = availableLocalJobSceneOptions(scene, conditionState).map(
        (option) => option.id,
      );
      if (availableIds.length > 0) {
        throw new Error(`Choose one option for ${job.title}: ${availableIds.join(", ")}.`);
      }
      // No option is legal yet: name the still-unmet gate(s) instead of a bare refusal,
      // so the player knows what would unlock it rather than filing this as broken.
      const unmetGates = describeUnmetLocalJobSceneOptionGates(scene, conditionState);
      throw new Error(
        unmetGates
          ? `${job.title} has no legal option yet; it still needs ${unmetGates}.`
          : `Choose one option for ${job.title}, but no authored option is legal yet in this journey.`,
      );
    }
    sceneOption = resolveLocalJobSceneOption(scene, state.optionId);
    if (!localJobSceneOptionRequirementsMet(sceneOption, conditionState)) {
      throw new Error(`That option for ${job.title} is unavailable in this journey.`);
    }
  } else if (state.optionId !== undefined) {
    throw new Error(`Local job ${job.title} has no authored option "${state.optionId}".`);
  }

  if (state.completedJobIds.has(job.id)) {
    const existing = state.journalEntries.get(`job:${job.id}`);
    if (existing) {
      if (scene && existing.localSceneProof?.optionId !== sceneOption?.id) {
        throw new Error(`Local job ${job.title} was completed with a different authored option.`);
      }
      return { alreadyKnown: true, minutes: 0, entry: existing };
    }
  }

  const action = describeOverworldJobAction(
    job,
    state.areasById.get(job.area) ?? null,
    sceneOption,
  );
  return {
    alreadyKnown: false,
    jobId: job.id,
    action,
    renownRegion: state.currentRegion,
    renown: action.regionalRenown ?? 0,
    ...(scene && sceneOption ? { localScene: { scene, option: sceneOption } } : {}),
  };
}

export function planOverworldSiteExploration(
  state: OverworldSiteExplorationState,
): OverworldSiteExplorationPlan {
  const site = state.sitesById.get(state.siteId);
  if (!site || site.nearest_town !== state.currentTownId) {
    throw new Error("That exploration site is not reachable from this town.");
  }
  if (site.area !== state.currentAreaId) {
    throw new Error("Move to that local area before exploring this site.");
  }
  if (!state.discoveredSiteIds.has(site.id)) {
    throw new Error(
      "This site is not discovered. Take a fresh local action in this area to reveal it.",
    );
  }
  if (state.exploredSiteIds.has(site.id)) {
    const existing = state.journalEntries.get(`site:${site.id}`);
    if (existing) return { alreadyKnown: true, minutes: 0, entry: existing };
  }

  const action = describeOverworldSiteAction(site);
  return {
    alreadyKnown: false,
    siteId: site.id,
    action,
    renownRegion: site.region,
    renown: action.regionalRenown ?? 0,
  };
}
