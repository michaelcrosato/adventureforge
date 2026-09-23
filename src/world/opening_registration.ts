import { z } from "zod";

import {
  CampaignCharacterIdSchema,
  CampaignCharacterStateSchema,
  cloneCampaignCharacterState,
  createInitialCampaignCharacterState,
  parseCampaignCharacterState,
  serializeCampaignCharacterState,
  type CampaignCharacterState,
} from "./campaign_character_state.js";

export const OPENING_REGISTRATION_VERSION = 1 as const;
export const OPENING_REGISTRATION_MIN_PROFILES = 4 as const;
export const OPENING_REGISTRATION_MAX_PROFILES = 8 as const;
export const OPENING_REGISTRATION_MIN_DOCTRINES = 3 as const;
export const OPENING_REGISTRATION_MAX_DOCTRINES = 6 as const;

const AUTHORED_TEXT = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "Authored text cannot be blank.",
  });

const REGISTRATION_TRIGGER_CATEGORY = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => value.trim().length > 0, {
    message: "Registration trigger category cannot be blank.",
  });

const STARTING_DOCTRINE_TRIGGER_CATEGORY = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => value.trim().length > 0, {
    message: "Starting doctrine trigger category cannot be blank.",
  });

/**
 * One complete, canonical campaign-character package presented at registration.
 * The profile id is also the persistent background id; there is no second
 * mapping table that can drift away from the state the player receives.
 */
export const OpeningRegistrationProfileSchema = z
  .object({
    id: CampaignCharacterIdSchema,
    title: AUTHORED_TEXT,
    summary: AUTHORED_TEXT,
    trigger_category: REGISTRATION_TRIGGER_CATEGORY.optional(),
    preview: AUTHORED_TEXT,
    tradeoff: AUTHORED_TEXT,
    consequence: AUTHORED_TEXT,
    character: CampaignCharacterStateSchema,
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (profile.character.background === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["character", "background"],
        message: "A registration profile character must have a background.",
      });
    } else if (profile.character.background !== profile.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["character", "background"],
        message: "A registration profile character background must equal its profile id.",
      });
    }
  });

/**
 * An authored, one-click starting route through the required opening choices.
 * It intentionally records only existing registration, oath, and source ids;
 * runtime selection remains owned by the normal opening flow.
 */
export const OpeningStartingDoctrineSchema = z
  .object({
    id: CampaignCharacterIdSchema,
    title: AUTHORED_TEXT,
    summary: AUTHORED_TEXT,
    trigger_category: STARTING_DOCTRINE_TRIGGER_CATEGORY,
    preview: AUTHORED_TEXT,
    tradeoff: AUTHORED_TEXT,
    consequence: AUTHORED_TEXT,
    immediate_cost: AUTHORED_TEXT,
    profile_id: CampaignCharacterIdSchema,
    relief_oath_option_id: CampaignCharacterIdSchema,
    lead_source_option_id: CampaignCharacterIdSchema,
  })
  .strict();

/** A single manifest-authored opening registration scene. */
export const OpeningRegistrationSchema = z
  .object({
    version: z.literal(OPENING_REGISTRATION_VERSION),
    id: CampaignCharacterIdSchema,
    home: AUTHORED_TEXT,
    area: AUTHORED_TEXT,
    contact: AUTHORED_TEXT,
    title: AUTHORED_TEXT,
    message: AUTHORED_TEXT,
    profiles: z
      .array(OpeningRegistrationProfileSchema)
      .min(OPENING_REGISTRATION_MIN_PROFILES)
      .max(OPENING_REGISTRATION_MAX_PROFILES),
    doctrines: z
      .array(OpeningStartingDoctrineSchema)
      .min(OPENING_REGISTRATION_MIN_DOCTRINES)
      .max(OPENING_REGISTRATION_MAX_DOCTRINES)
      .optional(),
  })
  .strict()
  .superRefine((registration, ctx) => {
    const profileIds = new Set<string>();
    const categorizedProfiles = registration.profiles.filter(
      (profile) => profile.trigger_category !== undefined,
    );
    if (
      categorizedProfiles.length !== 0 &&
      categorizedProfiles.length !== registration.profiles.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["profiles"],
        message:
          "Opening registration trigger categories must cover every profile or remain absent on an exact legacy manifest.",
      });
    }
    registration.profiles.forEach((profile, index) => {
      if (profileIds.has(profile.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles", index, "id"],
          message: `Duplicate opening registration profile id "${profile.id}".`,
        });
      }
      profileIds.add(profile.id);
    });

    const doctrineIds = new Set<string>();
    const doctrineSelections = new Set<string>();
    const doctrineProfiles = new Set<string>();
    registration.doctrines?.forEach((doctrine, index) => {
      if (doctrineIds.has(doctrine.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["doctrines", index, "id"],
          message: `Duplicate opening starting doctrine id "${doctrine.id}".`,
        });
      }
      if (profileIds.has(doctrine.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["doctrines", index, "id"],
          message: `Opening starting doctrine id "${doctrine.id}" collides with a registration profile id.`,
        });
      }
      doctrineIds.add(doctrine.id);

      const selection = [
        doctrine.profile_id,
        doctrine.relief_oath_option_id,
        doctrine.lead_source_option_id,
      ].join("|");
      if (doctrineSelections.has(selection)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["doctrines", index],
          message: "Opening starting doctrines must not repeat the same opening selection.",
        });
      }
      doctrineSelections.add(selection);
      if (doctrineProfiles.has(doctrine.profile_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["doctrines", index, "profile_id"],
          message: "Opening starting doctrines must not repeat the same registration profile.",
        });
      }
      doctrineProfiles.add(doctrine.profile_id);
    });
  });

export type OpeningRegistrationProfile = z.infer<typeof OpeningRegistrationProfileSchema>;
export type OpeningStartingDoctrine = z.infer<typeof OpeningStartingDoctrineSchema>;
export type OpeningRegistration = z.infer<typeof OpeningRegistrationSchema>;

/** Parse and deeply detach a manifest-authored registration scene. */
export function parseOpeningRegistration(input: unknown): OpeningRegistration {
  return OpeningRegistrationSchema.parse(input);
}

export function cloneOpeningRegistration(registration: OpeningRegistration): OpeningRegistration {
  return parseOpeningRegistration(registration);
}

/** Resolve a profile by id and return a detached package (null when absent). */
export function getOpeningRegistrationProfile(
  registration: OpeningRegistration,
  profileId: string,
): OpeningRegistrationProfile | null {
  const parsed = parseOpeningRegistration(registration);
  const profile = parsed.profiles.find((entry) => entry.id === profileId);
  return profile === undefined ? null : OpeningRegistrationProfileSchema.parse(profile);
}

const DEFAULT_CHARACTER_SERIALIZED = serializeCampaignCharacterState(
  createInitialCampaignCharacterState(),
);

/**
 * Apply one registration package atomically. Registration is a one-time
 * boundary: only the exact neutral campaign character may be replaced. Both
 * inputs are validated and detached before any selection is returned.
 */
export function applyOpeningRegistrationProfile(args: {
  registration: OpeningRegistration;
  character: CampaignCharacterState;
  profileId: string;
}): CampaignCharacterState {
  const registration = parseOpeningRegistration(args.registration);
  const character = parseCampaignCharacterState(args.character);

  if (serializeCampaignCharacterState(character) !== DEFAULT_CHARACTER_SERIALIZED) {
    throw new Error(
      "Opening registration can only be applied to the exact default campaign character.",
    );
  }

  const profile = registration.profiles.find((entry) => entry.id === args.profileId);
  if (profile === undefined) {
    throw new Error(`Unknown opening registration profile "${args.profileId}".`);
  }

  return cloneCampaignCharacterState(profile.character);
}
