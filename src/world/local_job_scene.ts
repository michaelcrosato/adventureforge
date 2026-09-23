import { z } from "zod";

import {
  CampaignStoryChoiceRefSchema,
  campaignStoryChoiceRefKey,
} from "./campaign_story_choices.js";
import type { CampaignCharacterState } from "./campaign_character_state.js";
import {
  CampaignCharacterConditionsSchema,
  campaignCharacterMatchesConditions,
} from "./campaign_consequences.js";

const LOCAL_JOB_SCENE_VERSION = 1 as const;
const LOCAL_JOB_SCENE_MIN_OPTIONS = 2 as const;
export const LOCAL_JOB_SCENE_MAX_OPTIONS = 6 as const;
/** Keep prerequisite fan-out auditable alongside the scene's bounded 2-6 definitions. */
export const LOCAL_JOB_SCENE_MAX_REQUIRED_QUESTS = 4 as const;
const LOCAL_JOB_SCENE_MAX_REQUIREMENTS = 8 as const;
export const LOCAL_JOB_SCENE_MAX_MINUTES = 24 * 60;
const LOCAL_JOB_SCENE_MAX_RENOWN = 10;

const NON_BLANK_TEXT = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "Authored local-job scene text cannot be blank.",
  });

const LocalJobSceneTermsSchema = z
  .object({
    minutes: z.number().int().positive().max(LOCAL_JOB_SCENE_MAX_MINUTES),
    renown: z.number().int().min(1).max(LOCAL_JOB_SCENE_MAX_RENOWN),
  })
  .strict();

const LocalJobSceneStoryChoiceRefsSchema = z
  .array(CampaignStoryChoiceRefSchema)
  .min(1)
  .max(LOCAL_JOB_SCENE_MAX_REQUIREMENTS)
  .superRefine((refs, context) => {
    const seen = new Set<string>();
    refs.forEach((ref, index) => {
      const key = campaignStoryChoiceRefKey(ref);
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Duplicate local-job story-choice requirement ${key}.`,
        });
      }
      seen.add(key);
    });
  });

export const LocalJobSceneOptionSchema = z
  .object({
    id: NON_BLANK_TEXT,
    title: NON_BLANK_TEXT,
    preview: NON_BLANK_TEXT,
    consequence: NON_BLANK_TEXT,
    terms: LocalJobSceneTermsSchema,
    requires_event_options: z
      .array(
        z
          .object({
            event_id: NON_BLANK_TEXT,
            option_id: NON_BLANK_TEXT,
          })
          .strict(),
      )
      .min(1)
      .max(LOCAL_JOB_SCENE_MAX_REQUIREMENTS)
      .optional(),
    requires_all_world_facts: z
      .array(NON_BLANK_TEXT)
      .min(1)
      .max(LOCAL_JOB_SCENE_MAX_REQUIREMENTS)
      .optional(),
    forbids_any_world_facts: z
      .array(NON_BLANK_TEXT)
      .min(1)
      .max(LOCAL_JOB_SCENE_MAX_REQUIREMENTS)
      .optional(),
    requires_all_story_choices: LocalJobSceneStoryChoiceRefsSchema.optional(),
    forbids_any_story_choices: LocalJobSceneStoryChoiceRefsSchema.optional(),
    character_conditions: CampaignCharacterConditionsSchema.optional(),
  })
  .strict()
  .superRefine((option, context) => {
    const eventOptionKeys = new Set<string>();
    option.requires_event_options?.forEach((requirement, index) => {
      const key = `${requirement.event_id}\u0000${requirement.option_id}`;
      if (eventOptionKeys.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requires_event_options", index],
          message: `Duplicate local-job event-option requirement "${requirement.event_id}:${requirement.option_id}".`,
        });
      }
      eventOptionKeys.add(key);
    });
    for (const field of ["requires_all_world_facts", "forbids_any_world_facts"] as const) {
      const values = option[field] ?? [];
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, index],
            message: `Duplicate local-job world-fact requirement "${value}".`,
          });
        }
        seen.add(value);
      });
    }
    const required = new Set(option.requires_all_world_facts ?? []);
    option.forbids_any_world_facts?.forEach((factId, index) => {
      if (required.has(factId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["forbids_any_world_facts", index],
          message: `Local-job option cannot both require and forbid world fact "${factId}".`,
        });
      }
    });
    const requiredStoryChoices = new Set(
      (option.requires_all_story_choices ?? []).map(campaignStoryChoiceRefKey),
    );
    const requiredChoiceByStoryId = new Map<string, string>();
    option.requires_all_story_choices?.forEach((ref, index) => {
      const selectedChoice = requiredChoiceByStoryId.get(ref.story_choice_id);
      if (selectedChoice !== undefined && selectedChoice !== ref.choice_id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requires_all_story_choices", index],
          message: `Local-job option cannot require mutually exclusive choices "${selectedChoice}" and "${ref.choice_id}" from story "${ref.story_choice_id}".`,
        });
      }
      requiredChoiceByStoryId.set(ref.story_choice_id, ref.choice_id);
    });
    option.forbids_any_story_choices?.forEach((ref, index) => {
      const key = campaignStoryChoiceRefKey(ref);
      if (requiredStoryChoices.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["forbids_any_story_choices", index],
          message: `Local-job option cannot both require and forbid story choice ${key}.`,
        });
      }
    });
  });

export const LocalJobSceneSchema = z
  .object({
    version: z.literal(LOCAL_JOB_SCENE_VERSION),
    id: NON_BLANK_TEXT,
    prompt: NON_BLANK_TEXT,
    required_poi_id: NON_BLANK_TEXT,
    required_contact_id: NON_BLANK_TEXT,
    requires_completed_quests: z
      .array(NON_BLANK_TEXT)
      .min(1)
      .max(LOCAL_JOB_SCENE_MAX_REQUIRED_QUESTS),
    requires_resolved_events: z
      .array(NON_BLANK_TEXT)
      .min(1)
      .max(LOCAL_JOB_SCENE_MAX_REQUIREMENTS)
      .optional(),
    requires_all_world_facts: z
      .array(NON_BLANK_TEXT)
      .min(1)
      .max(LOCAL_JOB_SCENE_MAX_REQUIREMENTS)
      .optional(),
    forbids_any_world_facts: z
      .array(NON_BLANK_TEXT)
      .min(1)
      .max(LOCAL_JOB_SCENE_MAX_REQUIREMENTS)
      .optional(),
    options: z
      .array(LocalJobSceneOptionSchema)
      .min(LOCAL_JOB_SCENE_MIN_OPTIONS)
      .max(LOCAL_JOB_SCENE_MAX_OPTIONS),
  })
  .strict()
  .superRefine((scene, context) => {
    const ids = new Set<string>();
    scene.options.forEach((option, index) => {
      if (ids.has(option.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options", index, "id"],
          message: `Duplicate local-job scene option id "${option.id}".`,
        });
      }
      ids.add(option.id);
    });
    const prerequisiteIds = new Set<string>();
    scene.requires_completed_quests.forEach((questId, index) => {
      if (prerequisiteIds.has(questId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requires_completed_quests", index],
          message: `Duplicate local-job scene prerequisite quest id "${questId}".`,
        });
      }
      prerequisiteIds.add(questId);
    });
    const resolvedEventIds = new Set<string>();
    scene.requires_resolved_events?.forEach((eventId, index) => {
      if (resolvedEventIds.has(eventId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requires_resolved_events", index],
          message: `Duplicate local-job scene resolved-event requirement "${eventId}".`,
        });
      }
      resolvedEventIds.add(eventId);
    });
    for (const field of ["requires_all_world_facts", "forbids_any_world_facts"] as const) {
      const values = scene[field] ?? [];
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, index],
            message: `Duplicate local-job scene world-fact requirement "${value}".`,
          });
        }
        seen.add(value);
      });
    }
    const requiredFacts = new Set(scene.requires_all_world_facts ?? []);
    scene.forbids_any_world_facts?.forEach((factId, index) => {
      if (requiredFacts.has(factId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["forbids_any_world_facts", index],
          message: `Local-job scene cannot both require and forbid world fact "${factId}".`,
        });
      }
    });
  });

export type LocalJobSceneOption = z.infer<typeof LocalJobSceneOptionSchema>;
export type LocalJobScene = z.infer<typeof LocalJobSceneSchema>;

export type LocalJobSceneConditionState = Readonly<{
  completedQuestIds: ReadonlySet<string>;
  resolvedEventIds: ReadonlySet<string>;
  worldFactIds: ReadonlySet<string>;
  storyChoiceKeys?: ReadonlySet<string> | undefined;
  character?: CampaignCharacterState | undefined;
  eventOptionIdFor: (eventId: string) => string | null;
}>;

type LocalJobSceneLegalTuple = readonly [
  id: string,
  title: string,
  preview: string,
  minutes: number,
  renown: number,
];

export function parseLocalJobScene(input: unknown): LocalJobScene {
  return LocalJobSceneSchema.parse(input);
}

/** Resolve only an exact authored option id; labels and partial ids are never executable. */
export function resolveLocalJobSceneOption(
  scene: LocalJobScene,
  optionId: string,
): LocalJobSceneOption {
  const parsed = parseLocalJobScene(scene);
  const option = parsed.options.find((candidate) => candidate.id === optionId);
  if (!option) {
    throw new Error(`Unknown local-job scene option "${optionId}" for scene "${parsed.id}".`);
  }
  return LocalJobSceneOptionSchema.parse(option);
}

/** Canonical player-facing choices in authored order, with their exact executable terms. */
export function localJobSceneLegalTuples(scene: LocalJobScene): readonly LocalJobSceneLegalTuple[] {
  const parsed = parseLocalJobScene(scene);
  return Object.freeze(
    parsed.options.map((option) =>
      Object.freeze([
        option.id,
        option.title,
        option.preview,
        option.terms.minutes,
        option.terms.renown,
      ] as const),
    ),
  );
}

function matchesWorldFacts(
  requires: readonly string[] | undefined,
  forbids: readonly string[] | undefined,
  worldFactIds: ReadonlySet<string>,
): boolean {
  return (
    (requires ?? []).every((factId) => worldFactIds.has(factId)) &&
    !(forbids ?? []).some((factId) => worldFactIds.has(factId))
  );
}

function matchesStoryChoices(
  requires: LocalJobSceneOption["requires_all_story_choices"],
  forbids: LocalJobSceneOption["forbids_any_story_choices"],
  storyChoiceKeys: ReadonlySet<string>,
): boolean {
  return (
    (requires ?? []).every((ref) => storyChoiceKeys.has(campaignStoryChoiceRefKey(ref))) &&
    !(forbids ?? []).some((ref) => storyChoiceKeys.has(campaignStoryChoiceRefKey(ref)))
  );
}

/** Generic scene-level chronology gate shared by view projection and execution. */
export function localJobSceneRequirementsMet(
  scene: LocalJobScene,
  state: LocalJobSceneConditionState,
): boolean {
  const parsed = parseLocalJobScene(scene);
  return (
    parsed.requires_completed_quests.every((questId) => state.completedQuestIds.has(questId)) &&
    (parsed.requires_resolved_events ?? []).every((eventId) =>
      state.resolvedEventIds.has(eventId),
    ) &&
    matchesWorldFacts(
      parsed.requires_all_world_facts,
      parsed.forbids_any_world_facts,
      state.worldFactIds,
    )
  );
}

/** Generic option gate over replayable local, quest, and campaign decisions. */
export function localJobSceneOptionRequirementsMet(
  option: LocalJobSceneOption,
  state: LocalJobSceneConditionState,
): boolean {
  const parsed = LocalJobSceneOptionSchema.parse(option);
  return (
    (parsed.requires_event_options ?? []).every(
      (requirement) =>
        state.resolvedEventIds.has(requirement.event_id) &&
        state.eventOptionIdFor(requirement.event_id) === requirement.option_id,
    ) &&
    matchesWorldFacts(
      parsed.requires_all_world_facts,
      parsed.forbids_any_world_facts,
      state.worldFactIds,
    ) &&
    matchesStoryChoices(
      parsed.requires_all_story_choices,
      parsed.forbids_any_story_choices,
      state.storyChoiceKeys ?? new Set<string>(),
    ) &&
    (parsed.character_conditions === undefined ||
      (state.character !== undefined &&
        campaignCharacterMatchesConditions(state.character, parsed.character_conditions)))
  );
}

export function availableLocalJobSceneOptions(
  scene: LocalJobScene,
  state: LocalJobSceneConditionState,
): LocalJobSceneOption[] {
  const parsed = parseLocalJobScene(scene);
  if (!localJobSceneRequirementsMet(parsed, state)) return [];
  return parsed.options.filter((option) => localJobSceneOptionRequirementsMet(option, state));
}

/**
 * True once an option's own gate can never legally pass, because a one-time authored
 * decision it depends on was already made a different, mutually exclusive way. Missing
 * (not-yet-decided) requirements do not foreclose — they are still reachable.
 */
function localJobSceneOptionForeclosed(
  option: LocalJobSceneOption,
  state: LocalJobSceneConditionState,
): boolean {
  const storyChoiceKeys = state.storyChoiceKeys ?? new Set<string>();
  return (
    (option.requires_event_options ?? []).some(
      (requirement) =>
        state.resolvedEventIds.has(requirement.event_id) &&
        state.eventOptionIdFor(requirement.event_id) !== requirement.option_id,
    ) ||
    (option.forbids_any_world_facts ?? []).some((factId) => state.worldFactIds.has(factId)) ||
    (option.forbids_any_story_choices ?? []).some((ref) =>
      storyChoiceKeys.has(campaignStoryChoiceRefKey(ref)),
    )
  );
}

/**
 * Player-facing reasons at least one option could still become legal, for the moment
 * every option is currently blocked. An option already foreclosed by a contradictory
 * authored decision is excluded rather than offered as an actionable step — telling a
 * player to resolve an event they already resolved a different way is worse than
 * saying nothing. Returns null when every option is foreclosed, which the caller
 * should treat as having nothing actionable to report.
 */
export function describeUnmetLocalJobSceneOptionGates(
  scene: LocalJobScene,
  state: LocalJobSceneConditionState,
): string | null {
  const parsed = parseLocalJobScene(scene);
  const storyChoiceKeys = state.storyChoiceKeys ?? new Set<string>();
  const gates = new Set<string>();
  for (const option of parsed.options) {
    if (localJobSceneOptionForeclosed(option, state)) continue;
    for (const requirement of option.requires_event_options ?? []) {
      if (!state.resolvedEventIds.has(requirement.event_id)) {
        gates.add(`resolve event "${requirement.event_id}" choosing "${requirement.option_id}"`);
      }
    }
    for (const factId of option.requires_all_world_facts ?? []) {
      if (!state.worldFactIds.has(factId)) gates.add(`world fact "${factId}"`);
    }
    for (const ref of option.requires_all_story_choices ?? []) {
      if (!storyChoiceKeys.has(campaignStoryChoiceRefKey(ref))) {
        gates.add(`story choice "${ref.story_choice_id}" of "${ref.choice_id}"`);
      }
    }
    if (
      option.character_conditions !== undefined &&
      !(
        state.character !== undefined &&
        campaignCharacterMatchesConditions(state.character, option.character_conditions)
      )
    ) {
      gates.add(`character requirements for "${option.id}"`);
    }
  }
  return gates.size > 0 ? [...gates].sort().join("; ") : null;
}

/** Resolves a quest or event id to the player-facing title named in a chronology gate. */
export type LocalJobSceneChronologyTitles = Readonly<{
  questTitle: (questId: string) => string;
  eventTitle: (eventId: string) => string;
}>;

/**
 * Player-facing reason a DISCOVERED job's own SCENE-level chronology gate is unmet, naming
 * the blocking quest or event by TITLE, or null once every scene-level gate is met. The
 * listing hint and the execution rejection both call this so they cannot describe the same
 * gate two different ways. Deliberately scoped to `localJobSceneRequirementsMet`'s own
 * checks (quests, events, world facts) — it says nothing about per-option gates, which are
 * `describeUnmetLocalJobSceneOptionGates`'s job.
 */
export function localJobSceneChronologyBlockedReason(
  scene: LocalJobScene,
  jobTitle: string,
  state: Pick<
    LocalJobSceneConditionState,
    "completedQuestIds" | "resolvedEventIds" | "worldFactIds"
  >,
  titles: LocalJobSceneChronologyTitles,
): string | null {
  const parsed = parseLocalJobScene(scene);
  const missingQuestId = parsed.requires_completed_quests.find(
    (questId) => !state.completedQuestIds.has(questId),
  );
  if (missingQuestId) {
    return `Complete quest "${titles.questTitle(missingQuestId)}" before working ${jobTitle}.`;
  }
  const missingEventId = (parsed.requires_resolved_events ?? []).find(
    (eventId) => !state.resolvedEventIds.has(eventId),
  );
  if (missingEventId) {
    return `Resolve event "${titles.eventTitle(missingEventId)}" before working ${jobTitle}.`;
  }
  if (
    !matchesWorldFacts(
      parsed.requires_all_world_facts,
      parsed.forbids_any_world_facts,
      state.worldFactIds,
    )
  ) {
    return `${jobTitle} is unavailable because its world-state requirements are not met.`;
  }
  return null;
}
