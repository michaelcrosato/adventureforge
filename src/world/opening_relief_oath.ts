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

const OPENING_RELIEF_OATH_VERSION = 1 as const;
export const OPENING_RELIEF_OATH_OPTION_COUNT = 3 as const;

const RELIEF_OATH_KINDS = ["official", "limited", "unaffiliated"] as const;

const AUTHORED_TEXT = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "Authored text cannot be blank.",
  });

const RELIEF_OATH_TRIGGER_CATEGORY = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => value.trim().length > 0, {
    message: "Relief oath trigger category cannot be blank.",
  });

export const OpeningReliefOathTermsSchema = z
  .object({
    minutes: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60),
  })
  .strict();

export const OpeningReliefOathOptionSchema = z
  .object({
    id: CampaignCharacterIdSchema,
    kind: z.enum(RELIEF_OATH_KINDS),
    title: AUTHORED_TEXT,
    summary: AUTHORED_TEXT,
    trigger_category: RELIEF_OATH_TRIGGER_CATEGORY.optional(),
    preview: AUTHORED_TEXT,
    tradeoff: AUTHORED_TEXT,
    consequence: AUTHORED_TEXT,
    access: AUTHORED_TEXT,
    duty: AUTHORED_TEXT,
    terms: OpeningReliefOathTermsSchema,
    effects: CampaignConsequenceEffectsSchema,
  })
  .strict()
  .superRefine((option, ctx) => {
    const allowedEffectTypes = new Set([
      "affirm_value",
      "learn_knowledge",
      "raise_faction_standing",
      "record_promise",
      "remember_relationship",
    ]);
    option.effects.forEach((effect, effectIndex) => {
      if (!allowedEffectTypes.has(effect.type)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["effects", effectIndex],
          message:
            "Opening relief oaths may teach knowledge, affirm one value, raise one faction standing, remember the clerk, and record the disclosed duty promise only.",
        });
      }
    });

    const requiredEffectCounts = [
      ["learn_knowledge", "knowledge"],
      ["affirm_value", "value"],
      ["raise_faction_standing", "faction standing"],
      ["remember_relationship", "clerk relationship memory"],
    ] as const;
    for (const [effectType, label] of requiredEffectCounts) {
      if (option.effects.filter((effect) => effect.type === effectType).length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["effects"],
          message: `Each opening relief oath option must contain exactly one ${label} effect.`,
        });
      }
    }

    const promiseCount = option.effects.filter((effect) => effect.type === "record_promise").length;
    if (promiseCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effects"],
        message:
          "Every relief-oath option must record exactly one disclosed duty or personal-bond promise.",
      });
    }
  });

export const OpeningReliefOathSchema = z
  .object({
    version: z.literal(OPENING_RELIEF_OATH_VERSION),
    id: CampaignCharacterIdSchema,
    after_registration: CampaignCharacterIdSchema,
    target_quest: z.string().min(1),
    home: z.string().min(1),
    area: z.string().min(1),
    contact: z.string().min(1),
    clerk_npc_id: CampaignCharacterIdSchema,
    title: AUTHORED_TEXT,
    message: AUTHORED_TEXT,
    options: z.array(OpeningReliefOathOptionSchema).length(OPENING_RELIEF_OATH_OPTION_COUNT),
  })
  .strict()
  .superRefine((scene, ctx) => {
    const optionIds = new Set<string>();
    const categorizedOptions = scene.options.filter(
      (option) => option.trigger_category !== undefined,
    );
    if (categorizedOptions.length !== 0 && categorizedOptions.length !== scene.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message:
          "Opening relief-oath trigger categories must cover every option or remain absent on an exact legacy manifest.",
      });
    }
    const kinds = new Set<string>();
    const knowledgeIds = new Set<string>();
    const memoryIds = new Set<string>();
    const promiseIds = new Set<string>();
    const valueIds = new Set<string>();

    scene.options.forEach((option, optionIndex) => {
      if (optionIds.has(option.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options", optionIndex, "id"],
          message: `Duplicate opening relief oath option id "${option.id}".`,
        });
      }
      optionIds.add(option.id);

      if (kinds.has(option.kind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options", optionIndex, "kind"],
          message: `Duplicate opening relief oath kind "${option.kind}".`,
        });
      }
      kinds.add(option.kind);

      option.effects.forEach((effect, effectIndex) => {
        if (effect.type === "learn_knowledge") {
          if (knowledgeIds.has(effect.knowledge_id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["options", optionIndex, "effects", effectIndex],
              message: `Opening relief oath knowledge "${effect.knowledge_id}" is repeated across options.`,
            });
          }
          knowledgeIds.add(effect.knowledge_id);
        }
        if (effect.type === "affirm_value") {
          if (valueIds.has(effect.value_id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["options", optionIndex, "effects", effectIndex],
              message: `Opening relief oath value "${effect.value_id}" is repeated across options.`,
            });
          }
          valueIds.add(effect.value_id);
        }
        if (effect.type === "remember_relationship") {
          if (memoryIds.has(effect.memory_id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["options", optionIndex, "effects", effectIndex],
              message: `Opening relief oath memory "${effect.memory_id}" is repeated across options.`,
            });
          }
          memoryIds.add(effect.memory_id);
        }
        if (effect.type === "record_promise") {
          if (promiseIds.has(effect.promise_id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["options", optionIndex, "effects", effectIndex],
              message: `Opening relief oath promise "${effect.promise_id}" is repeated across options.`,
            });
          }
          promiseIds.add(effect.promise_id);
        }
        if (effect.type === "remember_relationship" && effect.npc_id !== scene.clerk_npc_id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["options", optionIndex, "effects", effectIndex],
            message: "Opening relief oath relationship effects must target the named clerk.",
          });
        }
        if (effect.type === "record_promise" && effect.recipient_id !== scene.clerk_npc_id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["options", optionIndex, "effects", effectIndex],
            message: "Opening relief oath promises must bind the named clerk.",
          });
        }
      });
    });

    for (const kind of RELIEF_OATH_KINDS) {
      if (!kinds.has(kind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: `Opening relief oath must contain exactly one "${kind}" option.`,
        });
      }
    }
  });

export type OpeningReliefOathTerms = z.infer<typeof OpeningReliefOathTermsSchema>;
export type OpeningReliefOathOption = z.infer<typeof OpeningReliefOathOptionSchema>;
export type OpeningReliefOath = z.infer<typeof OpeningReliefOathSchema>;

type OpeningReliefOathApplication = Readonly<{
  characterAfter: CampaignCharacterState;
  option: OpeningReliefOathOption;
  terms: OpeningReliefOathTerms;
}>;

export function parseOpeningReliefOath(input: unknown): OpeningReliefOath {
  return OpeningReliefOathSchema.parse(input);
}

export function cloneOpeningReliefOath(scene: OpeningReliefOath): OpeningReliefOath {
  return parseOpeningReliefOath(scene);
}

export function openingReliefOathOptionById(
  scene: OpeningReliefOath,
  optionId: string,
): OpeningReliefOathOption | null {
  const parsed = parseOpeningReliefOath(scene);
  const option = parsed.options.find((candidate) => candidate.id === optionId);
  return option ? OpeningReliefOathOptionSchema.parse(option) : null;
}

export function formatOpeningReliefOathCost(terms: OpeningReliefOathTerms): string {
  return terms.minutes === 0 ? "no added time" : `${String(terms.minutes)} minutes`;
}

/** Apply one disclosed civic duty contract without mutating the caller-owned character. */
export function applyOpeningReliefOathOption(args: {
  scene: OpeningReliefOath;
  character: CampaignCharacterState;
  optionId: string;
}): OpeningReliefOathApplication {
  const scene = parseOpeningReliefOath(args.scene);
  const character = parseCampaignCharacterState(args.character);
  const option = scene.options.find((candidate) => candidate.id === args.optionId);
  if (!option) {
    throw new Error(`Unknown opening relief oath option "${args.optionId}".`);
  }
  const consequences = applyCampaignConsequences({ character, effects: option.effects });
  return Object.freeze({
    characterAfter: consequences.characterAfter,
    option,
    terms: { ...option.terms },
  });
}
