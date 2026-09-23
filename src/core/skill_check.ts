/**
 * Shared deterministic skill checks.
 *
 * Skill checks are core gameplay, not parser or RPG plumbing: any runtime can
 * roll d20 + a named state var and route through ordinary core effects.
 */
import { z } from "zod";
import { ConditionSchema, evalConditions } from "./conditions.js";
import { EffectSchema, type Effect } from "./effects.js";
import { rngForStep, type Rng } from "./rng.js";
import { readVar, type GameState } from "./state.js";
import type { Resolution } from "./engine.js";

const ConditionalSkillCheckEffectsSchema = z
  .object({
    conditions: z.array(ConditionSchema).min(1),
    effects: z.array(EffectSchema).min(1),
  })
  .strict();

/** Public, player-facing consequence prose carried with a checked action. */
export const SKILL_CHECK_STAKES_CHAR_LIMIT = 240;

export const SkillCheckSchema = z
  .object({
    skill: z.string().min(1),
    difficulty: z.number().int(),
    stakes: z.string().trim().min(1).max(SKILL_CHECK_STAKES_CHAR_LIMIT).optional(),
    on_success: z.array(EffectSchema).default([]),
    on_failure: z.array(EffectSchema).default([]),
    on_failure_when: z.array(ConditionalSkillCheckEffectsSchema).min(1).optional(),
  })
  .strict();

type SkillCheck = z.infer<typeof SkillCheckSchema>;

/**
 * Resolve a skill check: roll d20 + the named skill var against `difficulty`.
 * Deterministic per (seed, step). Returns the success or failure effects, with a
 * narration of the roll so the player understands the outcome.
 */
export function resolveSkillCheck(
  state: GameState,
  check: SkillCheck,
  rng: Rng = rngForStep(state.seed, state.step),
): Resolution {
  const roll = rng.int(1, 20);
  // Read the modifier ONCE, through the own-property-checked accessor: `check.skill`
  // is an authored name, and a plain `state.vars[name] ?? 0` resolves the inherited
  // Object.prototype accessor for a skill literally named `__proto__` — which would
  // make `total` the STRING "3[object Object]", compare it against the difficulty,
  // and print it to the player (see readVar in core/state.ts).
  const modifier = readVar(state.vars, check.skill);
  const total = roll + modifier;
  const success = total >= check.difficulty;
  const lead: Effect = {
    narrate: `${check.skill} check: d20 ${roll} + ${modifier} = ${total} vs ${check.difficulty} — ${success ? "success" : "failure"}.`,
  };
  const conditionalFailureEffects = success
    ? []
    : (check.on_failure_when ?? []).flatMap((branch) =>
        evalConditions(branch.conditions, state) ? branch.effects : [],
      );
  return {
    conditions: [],
    effects: [
      lead,
      ...(success ? check.on_success : check.on_failure),
      ...conditionalFailureEffects,
    ],
  };
}
