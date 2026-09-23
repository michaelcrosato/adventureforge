import type {
  OverworldCharacter,
  OverworldLocalEvent,
  OverworldPoi,
  OverworldRegionalArc,
} from "./overworld.js";
import { allOverworldContactPresentations } from "./session_contact_presentation.js";
import {
  type OverworldEventResolutionJournalIndex,
  type OverworldResolutionProofIndex,
} from "./session_journal_timeline.js";
import type { OverworldJournalEntry } from "./session_snapshot.js";
import { OVERWORLD_STARTING_MINUTES as STARTING_MINUTES } from "./travel_mechanics.js";
import {
  availableLocalEventSceneOptions,
  describeUnmetLocalEventSceneOptionGates,
  localEventSceneRequirementError,
  localEventSceneRequirementsMet,
  localEventSceneOptionRequirementsMet,
  resolveLocalEventSceneOption,
  type LocalEventScene,
  type LocalEventSceneConditionState,
  type LocalEventSceneOption,
} from "./local_event_scene.js";

type OverworldRegionalArcCompletionIndex = {
  eventsById: ReadonlyMap<string, OverworldLocalEvent>;
  regionalArcs: readonly OverworldRegionalArc[];
};

const OVERWORLD_EVENT_RESOLUTION_PREREQUISITES = [
  {
    id: "scout_poi",
    label: "scout a local point of interest",
  },
  {
    id: "talk_contact",
    label: "talk to a local contact",
  },
  {
    id: "investigate_event",
    label: "investigate the event",
  },
] as const;

type OverworldEventResolutionPrerequisite =
  (typeof OVERWORLD_EVENT_RESOLUTION_PREREQUISITES)[number]["id"];

type OverworldJournalEntryPresence = {
  has(id: string): boolean;
};

type OverworldEventResolutionReadinessIndex = {
  event: Pick<OverworldLocalEvent, "area" | "authored_scene" | "id">;
  poisByArea: ReadonlyMap<string, readonly Pick<OverworldPoi, "id">[]>;
  charactersByArea: ReadonlyMap<string, readonly OverworldCharacter[]>;
  journalEntryIds: OverworldJournalEntryPresence;
};

type OverworldEventResolutionReadiness = {
  scoutedPoi: boolean;
  talkedContact: boolean;
  investigatedEvent: boolean;
  missing: OverworldEventResolutionPrerequisite[];
};

type OverworldJournalEntryReadIndex = OverworldJournalEntryPresence & {
  get(id: string): OverworldJournalEntry | undefined;
};

type OverworldEventResolutionPlanState = {
  eventId: string;
  optionId?: string | undefined;
  eventsById: ReadonlyMap<string, OverworldLocalEvent>;
  currentTownId: string;
  currentTownName: string;
  currentRegion: string;
  currentAreaId: string | null;
  completedQuestIds: ReadonlySet<string>;
  completedJobIds?: ReadonlySet<string> | undefined;
  campaignWorldFactIds?: ReadonlySet<string> | undefined;
  resolvedEventIds: ReadonlySet<string>;
  journalEntries: OverworldJournalEntryReadIndex;
  poisByArea: ReadonlyMap<string, readonly Pick<OverworldPoi, "id">[]>;
  charactersByArea: ReadonlyMap<string, readonly OverworldCharacter[]>;
};

export type OverworldEventResolutionActionPlan = {
  alreadyKnown: false;
  event: OverworldLocalEvent;
  minutes: number;
  renown: number;
  region: string;
  entryDraft: Omit<OverworldJournalEntry, "recordedAt">;
  localScene?: {
    scene: LocalEventScene;
    option: LocalEventSceneOption;
  };
};

export type OverworldEventResolutionAlreadyKnownPlan = {
  alreadyKnown: true;
  event: OverworldLocalEvent;
  minutes: 0;
  entry: OverworldJournalEntry;
};

export type OverworldEventResolutionPlan =
  | OverworldEventResolutionActionPlan
  | OverworldEventResolutionAlreadyKnownPlan;

type OverworldPlannedEventResolution = Extract<
  OverworldEventResolutionPlan,
  { alreadyKnown: false }
>;

type OverworldEventResolutionApplicationState = {
  resolvedEventIds: Set<string>;
  resolvedEventHomeIds: Set<string>;
  regionRenown: Map<string, number>;
};

type OverworldAppliedEventResolution = {
  eventId: string;
  eventHome: string;
  renownRegion: string;
  renownGained: number;
  renownAfter: number;
};

type OverworldEventResolutionDescription = Readonly<{
  title: string;
  text: string;
  minutes: number;
  renown: number;
}>;

export function describeOverworldEventResolution(
  event: OverworldLocalEvent,
  townName: string,
  region: string,
  sceneOption: LocalEventSceneOption | null = null,
): OverworldEventResolutionDescription {
  const minutes = sceneOption?.terms.minutes ?? 30 + event.intensity * 10;
  const renown = sceneOption?.terms.renown ?? event.intensity;
  return {
    minutes,
    renown,
    title: sceneOption
      ? `Resolved ${event.title}: ${sceneOption.title}`
      : `Resolved ${event.title}`,
    text: sceneOption
      ? `${sceneOption.consequence} Time: ${minutes} minutes. Renown: +${renown} ${region}.`
      : `You stabilize ${townName} by resolving ${event.title}. Pressure reduced: ${event.pressure}. Renown: +${event.intensity} ${region}.`,
  };
}

function prerequisiteLabel(prerequisite: OverworldEventResolutionPrerequisite): string {
  return OVERWORLD_EVENT_RESOLUTION_PREREQUISITES.find((entry) => entry.id === prerequisite)!.label;
}

export function overworldEventResolutionReadiness(
  sources: OverworldEventResolutionReadinessIndex,
): OverworldEventResolutionReadiness {
  const scene = sources.event.authored_scene;
  const scoutedPoi = scene
    ? sources.journalEntryIds.has(`scout:${scene.required_poi_id}`)
    : (sources.poisByArea.get(sources.event.area) ?? []).some((poi) =>
        sources.journalEntryIds.has(`scout:${poi.id}`),
      );
  const talkedContact = scene
    ? (sources.charactersByArea.get(sources.event.area) ?? [])
        .filter((character) => character.id === scene.required_contact_id)
        .some((character) =>
          allOverworldContactPresentations(character).some((presentation) =>
            sources.journalEntryIds.has(presentation.journalId),
          ),
        )
    : (sources.charactersByArea.get(sources.event.area) ?? []).some((character) =>
        allOverworldContactPresentations(character).some((presentation) =>
          sources.journalEntryIds.has(presentation.journalId),
        ),
      );
  const investigatedEvent = sources.journalEntryIds.has(`investigate:${sources.event.id}`);
  const missing: OverworldEventResolutionPrerequisite[] = [];
  if (!scoutedPoi) missing.push("scout_poi");
  if (!talkedContact) missing.push("talk_contact");
  if (!investigatedEvent) missing.push("investigate_event");
  return {
    scoutedPoi,
    talkedContact,
    investigatedEvent,
    missing,
  };
}

export function missingOverworldEventResolutionStepLabels(
  missing: readonly OverworldEventResolutionPrerequisite[],
): string[] {
  return missing.map((prerequisite) => prerequisiteLabel(prerequisite));
}

export function assertOverworldEventResolutionReady(
  sources: OverworldEventResolutionReadinessIndex,
): void {
  const readiness = overworldEventResolutionReadiness(sources);
  if (readiness.missing.length === 0) return;
  throw new Error(
    `To resolve this event, first ${missingOverworldEventResolutionStepLabels(readiness.missing).join(", ")}.`,
  );
}

/**
 * No option is legal yet: name the still-unmet gate(s) instead of a bare refusal, so
 * the player knows what would unlock it rather than filing this as broken.
 */
function noLegalEventOptionError(
  event: OverworldLocalEvent,
  scene: LocalEventScene,
  conditionState: LocalEventSceneConditionState,
): Error {
  const availableIds = availableLocalEventSceneOptions(scene, conditionState).map(
    (option) => option.id,
  );
  if (availableIds.length > 0) {
    return new Error(`Choose one option for ${event.title}: ${availableIds.join(", ")}.`);
  }
  const unmetGates = describeUnmetLocalEventSceneOptionGates(scene, conditionState);
  return new Error(
    unmetGates
      ? `${event.title} has no legal option yet; it still needs ${unmetGates}.`
      : `Choose one option for ${event.title}, but no authored option is legal yet in this journey.`,
  );
}

export function planOverworldEventResolution(
  state: OverworldEventResolutionPlanState,
): OverworldEventResolutionPlan {
  const event = state.eventsById.get(state.eventId);
  if (!event || event.home !== state.currentTownId) {
    throw new Error("That event is not active in this town.");
  }
  if (event.area !== state.currentAreaId) {
    throw new Error("Move to that local area before resolving that event.");
  }

  const scene = event.authored_scene;
  let sceneOption: LocalEventSceneOption | null = null;
  if (scene) {
    if (state.optionId) sceneOption = resolveLocalEventSceneOption(scene, state.optionId);
  } else if (state.optionId !== undefined) {
    throw new Error(`Local event ${event.title} has no authored option "${state.optionId}".`);
  }

  const entryId = `resolve:${event.id}`;
  if (state.resolvedEventIds.has(event.id)) {
    const existing = state.journalEntries.get(entryId);
    if (existing) {
      if (scene && !sceneOption) {
        throw noLegalEventOptionError(event, scene, {
          completedQuestIds: state.completedQuestIds,
          completedJobIds: state.completedJobIds,
          worldFactIds: state.campaignWorldFactIds,
        });
      }
      if (scene && existing.localSceneProof?.optionId !== sceneOption?.id) {
        throw new Error(`This event was already resolved with a different option: ${event.title}.`);
      }
      return {
        alreadyKnown: true,
        event,
        minutes: 0,
        entry: existing,
      };
    }
  }

  assertOverworldEventResolutionReady({
    charactersByArea: state.charactersByArea,
    event,
    journalEntryIds: state.journalEntries,
    poisByArea: state.poisByArea,
  });

  if (scene && !localEventSceneRequirementsMet(scene, state)) {
    throw new Error(
      `${event.title}: ${localEventSceneRequirementError(scene, state) ?? "Its requirements are not met."}`,
    );
  }
  if (scene && !sceneOption) {
    // Every scene-level gate above already passed, so each id named here is
    // immediately workable rather than a guess the caller has to resolve elsewhere.
    throw noLegalEventOptionError(event, scene, {
      completedQuestIds: state.completedQuestIds,
      completedJobIds: state.completedJobIds,
      worldFactIds: state.campaignWorldFactIds,
    });
  }
  if (
    sceneOption &&
    !localEventSceneOptionRequirementsMet(sceneOption, {
      worldFactIds: state.campaignWorldFactIds,
    })
  ) {
    throw new Error(`That option for ${event.title} is unavailable in this journey.`);
  }

  const action = describeOverworldEventResolution(
    event,
    state.currentTownName,
    state.currentRegion,
    sceneOption,
  );

  return {
    alreadyKnown: false,
    event,
    minutes: action.minutes,
    renown: action.renown,
    region: state.currentRegion,
    entryDraft: {
      id: entryId,
      kind: "resolution",
      town: state.currentTownName,
      title: action.title,
      text: action.text,
      ...(scene && sceneOption
        ? {
            localSceneProof: {
              sceneId: scene.id,
              optionId: sceneOption.id,
            },
          }
        : {}),
    },
    ...(scene && sceneOption ? { localScene: { scene, option: sceneOption } } : {}),
  };
}

export function applyOverworldEventResolution(
  state: OverworldEventResolutionApplicationState,
  plan: OverworldPlannedEventResolution,
): OverworldAppliedEventResolution {
  state.resolvedEventIds.add(plan.event.id);
  state.resolvedEventHomeIds.add(plan.event.home);
  state.regionRenown.set(plan.region, (state.regionRenown.get(plan.region) ?? 0) + plan.renown);
  return {
    eventId: plan.event.id,
    eventHome: plan.event.home,
    renownRegion: plan.region,
    renownGained: plan.renown,
    renownAfter: state.regionRenown.get(plan.region) ?? 0,
  };
}

export function assertSnapshotEventResolutionProofs(
  resolvedEventIds: ReadonlySet<string>,
  sources: OverworldResolutionProofIndex,
  journal: OverworldEventResolutionJournalIndex,
): void {
  for (const eventId of resolvedEventIds) {
    const event = sources.eventsById.get(eventId);
    if (!event) continue;
    const resolvedAt = journal.recordedAtById.get(`resolve:${eventId}`);
    if (resolvedAt === undefined) continue;

    const scene = event.authored_scene;
    const scoutAt = scene
      ? journal.recordedAtById.get(`scout:${scene.required_poi_id}`)
      : journal.scoutTimeByArea.get(event.area);
    if (scoutAt === undefined || (scene ? scoutAt >= resolvedAt : scoutAt > resolvedAt)) {
      throw new Error(
        scene
          ? `Overworld session snapshot resolved event "${eventId}" is missing its earlier exact point-of-interest scout prerequisite.`
          : `Overworld session snapshot resolved event "${eventId}" is missing a local scout prerequisite.`,
      );
    }

    const requiredContact = scene
      ? sources.charactersById.get(scene.required_contact_id)
      : undefined;
    const contactTimes = requiredContact
      ? allOverworldContactPresentations(requiredContact).flatMap((presentation) => {
          const recordedAt = journal.recordedAtById.get(presentation.journalId);
          return recordedAt === undefined ? [] : [recordedAt];
        })
      : [];
    const contactAt = scene
      ? contactTimes.length > 0
        ? Math.min(...contactTimes)
        : undefined
      : journal.contactTimeByArea.get(event.area);
    if (contactAt === undefined || (scene ? contactAt >= resolvedAt : contactAt > resolvedAt)) {
      throw new Error(
        scene
          ? `Overworld session snapshot resolved event "${eventId}" is missing its earlier exact contact prerequisite.`
          : `Overworld session snapshot resolved event "${eventId}" is missing a local contact prerequisite.`,
      );
    }

    const investigationAt = journal.recordedAtById.get(`investigate:${eventId}`);
    if (
      investigationAt === undefined ||
      (scene ? investigationAt >= resolvedAt : investigationAt > resolvedAt)
    ) {
      throw new Error(
        scene
          ? `Overworld session snapshot resolved event "${eventId}" is missing its earlier exact investigation prerequisite.`
          : `Overworld session snapshot resolved event "${eventId}" is missing an investigated event prerequisite.`,
      );
    }
  }
}

type RegionalArcResolutionProof = {
  completionProofAt: number;
  resolvedCount: number;
};

export function regionalArcResolutionProof(
  arc: OverworldRegionalArc,
  resolutionTimesByTown: ReadonlyMap<string, number>,
): RegionalArcResolutionProof {
  const required = arc.required_resolutions;
  const requiredResolutionTimes: number[] = [];
  let resolvedCount = 0;

  for (const townId of arc.anchor_towns) {
    const resolvedAt = resolutionTimesByTown.get(townId);
    if (resolvedAt === undefined) continue;

    resolvedCount += 1;
    if (required <= 0) continue;

    let insertAt = requiredResolutionTimes.length;
    while (insertAt > 0 && requiredResolutionTimes[insertAt - 1]! > resolvedAt) {
      insertAt -= 1;
    }
    if (insertAt >= required) continue;

    requiredResolutionTimes.splice(insertAt, 0, resolvedAt);
    if (requiredResolutionTimes.length > required) requiredResolutionTimes.pop();
  }

  return {
    completionProofAt:
      required > 0 && requiredResolutionTimes.length >= required
        ? requiredResolutionTimes[required - 1]!
        : STARTING_MINUTES,
    resolvedCount,
  };
}

export function assertSnapshotRegionalArcCompletionProofs(
  sources: OverworldRegionalArcCompletionIndex,
  journal: OverworldEventResolutionJournalIndex,
  completedRegionalArcIds: ReadonlySet<string>,
): void {
  for (const arc of sources.regionalArcs) {
    const resolutionProof = regionalArcResolutionProof(arc, journal.resolutionTimeByTown);
    const hasRequiredResolutions = resolutionProof.resolvedCount >= arc.required_resolutions;
    const completed = completedRegionalArcIds.has(arc.id);

    if (completed && !hasRequiredResolutions) {
      throw new Error(
        `Overworld session snapshot completed regional arc "${arc.id}" lacks required resolved anchor towns.`,
      );
    }
    if (!completed && hasRequiredResolutions) {
      throw new Error(
        `Overworld session snapshot is missing completed regional arc "${arc.id}" earned by resolved anchor towns.`,
      );
    }
    if (!completed) continue;

    const arcRecordedAt = journal.recordedAtById.get(`arc:${arc.id}`);
    if (arcRecordedAt === undefined) continue;
    const completionProofAt = resolutionProof.completionProofAt;
    if (arcRecordedAt < completionProofAt) {
      throw new Error(
        `Overworld session snapshot completed regional arc "${arc.id}" was recorded before enough anchor resolutions.`,
      );
    }
  }
}
