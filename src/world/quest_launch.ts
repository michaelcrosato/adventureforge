import { z } from "zod";

import { hashState } from "../core/hash.js";
import {
  CampaignCharacterIdSchema,
  parseCampaignCharacterState,
  serializeCampaignCharacterState,
  type CampaignCharacterState,
} from "./campaign_character_state.js";
import {
  LearnKnowledgeConsequenceSchema,
  applyCampaignConsequences,
} from "./campaign_consequences.js";
import {
  OVERWORLD_MAX_FATIGUE,
  OVERWORLD_MAX_SUPPLIES,
  travelCondition,
} from "./travel_mechanics.js";
import type { QuestDispatchPresentationWindow } from "./quest_dispatch_window.js";
import { wolfHillRoutePresentation } from "./wolf_hill_route_presentation.js";

const OVERWORLD_QUEST_LAUNCH_VERSION = 1 as const;

const AUTHORED_TEXT = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "Authored text cannot be blank.",
  });

const OverworldQuestLaunchTermsSchema = z
  .object({
    minutes: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60),
    supplies: z.number().int().nonnegative().max(OVERWORLD_MAX_SUPPLIES),
    fatigue: z.number().int().nonnegative().max(OVERWORLD_MAX_FATIGUE),
  })
  .strict();

const OverworldQuestLaunchEffectSchema = z.discriminatedUnion("type", [
  LearnKnowledgeConsequenceSchema,
  z
    .object({
      type: z.literal("remember_relationship"),
      npc_id: CampaignCharacterIdSchema,
      memory_id: CampaignCharacterIdSchema,
    })
    .strict(),
]);

const OverworldQuestLaunchOptionSchema = z
  .object({
    id: CampaignCharacterIdSchema,
    title: AUTHORED_TEXT,
    summary: AUTHORED_TEXT,
    preview: AUTHORED_TEXT,
    consequence: AUTHORED_TEXT,
    return_summary: AUTHORED_TEXT,
    terms: OverworldQuestLaunchTermsSchema,
    effects: z.array(OverworldQuestLaunchEffectSchema).min(2),
  })
  .strict()
  .superRefine((option, ctx) => {
    const knowledge = option.effects.filter((effect) => effect.type === "learn_knowledge");
    const memories = option.effects.filter((effect) => effect.type === "remember_relationship");
    if (knowledge.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effects"],
        message: "A quest launch option must teach exactly one persistent approach knowledge.",
      });
    }
    if (memories.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effects"],
        message: "A quest launch option must record at least one relationship memory.",
      });
    }
  });

export const OverworldQuestLaunchSchema = z
  .object({
    version: z.literal(OVERWORLD_QUEST_LAUNCH_VERSION),
    id: CampaignCharacterIdSchema,
    prompt: AUTHORED_TEXT,
    options: z.array(OverworldQuestLaunchOptionSchema).min(2).max(8),
  })
  .strict()
  .superRefine((launch, ctx) => {
    const optionIds = new Set<string>();
    const knowledgeIds = new Set<string>();
    launch.options.forEach((option, optionIndex) => {
      if (optionIds.has(option.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options", optionIndex, "id"],
          message: `Duplicate quest launch option id "${option.id}".`,
        });
      }
      optionIds.add(option.id);
      option.effects.forEach((effect, effectIndex) => {
        if (effect.type !== "learn_knowledge") return;
        if (knowledgeIds.has(effect.knowledge_id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["options", optionIndex, "effects", effectIndex],
            message: `Quest launch knowledge "${effect.knowledge_id}" is repeated across options.`,
          });
        }
        knowledgeIds.add(effect.knowledge_id);
      });
    });
  });

type OverworldQuestLaunchTerms = z.infer<typeof OverworldQuestLaunchTermsSchema>;
type OverworldQuestLaunchOption = z.infer<typeof OverworldQuestLaunchOptionSchema>;
export type OverworldQuestLaunch = z.infer<typeof OverworldQuestLaunchSchema>;

export type OverworldQuestLaunchResources = Readonly<{
  minutes: number;
  supplies: number;
  fatigue: number;
}>;

type OverworldQuestLaunchProjection = Readonly<{
  available: boolean;
  minutesAfter: number;
  suppliesAfter: number | null;
  fatigueAfter: number | null;
  travelConditionAfter: string | null;
  blockedReason?: string;
}>;

export type OverworldQuestLaunchOptionView = Readonly<{
  id: string;
  title: string;
  summary: string;
  preview: string;
  consequence: string;
  tradeoffSummary?: string;
  terms: OverworldQuestLaunchTerms;
  projection: OverworldQuestLaunchProjection | null;
}>;

export type OverworldQuestLaunchSelectionView = Readonly<{
  optionId: string;
  minutesBefore: number;
  minutesAfter: number;
  suppliesBefore: number;
  suppliesAfter: number;
  fatigueBefore: number;
  fatigueAfter: number;
  travelConditionAfter: string;
}>;

export type OverworldQuestLaunchView = Readonly<{
  id: string;
  prompt: string;
  options: readonly OverworldQuestLaunchOptionView[];
  selected?: OverworldQuestLaunchSelectionView;
}>;

type OverworldQuestLaunchApplication = Readonly<{
  characterAfter: CampaignCharacterState;
  option: OverworldQuestLaunchOption;
  projection: OverworldQuestLaunchProjection & {
    suppliesAfter: number;
    fatigueAfter: number;
    travelConditionAfter: string;
  };
}>;

type OverworldQuestStartPrecondition = Readonly<{
  sessionFingerprint?: string;
  questId: string;
  approachId: string | null;
  launch: OverworldQuestLaunch | null;
  currentTownId: string;
  currentAreaId: string | null;
  minutes: number;
  supplies: number;
  fatigue: number;
  character: CampaignCharacterState;
  discovered: boolean;
  started: boolean;
}>;

export function projectOverworldQuestLaunchOption(
  option: Pick<OverworldQuestLaunchOption, "terms">,
  resources: OverworldQuestLaunchResources,
): OverworldQuestLaunchProjection {
  const minutesAfter = resources.minutes + option.terms.minutes;
  if (resources.supplies < option.terms.supplies) {
    const requiredSupplyUnit = option.terms.supplies === 1 ? "supply" : "supplies";
    const currentSupplyUnit = resources.supplies === 1 ? "supply" : "supplies";
    const blockedReason = `Requires ${String(option.terms.supplies)} ${requiredSupplyUnit}. You have ${String(resources.supplies)} ${currentSupplyUnit}.`;
    return Object.freeze({
      available: false,
      minutesAfter,
      suppliesAfter: null,
      fatigueAfter: null,
      travelConditionAfter: null,
      blockedReason,
    });
  }
  const suppliesAfter = resources.supplies - option.terms.supplies;
  const fatigueAfter = Math.min(OVERWORLD_MAX_FATIGUE, resources.fatigue + option.terms.fatigue);
  return Object.freeze({
    available: true,
    minutesAfter,
    suppliesAfter,
    fatigueAfter,
    travelConditionAfter: travelCondition(fatigueAfter, suppliesAfter),
  });
}

export function presentOverworldQuestLaunch(
  launch: OverworldQuestLaunch,
  resources?: OverworldQuestLaunchResources,
  selectedOptionId?: string,
  knowledgeIds?: readonly string[],
  dispatchWindow?: QuestDispatchPresentationWindow,
): OverworldQuestLaunchView {
  const parsed = OverworldQuestLaunchSchema.parse(launch);
  const options = parsed.options.map((option) => {
    const routePresentation = wolfHillRoutePresentation({
      launchId: parsed.id,
      optionId: option.id,
      ...(knowledgeIds ? { knowledgeIds } : {}),
      ...(dispatchWindow ? { dispatchWindow } : {}),
    });
    return {
      id: option.id,
      title: option.title,
      summary: option.summary,
      preview: option.preview,
      consequence: option.consequence,
      ...(routePresentation ? { tradeoffSummary: routePresentation.tradeoffSummary } : {}),
      terms: { ...option.terms },
      projection: resources ? projectOverworldQuestLaunchOption(option, resources) : null,
    };
  });
  const selectedOption = selectedOptionId
    ? parsed.options.find((option) => option.id === selectedOptionId)
    : undefined;
  const selectedProjection =
    selectedOption && resources
      ? projectOverworldQuestLaunchOption(selectedOption, resources)
      : undefined;
  return Object.freeze({
    id: parsed.id,
    prompt: parsed.prompt,
    options,
    ...(selectedOption && selectedProjection?.available
      ? {
          selected: {
            optionId: selectedOption.id,
            minutesBefore: resources!.minutes,
            minutesAfter: selectedProjection.minutesAfter,
            suppliesBefore: resources!.supplies,
            suppliesAfter: selectedProjection.suppliesAfter!,
            fatigueBefore: resources!.fatigue,
            fatigueAfter: selectedProjection.fatigueAfter!,
            travelConditionAfter: selectedProjection.travelConditionAfter!,
          },
        }
      : {}),
  });
}

export function applyOverworldQuestLaunchOption(args: {
  launch: OverworldQuestLaunch;
  approachId: string;
  character: CampaignCharacterState;
  resources: OverworldQuestLaunchResources;
}): OverworldQuestLaunchApplication {
  const launch = OverworldQuestLaunchSchema.parse(args.launch);
  const character = parseCampaignCharacterState(args.character);
  const option = launch.options.find((candidate) => candidate.id === args.approachId);
  if (!option) throw new Error(`Unknown quest launch approach "${args.approachId}".`);
  const projection = projectOverworldQuestLaunchOption(option, args.resources);
  if (!projection.available) {
    throw new Error(projection.blockedReason ?? "That quest launch approach is unavailable.");
  }
  const consequence = applyCampaignConsequences({ character, effects: option.effects });
  return Object.freeze({
    characterAfter: consequence.characterAfter,
    option,
    projection: {
      ...projection,
      suppliesAfter: projection.suppliesAfter!,
      fatigueAfter: projection.fatigueAfter!,
      travelConditionAfter: projection.travelConditionAfter!,
    },
  });
}

export function overworldQuestStartPreconditionFingerprint(
  precondition: OverworldQuestStartPrecondition,
): string {
  return hashState({
    version: 1,
    sessionFingerprint: precondition.sessionFingerprint ?? null,
    questId: precondition.questId,
    approachId: precondition.approachId,
    launch: precondition.launch,
    currentTownId: precondition.currentTownId,
    currentAreaId: precondition.currentAreaId,
    minutes: precondition.minutes,
    supplies: precondition.supplies,
    fatigue: precondition.fatigue,
    character: serializeCampaignCharacterState(precondition.character),
    discovered: precondition.discovered,
    started: precondition.started,
  });
}
