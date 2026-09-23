import { z } from "zod";

export const CAMPAIGN_CHARACTER_STATE_VERSION = 1 as const;
export const CAMPAIGN_CHARACTER_DEFAULT_HEALTH = 30 as const;
export const CAMPAIGN_CHARACTER_MAX_HEALTH = 999 as const;
export const CAMPAIGN_CHARACTER_MAX_MONEY = 1_000_000_000 as const;
export const CAMPAIGN_CHARACTER_MAX_RANK = 5 as const;
export const CAMPAIGN_CHARACTER_MIN_SCORE = -100 as const;
export const CAMPAIGN_CHARACTER_MAX_SCORE = 100 as const;
export const CAMPAIGN_CHARACTER_MAX_OWED = 100 as const;
export const CAMPAIGN_CHARACTER_MAX_EQUIPMENT_QUANTITY = 999 as const;
export const CAMPAIGN_CHARACTER_MAX_EQUIPMENT_CONDITION = 100 as const;
export const CAMPAIGN_CHARACTER_MAX_ID_LENGTH = 96 as const;

/**
 * Stable content ids are deliberately namespaced. This prevents a quest-local
 * `cade` or `spear` from silently colliding with another pack's persistent state.
 */
const CAMPAIGN_CHARACTER_ID_PATTERN = /^[a-z][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)+$/;

export const CampaignCharacterIdSchema = z
  .string()
  .min(3)
  .max(CAMPAIGN_CHARACTER_MAX_ID_LENGTH)
  .regex(CAMPAIGN_CHARACTER_ID_PATTERN);

const RANK = z.number().int().min(1).max(CAMPAIGN_CHARACTER_MAX_RANK);
const SCORE = z.number().int().min(CAMPAIGN_CHARACTER_MIN_SCORE).max(CAMPAIGN_CHARACTER_MAX_SCORE);
const OWED = z.number().int().min(0).max(CAMPAIGN_CHARACTER_MAX_OWED);

const CampaignCharacterSkillSchema = z
  .object({
    skillId: CampaignCharacterIdSchema,
    rank: RANK,
  })
  .strict();

const CampaignCharacterValueSchema = z
  .object({
    valueId: CampaignCharacterIdSchema,
    strength: RANK,
  })
  .strict();

export const CampaignCharacterHealthSchema = z
  .object({
    current: z.number().int().min(0).max(CAMPAIGN_CHARACTER_MAX_HEALTH),
    max: z.number().int().min(1).max(CAMPAIGN_CHARACTER_MAX_HEALTH),
  })
  .strict()
  .superRefine((health, ctx) => {
    if (health.current > health.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["current"],
        message: "Current health cannot exceed maximum health.",
      });
    }
  });

export const CampaignWoundTreatmentSchema = z.enum(["untreated", "stabilized", "treated"]);

const CampaignCharacterWoundSchema = z
  .object({
    woundId: CampaignCharacterIdSchema,
    severity: RANK,
    treatment: CampaignWoundTreatmentSchema,
  })
  .strict();

/**
 * `equipmentId` identifies this persistent instance or stack. `itemId`
 * identifies its authored kind, so two damaged spears remain two distinct
 * possessions instead of collapsing into one inventory flag.
 */
const CampaignCharacterEquipmentSchema = z
  .object({
    equipmentId: CampaignCharacterIdSchema,
    itemId: CampaignCharacterIdSchema,
    quantity: z.number().int().min(1).max(CAMPAIGN_CHARACTER_MAX_EQUIPMENT_QUANTITY),
    condition: z.number().int().min(0).max(CAMPAIGN_CHARACTER_MAX_EQUIPMENT_CONDITION),
    equipped: z.boolean(),
  })
  .strict();

export const CampaignPromiseStatusSchema = z.enum(["active", "kept", "broken", "released"]);

const CampaignCharacterPromiseSchema = z
  .object({
    promiseId: CampaignCharacterIdSchema,
    recipientId: CampaignCharacterIdSchema,
    status: CampaignPromiseStatusSchema,
  })
  .strict();

export const CampaignCrimeStatusSchema = z.enum(["hidden", "suspected", "known", "resolved"]);

const CampaignCharacterCrimeSchema = z
  .object({
    crimeId: CampaignCharacterIdSchema,
    jurisdictionId: CampaignCharacterIdSchema,
    severity: RANK,
    status: CampaignCrimeStatusSchema,
  })
  .strict();

const CampaignCharacterRelationshipSchema = z
  .object({
    npcId: CampaignCharacterIdSchema,
    trust: SCORE,
    regard: SCORE,
    owesPlayer: OWED,
    playerOwes: OWED,
    memories: z.array(CampaignCharacterIdSchema),
  })
  .strict();

const CampaignCharacterFactionStandingSchema = z
  .object({
    factionId: CampaignCharacterIdSchema,
    standing: SCORE.refine((standing) => standing !== 0, {
      message: "Zero faction standing must be omitted from canonical state.",
    }),
  })
  .strict();

function addCanonicalIssue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function requireCanonicalIds<T>(
  values: readonly T[],
  idFor: (value: T) => string,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  const seen = new Set<string>();
  let previous: string | null = null;
  values.forEach((value, index) => {
    const id = idFor(value);
    if (seen.has(id)) {
      addCanonicalIssue(ctx, [...path, index], `Duplicate canonical id "${id}".`);
    }
    if (previous !== null && id < previous) {
      addCanonicalIssue(ctx, [...path, index], "Ids must be in ascending canonical order.");
    }
    seen.add(id);
    previous = id;
  });
}

export const CampaignCharacterStateSchema = z
  .object({
    version: z.literal(CAMPAIGN_CHARACTER_STATE_VERSION),
    background: CampaignCharacterIdSchema.nullable(),
    skills: z.array(CampaignCharacterSkillSchema),
    values: z.array(CampaignCharacterValueSchema),
    health: CampaignCharacterHealthSchema,
    wounds: z.array(CampaignCharacterWoundSchema),
    equipment: z.array(CampaignCharacterEquipmentSchema),
    money: z.number().int().min(0).max(CAMPAIGN_CHARACTER_MAX_MONEY),
    abilities: z.array(CampaignCharacterIdSchema),
    knowledge: z.array(CampaignCharacterIdSchema),
    promises: z.array(CampaignCharacterPromiseSchema),
    crimes: z.array(CampaignCharacterCrimeSchema),
    relationships: z.array(CampaignCharacterRelationshipSchema),
    factionStanding: z.array(CampaignCharacterFactionStandingSchema),
    // Added within v1 as a backwards-compatible party-membership set. Zod's
    // default upgrades persisted pre-companion characters without inventing a
    // member; newly built state always emits the canonical empty collection.
    companions: z.array(CampaignCharacterIdSchema).default([]),
  })
  .strict()
  .superRefine((state, ctx) => {
    requireCanonicalIds(state.skills, (entry) => entry.skillId, ctx, ["skills"]);
    requireCanonicalIds(state.values, (entry) => entry.valueId, ctx, ["values"]);
    requireCanonicalIds(state.wounds, (entry) => entry.woundId, ctx, ["wounds"]);
    requireCanonicalIds(state.equipment, (entry) => entry.equipmentId, ctx, ["equipment"]);
    requireCanonicalIds(state.abilities, (entry) => entry, ctx, ["abilities"]);
    requireCanonicalIds(state.knowledge, (entry) => entry, ctx, ["knowledge"]);
    requireCanonicalIds(state.promises, (entry) => entry.promiseId, ctx, ["promises"]);
    requireCanonicalIds(state.crimes, (entry) => entry.crimeId, ctx, ["crimes"]);
    requireCanonicalIds(state.relationships, (entry) => entry.npcId, ctx, ["relationships"]);
    requireCanonicalIds(state.factionStanding, (entry) => entry.factionId, ctx, [
      "factionStanding",
    ]);
    requireCanonicalIds(state.companions, (entry) => entry, ctx, ["companions"]);
    state.relationships.forEach((relationship, index) => {
      requireCanonicalIds(relationship.memories, (entry) => entry, ctx, [
        "relationships",
        index,
        "memories",
      ]);
    });
  });

export type CampaignCharacterSkill = z.infer<typeof CampaignCharacterSkillSchema>;
export type CampaignCharacterValue = z.infer<typeof CampaignCharacterValueSchema>;
export type CampaignCharacterHealth = z.infer<typeof CampaignCharacterHealthSchema>;
export type CampaignWoundTreatment = z.infer<typeof CampaignWoundTreatmentSchema>;
export type CampaignCharacterWound = z.infer<typeof CampaignCharacterWoundSchema>;
export type CampaignCharacterEquipment = z.infer<typeof CampaignCharacterEquipmentSchema>;
export type CampaignPromiseStatus = z.infer<typeof CampaignPromiseStatusSchema>;
export type CampaignCharacterPromise = z.infer<typeof CampaignCharacterPromiseSchema>;
export type CampaignCrimeStatus = z.infer<typeof CampaignCrimeStatusSchema>;
export type CampaignCharacterCrime = z.infer<typeof CampaignCharacterCrimeSchema>;
export type CampaignCharacterRelationship = z.infer<typeof CampaignCharacterRelationshipSchema>;
export type CampaignCharacterFactionStanding = z.infer<
  typeof CampaignCharacterFactionStandingSchema
>;
export type CampaignCharacterState = z.infer<typeof CampaignCharacterStateSchema>;

export type CampaignCharacterStateBuildInput = {
  version?: typeof CAMPAIGN_CHARACTER_STATE_VERSION;
  background?: string | null;
  skills?: readonly CampaignCharacterSkill[];
  values?: readonly CampaignCharacterValue[];
  health?: Partial<CampaignCharacterHealth>;
  wounds?: readonly CampaignCharacterWound[];
  equipment?: readonly CampaignCharacterEquipment[];
  money?: number;
  abilities?: readonly string[];
  knowledge?: readonly string[];
  promises?: readonly CampaignCharacterPromise[];
  crimes?: readonly CampaignCharacterCrime[];
  relationships?: readonly CampaignCharacterRelationship[];
  factionStanding?: readonly CampaignCharacterFactionStanding[];
  companions?: readonly string[];
};

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalStrings(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].sort(compareIds);
}

function canonicalObjects<T>(
  values: readonly T[] | undefined,
  idFor: (value: T) => string,
  clone: (value: T) => T = (value) => ({ ...value }),
): T[] {
  return (values ?? []).map(clone).sort((left, right) => compareIds(idFor(left), idFor(right)));
}

/**
 * Build canonical state from authoring/runtime pieces. Unlike parsing an
 * already-persisted state, building sorts set-like arrays without mutating the
 * caller. Duplicate ids still fail rather than silently discarding state.
 */
export function buildCampaignCharacterState(
  input: CampaignCharacterStateBuildInput = {},
): CampaignCharacterState {
  const healthMax = input.health?.max ?? CAMPAIGN_CHARACTER_DEFAULT_HEALTH;
  const healthCurrent = input.health?.current ?? healthMax;
  return CampaignCharacterStateSchema.parse({
    version: input.version ?? CAMPAIGN_CHARACTER_STATE_VERSION,
    background: input.background ?? null,
    skills: canonicalObjects(input.skills, (entry) => entry.skillId),
    values: canonicalObjects(input.values, (entry) => entry.valueId),
    health: { current: healthCurrent, max: healthMax },
    wounds: canonicalObjects(input.wounds, (entry) => entry.woundId),
    equipment: canonicalObjects(input.equipment, (entry) => entry.equipmentId),
    money: input.money ?? 0,
    abilities: canonicalStrings(input.abilities),
    knowledge: canonicalStrings(input.knowledge),
    promises: canonicalObjects(input.promises, (entry) => entry.promiseId),
    crimes: canonicalObjects(input.crimes, (entry) => entry.crimeId),
    relationships: canonicalObjects(
      input.relationships,
      (entry) => entry.npcId,
      (entry) => ({ ...entry, memories: canonicalStrings(entry.memories) }),
    ),
    factionStanding: canonicalObjects(input.factionStanding, (entry) => entry.factionId),
    companions: canonicalStrings(input.companions),
  });
}

export function createInitialCampaignCharacterState(
  background: string | null = null,
): CampaignCharacterState {
  return buildCampaignCharacterState({ background });
}

/** Parse and independently clone canonical persisted or boundary state. */
export function parseCampaignCharacterState(input: unknown): CampaignCharacterState {
  return CampaignCharacterStateSchema.parse(input);
}

export function cloneCampaignCharacterState(state: CampaignCharacterState): CampaignCharacterState {
  return parseCampaignCharacterState(state);
}

/** Stable compact JSON: schema order plus canonical arrays makes bytes deterministic. */
export function serializeCampaignCharacterState(state: CampaignCharacterState): string {
  return JSON.stringify(parseCampaignCharacterState(state));
}

export function deserializeCampaignCharacterState(serialized: string): CampaignCharacterState {
  return parseCampaignCharacterState(JSON.parse(serialized) as unknown);
}

/**
 * Evolve state transactionally. The mutator receives a deep draft; the source
 * remains untouched even when mutation or validation throws. Returned state is
 * re-canonicalized and fully validated.
 */
export function evolveCampaignCharacterState(
  state: CampaignCharacterState,
  mutate: (draft: CampaignCharacterState) => void,
): CampaignCharacterState {
  const draft = cloneCampaignCharacterState(state);
  mutate(draft);
  return buildCampaignCharacterState(draft);
}
