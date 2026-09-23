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

const OPENING_PREPARATION_VERSION = 1 as const;
export const OPENING_PREPARATION_MIN_PROFILES = 3 as const;
export const OPENING_PREPARATION_MAX_PROFILES = 5 as const;

const AUTHORED_TEXT = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "Authored text cannot be blank.",
  });

const PREPARATION_TRIGGER_CATEGORY = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => value.trim().length > 0, {
    message: "Preparation trigger category cannot be blank.",
  });

export const OpeningPreparationCheckConsumerSchema = z
  .object({
    object_id: z.string().min(1),
    verb: z.enum(["USE", "READ", "INSPECT", "OPEN", "CLOSE"]),
    command_verb: z.string().regex(/^[a-z]+$/),
  })
  .strict();

export const OpeningPreparationCheckDisclosureSchema = z
  .object({
    skill_id: CampaignCharacterIdSchema,
    skill_label: AUTHORED_TEXT,
    difficulty: z.number().int().min(1).max(100),
    consumer: OpeningPreparationCheckConsumerSchema,
  })
  .strict();

const OpeningPreparationTermsSchema = z
  .object({
    minutes: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60),
    money: z.number().int().nonnegative().max(CAMPAIGN_CHARACTER_MAX_MONEY),
  })
  .strict();

const OpeningPreparationSponsorSchema = z
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

/**
 * One mutually exclusive preparation plan. Physical quest-local resources are
 * deliberately not campaign equipment here: the persistent effects are the
 * plan the character learned and the provider's memory of the allocation.
 */
export const OpeningPreparationProfileSchema = z
  .object({
    id: CampaignCharacterIdSchema,
    title: AUTHORED_TEXT,
    provider_npc_id: CampaignCharacterIdSchema,
    summary: AUTHORED_TEXT,
    trigger_category: PREPARATION_TRIGGER_CATEGORY.optional(),
    preview: AUTHORED_TEXT,
    tradeoff: AUTHORED_TEXT,
    check_disclosure: OpeningPreparationCheckDisclosureSchema.optional(),
    consequence: AUTHORED_TEXT,
    terms: OpeningPreparationTermsSchema,
    sponsor: OpeningPreparationSponsorSchema.optional(),
    effects: CampaignConsequenceEffectsSchema,
  })
  .strict()
  .superRefine((profile, ctx) => {
    const knowledgeEffects = profile.effects.filter((effect) => effect.type === "learn_knowledge");
    const relationshipEffects = profile.effects.filter(
      (effect) => effect.type === "remember_relationship",
    );
    if (
      profile.effects.some(
        (effect) => effect.type !== "learn_knowledge" && effect.type !== "remember_relationship",
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effects"],
        message:
          "Opening preparation may change character knowledge and relationships, not world facts, wounds, companions, or promises.",
      });
    }
    if (knowledgeEffects.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effects"],
        message: "An opening preparation profile must teach persistent preparation knowledge.",
      });
    }
    if (relationshipEffects.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effects"],
        message: "An opening preparation profile must record its provider relationship memory.",
      });
    }
    relationshipEffects.forEach((effect, index) => {
      if (effect.npc_id !== profile.provider_npc_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["effects", index],
          message:
            "Opening preparation relationship effects must remember the profile's named provider.",
        });
      }
    });
    if (
      profile.sponsor &&
      (profile.sponsor.minutes > profile.terms.minutes ||
        profile.sponsor.money > profile.terms.money)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sponsor"],
        message: "Opening preparation sponsor terms cannot cost more than the public terms.",
      });
    }
    if (
      profile.sponsor &&
      profile.sponsor.minutes === profile.terms.minutes &&
      profile.sponsor.money === profile.terms.money
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sponsor"],
        message: "Opening preparation sponsor terms must change time or money.",
      });
    }
  });

export const OpeningPreparationSchema = z
  .object({
    version: z.literal(OPENING_PREPARATION_VERSION),
    id: CampaignCharacterIdSchema,
    after_lead_source: CampaignCharacterIdSchema,
    target_quest: z.string().min(1),
    home: z.string().min(1),
    area: z.string().min(1),
    title: AUTHORED_TEXT,
    message: AUTHORED_TEXT,
    profiles: z
      .array(OpeningPreparationProfileSchema)
      .min(OPENING_PREPARATION_MIN_PROFILES)
      .max(OPENING_PREPARATION_MAX_PROFILES),
  })
  .strict()
  .superRefine((scene, ctx) => {
    const profileIds = new Set<string>();
    const knowledgeIds = new Set<string>();
    const categorizedProfiles = scene.profiles.filter(
      (profile) => profile.trigger_category !== undefined,
    );
    if (categorizedProfiles.length !== 0 && categorizedProfiles.length !== scene.profiles.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["profiles"],
        message:
          "Opening preparation trigger categories must cover every profile or remain absent on an exact legacy manifest.",
      });
    }
    scene.profiles.forEach((profile, profileIndex) => {
      if (profileIds.has(profile.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles", profileIndex, "id"],
          message: `Duplicate opening preparation profile id "${profile.id}".`,
        });
      }
      profileIds.add(profile.id);
      profile.effects.forEach((effect, effectIndex) => {
        if (effect.type !== "learn_knowledge") return;
        if (knowledgeIds.has(effect.knowledge_id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["profiles", profileIndex, "effects", effectIndex],
            message: `Opening preparation knowledge "${effect.knowledge_id}" is repeated across profiles.`,
          });
        }
        knowledgeIds.add(effect.knowledge_id);
      });
    });
  });

export type OpeningPreparationCheckConsumer = z.infer<typeof OpeningPreparationCheckConsumerSchema>;
export type OpeningPreparationCheckDisclosure = z.infer<
  typeof OpeningPreparationCheckDisclosureSchema
>;
export type OpeningPreparationProfile = z.infer<typeof OpeningPreparationProfileSchema>;
export type OpeningPreparation = z.infer<typeof OpeningPreparationSchema>;

export type OpeningPreparationTerms = Readonly<{
  minutes: number;
  money: number;
  sponsored: boolean;
  sponsorNote: string | null;
}>;

type OpeningPreparationApplication = Readonly<{
  characterAfter: CampaignCharacterState;
  profile: OpeningPreparationProfile;
  terms: OpeningPreparationTerms;
}>;

/** Parse and deeply detach one manifest-authored preparation scene. */
export function parseOpeningPreparation(input: unknown): OpeningPreparation {
  return OpeningPreparationSchema.parse(input);
}

export function cloneOpeningPreparation(scene: OpeningPreparation): OpeningPreparation {
  return parseOpeningPreparation(scene);
}

export function openingPreparationProfileById(
  scene: OpeningPreparation,
  profileId: string,
): OpeningPreparationProfile | null {
  const parsed = parseOpeningPreparation(scene);
  const profile = parsed.profiles.find((candidate) => candidate.id === profileId);
  return profile ? OpeningPreparationProfileSchema.parse(profile) : null;
}

function characterHasMemory(character: CampaignCharacterState, memoryId: string): boolean {
  return character.relationships.some((relationship) => relationship.memories.includes(memoryId));
}

export function openingPreparationTerms(
  profile: OpeningPreparationProfile,
  character: CampaignCharacterState,
): OpeningPreparationTerms {
  const parsedProfile = OpeningPreparationProfileSchema.parse(profile);
  const parsedCharacter = parseCampaignCharacterState(character);
  const sponsored =
    parsedProfile.sponsor !== undefined &&
    characterHasMemory(parsedCharacter, parsedProfile.sponsor.memory_id);
  const terms = sponsored ? parsedProfile.sponsor! : parsedProfile.terms;
  return Object.freeze({
    minutes: terms.minutes,
    money: terms.money,
    sponsored,
    sponsorNote: sponsored ? parsedProfile.sponsor!.note : null,
  });
}

export function formatOpeningPreparationCost(terms: OpeningPreparationTerms): string {
  const parts: string[] = [];
  if (terms.minutes === 0) parts.push("no added time");
  else parts.push(`${String(terms.minutes)} minutes`);
  if (terms.money === 0) parts.push("$0");
  else parts.push(`$${String(terms.money)}`);
  return parts.join(" and ");
}

/** Apply one preparation profile atomically, including its exact paid terms. */
export function applyOpeningPreparationProfile(args: {
  scene: OpeningPreparation;
  character: CampaignCharacterState;
  profileId: string;
}): OpeningPreparationApplication {
  const scene = parseOpeningPreparation(args.scene);
  const character = parseCampaignCharacterState(args.character);
  const profile = scene.profiles.find((candidate) => candidate.id === args.profileId);
  if (!profile) throw new Error(`Unknown opening preparation profile "${args.profileId}".`);
  const terms = openingPreparationTerms(profile, character);
  if (character.money < terms.money) {
    throw new Error(
      `Opening preparation profile "${profile.id}" costs $${String(terms.money)}, but the campaign character has only $${String(character.money)}.`,
    );
  }
  const consequences = applyCampaignConsequences({ character, effects: profile.effects });
  const characterAfter = evolveCampaignCharacterState(consequences.characterAfter, (draft) => {
    draft.money -= terms.money;
  });
  return Object.freeze({ characterAfter, profile, terms });
}
