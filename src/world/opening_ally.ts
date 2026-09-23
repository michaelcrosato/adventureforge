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

const OPENING_ALLY_VERSION = 1 as const;
const OPENING_ALLY_MIN_OPTIONS = 3 as const;
const OPENING_ALLY_MAX_OPTIONS = 4 as const;
/** Every opening ally offer begins with the standard substantive contact. */
const OPENING_ALLY_CONTACT_MINUTES = 15 as const;

const AUTHORED_TEXT = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "Authored text cannot be blank.",
  });

export const OpeningAllyTermsSchema = z
  .object({
    minutes: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60),
  })
  .strict();

export const OpeningAllyOptionSchema = z
  .object({
    id: CampaignCharacterIdSchema,
    title: AUTHORED_TEXT,
    summary: AUTHORED_TEXT,
    preview: AUTHORED_TEXT,
    tradeoff: AUTHORED_TEXT,
    consequence: AUTHORED_TEXT,
    terms: OpeningAllyTermsSchema,
    effects: CampaignConsequenceEffectsSchema,
  })
  .strict()
  .superRefine((option, ctx) => {
    if (
      option.effects.some(
        (effect) =>
          effect.type !== "add_companion" &&
          effect.type !== "record_promise" &&
          effect.type !== "remember_relationship",
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effects"],
        message:
          "Opening ally options may add the named companion, record its promise, and remember its relationship; they cannot apply wounds or other campaign outcomes.",
      });
    }
  });

export const OpeningAllySchema = z
  .object({
    version: z.literal(OPENING_ALLY_VERSION),
    id: CampaignCharacterIdSchema,
    after_preparation: CampaignCharacterIdSchema,
    target_quest: z.string().min(1),
    home: z.string().min(1),
    area: z.string().min(1),
    contact: z.string().min(1),
    ally_npc_id: CampaignCharacterIdSchema,
    solo_option_id: CampaignCharacterIdSchema,
    title: AUTHORED_TEXT,
    message: AUTHORED_TEXT,
    capability: AUTHORED_TEXT,
    condition: AUTHORED_TEXT,
    options: z
      .array(OpeningAllyOptionSchema)
      .min(OPENING_ALLY_MIN_OPTIONS)
      .max(OPENING_ALLY_MAX_OPTIONS),
  })
  .strict()
  .superRefine((scene, ctx) => {
    const optionIds = new Set<string>();
    let joiningOptions = 0;
    let zeroMinuteOptions = 0;
    scene.options.forEach((option, optionIndex) => {
      if (optionIds.has(option.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options", optionIndex, "id"],
          message: `Duplicate opening ally option id "${option.id}".`,
        });
      }
      optionIds.add(option.id);
      if (option.terms.minutes === 0) zeroMinuteOptions += 1;

      const relationshipEffects = option.effects.filter(
        (effect) => effect.type === "remember_relationship",
      );
      const companionEffects = option.effects.filter((effect) => effect.type === "add_companion");
      const promiseEffects = option.effects.filter((effect) => effect.type === "record_promise");
      if (relationshipEffects.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options", optionIndex, "effects"],
          message: "Every opening ally option must record the named ally's memory.",
        });
      }
      relationshipEffects.forEach((effect, effectIndex) => {
        if (effect.npc_id !== scene.ally_npc_id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["options", optionIndex, "effects", effectIndex],
            message: "Opening ally relationship effects must target the named ally.",
          });
        }
      });
      companionEffects.forEach((effect, effectIndex) => {
        if (effect.npc_id !== scene.ally_npc_id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["options", optionIndex, "effects", effectIndex],
            message: "Opening ally companion effects must add the named ally.",
          });
        }
      });
      promiseEffects.forEach((effect, effectIndex) => {
        if (effect.recipient_id !== scene.ally_npc_id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["options", optionIndex, "effects", effectIndex],
            message: "Opening ally promises must bind the named ally.",
          });
        }
      });
      if (companionEffects.length > 0) {
        joiningOptions += 1;
        if (companionEffects.length !== 1 || promiseEffects.length !== 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["options", optionIndex, "effects"],
            message: "The joining option must add one companion and record one active promise.",
          });
        }
      } else if (promiseEffects.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options", optionIndex, "effects"],
          message: "A non-joining ally option cannot create a field promise.",
        });
      }
      option.effects.forEach((effect, effectIndex) => {
        if (
          effect.type === "learn_knowledge" ||
          effect.type === "set_world_fact" ||
          effect.type === "remove_companion" ||
          effect.type === "resolve_promise"
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["options", optionIndex, "effects", effectIndex],
            message:
              "Opening ally options may remember the ally, add the ally, and record a promise; later consequence rules own departure and resolution.",
          });
        }
      });
    });
    if (joiningOptions !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "An opening ally scene must contain exactly one option that adds the ally.",
      });
    }
    if (zeroMinuteOptions === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "An opening ally scene must preserve a no-delay solo option.",
      });
    }
    const solo = scene.options.find((option) => option.id === scene.solo_option_id);
    if (!solo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["solo_option_id"],
        message: "Opening ally solo_option_id must reference an authored option.",
      });
    } else if (
      solo.terms.minutes !== 0 ||
      solo.effects.some(
        (effect) => effect.type === "add_companion" || effect.type === "record_promise",
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["solo_option_id"],
        message: "The implicit solo option must add no time, companion, or promise.",
      });
    }
  });

export type OpeningAllyTerms = z.infer<typeof OpeningAllyTermsSchema>;
export type OpeningAllyOption = z.infer<typeof OpeningAllyOptionSchema>;
export type OpeningAlly = z.infer<typeof OpeningAllySchema>;

type OpeningAllyApplication = Readonly<{
  characterAfter: CampaignCharacterState;
  option: OpeningAllyOption;
  terms: OpeningAllyTerms;
}>;

export function parseOpeningAlly(input: unknown): OpeningAlly {
  return OpeningAllySchema.parse(input);
}

export function openingAllyOptionById(
  scene: OpeningAlly,
  optionId: string,
): OpeningAllyOption | null {
  const parsed = parseOpeningAlly(scene);
  const option = parsed.options.find((candidate) => candidate.id === optionId);
  return option ? OpeningAllyOptionSchema.parse(option) : null;
}

/** Keep authored display labels on every ally option. */
export function openingAllyOptionDisplayLabel(
  _scene: Pick<OpeningAlly, "solo_option_id">,
  option: Pick<OpeningAllyOption, "title">,
): string {
  return option.title;
}

export function formatOpeningAllyCost(terms: OpeningAllyTerms): string {
  return terms.minutes === 0 ? "no added time" : `${String(terms.minutes)} minutes`;
}

/** State both the follow-up cost and the cost from choosing to contact the ally. */
export function formatOpeningAllyTimingDisclosure(terms: OpeningAllyTerms): string {
  const totalMinutes = OPENING_ALLY_CONTACT_MINUTES + terms.minutes;
  return `Conversation: ${String(OPENING_ALLY_CONTACT_MINUTES)} minutes. Choice adds: ${formatOpeningAllyCost(terms)}. Total: ${String(totalMinutes)} minutes.`;
}

/** Keep the same total-time truth compact enough for the bounded selection receipt. */
export function formatOpeningAllyChoiceTiming(terms: OpeningAllyTerms): string {
  const totalMinutes = OPENING_ALLY_CONTACT_MINUTES + terms.minutes;
  const additional =
    terms.minutes === 0 ? "no added time" : `${String(terms.minutes)} minutes additional`;
  return `${String(OPENING_ALLY_CONTACT_MINUTES)}-minute talk + ${additional}; ${String(totalMinutes)} minutes total`;
}

function openingAllyOptionTimingSummary(scene: OpeningAlly): string {
  const parsed = parseOpeningAlly(scene);
  return parsed.options
    .map((option) => {
      const totalMinutes = OPENING_ALLY_CONTACT_MINUTES + option.terms.minutes;
      const additional =
        option.terms.minutes === 0
          ? "no added time"
          : `${formatOpeningAllyCost(option.terms)} additional`;
      return `${openingAllyOptionDisplayLabel(parsed, option)}: ${additional}, ${String(totalMinutes)} minutes total`;
    })
    .join("; ");
}

/** Disclose totals without asserting whether this session has already paid for the conversation. */
export function openingAllyTotalTimingSummary(scene: OpeningAlly): string {
  return `All totals include the ${String(OPENING_ALLY_CONTACT_MINUTES)}-minute conversation: ${openingAllyOptionTimingSummary(scene)}.`;
}

/** Summarize every option before the player spends the initial conversation time. */
export function openingAllyContactTimingSummary(
  scene: OpeningAlly,
  conversationAlreadyPaid = false,
): string {
  const conversation = conversationAlreadyPaid
    ? `The ${String(OPENING_ALLY_CONTACT_MINUTES)}-minute conversation is already recorded. Reviewing it adds 0 minutes.`
    : `Talking takes ${String(OPENING_ALLY_CONTACT_MINUTES)} minutes.`;
  return `${conversation} ${openingAllyOptionTimingSummary(scene)}.`;
}

/** Apply one departure commitment atomically; authored effects own party and promise state. */
export function applyOpeningAllyOption(args: {
  scene: OpeningAlly;
  character: CampaignCharacterState;
  optionId: string;
}): OpeningAllyApplication {
  const scene = parseOpeningAlly(args.scene);
  const character = parseCampaignCharacterState(args.character);
  const option = scene.options.find((candidate) => candidate.id === args.optionId);
  if (!option) throw new Error(`Unknown opening ally option "${args.optionId}".`);
  const consequences = applyCampaignConsequences({ character, effects: option.effects });
  return Object.freeze({
    characterAfter: consequences.characterAfter,
    option,
    terms: { ...option.terms },
  });
}
