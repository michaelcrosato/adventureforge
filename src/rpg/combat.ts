/**
 * Deterministic RPG combat resolution (spec §13 Stage 4, §14).
 *
 * These produce ordinary core effects from SEEDED rolls, so the engine's pure
 * reducer applies them unchanged and the determinism contract (§8.5) holds: the
 * PRNG is derived from (state.seed, state.step), and the engine advances `step`
 * after each action, so successive rounds draw independent, replayable streams.
 * No `Math.random`, no clock. A whole fight is reproducible from its trace.
 *
 * Combat is one ATTACK = one round: the player strikes; if the enemy survives it
 * strikes back. Damage = d6 + attacker.attack − defender.defense (min 1). A
 * defeated enemy fires its `on_defeat` effects; a fallen player hits `end_game`
 * on the enemy's death ending (recoverable via an earlier save, §8.7).
 */
import { rngForStep, type Rng } from "../core/rng.js";
import type { Effect } from "../core/effects.js";
import type { GameState } from "../core/state.js";
import type { Resolution } from "../core/engine.js";
import { HP_VAR, ATTACK_VAR, DEFENSE_VAR, enemyHpVar, type Enemy } from "./schema.js";

type CombatRoundModifiers = {
  attackBonus?: number;
  defenseBonus?: number;
};

/**
 * One damage roll and a LEGIBLE breakdown of how it was computed. The numeric
 * `dealt` is `max(1, roll + atk - def)` — byte-identical to the old `dmg()` — so
 * behaviour, determinism, and every trace's final hash are unchanged. The `how`
 * string mirrors the skill-check narration's transparent `d20 X + bonus = total
 * vs DC` format so a player can SEE the attack and defense at work: the same d6 roll
 * lands for less when the defender is better armoured, which is the only way the
 * player perceives that gear (e.g. the cold-iron plate's +2 defense) is doing
 * anything — a blind playtester flagged that the plate "felt invisible" because
 * the old narration showed only the final number, swamped by d6 variance
 * (bug_0131; the same is true of the barrow ward, cf. bug_0119). The `min 1`
 * floor is stated honestly when a blow is blunted to it, so the shown breakdown
 * can never silently fail to add up to the damage dealt.
 */
function rollDamage(roll: number, atk: number, def: number): { dealt: number; how: string } {
  const raw = roll + atk - def;
  const dealt = Math.max(1, raw);
  const base = `d6 ${roll} + ${atk} atk - ${def} def`;
  const how = raw < dealt ? `${base} = ${raw}, blunted to the floor of ${dealt}` : base;
  return { dealt, how };
}

/** Current HP of an enemy (its full HP until combat writes the hidden var). */
export function enemyHp(state: GameState, enemy: Enemy): number {
  return state.vars[enemyHpVar(enemy.id)] ?? enemy.hp;
}

/** Is the enemy still standing? */
export function enemyAlive(state: GameState, enemy: Enemy): boolean {
  return enemyHp(state, enemy) > 0;
}

/**
 * Resolve one combat round into concrete effects. Pure: same (state, enemy) ⇒
 * same effects, because the only randomness is the (seed, step)-derived PRNG.
 *
 * `rng` defaults to that step-keyed stream — production play passes nothing, so
 * behaviour is unchanged. The seam exists ONLY so structural verification can drive
 * a fight under chosen rolls (the exhaustive RPG ending-reachability proof steps the
 * fight under player-best and player-worst rolls to prove both combat outcomes are
 * reachable; see tests/regression/rpg_all_endings_reachable.test.ts). The two d6
 * draws below come from this one `rng` in order: player strike, then enemy reply.
 */
export function resolveAttack(
  state: GameState,
  enemy: Enemy,
  rng: Rng = rngForStep(state.seed, state.step),
  modifiers?: CombatRoundModifiers,
): Resolution {
  const hpVar = enemyHpVar(enemy.id);
  const curEnemyHp = enemyHp(state, enemy);
  const playerHp = state.vars[HP_VAR] ?? 0;
  const persistentAttack = state.vars[ATTACK_VAR] ?? 0;
  const persistentDefense = state.vars[DEFENSE_VAR] ?? 0;
  // Preserve the exact legacy ATTACK arithmetic when no temporary modifiers
  // are supplied. Maneuvers alone use clamped effective stats for this round;
  // neither path writes a persistent stat back to GameState.
  const playerAtk =
    modifiers === undefined
      ? persistentAttack
      : Math.max(0, persistentAttack + (modifiers.attackBonus ?? 0));
  const playerDef =
    modifiers === undefined
      ? persistentDefense
      : Math.max(0, persistentDefense + (modifiers.defenseBonus ?? 0));

  const strike = rollDamage(rng.int(1, 6), playerAtk, enemy.defense);
  const newEnemyHp = curEnemyHp - strike.dealt;
  const effects: Effect[] = [
    { set_var: { name: hpVar, value: Math.max(0, newEnemyHp) } },
    {
      narrate: `You strike ${enemy.name} for ${strike.dealt} (${strike.how}; it has ${Math.max(0, newEnemyHp)} HP left).`,
    },
  ];

  if (newEnemyHp <= 0) {
    effects.push({ narrate: `${enemy.name} falls.` });
    if (enemy.defeat_flag) effects.push({ set_flag: enemy.defeat_flag });
    effects.push(...enemy.on_defeat);
    return { conditions: [], effects };
  }

  // Enemy counterattacks (it drew the next value from the same stream → ordered).
  const blow = rollDamage(rng.int(1, 6), enemy.attack, playerDef);
  const newPlayerHp = playerHp - blow.dealt;
  effects.push(
    { set_var: { name: HP_VAR, value: Math.max(0, newPlayerHp) } },
    {
      narrate: `${enemy.name} hits you for ${blow.dealt} (${blow.how}; you have ${Math.max(0, newPlayerHp)} HP left).`,
    },
  );
  if (newPlayerHp <= 0) {
    effects.push({ narrate: "Your health reaches 0. You die." }, { end_game: enemy.death_ending });
  }
  return { conditions: [], effects };
}
