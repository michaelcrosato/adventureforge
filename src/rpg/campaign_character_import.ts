import { z } from "zod";
import {
  CAMPAIGN_IMPORT_RECEIPT_VERSION,
  CampaignImportReceiptSchema,
  cloneCampaignImportReceipt,
  type CampaignImportReceipt,
  type CampaignImportReceiptEffect,
} from "../core/campaign_import_receipt.js";
import { hashState } from "../core/hash.js";
import { cloneGameState, type GameState } from "../core/state.js";
import {
  CAMPAIGN_CHARACTER_MAX_EQUIPMENT_CONDITION,
  CAMPAIGN_CHARACTER_MAX_EQUIPMENT_QUANTITY,
  CAMPAIGN_CHARACTER_MAX_HEALTH,
  CAMPAIGN_CHARACTER_MAX_RANK,
  CampaignCharacterIdSchema,
  parseCampaignCharacterState,
  type CampaignCharacterState,
} from "../world/campaign_character_state.js";
import { HP_VAR, SCORE_VAR, type RpgPack } from "./schema.js";

const CAMPAIGN_CHARACTER_IMPORTS_VERSION = 1 as const;

const RuleId = CampaignCharacterIdSchema;

const HealthCurrentToVarRuleSchema = z
  .object({
    id: RuleId,
    type: z.literal("health_current_to_var"),
    target_var: z.string().min(1),
  })
  .strict();
const SkillRankToVarRuleSchema = z
  .object({
    id: RuleId,
    type: z.literal("skill_rank_to_var"),
    skill_id: CampaignCharacterIdSchema,
    target_var: z.string().min(1),
  })
  .strict();
const BackgroundToFlagRuleSchema = z
  .object({
    id: RuleId,
    type: z.literal("background_to_flag"),
    background_id: CampaignCharacterIdSchema,
    target_flag: z.string().min(1),
  })
  .strict();
const AbilityToFlagRuleSchema = z
  .object({
    id: RuleId,
    type: z.literal("ability_to_flag"),
    ability_id: CampaignCharacterIdSchema,
    target_flag: z.string().min(1),
  })
  .strict();
const KnowledgeToFlagRuleSchema = z
  .object({
    id: RuleId,
    type: z.literal("knowledge_to_flag"),
    knowledge_id: CampaignCharacterIdSchema,
    target_flag: z.string().min(1),
  })
  .strict();
const CompanionToFlagRuleSchema = z
  .object({
    id: RuleId,
    type: z.literal("companion_to_flag"),
    companion_id: CampaignCharacterIdSchema,
    target_flag: z.string().min(1),
  })
  .strict();
const EquipmentToItemRuleSchema = z
  .object({
    id: RuleId,
    type: z.literal("equipment_to_item"),
    item_id: CampaignCharacterIdSchema,
    target_object: z.string().min(1),
    equipped: z.boolean().optional(),
    condition_at_least: z
      .number()
      .int()
      .min(0)
      .max(CAMPAIGN_CHARACTER_MAX_EQUIPMENT_CONDITION)
      .optional(),
    quantity_at_least: z
      .number()
      .int()
      .min(1)
      .max(CAMPAIGN_CHARACTER_MAX_EQUIPMENT_QUANTITY)
      .optional(),
  })
  .strict();

export const CampaignCharacterImportRuleSchema = z.discriminatedUnion("type", [
  HealthCurrentToVarRuleSchema,
  SkillRankToVarRuleSchema,
  BackgroundToFlagRuleSchema,
  AbilityToFlagRuleSchema,
  KnowledgeToFlagRuleSchema,
  CompanionToFlagRuleSchema,
  EquipmentToItemRuleSchema,
]);

export type CampaignCharacterImportRule = z.infer<typeof CampaignCharacterImportRuleSchema>;

function ruleWriter(rule: CampaignCharacterImportRule): string {
  if (rule.type === "health_current_to_var" || rule.type === "skill_rank_to_var") {
    return `var:${rule.target_var}`;
  }
  if (rule.type === "equipment_to_item") return `item:${rule.target_object}`;
  return `flag:${rule.target_flag}`;
}

export const CampaignCharacterImportsSchema = z
  .object({
    version: z.literal(CAMPAIGN_CHARACTER_IMPORTS_VERSION),
    rules: z.array(CampaignCharacterImportRuleSchema).min(1),
  })
  .strict()
  .superRefine((imports, ctx) => {
    const ids = new Set<string>();
    const writers = new Map<string, string>();
    imports.rules.forEach((rule, index) => {
      if (ids.has(rule.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", index, "id"],
          message: `Duplicate campaign import rule id "${rule.id}".`,
        });
      }
      ids.add(rule.id);
      const target = ruleWriter(rule);
      const previous = writers.get(target);
      if (previous !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", index],
          message: `Campaign import rules "${previous}" and "${rule.id}" both write "${target}".`,
        });
      } else {
        writers.set(target, rule.id);
      }
    });
  });

export type CampaignCharacterImports = z.infer<typeof CampaignCharacterImportsSchema>;

type CampaignCharacterImportVarRange = Readonly<{
  min: number;
  max: number;
}>;

type CampaignCharacterImportPlayerStateContract = Readonly<{
  settableFlagIds: readonly string[];
  obtainableObjectIds: readonly string[];
  initialVarRanges: ReadonlyMap<string, CampaignCharacterImportVarRange>;
}>;

/**
 * Describe exactly which fresh quest-state fields the declared campaign import
 * boundary may change. Numeric bounds come from the persisted player schema,
 * while an absent matching skill still leaves the pack's authored default in
 * play; the validator merges these ranges with that default.
 */
export function campaignCharacterImportPlayerStateContract(
  imports: CampaignCharacterImports | undefined,
): CampaignCharacterImportPlayerStateContract {
  const settableFlagIds: string[] = [];
  const obtainableObjectIds: string[] = [];
  const initialVarRanges = new Map<string, CampaignCharacterImportVarRange>();
  for (const rule of imports?.rules ?? []) {
    if (rule.type === "health_current_to_var") {
      initialVarRanges.set(rule.target_var, { min: 0, max: CAMPAIGN_CHARACTER_MAX_HEALTH });
    } else if (rule.type === "skill_rank_to_var") {
      initialVarRanges.set(rule.target_var, { min: 1, max: CAMPAIGN_CHARACTER_MAX_RANK });
    } else if (rule.type === "equipment_to_item") {
      obtainableObjectIds.push(rule.target_object);
    } else {
      settableFlagIds.push(rule.target_flag);
    }
  }
  settableFlagIds.sort();
  obtainableObjectIds.sort();
  return { initialVarRanges, obtainableObjectIds, settableFlagIds };
}

export class CampaignImportReceiptCatalogError extends Error {
  constructor(message: string) {
    super(`Campaign import receipt does not match the current catalog: ${message}`);
    this.name = "CampaignImportReceiptCatalogError";
  }
}

export type CampaignCharacterImportInput = {
  character: CampaignCharacterState;
  imports: CampaignCharacterImports;
};

type CampaignCharacterImportTargetIssueCode =
  | "UNKNOWN_VAR"
  | "INVALID_HEALTH_TARGET"
  | "INVALID_SKILL_TARGET"
  | "IMMUTABLE_SEEDED_OPENING_FLAG"
  | "UNKNOWN_FLAG"
  | "UNKNOWN_OBJECT"
  | "INVALID_INVENTORY_TARGET";

type CampaignCharacterImportTargetIssue = {
  code: CampaignCharacterImportTargetIssueCode;
  ruleId: string;
  path: (string | number)[];
  message: string;
};

export class CampaignCharacterImportTargetError extends Error {
  readonly issues: CampaignCharacterImportTargetIssue[];

  constructor(issues: CampaignCharacterImportTargetIssue[]) {
    super(issues.map((issue) => issue.message).join(" "));
    this.name = "CampaignCharacterImportTargetError";
    this.issues = issues.map((issue) => ({ ...issue, path: [...issue.path] }));
  }
}

function collectStringTargets(node: unknown, keys: ReadonlySet<string>, acc: Set<string>): void {
  if (Array.isArray(node)) {
    for (const value of node) collectStringTargets(value, keys, acc);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (keys.has(key) && typeof value === "string") acc.add(value);
    collectStringTargets(value, keys, acc);
  }
}

function authoredFlags(pack: RpgPack): Set<string> {
  const flags = new Set([...pack.meta.flags_init, ...(pack.meta.seeded_opening_flags ?? [])]);
  collectStringTargets(
    pack,
    new Set(["has_flag", "not_flag", "set_flag", "clear_flag", "defeat_flag", "result_flag"]),
    flags,
  );
  return flags;
}

function authoredInventoryTargets(pack: RpgPack): Set<string> {
  const targets = new Set(
    pack.objects.filter((object) => object.takeable || object.held).map((object) => object.id),
  );
  collectStringTargets(pack, new Set(["add_item"]), targets);
  return targets;
}

type ImportTarget = CampaignCharacterImportRule | CampaignImportReceiptEffect;

function targetRuleId(target: ImportTarget): string {
  return "id" in target ? target.id : target.rule_id;
}

function targetIssues(
  pack: RpgPack,
  targets: readonly ImportTarget[],
): CampaignCharacterImportTargetIssue[] {
  const issues: CampaignCharacterImportTargetIssue[] = [];
  const vars = new Set(Object.keys(pack.meta.vars_init));
  const flags = authoredFlags(pack);
  const seededOpeningFlags = new Set(pack.meta.seeded_opening_flags ?? []);
  const objects = new Set(pack.objects.map((object) => object.id));
  const inventoryTargets = authoredInventoryTargets(pack);

  targets.forEach((target, index) => {
    const ruleId = targetRuleId(target);
    const path = ["rules", index] as (string | number)[];
    if (target.type === "health_current_to_var") {
      if (target.target_var !== HP_VAR) {
        issues.push({
          code: "INVALID_HEALTH_TARGET",
          ruleId,
          path: [...path, "target_var"],
          message: `Campaign import rule "${ruleId}" must target the player hp var "${HP_VAR}".`,
        });
      } else if (!vars.has(target.target_var)) {
        issues.push({
          code: "UNKNOWN_VAR",
          ruleId,
          path: [...path, "target_var"],
          message: `Campaign import rule "${ruleId}" targets undeclared var "${target.target_var}".`,
        });
      }
    } else if (target.type === "skill_rank_to_var") {
      if (target.target_var === HP_VAR || target.target_var === SCORE_VAR) {
        issues.push({
          code: "INVALID_SKILL_TARGET",
          ruleId,
          path: [...path, "target_var"],
          message: `Campaign import rule "${ruleId}" cannot floor reserved var "${target.target_var}".`,
        });
      } else if (!vars.has(target.target_var)) {
        issues.push({
          code: "UNKNOWN_VAR",
          ruleId,
          path: [...path, "target_var"],
          message: `Campaign import rule "${ruleId}" targets undeclared var "${target.target_var}".`,
        });
      }
    } else if (target.type === "equipment_to_item") {
      if (!objects.has(target.target_object)) {
        issues.push({
          code: "UNKNOWN_OBJECT",
          ruleId,
          path: [...path, "target_object"],
          message: `Campaign import rule "${ruleId}" targets unknown object "${target.target_object}".`,
        });
      } else if (!inventoryTargets.has(target.target_object)) {
        issues.push({
          code: "INVALID_INVENTORY_TARGET",
          ruleId,
          path: [...path, "target_object"],
          message: `Campaign import rule "${ruleId}" targets object "${target.target_object}", which cannot legitimately enter inventory.`,
        });
      }
    } else if (seededOpeningFlags.has(target.target_flag)) {
      issues.push({
        code: "IMMUTABLE_SEEDED_OPENING_FLAG",
        ruleId,
        path: [...path, "target_flag"],
        message: `Campaign import rule "${ruleId}" cannot target immutable seeded opening flag "${target.target_flag}".`,
      });
    } else if (!flags.has(target.target_flag)) {
      issues.push({
        code: "UNKNOWN_FLAG",
        ruleId,
        path: [...path, "target_flag"],
        message: `Campaign import rule "${ruleId}" targets unknown authored flag "${target.target_flag}".`,
      });
    }
  });
  return issues;
}

export function campaignCharacterImportTargetIssues(
  pack: RpgPack,
  imports: CampaignCharacterImports,
): CampaignCharacterImportTargetIssue[] {
  const parsed = CampaignCharacterImportsSchema.parse(imports);
  return targetIssues(pack, parsed.rules);
}

export function validateCampaignCharacterImportTargets(
  pack: RpgPack,
  imports: CampaignCharacterImports,
): CampaignCharacterImports {
  const parsed = CampaignCharacterImportsSchema.parse(imports);
  const issues = targetIssues(pack, parsed.rules);
  if (issues.length > 0) throw new CampaignCharacterImportTargetError(issues);
  return parsed;
}

export function campaignImportReceiptTargetIssues(
  pack: RpgPack,
  receipt: CampaignImportReceipt,
): CampaignCharacterImportTargetIssue[] {
  const parsed = CampaignImportReceiptSchema.parse(receipt);
  return targetIssues(pack, parsed.effects);
}

function receiptEffectTargetMatchesRule(
  effect: CampaignImportReceiptEffect,
  rule: CampaignCharacterImportRule,
): boolean {
  if (effect.type !== rule.type) return false;
  if (effect.type === "health_current_to_var" || effect.type === "skill_rank_to_var") {
    return rule.type === effect.type && effect.target_var === rule.target_var;
  }
  if (effect.type === "equipment_to_item") {
    return rule.type === effect.type && effect.target_object === rule.target_object;
  }
  return rule.type === effect.type && effect.target_flag === rule.target_flag;
}

/**
 * Bind a persisted import receipt to the exact import catalog trusted by the
 * current quest. A missing receipt is valid for legacy, direct, and no-op
 * starts. Like the rest of SaveIntegrityError's structural/referential checks,
 * this is catalog compatibility—not cryptographic authentication of an
 * intentionally user-editable local save. `character_hash` remains a
 * deterministic creation-time audit commitment; detached loads do not carry
 * the parent campaign character needed to recompute it.
 */
export function assertCampaignImportReceiptMatchesCatalog(
  receiptInput: CampaignImportReceipt | undefined,
  importsInput: CampaignCharacterImports | undefined,
): void {
  if (receiptInput === undefined) return;

  // Parse first so canonical ordering, one-to-one effects, and all other
  // receipt invariants are enforced even when the catalog is unavailable.
  const receipt = CampaignImportReceiptSchema.parse(receiptInput);
  if (importsInput === undefined) {
    throw new CampaignImportReceiptCatalogError("the current quest has no import catalog.");
  }
  const imports = CampaignCharacterImportsSchema.parse(importsInput);
  const currentCatalogHash = hashState(imports);
  if (receipt.catalog_hash !== currentCatalogHash) {
    throw new CampaignImportReceiptCatalogError(
      `catalog hash ${receipt.catalog_hash} is stale; expected ${currentCatalogHash}.`,
    );
  }

  const rulesById = new Map(imports.rules.map((rule) => [rule.id, rule]));
  for (const effect of receipt.effects) {
    const rule = rulesById.get(effect.rule_id);
    if (rule === undefined) {
      throw new CampaignImportReceiptCatalogError(
        `applied rule "${effect.rule_id}" is not present.`,
      );
    }
    if (effect.type !== rule.type) {
      throw new CampaignImportReceiptCatalogError(
        `applied rule "${effect.rule_id}" has effect type "${effect.type}"; expected "${rule.type}".`,
      );
    }
    if (!receiptEffectTargetMatchesRule(effect, rule)) {
      throw new CampaignImportReceiptCatalogError(
        `applied rule "${effect.rule_id}" targets a different quest-state field.`,
      );
    }
  }
}

function plannedEffect(
  rule: CampaignCharacterImportRule,
  state: GameState,
  character: CampaignCharacterState,
): CampaignImportReceiptEffect | null {
  if (rule.type === "health_current_to_var") {
    return state.vars[rule.target_var] === character.health.current
      ? null
      : {
          rule_id: rule.id,
          type: rule.type,
          target_var: rule.target_var,
          value: character.health.current,
        };
  }
  if (rule.type === "skill_rank_to_var") {
    const skill = character.skills.find((entry) => entry.skillId === rule.skill_id);
    const current = state.vars[rule.target_var];
    return skill !== undefined && current !== undefined && skill.rank > current
      ? {
          rule_id: rule.id,
          type: rule.type,
          target_var: rule.target_var,
          value: skill.rank,
        }
      : null;
  }
  if (rule.type === "background_to_flag") {
    return character.background === rule.background_id && state.flags[rule.target_flag] !== true
      ? { rule_id: rule.id, type: rule.type, target_flag: rule.target_flag, value: true }
      : null;
  }
  if (rule.type === "ability_to_flag") {
    return character.abilities.includes(rule.ability_id) && state.flags[rule.target_flag] !== true
      ? { rule_id: rule.id, type: rule.type, target_flag: rule.target_flag, value: true }
      : null;
  }
  if (rule.type === "knowledge_to_flag") {
    return character.knowledge.includes(rule.knowledge_id) && state.flags[rule.target_flag] !== true
      ? { rule_id: rule.id, type: rule.type, target_flag: rule.target_flag, value: true }
      : null;
  }
  if (rule.type === "companion_to_flag") {
    return character.companions.includes(rule.companion_id) &&
      state.flags[rule.target_flag] !== true
      ? { rule_id: rule.id, type: rule.type, target_flag: rule.target_flag, value: true }
      : null;
  }
  const matches = character.equipment.some(
    (equipment) =>
      equipment.itemId === rule.item_id &&
      (rule.equipped === undefined || equipment.equipped === rule.equipped) &&
      equipment.condition >= (rule.condition_at_least ?? 0) &&
      equipment.quantity >= (rule.quantity_at_least ?? 1),
  );
  return matches && !state.inventory.includes(rule.target_object)
    ? { rule_id: rule.id, type: rule.type, target_object: rule.target_object }
    : null;
}

type CampaignCharacterImportProjection = {
  state: GameState;
  receipt: CampaignImportReceipt | null;
};

/** Apply trusted persistent state to a fresh RPG state without leaking persistent item ids. */
export function projectCampaignCharacterImports(
  pack: RpgPack,
  baseState: GameState,
  characterInput: CampaignCharacterState,
  importsInput: CampaignCharacterImports,
): CampaignCharacterImportProjection {
  if (baseState.campaignImportReceipt !== undefined) {
    throw new Error("Campaign character imports require a fresh state without an import receipt.");
  }
  const character = parseCampaignCharacterState(characterInput);
  const imports = validateCampaignCharacterImportTargets(pack, importsInput);
  if (character.health.current <= 0) {
    throw new Error("Cannot start an active RPG from campaign character health 0.");
  }
  const effects = imports.rules
    .map((rule) => plannedEffect(rule, baseState, character))
    .filter((effect): effect is CampaignImportReceiptEffect => effect !== null)
    .sort((left, right) =>
      left.rule_id < right.rule_id ? -1 : left.rule_id > right.rule_id ? 1 : 0,
    );
  if (effects.length === 0) return { state: baseState, receipt: null };

  const receipt = CampaignImportReceiptSchema.parse({
    version: CAMPAIGN_IMPORT_RECEIPT_VERSION,
    catalog_hash: hashState(imports),
    character_hash: hashState(character),
    applied_rules: effects.map((effect) => effect.rule_id),
    effects,
  });
  const state = cloneGameState(baseState);
  for (const effect of effects) {
    if (effect.type === "health_current_to_var" || effect.type === "skill_rank_to_var") {
      state.vars[effect.target_var] = effect.value;
    } else if (effect.type === "equipment_to_item") {
      state.inventory.push(effect.target_object);
    } else {
      state.flags[effect.target_flag] = true;
    }
  }
  state.campaignImportReceipt = cloneCampaignImportReceipt(receipt);
  return { state, receipt: cloneCampaignImportReceipt(receipt) };
}
