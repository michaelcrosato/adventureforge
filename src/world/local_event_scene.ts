import { z } from "zod";

const LOCAL_EVENT_SCENE_VERSION = 1 as const;
const LOCAL_EVENT_SCENE_MIN_OPTIONS = 2 as const;
const LOCAL_EVENT_SCENE_MAX_OPTIONS = 4 as const;
const LOCAL_EVENT_SCENE_MAX_REQUIREMENTS = 8 as const;
const LOCAL_EVENT_SCENE_MAX_MINUTES = 24 * 60;
const LOCAL_EVENT_SCENE_MAX_RENOWN = 10;

const NON_BLANK_TEXT = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "Authored local-event scene text cannot be blank.",
  });

const LocalEventSceneTermsSchema = z
  .object({
    minutes: z.number().int().positive().max(LOCAL_EVENT_SCENE_MAX_MINUTES),
    renown: z.number().int().min(1).max(LOCAL_EVENT_SCENE_MAX_RENOWN),
  })
  .strict();

export const LocalEventSceneOptionSchema = z
  .object({
    id: NON_BLANK_TEXT,
    title: NON_BLANK_TEXT,
    preview: NON_BLANK_TEXT,
    consequence: NON_BLANK_TEXT,
    terms: LocalEventSceneTermsSchema,
    requires_all_world_facts: z
      .array(NON_BLANK_TEXT)
      .min(1)
      .max(LOCAL_EVENT_SCENE_MAX_REQUIREMENTS)
      .optional(),
    forbids_any_world_facts: z
      .array(NON_BLANK_TEXT)
      .min(1)
      .max(LOCAL_EVENT_SCENE_MAX_REQUIREMENTS)
      .optional(),
  })
  .strict()
  .superRefine((option, context) => {
    for (const field of ["requires_all_world_facts", "forbids_any_world_facts"] as const) {
      const seen = new Set<string>();
      (option[field] ?? []).forEach((factId, index) => {
        if (seen.has(factId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, index],
            message: `Duplicate local-event world-fact requirement "${factId}".`,
          });
        }
        seen.add(factId);
      });
    }
    const required = new Set(option.requires_all_world_facts ?? []);
    option.forbids_any_world_facts?.forEach((factId, index) => {
      if (required.has(factId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["forbids_any_world_facts", index],
          message: `Local-event option cannot both require and forbid world fact "${factId}".`,
        });
      }
    });
  });

export const LocalEventSceneSchema = z
  .object({
    version: z.literal(LOCAL_EVENT_SCENE_VERSION),
    id: NON_BLANK_TEXT,
    prompt: NON_BLANK_TEXT,
    required_poi_id: NON_BLANK_TEXT,
    required_contact_id: NON_BLANK_TEXT,
    requires_completed_quests: z.array(NON_BLANK_TEXT).min(1).optional(),
    forbids_completed_quests: z.array(NON_BLANK_TEXT).min(1).optional(),
    forbids_completed_jobs: z
      .array(NON_BLANK_TEXT)
      .min(1)
      .max(LOCAL_EVENT_SCENE_MAX_REQUIREMENTS)
      .optional(),
    advertise_blocked_lead: z.boolean().optional(),
    options: z
      .array(LocalEventSceneOptionSchema)
      .min(LOCAL_EVENT_SCENE_MIN_OPTIONS)
      .max(LOCAL_EVENT_SCENE_MAX_OPTIONS),
  })
  .strict()
  .superRefine((scene, context) => {
    const ids = new Set<string>();
    scene.options.forEach((option, index) => {
      if (ids.has(option.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options", index, "id"],
          message: `Duplicate local-event scene option id "${option.id}".`,
        });
      }
      ids.add(option.id);
    });
    const requiredQuestIds = new Set<string>();
    scene.requires_completed_quests?.forEach((questId, index) => {
      if (requiredQuestIds.has(questId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requires_completed_quests", index],
          message: `Duplicate required completed quest id "${questId}".`,
        });
      }
      requiredQuestIds.add(questId);
    });
    const forbiddenQuestIds = new Set<string>();
    scene.forbids_completed_quests?.forEach((questId, index) => {
      if (forbiddenQuestIds.has(questId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["forbids_completed_quests", index],
          message: `Duplicate forbidden completed quest id "${questId}".`,
        });
      }
      if (requiredQuestIds.has(questId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["forbids_completed_quests", index],
          message: `Completed quest id "${questId}" cannot be both required and forbidden.`,
        });
      }
      forbiddenQuestIds.add(questId);
    });
    const forbiddenJobIds = new Set<string>();
    scene.forbids_completed_jobs?.forEach((jobId, index) => {
      if (forbiddenJobIds.has(jobId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["forbids_completed_jobs", index],
          message: `Duplicate forbidden completed job id "${jobId}".`,
        });
      }
      forbiddenJobIds.add(jobId);
    });
  });

export type LocalEventScene = z.infer<typeof LocalEventSceneSchema>;
export type LocalEventSceneOption = z.infer<typeof LocalEventSceneOptionSchema>;

export type LocalEventSceneConditionState = Readonly<{
  completedQuestIds: ReadonlySet<string>;
  completedJobIds?: ReadonlySet<string> | undefined;
  worldFactIds?: ReadonlySet<string> | undefined;
}>;

type LocalEventSceneLegalTuple = readonly [
  id: string,
  title: string,
  preview: string,
  minutes: number,
  renown: number,
];

export function parseLocalEventScene(input: unknown): LocalEventScene {
  return LocalEventSceneSchema.parse(input);
}

/** Whether every required quest is complete and every forbidden quest remains incomplete. */
export function localEventSceneRequirementsMet(
  scene: LocalEventScene,
  state: LocalEventSceneConditionState,
): boolean {
  const parsed = parseLocalEventScene(scene);
  return (
    (parsed.requires_completed_quests ?? []).every((questId) =>
      state.completedQuestIds.has(questId),
    ) &&
    (parsed.forbids_completed_quests ?? []).every(
      (questId) => !state.completedQuestIds.has(questId),
    ) &&
    (parsed.forbids_completed_jobs ?? []).every((jobId) => !state.completedJobIds?.has(jobId))
  );
}

export function localEventSceneRequirementError(
  scene: LocalEventScene,
  state: LocalEventSceneConditionState,
): string | null {
  const parsed = parseLocalEventScene(scene);
  const missing = (parsed.requires_completed_quests ?? []).filter(
    (questId) => !state.completedQuestIds.has(questId),
  );
  if (missing.length > 0) {
    return `Complete ${missing.join(", ")} before choosing this event option.`;
  }
  const forbidden = (parsed.forbids_completed_quests ?? []).filter((questId) =>
    state.completedQuestIds.has(questId),
  );
  if (forbidden.length > 0) {
    return `This event option closed when you completed ${forbidden.join(", ")}.`;
  }
  const completedJobs = (parsed.forbids_completed_jobs ?? []).filter((jobId) =>
    state.completedJobIds?.has(jobId),
  );
  return completedJobs.length > 0
    ? `This event option closed when you completed job ${completedJobs.join(", ")}.`
    : null;
}

/** Resolve only an exact authored option id; labels and partial ids are never executable. */
export function resolveLocalEventSceneOption(
  scene: LocalEventScene,
  optionId: string,
): LocalEventSceneOption {
  const parsed = parseLocalEventScene(scene);
  const option = parsed.options.find((candidate) => candidate.id === optionId);
  if (!option) {
    throw new Error(`Unknown local-event scene option "${optionId}" for scene "${parsed.id}".`);
  }
  return LocalEventSceneOptionSchema.parse(option);
}

/** Whether an authored option is legal for the campaign facts proven in this journey. */
export function localEventSceneOptionRequirementsMet(
  option: LocalEventSceneOption,
  state: Pick<LocalEventSceneConditionState, "worldFactIds">,
): boolean {
  const parsed = LocalEventSceneOptionSchema.parse(option);
  const worldFactIds = state.worldFactIds ?? new Set<string>();
  return (
    (parsed.requires_all_world_facts ?? []).every((factId) => worldFactIds.has(factId)) &&
    !(parsed.forbids_any_world_facts ?? []).some((factId) => worldFactIds.has(factId))
  );
}

/** Authored options available now, retaining canonical authored order. */
export function availableLocalEventSceneOptions(
  scene: LocalEventScene,
  state: LocalEventSceneConditionState,
): LocalEventSceneOption[] {
  const parsed = parseLocalEventScene(scene);
  if (!localEventSceneRequirementsMet(parsed, state)) return [];
  return parsed.options.filter((option) => localEventSceneOptionRequirementsMet(option, state));
}

/**
 * Player-facing reasons at least one option could still become legal, for the moment
 * every option is currently blocked. An option already foreclosed by a currently-true
 * forbidden world fact is excluded rather than offered as an actionable step. Returns
 * null when every option is foreclosed, which the caller should treat as having
 * nothing actionable to report.
 */
export function describeUnmetLocalEventSceneOptionGates(
  scene: LocalEventScene,
  state: Pick<LocalEventSceneConditionState, "worldFactIds">,
): string | null {
  const parsed = parseLocalEventScene(scene);
  const worldFactIds = state.worldFactIds ?? new Set<string>();
  const gates = new Set<string>();
  for (const option of parsed.options) {
    if ((option.forbids_any_world_facts ?? []).some((factId) => worldFactIds.has(factId))) {
      continue;
    }
    for (const factId of option.requires_all_world_facts ?? []) {
      if (!worldFactIds.has(factId)) gates.add(`world fact "${factId}"`);
    }
  }
  return gates.size > 0 ? [...gates].sort().join("; ") : null;
}

/**
 * Canonical player-facing choices in authored order, with their exact executable terms.
 * Conditional options fail closed when no live condition state is supplied.
 */
export function localEventSceneLegalTuples(
  scene: LocalEventScene,
  state?: LocalEventSceneConditionState,
): readonly LocalEventSceneLegalTuple[] {
  const parsed = parseLocalEventScene(scene);
  const options = state
    ? availableLocalEventSceneOptions(parsed, state)
    : parsed.options.filter(
        (option) =>
          option.requires_all_world_facts === undefined &&
          option.forbids_any_world_facts === undefined,
      );
  return Object.freeze(
    options.map((option) =>
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
