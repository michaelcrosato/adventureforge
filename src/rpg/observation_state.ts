import type { GameState } from "../core/state.js";

type PublicVarsOptions = {
  hideInternal?: boolean;
};

type PublicInventoryOptions = {
  sort?: boolean;
};

export function publicFlags(state: GameState): string[] {
  return Object.keys(state.flags)
    .filter((flag) => state.flags[flag] === true && !flag.startsWith("__"))
    .sort();
}

export function publicVars(
  state: GameState,
  { hideInternal = true }: PublicVarsOptions = {},
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(state.vars).sort()) {
    if (hideInternal && key.startsWith("__")) continue;
    out[key] = state.vars[key] as number;
  }
  return out;
}

export function publicInventory(
  state: GameState,
  { sort = false }: PublicInventoryOptions = {},
): string[] {
  const inventory = [...state.inventory];
  return sort ? inventory.sort() : inventory;
}

export function publicJournal(state: GameState): string[] {
  return [...state.journal];
}
