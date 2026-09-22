import { z } from "zod";

import {
  CAMPAIGN_CHARACTER_MAX_HEALTH,
  CAMPAIGN_CHARACTER_MAX_OWED,
  CAMPAIGN_CHARACTER_MAX_RANK,
  CAMPAIGN_CHARACTER_MAX_SCORE,
  CAMPAIGN_CHARACTER_MIN_SCORE,
  CampaignCharacterIdSchema,
  CampaignPromiseStatusSchema,
  CampaignWoundTreatmentSchema,
  evolveCampaignCharacterState,
  type CampaignCharacterState,
} from "./campaign_character_state.js";

const CAMPAIGN_SCORE_FLOOR = z
  .number()
  .int()
  .min(CAMPAIGN_CHARACTER_MIN_SCORE)
  .max(CAMPAIGN_CHARACTER_MAX_SCORE);
const CAMPAIGN_OWED_FLOOR = z.number().int().min(0).max(CAMPAIGN_CHARACTER_MAX_OWED);
const CAMPAIGN_RANK_FLOOR = z.number().int().min(1).max(CAMPAIGN_CHARACTER_MAX_RANK);
const CAMPAIGN_POSITIVE_SCORE_FLOOR = z.number().int().min(1).max(CAMPAIGN_CHARACTER_MAX_SCORE);

export const AffirmValueConsequenceSchema = z
  .object({
    type: z.literal("affirm_value"),
    value_id: CampaignCharacterIdSchema,
    strength_at_least: CAMPAIGN_RANK_FLOOR,
  })
  .strict();

export const RaiseFactionStandingConsequenceSchema = z
  .object({
    type: z.literal("raise_faction_standing"),
    faction_id: CampaignCharacterIdSchema,
    standing_at_least: CAMPAIGN_POSITIVE_SCORE_FLOOR,
  })
  .strict();

export const RememberRelationshipConsequenceSchema = z
  .object({
    type: z.literal("remember_relationship"),
    npc_id: CampaignCharacterIdSchema,
    memory_id: CampaignCharacterIdSchema,
    trust_at_least: CAMPAIGN_SCORE_FLOOR.optional(),
    regard_at_least: CAMPAIGN_SCORE_FLOOR.optional(),
    owes_player_at_least: CAMPAIGN_OWED_FLOOR.optional(),
  })
  .strict();

export const SetWorldFactConsequenceSchema = z
  .object({
    type: z.literal("set_world_fact"),
    fact_id: CampaignCharacterIdSchema,
  })
  .strict();

export const LearnKnowledgeConsequenceSchema = z
  .object({
    type: z.literal("learn_knowledge"),
    knowledge_id: CampaignCharacterIdSchema,
  })
  .strict();

export const AddCompanionConsequenceSchema = z
  .object({
    type: z.literal("add_companion"),
    npc_id: CampaignCharacterIdSchema,
  })
  .strict();

export const RemoveCompanionConsequenceSchema = z
  .object({
    type: z.literal("remove_companion"),
    npc_id: CampaignCharacterIdSchema,
  })
  .strict();

export const RecordPromiseConsequenceSchema = z
  .object({
    type: z.literal("record_promise"),
    promise_id: CampaignCharacterIdSchema,
    recipient_id: CampaignCharacterIdSchema,
  })
  .strict();

export const ResolvePromiseConsequenceSchema = z
  .object({
    type: z.literal("resolve_promise"),
    promise_id: CampaignCharacterIdSchema,
    status: CampaignPromiseStatusSchema.refine((status) => status !== "active", {
      message: "Resolved promises must become kept, broken, or released.",
    }),
  })
  .strict();

export const SufferWoundConsequenceSchema = z
  .object({
    type: z.literal("suffer_wound"),
    wound_id: CampaignCharacterIdSchema,
    severity: z.number().int().min(1).max(CAMPAIGN_CHARACTER_MAX_RANK),
    treatment: CampaignWoundTreatmentSchema,
    health_loss: z.number().int().min(1).max(CAMPAIGN_CHARACTER_MAX_HEALTH),
  })
  .strict();

const CAMPAIGN_WOUND_TREATMENT_ORDER = Object.freeze({
  untreated: 0,
  stabilized: 1,
  treated: 2,
} as const);

const TreatWoundConsequenceBaseSchema = z
  .object({
    type: z.literal("treat_wound"),
    wound_id: CampaignCharacterIdSchema,
    from_treatment: CampaignWoundTreatmentSchema,
    to_treatment: CampaignWoundTreatmentSchema,
    health_restore: z.number().int().min(1).max(CAMPAIGN_CHARACTER_MAX_HEALTH),
  })
  .strict();

function assertTreatmentAdvances(
  effect: z.infer<typeof TreatWoundConsequenceBaseSchema>,
  ctx: z.RefinementCtx,
): void {
  if (
    CAMPAIGN_WOUND_TREATMENT_ORDER[effect.to_treatment] <=
    CAMPAIGN_WOUND_TREATMENT_ORDER[effect.from_treatment]
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["to_treatment"],
      message: `Wound treatment must advance from "${effect.from_treatment}" to a later treatment state.`,
    });
  }
}

export const TreatWoundConsequenceSchema =
  TreatWoundConsequenceBaseSchema.superRefine(assertTreatmentAdvances);

export const CampaignConsequenceEffectSchema = z
  .discriminatedUnion("type", [
    AddCompanionConsequenceSchema,
    AffirmValueConsequenceSchema,
    LearnKnowledgeConsequenceSchema,
    RaiseFactionStandingConsequenceSchema,
    RecordPromiseConsequenceSchema,
    RememberRelationshipConsequenceSchema,
    RemoveCompanionConsequenceSchema,
    ResolvePromiseConsequenceSchema,
    SetWorldFactConsequenceSchema,
    SufferWoundConsequenceSchema,
    TreatWoundConsequenceBaseSchema,
  ])
  .superRefine((effect, ctx) => {
    if (effect.type === "treat_wound") assertTreatmentAdvances(effect, ctx);
  });

export type AddCompanionConsequence = z.infer<typeof AddCompanionConsequenceSchema>;
export type AffirmValueConsequence = z.infer<typeof AffirmValueConsequenceSchema>;
export type LearnKnowledgeConsequence = z.infer<typeof LearnKnowledgeConsequenceSchema>;
export type RaiseFactionStandingConsequence = z.infer<typeof RaiseFactionStandingConsequenceSchema>;
export type RecordPromiseConsequence = z.infer<typeof RecordPromiseConsequenceSchema>;
export type RememberRelationshipConsequence = z.infer<typeof RememberRelationshipConsequenceSchema>;
export type RemoveCompanionConsequence = z.infer<typeof RemoveCompanionConsequenceSchema>;
export type ResolvePromiseConsequence = z.infer<typeof ResolvePromiseConsequenceSchema>;
export type SetWorldFactConsequence = z.infer<typeof SetWorldFactConsequenceSchema>;
export type SufferWoundConsequence = z.infer<typeof SufferWoundConsequenceSchema>;
export type TreatWoundConsequence = z.infer<typeof TreatWoundConsequenceSchema>;
export type CampaignConsequenceEffect = z.infer<typeof CampaignConsequenceEffectSchema>;

export const CampaignCharacterConditionIdsSchema = z
  .array(CampaignCharacterIdSchema)
  .min(1)
  .superRefine((ids, ctx) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Duplicate campaign character condition id "${id}".`,
        });
      }
      seen.add(id);
    });
  });

export const CampaignPromiseConditionSchema = z
  .object({
    promise_id: CampaignCharacterIdSchema,
    status: CampaignPromiseStatusSchema,
  })
  .strict();

export const CampaignPromiseConditionsSchema = z
  .array(CampaignPromiseConditionSchema)
  .min(1)
  .superRefine((promises, ctx) => {
    const seen = new Set<string>();
    promises.forEach((promise, index) => {
      if (seen.has(promise.promise_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Campaign character conditions repeat promise "${promise.promise_id}".`,
        });
      }
      seen.add(promise.promise_id);
    });
  });

export const CampaignRelationshipMemoryConditionSchema = z
  .object({
    npc_id: CampaignCharacterIdSchema,
    memory_id: CampaignCharacterIdSchema,
  })
  .strict();

export const CampaignRelationshipMemoryConditionsSchema = z
  .array(CampaignRelationshipMemoryConditionSchema)
  .min(1)
  .superRefine((memories, ctx) => {
    const seen = new Set<string>();
    memories.forEach((memory, index) => {
      const key = JSON.stringify([memory.npc_id, memory.memory_id]);
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Campaign character conditions repeat relationship memory ${key}.`,
        });
      }
      seen.add(key);
    });
  });

export const CampaignWoundConditionSchema = z
  .object({
    wound_id: CampaignCharacterIdSchema,
    treatment: CampaignWoundTreatmentSchema,
  })
  .strict();

export const CampaignWoundConditionsSchema = z
  .array(CampaignWoundConditionSchema)
  .min(1)
  .superRefine((wounds, ctx) => {
    const treatmentByWoundId = new Map<string, string>();
    wounds.forEach((wound, index) => {
      const prior = treatmentByWoundId.get(wound.wound_id);
      if (prior !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message:
            prior === wound.treatment
              ? `Campaign character conditions repeat wound "${wound.wound_id}" with treatment "${wound.treatment}".`
              : `Campaign character conditions require mutually exclusive treatments "${prior}" and "${wound.treatment}" for wound "${wound.wound_id}".`,
        });
      }
      treatmentByWoundId.set(wound.wound_id, wound.treatment);
    });
  });

export const CampaignForbiddenWoundConditionsSchema = z
  .array(CampaignWoundConditionSchema)
  .min(1)
  .superRefine((wounds, ctx) => {
    const seen = new Set<string>();
    wounds.forEach((wound, index) => {
      const key = woundConditionKey(wound);
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Campaign character conditions repeat forbidden wound ${key}.`,
        });
      }
      seen.add(key);
    });
  });

function relationshipMemoryConditionKey(condition: { npc_id: string; memory_id: string }): string {
  return JSON.stringify([condition.npc_id, condition.memory_id]);
}

function woundConditionKey(condition: { wound_id: string; treatment: string }): string {
  return JSON.stringify([condition.wound_id, condition.treatment]);
}

export const CampaignCharacterConditionsSchema = z
  .object({
    requires_all_companions: CampaignCharacterConditionIdsSchema.optional(),
    forbids_any_companions: CampaignCharacterConditionIdsSchema.optional(),
    requires_all_promises: CampaignPromiseConditionsSchema.optional(),
    requires_all_relationship_memories: CampaignRelationshipMemoryConditionsSchema.optional(),
    forbids_any_relationship_memories: CampaignRelationshipMemoryConditionsSchema.optional(),
    requires_all_wounds: CampaignWoundConditionsSchema.optional(),
    forbids_any_wounds: CampaignForbiddenWoundConditionsSchema.optional(),
  })
  .strict()
  .superRefine((conditions, ctx) => {
    if (
      conditions.requires_all_companions === undefined &&
      conditions.forbids_any_companions === undefined &&
      conditions.requires_all_promises === undefined &&
      conditions.requires_all_relationship_memories === undefined &&
      conditions.forbids_any_relationship_memories === undefined &&
      conditions.requires_all_wounds === undefined &&
      conditions.forbids_any_wounds === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Campaign character conditions require at least one predicate.",
      });
    }
    const requiredCompanions = new Set(conditions.requires_all_companions ?? []);
    conditions.forbids_any_companions?.forEach((companionId, index) => {
      if (requiredCompanions.has(companionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["forbids_any_companions", index],
          message: `Campaign character conditions cannot require and forbid companion "${companionId}".`,
        });
      }
    });
    const requiredMemories = new Set(
      (conditions.requires_all_relationship_memories ?? []).map(relationshipMemoryConditionKey),
    );
    conditions.forbids_any_relationship_memories?.forEach((memory, index) => {
      if (requiredMemories.has(relationshipMemoryConditionKey(memory))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["forbids_any_relationship_memories", index],
          message: `Campaign character conditions cannot require and forbid relationship memory ${relationshipMemoryConditionKey(memory)}.`,
        });
      }
    });
    const requiredWounds = new Set((conditions.requires_all_wounds ?? []).map(woundConditionKey));
    conditions.forbids_any_wounds?.forEach((wound, index) => {
      if (requiredWounds.has(woundConditionKey(wound))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["forbids_any_wounds", index],
          message: `Campaign character conditions cannot require and forbid wound ${woundConditionKey(wound)}.`,
        });
      }
    });
  });

export type CampaignCharacterConditions = z.infer<typeof CampaignCharacterConditionsSchema>;

/** Resolve reusable party/promise predicates against canonical campaign state. */
export function campaignCharacterMatchesConditions(
  character: CampaignCharacterState,
  input: CampaignCharacterConditions,
): boolean {
  // Optimization: Skip re-parsing Zod schema on every condition match check in hot loops.
  // The input parameter is already strongly typed as CampaignCharacterConditions.
  const conditions = input;
  const companions = new Set(character.companions);
  const promises = new Map(
    character.promises.map((promise) => [promise.promiseId, promise.status] as const),
  );
  const relationshipMemories = new Set(
    character.relationships.flatMap((relationship) =>
      relationship.memories.map((memoryId) =>
        relationshipMemoryConditionKey({
          npc_id: relationship.npcId,
          memory_id: memoryId,
        }),
      ),
    ),
  );
  const wounds = new Set(
    character.wounds.map((wound) =>
      woundConditionKey({
        wound_id: wound.woundId,
        treatment: wound.treatment,
      }),
    ),
  );
  return (
    (conditions.requires_all_companions ?? []).every((id) => companions.has(id)) &&
    !(conditions.forbids_any_companions ?? []).some((id) => companions.has(id)) &&
    (conditions.requires_all_promises ?? []).every(
      (promise) => promises.get(promise.promise_id) === promise.status,
    ) &&
    (conditions.requires_all_relationship_memories ?? []).every((memory) =>
      relationshipMemories.has(relationshipMemoryConditionKey(memory)),
    ) &&
    !(conditions.forbids_any_relationship_memories ?? []).some((memory) =>
      relationshipMemories.has(relationshipMemoryConditionKey(memory)),
    ) &&
    (conditions.requires_all_wounds ?? []).every((wound) => wounds.has(woundConditionKey(wound))) &&
    !(conditions.forbids_any_wounds ?? []).some((wound) => wounds.has(woundConditionKey(wound)))
  );
}

/** True when no canonical campaign character can satisfy both predicate groups. */
export function campaignCharacterConditionsAreMutuallyExclusive(
  left: CampaignCharacterConditions,
  right: CampaignCharacterConditions,
): boolean {
  // Optimization: Skip re-parsing Zod schema on typed condition objects in hot validation loops.
  const parsedLeft = left;
  const parsedRight = right;
  const leftRequiredCompanions = new Set(parsedLeft.requires_all_companions ?? []);
  const rightRequiredCompanions = new Set(parsedRight.requires_all_companions ?? []);
  if (
    (parsedLeft.forbids_any_companions ?? []).some((id) => rightRequiredCompanions.has(id)) ||
    (parsedRight.forbids_any_companions ?? []).some((id) => leftRequiredCompanions.has(id))
  ) {
    return true;
  }

  const leftPromises = new Map(
    (parsedLeft.requires_all_promises ?? []).map((promise) => [promise.promise_id, promise.status]),
  );
  if (
    (parsedRight.requires_all_promises ?? []).some(
      (promise) =>
        leftPromises.has(promise.promise_id) &&
        leftPromises.get(promise.promise_id) !== promise.status,
    )
  ) {
    return true;
  }

  const leftRequiredMemories = new Set(
    (parsedLeft.requires_all_relationship_memories ?? []).map(relationshipMemoryConditionKey),
  );
  const rightRequiredMemories = new Set(
    (parsedRight.requires_all_relationship_memories ?? []).map(relationshipMemoryConditionKey),
  );
  if (
    (parsedLeft.forbids_any_relationship_memories ?? []).some((memory) =>
      rightRequiredMemories.has(relationshipMemoryConditionKey(memory)),
    ) ||
    (parsedRight.forbids_any_relationship_memories ?? []).some((memory) =>
      leftRequiredMemories.has(relationshipMemoryConditionKey(memory)),
    )
  ) {
    return true;
  }

  const leftRequiredWounds = new Map(
    (parsedLeft.requires_all_wounds ?? []).map((wound) => [wound.wound_id, wound.treatment]),
  );
  const rightRequiredWounds = new Map(
    (parsedRight.requires_all_wounds ?? []).map((wound) => [wound.wound_id, wound.treatment]),
  );
  if (
    [...rightRequiredWounds].some(
      ([woundId, treatment]) =>
        leftRequiredWounds.has(woundId) && leftRequiredWounds.get(woundId) !== treatment,
    )
  ) {
    return true;
  }
  if (
    (parsedLeft.forbids_any_wounds ?? []).some(
      (wound) => rightRequiredWounds.get(wound.wound_id) === wound.treatment,
    ) ||
    (parsedRight.forbids_any_wounds ?? []).some(
      (wound) => leftRequiredWounds.get(wound.wound_id) === wound.treatment,
    )
  ) {
    return true;
  }
  return false;
}

/** Stable semantic identity used by authoring validators to reject repeated effects. */
export function campaignConsequenceEffectKey(effect: CampaignConsequenceEffect): string {
  switch (effect.type) {
    case "add_companion":
    case "remove_companion":
      return JSON.stringify([effect.type, effect.npc_id]);
    case "affirm_value":
      return JSON.stringify([effect.type, effect.value_id]);
    case "learn_knowledge":
      return JSON.stringify([effect.type, effect.knowledge_id]);
    case "raise_faction_standing":
      return JSON.stringify([effect.type, effect.faction_id]);
    case "record_promise":
    case "resolve_promise":
      return JSON.stringify([effect.type, effect.promise_id]);
    case "remember_relationship":
      return JSON.stringify([effect.type, effect.npc_id, effect.memory_id]);
    case "set_world_fact":
      return JSON.stringify([effect.type, effect.fact_id]);
    case "suffer_wound":
    case "treat_wound":
      return JSON.stringify([effect.type, effect.wound_id]);
  }
}

export const CampaignConsequenceEffectsSchema = z
  .array(CampaignConsequenceEffectSchema)
  .superRefine((effects, ctx) => {
    const seen = new Set<string>();
    effects.forEach((effect, index) => {
      const key = campaignConsequenceEffectKey(effect);
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Duplicate campaign consequence effect ${key}.`,
        });
      }
      seen.add(key);
    });
  });

export type CampaignConsequenceEffects = z.infer<typeof CampaignConsequenceEffectsSchema>;

export type CampaignConsequenceApplication = {
  characterAfter: CampaignCharacterState;
  worldFactIds: string[];
};

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Derive historical world truth from trusted outcome effect groups. Facts shared
 * by more than one outcome remain one fact; duplicates inside one authored
 * outcome are rejected as likely authoring mistakes.
 */
export function deriveCampaignWorldFactIds(
  effectGroups: readonly (readonly CampaignConsequenceEffect[])[],
): string[] {
  const facts = new Set<string>();
  for (const group of effectGroups) {
    // Optimization: Directly iterate over already-validated effect groups instead of
    // calling CampaignConsequenceEffectsSchema.parse on every derivation step in hot loops.
    for (const effect of group) {
      if (effect.type === "set_world_fact") facts.add(effect.fact_id);
    }
  }
  return [...facts].sort(compareIds);
}

function applyRelationshipMemory(
  character: CampaignCharacterState,
  effect: RememberRelationshipConsequence,
): void {
  let relationship = character.relationships.find((candidate) => candidate.npcId === effect.npc_id);
  if (!relationship) {
    relationship = {
      npcId: effect.npc_id,
      trust: 0,
      regard: 0,
      owesPlayer: 0,
      playerOwes: 0,
      memories: [],
    };
    character.relationships.push(relationship);
  }

  if (!relationship.memories.includes(effect.memory_id)) {
    relationship.memories.push(effect.memory_id);
  }
  if (effect.trust_at_least !== undefined) {
    relationship.trust = Math.max(relationship.trust, effect.trust_at_least);
  }
  if (effect.regard_at_least !== undefined) {
    relationship.regard = Math.max(relationship.regard, effect.regard_at_least);
  }
  if (effect.owes_player_at_least !== undefined) {
    relationship.owesPlayer = Math.max(relationship.owesPlayer, effect.owes_player_at_least);
  }
}

function affirmValue(character: CampaignCharacterState, effect: AffirmValueConsequence): void {
  const existing = character.values.find((value) => value.valueId === effect.value_id);
  if (existing === undefined) {
    character.values.push({
      valueId: effect.value_id,
      strength: effect.strength_at_least,
    });
    return;
  }
  existing.strength = Math.max(existing.strength, effect.strength_at_least);
}

function raiseFactionStanding(
  character: CampaignCharacterState,
  effect: RaiseFactionStandingConsequence,
): void {
  const existing = character.factionStanding.find(
    (standing) => standing.factionId === effect.faction_id,
  );
  if (existing === undefined) {
    character.factionStanding.push({
      factionId: effect.faction_id,
      standing: effect.standing_at_least,
    });
    return;
  }
  existing.standing = Math.max(existing.standing, effect.standing_at_least);
}

function recordPromise(character: CampaignCharacterState, effect: RecordPromiseConsequence): void {
  const existing = character.promises.find((promise) => promise.promiseId === effect.promise_id);
  if (existing === undefined) {
    character.promises.push({
      promiseId: effect.promise_id,
      recipientId: effect.recipient_id,
      status: "active",
    });
    return;
  }
  if (existing.recipientId !== effect.recipient_id) {
    throw new Error(
      `Promise "${effect.promise_id}" is already bound to recipient "${existing.recipientId}".`,
    );
  }
  // Exact re-application is a no-op even after a companion outcome resolved
  // the promise. Stable ids are never reused to open a second obligation.
}

function resolvePromise(
  character: CampaignCharacterState,
  effect: ResolvePromiseConsequence,
): void {
  const existing = character.promises.find((promise) => promise.promiseId === effect.promise_id);
  if (existing === undefined) {
    throw new Error(`Cannot resolve unknown promise "${effect.promise_id}".`);
  }
  if (existing.status === "active") {
    existing.status = effect.status;
    return;
  }
  if (existing.status !== effect.status) {
    throw new Error(`Promise "${effect.promise_id}" is already resolved as "${existing.status}".`);
  }
}

function sufferWound(character: CampaignCharacterState, effect: SufferWoundConsequence): void {
  const existing = character.wounds.find((wound) => wound.woundId === effect.wound_id);
  if (existing !== undefined) {
    if (existing.severity !== effect.severity || existing.treatment !== effect.treatment) {
      throw new Error(
        `Wound "${effect.wound_id}" already exists with severity ${existing.severity} and treatment "${existing.treatment}".`,
      );
    }
    // The persisted wound is the replay marker; its health cost belongs only
    // to the first application that creates it.
    return;
  }

  character.wounds.push({
    woundId: effect.wound_id,
    severity: effect.severity,
    treatment: effect.treatment,
  });
  character.health.current =
    character.health.current === 0 ? 0 : Math.max(1, character.health.current - effect.health_loss);
}

function treatWound(character: CampaignCharacterState, effect: TreatWoundConsequence): void {
  const existing = character.wounds.find((wound) => wound.woundId === effect.wound_id);
  if (existing === undefined) {
    throw new Error(`Cannot treat unknown wound "${effect.wound_id}".`);
  }
  if (existing.treatment === effect.to_treatment) {
    // The destination treatment is the replay marker. Exact re-application
    // cannot restore health a second time.
    return;
  }
  if (existing.treatment !== effect.from_treatment) {
    throw new Error(
      `Wound "${effect.wound_id}" has treatment "${existing.treatment}", not required source treatment "${effect.from_treatment}".`,
    );
  }
  existing.treatment = effect.to_treatment;
  character.health.current = Math.min(
    character.health.max,
    character.health.current + effect.health_restore,
  );
}

/**
 * Apply one trusted outcome atomically. Parsing occurs before evolution, and
 * evolution works on a detached draft, so rejection never partially commits.
 * `set_world_fact` is derived historical state; it deliberately does not grant
 * the player knowledge.
 */
export function applyCampaignConsequences(args: {
  character: CampaignCharacterState;
  effects: unknown;
}): CampaignConsequenceApplication {
  const effects = CampaignConsequenceEffectsSchema.parse(args.effects);
  const characterAfter = evolveCampaignCharacterState(args.character, (draft) => {
    for (const effect of effects) {
      switch (effect.type) {
        case "add_companion":
          if (!draft.companions.includes(effect.npc_id)) {
            draft.companions.push(effect.npc_id);
          }
          break;
        case "affirm_value":
          affirmValue(draft, effect);
          break;
        case "learn_knowledge":
          if (!draft.knowledge.includes(effect.knowledge_id)) {
            draft.knowledge.push(effect.knowledge_id);
          }
          break;
        case "raise_faction_standing":
          raiseFactionStanding(draft, effect);
          break;
        case "record_promise":
          recordPromise(draft, effect);
          break;
        case "remember_relationship":
          applyRelationshipMemory(draft, effect);
          break;
        case "remove_companion":
          draft.companions = draft.companions.filter(
            (companionId) => companionId !== effect.npc_id,
          );
          break;
        case "resolve_promise":
          resolvePromise(draft, effect);
          break;
        case "set_world_fact":
          break;
        case "suffer_wound":
          sufferWound(draft, effect);
          break;
        case "treat_wound":
          treatWound(draft, effect);
          break;
      }
    }
  });

  return {
    characterAfter,
    worldFactIds: deriveCampaignWorldFactIds([effects]),
  };
}
