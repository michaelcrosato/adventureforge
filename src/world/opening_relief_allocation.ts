import { z } from "zod";

import {
  CampaignCharacterIdSchema,
  parseCampaignCharacterState,
  type CampaignCharacterState,
} from "./campaign_character_state.js";
import {
  CampaignConsequenceEffectsSchema,
  applyCampaignConsequences,
} from "./campaign_consequences.js";

const OPENING_RELIEF_ALLOCATION_VERSION = 1 as const;
export const OPENING_RELIEF_ALLOCATION_OPTION_COUNT = 3 as const;

const AUTHORED_TEXT = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "Authored text cannot be blank.",
  });

const RELIEF_ALLOCATION_TRIGGER_CATEGORY = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => value.trim().length > 0, {
    message: "Relief allocation trigger category cannot be blank.",
  });

export const OpeningReliefAllocationTermsSchema = z
  .object({
    minutes: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60),
  })
  .strict();

/**
 * One exclusive use of a finite relief packet. Knowledge is the quest-import
 * carrier; relationship memory is the persistent public account. World facts
 * remain owned by quest outcomes rather than being invented at departure.
 */
export const OpeningReliefAllocationOptionSchema = z
  .object({
    id: CampaignCharacterIdSchema,
    title: AUTHORED_TEXT,
    provider_npc_id: CampaignCharacterIdSchema,
    summary: AUTHORED_TEXT,
    trigger_category: RELIEF_ALLOCATION_TRIGGER_CATEGORY.optional(),
    preview: AUTHORED_TEXT,
    consequence: AUTHORED_TEXT,
    protects: AUTHORED_TEXT,
    leaves_exposed: AUTHORED_TEXT,
    terms: OpeningReliefAllocationTermsSchema,
    effects: CampaignConsequenceEffectsSchema,
  })
  .strict()
  .superRefine((option, ctx) => {
    const knowledgeEffects = option.effects.filter((effect) => effect.type === "learn_knowledge");
    const relationshipEffects = option.effects.filter(
      (effect) => effect.type === "remember_relationship",
    );
    if (
      option.effects.some(
        (effect) => effect.type !== "learn_knowledge" && effect.type !== "remember_relationship",
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effects"],
        message:
          "Opening relief allocations may teach allocation knowledge and remember the provider; they cannot create world facts, wounds, companions, or promises.",
      });
    }
    if (knowledgeEffects.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effects"],
        message: "Each opening relief allocation must teach exactly one persistent knowledge id.",
      });
    }
    if (relationshipEffects.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effects"],
        message: "Each opening relief allocation must record its provider relationship memory.",
      });
    }
    relationshipEffects.forEach((effect, index) => {
      if (effect.npc_id !== option.provider_npc_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["effects", index],
          message:
            "Opening relief allocation relationship effects must remember the option's named provider.",
        });
      }
    });
  });

export const OpeningReliefAllocationSchema = z
  .object({
    version: z.literal(OPENING_RELIEF_ALLOCATION_VERSION),
    id: CampaignCharacterIdSchema,
    after_preparation: CampaignCharacterIdSchema,
    target_quest: z.string().min(1),
    home: z.string().min(1),
    area: z.string().min(1),
    title: AUTHORED_TEXT,
    message: AUTHORED_TEXT,
    options: z
      .array(OpeningReliefAllocationOptionSchema)
      .length(OPENING_RELIEF_ALLOCATION_OPTION_COUNT),
  })
  .strict()
  .superRefine((scene, ctx) => {
    const optionIds = new Set<string>();
    const knowledgeIds = new Set<string>();
    const categorizedOptions = scene.options.filter(
      (option) => option.trigger_category !== undefined,
    );
    if (categorizedOptions.length !== 0 && categorizedOptions.length !== scene.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message:
          "Opening relief allocation trigger categories must cover every option or remain absent on an exact legacy manifest.",
      });
    }
    scene.options.forEach((option, optionIndex) => {
      if (optionIds.has(option.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options", optionIndex, "id"],
          message: `Duplicate opening relief allocation option id "${option.id}".`,
        });
      }
      optionIds.add(option.id);
      option.effects.forEach((effect, effectIndex) => {
        if (effect.type !== "learn_knowledge") return;
        if (knowledgeIds.has(effect.knowledge_id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["options", optionIndex, "effects", effectIndex],
            message: `Opening relief allocation knowledge "${effect.knowledge_id}" is repeated across options.`,
          });
        }
        knowledgeIds.add(effect.knowledge_id);
      });
    });
  });

export type OpeningReliefAllocationTerms = z.infer<typeof OpeningReliefAllocationTermsSchema>;
export type OpeningReliefAllocationOption = z.infer<typeof OpeningReliefAllocationOptionSchema>;
export type OpeningReliefAllocation = z.infer<typeof OpeningReliefAllocationSchema>;

type OpeningReliefAllocationApplication = Readonly<{
  characterAfter: CampaignCharacterState;
  option: OpeningReliefAllocationOption;
  terms: OpeningReliefAllocationTerms;
}>;

export function parseOpeningReliefAllocation(input: unknown): OpeningReliefAllocation {
  return OpeningReliefAllocationSchema.parse(input);
}

export function cloneOpeningReliefAllocation(
  scene: OpeningReliefAllocation,
): OpeningReliefAllocation {
  return parseOpeningReliefAllocation(scene);
}

export function openingReliefAllocationOptionById(
  scene: OpeningReliefAllocation,
  optionId: string,
): OpeningReliefAllocationOption | null {
  const parsed = parseOpeningReliefAllocation(scene);
  const option = parsed.options.find((candidate) => candidate.id === optionId);
  return option ? OpeningReliefAllocationOptionSchema.parse(option) : null;
}

export function formatOpeningReliefAllocationCost(terms: OpeningReliefAllocationTerms): string {
  return terms.minutes === 0 ? "no added time" : `${String(terms.minutes)} minutes`;
}

/** Apply one finite allocation atomically without creating a detached reserve meter. */
export function applyOpeningReliefAllocationOption(args: {
  scene: OpeningReliefAllocation;
  character: CampaignCharacterState;
  optionId: string;
}): OpeningReliefAllocationApplication {
  const scene = parseOpeningReliefAllocation(args.scene);
  const character = parseCampaignCharacterState(args.character);
  const option = scene.options.find((candidate) => candidate.id === args.optionId);
  if (!option) {
    throw new Error(`Unknown opening relief allocation option "${args.optionId}".`);
  }
  const consequences = applyCampaignConsequences({ character, effects: option.effects });
  return Object.freeze({
    characterAfter: consequences.characterAfter,
    option,
    terms: { ...option.terms },
  });
}
