import { z } from "zod";

import {
  CAMPAIGN_CHARACTER_MAX_MONEY,
  CampaignCharacterIdSchema,
  evolveCampaignCharacterState,
  parseCampaignCharacterState,
  type CampaignCharacterState,
} from "./campaign_character_state.js";
import {
  CampaignConsequenceEffectsSchema,
  applyCampaignConsequences,
} from "./campaign_consequences.js";

const OPENING_LEAD_SOURCE_VERSION = 1 as const;
export const OPENING_LEAD_SOURCE_MIN_OPTIONS = 3 as const;
export const OPENING_LEAD_SOURCE_MAX_OPTIONS = 5 as const;

const AUTHORED_TEXT = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "Authored text cannot be blank.",
  });

const LEAD_SOURCE_TRIGGER_CATEGORY = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => value.trim().length > 0, {
    message: "Lead-source trigger category cannot be blank.",
  });

const OpeningLeadSourceTermsSchema = z
  .object({
    minutes: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60),
    money: z.number().int().nonnegative().max(CAMPAIGN_CHARACTER_MAX_MONEY),
  })
  .strict();

const OpeningLeadSourceSponsorSchema = z
  .object({
    memory_id: CampaignCharacterIdSchema,
    minutes: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60),
    money: z.number().int().nonnegative().max(CAMPAIGN_CHARACTER_MAX_MONEY),
    note: AUTHORED_TEXT,
  })
  .strict();

export const OpeningLeadSourceOptionSchema = z
  .object({
    id: CampaignCharacterIdSchema,
    title: AUTHORED_TEXT,
    source_npc_id: CampaignCharacterIdSchema,
    summary: AUTHORED_TEXT,
    trigger_category: LEAD_SOURCE_TRIGGER_CATEGORY.optional(),
    preview: AUTHORED_TEXT,
    tradeoff: AUTHORED_TEXT,
    consequence: AUTHORED_TEXT,
    terms: OpeningLeadSourceTermsSchema,
    sponsor: OpeningLeadSourceSponsorSchema.optional(),
    effects: CampaignConsequenceEffectsSchema,
  })
  .strict()
  .superRefine((option, ctx) => {
    if (
      option.effects.some(
        (effect) => effect.type !== "learn_knowledge" && effect.type !== "remember_relationship",
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effects"],
        message:
          "Opening lead sources may change character knowledge and relationships, not world facts, wounds, companions, or promises.",
      });
    }
    if (
      option.sponsor &&
      (option.sponsor.minutes > option.terms.minutes || option.sponsor.money > option.terms.money)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sponsor"],
        message: "Opening lead-source sponsor terms cannot cost more than the public terms.",
      });
    }
    if (
      option.sponsor &&
      option.sponsor.minutes === option.terms.minutes &&
      option.sponsor.money === option.terms.money
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sponsor"],
        message: "Opening lead-source sponsor terms must change time or money.",
      });
    }
  });

export const OpeningLeadSourceSchema = z
  .object({
    version: z.literal(OPENING_LEAD_SOURCE_VERSION),
    id: CampaignCharacterIdSchema,
    after_registration: CampaignCharacterIdSchema,
    target_quest: z.string().min(1),
    home: z.string().min(1),
    area: z.string().min(1),
    title: AUTHORED_TEXT,
    message: AUTHORED_TEXT,
    options: z
      .array(OpeningLeadSourceOptionSchema)
      .min(OPENING_LEAD_SOURCE_MIN_OPTIONS)
      .max(OPENING_LEAD_SOURCE_MAX_OPTIONS),
  })
  .strict()
  .superRefine((scene, ctx) => {
    const ids = new Set<string>();
    const categorizedOptions = scene.options.filter(
      (option) => option.trigger_category !== undefined,
    );
    if (categorizedOptions.length !== 0 && categorizedOptions.length !== scene.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message:
          "Opening lead-source trigger categories must cover every option or remain absent on an exact legacy manifest.",
      });
    }
    scene.options.forEach((option, index) => {
      if (ids.has(option.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options", index, "id"],
          message: `Duplicate opening lead-source option id "${option.id}".`,
        });
      }
      ids.add(option.id);
    });
    if (!scene.options.some((option) => option.effects.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "Opening lead sources require one explicit unaugmented/default packet.",
      });
    }
    if (
      scene.options.filter((option) =>
        option.effects.some((effect) => effect.type === "learn_knowledge"),
      ).length < 2
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "Opening lead sources require at least two distinct knowledge-bearing reports.",
      });
    }
  });

export type OpeningLeadSourceOption = z.infer<typeof OpeningLeadSourceOptionSchema>;
export type OpeningLeadSource = z.infer<typeof OpeningLeadSourceSchema>;

export type OpeningLeadSourceTerms = Readonly<{
  minutes: number;
  money: number;
  sponsored: boolean;
  sponsorNote: string | null;
}>;

type OpeningLeadSourceApplication = Readonly<{
  characterAfter: CampaignCharacterState;
  option: OpeningLeadSourceOption;
  terms: OpeningLeadSourceTerms;
}>;

export function parseOpeningLeadSource(input: unknown): OpeningLeadSource {
  return OpeningLeadSourceSchema.parse(input);
}

export function cloneOpeningLeadSource(scene: OpeningLeadSource): OpeningLeadSource {
  return parseOpeningLeadSource(scene);
}

function characterHasMemory(character: CampaignCharacterState, memoryId: string): boolean {
  return character.relationships.some((relationship) => relationship.memories.includes(memoryId));
}

export function openingLeadSourceOptionById(
  scene: OpeningLeadSource,
  optionId: string,
): OpeningLeadSourceOption | null {
  const parsed = parseOpeningLeadSource(scene);
  const option = parsed.options.find((candidate) => candidate.id === optionId);
  return option ? OpeningLeadSourceOptionSchema.parse(option) : null;
}

export function openingLeadSourceTerms(
  option: OpeningLeadSourceOption,
  character: CampaignCharacterState,
): OpeningLeadSourceTerms {
  const parsedOption = OpeningLeadSourceOptionSchema.parse(option);
  const parsedCharacter = parseCampaignCharacterState(character);
  const sponsored =
    parsedOption.sponsor !== undefined &&
    characterHasMemory(parsedCharacter, parsedOption.sponsor.memory_id);
  const terms = sponsored ? parsedOption.sponsor! : parsedOption.terms;
  return Object.freeze({
    minutes: terms.minutes,
    money: terms.money,
    sponsored,
    sponsorNote: sponsored ? parsedOption.sponsor!.note : null,
  });
}

export function formatOpeningLeadSourceCost(terms: OpeningLeadSourceTerms): string {
  const parts: string[] = [];
  if (terms.minutes === 0) parts.push("no added time");
  else parts.push(`${String(terms.minutes)} minutes`);
  if (terms.money === 0) parts.push("$0");
  else parts.push(`$${String(terms.money)}`);
  return parts.join(" and ");
}

/** Apply a manifest-authored source choice atomically, including its exact paid terms. */
export function applyOpeningLeadSourceOption(args: {
  scene: OpeningLeadSource;
  character: CampaignCharacterState;
  optionId: string;
}): OpeningLeadSourceApplication {
  const scene = parseOpeningLeadSource(args.scene);
  const character = parseCampaignCharacterState(args.character);
  const option = scene.options.find((candidate) => candidate.id === args.optionId);
  if (!option) throw new Error(`Unknown opening lead-source option "${args.optionId}".`);
  const terms = openingLeadSourceTerms(option, character);
  if (character.money < terms.money) {
    throw new Error(
      `Opening lead-source option "${option.id}" costs $${String(terms.money)}, but the campaign character has only $${String(character.money)}.`,
    );
  }
  const consequences = applyCampaignConsequences({ character, effects: option.effects });
  const characterAfter = evolveCampaignCharacterState(consequences.characterAfter, (draft) => {
    draft.money -= terms.money;
  });
  return Object.freeze({ characterAfter, option, terms });
}
