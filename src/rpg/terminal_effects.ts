import type { Effect } from "../core/effects.js";

export function endGameEffects(ending: string): Effect[] {
  return [{ end_game: ending }];
}
