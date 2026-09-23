import type {
  OverworldArea,
  OverworldExplorationSite,
  OverworldLocalEvent,
  OverworldLocalJob,
  OverworldQuest,
} from "./overworld.js";
import { questView, type OverworldQuestView } from "./session_local_discovery.js";
import {
  availableLocalJobSceneOptions,
  localJobSceneChronologyBlockedReason,
  localJobSceneRequirementsMet,
  type LocalJobSceneChronologyTitles,
  type LocalJobSceneConditionState,
} from "./local_job_scene.js";
import type { OverworldJournalEntry } from "./session_snapshot.js";
import type { CampaignCharacterState } from "./campaign_character_state.js";

/** A discovered, not-yet-workable job named with why — never a silent drop into hiddenJobCount. */
export type OverworldSessionLocalJobLead = Readonly<{
  id: string;
  title: string;
  blockedReason: string;
}>;

export type OverworldSessionLocalView = {
  areas: OverworldArea[];
  hiddenAreaCount: number;
  jobs: OverworldLocalJob[];
  rememberedJobs: OverworldLocalJob[];
  hiddenJobCount: number;
  jobLeads: OverworldSessionLocalJobLead[];
  sites: OverworldExplorationSite[];
  hiddenSiteCount: number;
  quests: OverworldQuestView[];
  hiddenQuestCount: number;
};

type OverworldSessionLocalViewState = {
  localAreas: readonly OverworldArea[];
  currentAreaId: string;
  localJobs: readonly OverworldLocalJob[];
  currentAreaSites: readonly OverworldExplorationSite[];
  localQuests: readonly OverworldQuest[];
  discoveredAreaIds: ReadonlySet<string>;
  discoveredJobIds: ReadonlySet<string>;
  completedJobIds: ReadonlySet<string>;
  discoveredSiteIds: ReadonlySet<string>;
  discoveredQuestIds: ReadonlySet<string>;
  completedQuestIds: ReadonlySet<string>;
  resolvedEventIds?: ReadonlySet<string>;
  campaignWorldFactIds?: ReadonlySet<string>;
  campaignStoryChoiceKeys?: ReadonlySet<string>;
  campaignCharacter?: CampaignCharacterState;
  journalEntries?: ReadonlyMap<string, OverworldJournalEntry>;
  /** Title lookups for job leads' chronology-gate text; ids are shown when absent. */
  questsById?: ReadonlyMap<string, Pick<OverworldQuest, "title">>;
  eventsById?: ReadonlyMap<string, Pick<OverworldLocalEvent, "title">>;
};

function discoveredValues<T extends { id: string }>(
  values: readonly T[],
  discoveredIds: ReadonlySet<string>,
): T[] {
  const discovered: T[] = [];
  for (const value of values) {
    if (discoveredIds.has(value.id)) discovered.push(value);
  }
  return discovered;
}

function hiddenCount<T extends { id: string }>(
  values: readonly T[],
  discoveredIds: ReadonlySet<string>,
): number {
  let count = 0;
  for (const value of values) {
    if (!discoveredIds.has(value.id)) count += 1;
  }
  return count;
}

type LocalJobSceneConditionSourceState = Pick<
  OverworldSessionLocalViewState,
  | "completedQuestIds"
  | "resolvedEventIds"
  | "campaignWorldFactIds"
  | "campaignStoryChoiceKeys"
  | "campaignCharacter"
  | "journalEntries"
>;

/** Shared by job projection and job-lead computation, so both read one journey state. */
function localJobSceneConditionStateFrom(
  state: LocalJobSceneConditionSourceState,
): LocalJobSceneConditionState {
  const journalEntries = state.journalEntries ?? new Map<string, OverworldJournalEntry>();
  return {
    completedQuestIds: state.completedQuestIds,
    resolvedEventIds: state.resolvedEventIds ?? new Set<string>(),
    worldFactIds: state.campaignWorldFactIds ?? new Set<string>(),
    storyChoiceKeys: state.campaignStoryChoiceKeys ?? new Set<string>(),
    ...(state.campaignCharacter ? { character: state.campaignCharacter } : {}),
    eventOptionIdFor: (eventId) =>
      journalEntries.get(`resolve:${eventId}`)?.localSceneProof?.optionId ?? null,
  };
}

export function projectOverworldSessionLocalJob(
  job: OverworldLocalJob,
  state: Pick<
    OverworldSessionLocalViewState,
    | "completedQuestIds"
    | "resolvedEventIds"
    | "campaignWorldFactIds"
    | "campaignStoryChoiceKeys"
    | "campaignCharacter"
    | "journalEntries"
  >,
  retainUnavailable: true,
): OverworldLocalJob;
export function projectOverworldSessionLocalJob(
  job: OverworldLocalJob,
  state: Pick<
    OverworldSessionLocalViewState,
    | "completedQuestIds"
    | "resolvedEventIds"
    | "campaignWorldFactIds"
    | "campaignStoryChoiceKeys"
    | "campaignCharacter"
    | "journalEntries"
  >,
  retainUnavailable?: false,
): OverworldLocalJob | null;
export function projectOverworldSessionLocalJob(
  job: OverworldLocalJob,
  state: Pick<
    OverworldSessionLocalViewState,
    | "completedQuestIds"
    | "resolvedEventIds"
    | "campaignWorldFactIds"
    | "campaignStoryChoiceKeys"
    | "campaignCharacter"
    | "journalEntries"
  >,
  retainUnavailable = false,
): OverworldLocalJob | null {
  if (!job.authored_scene) return job;
  const conditionState = localJobSceneConditionStateFrom(state);
  const options = availableLocalJobSceneOptions(job.authored_scene, conditionState);
  if (options.length === 0 && !retainUnavailable) return null;
  const projectedOptions = options.map(
    ({
      requires_event_options: _eventOptions,
      requires_all_world_facts: _requiredFacts,
      forbids_any_world_facts: _forbiddenFacts,
      requires_all_story_choices: _requiredChoices,
      forbids_any_story_choices: _forbiddenChoices,
      character_conditions: _characterConditions,
      ...option
    }) => option,
  );
  const hasPlayerHiddenPredicates = options.some(
    (option) =>
      option.requires_event_options !== undefined ||
      option.requires_all_world_facts !== undefined ||
      option.forbids_any_world_facts !== undefined ||
      option.requires_all_story_choices !== undefined ||
      option.forbids_any_story_choices !== undefined ||
      option.character_conditions !== undefined,
  );
  if (!hasPlayerHiddenPredicates && options.length === job.authored_scene.options.length)
    return job;
  return {
    ...job,
    authored_scene: {
      ...job.authored_scene,
      options: projectedOptions,
    },
  };
}

function discoveredCurrentAreaJobs(
  jobs: readonly OverworldLocalJob[],
  currentAreaId: string,
  discoveredJobIds: ReadonlySet<string>,
  completedJobIds: ReadonlySet<string>,
): OverworldLocalJob[] {
  const discovered: OverworldLocalJob[] = [];
  for (const job of jobs) {
    if (
      job.area === currentAreaId &&
      discoveredJobIds.has(job.id) &&
      !completedJobIds.has(job.id)
    ) {
      discovered.push(job);
    }
  }
  return discovered;
}

function discoveredOtherAreaJobs(
  jobs: readonly OverworldLocalJob[],
  currentAreaId: string,
  discoveredJobIds: ReadonlySet<string>,
  completedJobIds: ReadonlySet<string>,
): OverworldLocalJob[] {
  const discovered: OverworldLocalJob[] = [];
  for (const job of jobs) {
    if (
      job.area !== currentAreaId &&
      discoveredJobIds.has(job.id) &&
      !completedJobIds.has(job.id)
    ) {
      discovered.push(job);
    }
  }
  return discovered;
}

/**
 * Discovered, current-area jobs whose own SCENE-level chronology gate (requires_completed_quests
 * / requires_resolved_events / scene world facts) is unmet, named in player terms. The
 * option-level case — scene met, zero options currently legal — is deliberately excluded here;
 * it stays silent inside hiddenJobCount exactly as before (83fc32b6e9e9f715 / the Cade packet).
 */
function discoveredCurrentAreaJobLeads(
  jobs: readonly OverworldLocalJob[],
  currentAreaId: string,
  discoveredJobIds: ReadonlySet<string>,
  completedJobIds: ReadonlySet<string>,
  journalEntryIds: ReadonlySet<string>,
  conditionState: LocalJobSceneConditionState,
  titles: LocalJobSceneChronologyTitles,
): OverworldSessionLocalJobLead[] {
  const leads: OverworldSessionLocalJobLead[] = [];
  for (const job of jobs) {
    if (
      job.area !== currentAreaId ||
      !discoveredJobIds.has(job.id) ||
      completedJobIds.has(job.id)
    ) {
      continue;
    }
    const scene = job.authored_scene;
    if (!scene) continue;
    if (!journalEntryIds.has(`scout:${scene.required_poi_id}`)) continue;
    const contactPrefix = `talk:${scene.required_contact_id}`;
    const talkedContact = [...journalEntryIds].some(
      (entryId) => entryId === contactPrefix || entryId.startsWith(`${contactPrefix}@`),
    );
    if (!talkedContact) continue;
    if (localJobSceneRequirementsMet(scene, conditionState)) continue;
    const blockedReason = localJobSceneChronologyBlockedReason(
      scene,
      job.title,
      conditionState,
      titles,
    );
    if (blockedReason) leads.push({ id: job.id, title: job.title, blockedReason });
  }
  return leads;
}

function discoveredQuestViews(
  quests: readonly OverworldQuest[],
  discoveredQuestIds: ReadonlySet<string>,
  completedQuestIds: ReadonlySet<string>,
): OverworldQuestView[] {
  const discovered: OverworldQuestView[] = [];
  for (const quest of quests) {
    if (discoveredQuestIds.has(quest.id) && !completedQuestIds.has(quest.id)) {
      discovered.push(questView(quest));
    }
  }
  return discovered;
}

export function buildOverworldSessionLocalView(
  state: OverworldSessionLocalViewState,
): OverworldSessionLocalView {
  const chronologicallyAvailableJobs = state.localJobs.flatMap((job) => {
    const projected = projectOverworldSessionLocalJob(job, state);
    return projected ? [projected] : [];
  });
  const journalEntryIds = state.journalEntries ?? new Map<string, OverworldJournalEntry>();
  const jobLeads = discoveredCurrentAreaJobLeads(
    state.localJobs,
    state.currentAreaId,
    state.discoveredJobIds,
    state.completedJobIds,
    new Set(journalEntryIds.keys()),
    localJobSceneConditionStateFrom(state),
    {
      questTitle: (questId) => state.questsById?.get(questId)?.title ?? questId,
      eventTitle: (eventId) => state.eventsById?.get(eventId)?.title ?? eventId,
    },
  );
  return {
    areas: discoveredValues(state.localAreas, state.discoveredAreaIds),
    hiddenAreaCount: hiddenCount(state.localAreas, state.discoveredAreaIds),
    jobs: discoveredCurrentAreaJobs(
      chronologicallyAvailableJobs,
      state.currentAreaId,
      state.discoveredJobIds,
      state.completedJobIds,
    ),
    rememberedJobs: discoveredOtherAreaJobs(
      chronologicallyAvailableJobs,
      state.currentAreaId,
      state.discoveredJobIds,
      state.completedJobIds,
    ),
    jobLeads,
    hiddenJobCount: state.localJobs.filter(
      (job) =>
        !state.discoveredJobIds.has(job.id) ||
        (!state.completedJobIds.has(job.id) && !projectOverworldSessionLocalJob(job, state)),
    ).length,
    sites: discoveredValues(state.currentAreaSites, state.discoveredSiteIds),
    hiddenSiteCount: hiddenCount(state.currentAreaSites, state.discoveredSiteIds),
    quests: discoveredQuestViews(
      state.localQuests,
      state.discoveredQuestIds,
      state.completedQuestIds,
    ),
    hiddenQuestCount: hiddenCount(state.localQuests, state.discoveredQuestIds),
  };
}
