/**
 * Shared first-match reactive text helpers.
 *
 * Rooms, objects, dialogue nodes, scenes, and endings all use the same rule:
 * scan authored variants in order, use the first whose conditions hold, else
 * fall back to the base string. Surfaces that opt into additive fragments may
 * then append every independently matching authored note in declaration order.
 */
import { evalConditions, type Condition } from "./conditions.js";
import type { GameState } from "./state.js";

type ReactiveVariant = { when: Condition[] };
type TextVariant = ReactiveVariant & { text: string };
type NameVariant = ReactiveVariant & { name?: string | undefined };

function firstMatchingVariant<T extends ReactiveVariant>(
  variants: readonly T[] | undefined,
  state: GameState,
): T | undefined {
  for (const variant of variants ?? []) {
    if (evalConditions(variant.when, state)) return variant;
  }
  return undefined;
}

export function reactiveText(
  base: string,
  variants: readonly TextVariant[] | undefined,
  state: GameState,
): string {
  return firstMatchingVariant(variants, state)?.text ?? base;
}

/**
 * Append every matching authored fragment without turning independent facts
 * into a first-match competition. Authored whitespace is preserved; one space
 * is inserted only when neither adjoining boundary provides one.
 */
export function appendMatchingText(
  base: string,
  fragments: readonly TextVariant[] | undefined,
  state: GameState,
): string {
  let composed = base;
  for (const fragment of fragments ?? []) {
    if (!evalConditions(fragment.when, state)) continue;
    if (composed.length > 0 && !/\s$/.test(composed) && !/^\s/.test(fragment.text)) {
      composed += " ";
    }
    composed += fragment.text;
  }
  return composed;
}

export function reactiveName(
  base: string,
  variants: readonly NameVariant[] | undefined,
  state: GameState,
): string {
  for (const variant of variants ?? []) {
    if (variant.name !== undefined && evalConditions(variant.when, state)) return variant.name;
  }
  return base;
}
