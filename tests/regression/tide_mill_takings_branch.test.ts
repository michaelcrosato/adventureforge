/**
 * Tide-Mill replay-pressure branch: the takings are no longer a single hard
 * early ending. Once the sea-gate is up, a player can pocket them, return
 * them, save the boat while keeping them, or deliberately walk off with them.
 * The clean route remains the only 55/55 route.
 */
import { describe, it, expect } from "vitest";
import { loadRpgSourceFile } from "../../src/rpg/source.js";
import {
  indexRpgPack,
  buildRpgRules,
  initStateForRpgPack,
  enumerateRpgActions,
} from "../../src/rpg/runner.js";
import { buildRpgObservation } from "../../src/rpg/observation.js";
import { activeDialogue } from "../../src/rpg/model.js";
import { load, save } from "../../src/persist/save_load.js";
import { makeStep } from "../../src/core/engine.js";
import type { Rng } from "../../src/core/rng.js";
import type { GameState } from "../../src/core/state.js";

const loaded = loadRpgSourceFile("content/rpg/quests/tide_mill.yaml");
if (!loaded.ok) throw new Error("tide_mill must compile");
const index = indexRpgPack(loaded.compiled.pack);

const bestRng = (): Rng => ({ next: () => 0.99, int: (_min, max) => max });
const step = makeStep(buildRpgRules(index, () => bestRng()));

const options = (state: GameState) => enumerateRpgActions(index, state);
const score = (state: GameState) => buildRpgObservation(index, state).score;
const endingText = (state: GameState) => buildRpgObservation(index, state).description;

function act(state: GameState, id: string): GameState {
  const option = options(state).find((candidate) => candidate.id === id);
  if (!option) {
    throw new Error(
      `Missing ${id}; legal=[${options(state)
        .map((candidate) => `${candidate.id}:${candidate.command}`)
        .join(", ")}] in ${state.current}`,
    );
  }
  const result = step(state, option.action);
  expect(result.ok).toBe(true);
  return result.state;
}

function fightUntilYardClear(state: GameState): GameState {
  let next = state;
  for (
    let i = 0;
    i < 10 && options(next).some((option) => option.id === "attack_mill_saboteur");
    i++
  ) {
    next = act(next, "attack_mill_saboteur");
  }
  expect(next.flags["yard_clear"]).toBe(true);
  return next;
}

function raiseGateFromMillHouse(state: GameState): GameState {
  let next = state;
  for (const id of [
    "read_millboard",
    "take_gaff_hook",
    "go_east",
    "take_oilskin_coat",
    "go_west",
    "go_north",
    "take_crank_handle",
    "go_east",
  ]) {
    next = act(next, id);
  }

  next = fightUntilYardClear(next);

  for (const id of [
    "go_east",
    "take_billhook",
    "take_crow_bar",
    "go_west",
    "go_west",
    "go_west",
    "use_billhook_on_choked_sluice",
    "go_east",
    "use_crow_bar_on_brake_pawl",
    "use_crank_handle_on_sea_winch",
  ]) {
    next = act(next, id);
  }

  expect(next.flags["gate_up"]).toBe(true);
  expect(next.current).toBe("wheel_room");
  expect(next.ended).toBe(false);
  return next;
}

function rescueFromMillHouse(state: GameState): GameState {
  const next = act(raiseGateFromMillHouse(state), "go_down");
  expect(next.ended).toBe(true);
  return next;
}

function fresh(): GameState {
  return initStateForRpgPack(index, 151);
}

describe("Tide-Mill takings replay branch", () => {
  it("keeps the untouched rescue as the only clean full-score ending", () => {
    const state = rescueFromMillHouse(fresh());

    expect(state.endingId).toBe("ending_saved");
    expect(score(state)).toBe(55);
    expect(endingText(state)).toMatch(/coin-bag remains on the desk/i);
  });

  it("lets the player pocket then return the takings for a lower-score rescue", () => {
    let state = act(fresh(), "go_east");
    expect(options(state).map((option) => option.id)).not.toContain("take_coin_bag");
    expect(options(state).map((option) => option.id)).not.toContain("use_coin_bag");

    state = raiseGateFromMillHouse(fresh());
    state = act(state, "go_south");
    state = act(state, "go_east");

    expect(options(state).find((option) => option.id === "use_coin_bag")?.command).toMatch(
      /pocket .*coin-bag/i,
    );
    state = act(state, "use_coin_bag");
    expect(options(state).map((option) => option.id)).not.toContain("drop_coin_bag");
    expect(options(state).find((option) => option.id === "use_coin_bag")?.command).toMatch(
      /return .*coin-bag/i,
    );

    state = act(state, "use_coin_bag");
    expect(state.inventory).not.toContain("coin_bag");
    expect(state.flags["coin_bag_returned"]).toBe(true);

    state = act(state, "go_west");
    state = act(state, "go_north");
    state = act(state, "go_down");

    expect(state.endingId).toBe("ending_saved_returned_takings");
    expect(score(state)).toBe(50);
    expect(endingText(state)).toMatch(/returned Miller Ives's coin-bag/i);
  });

  it("lets the player save the boat while keeping the takings, but not at full score", () => {
    let state = raiseGateFromMillHouse(fresh());
    state = act(state, "go_south");
    state = act(state, "go_east");
    state = act(state, "use_coin_bag");
    state = act(state, "go_west");

    expect(options(state).find((option) => option.id === "use_coin_bag")?.command).toMatch(
      /steal .*coin-bag/i,
    );
    expect(options(state).map((option) => option.id)).not.toContain("drop_coin_bag");

    state = act(state, "go_north");
    state = act(state, "go_down");

    expect(state.endingId).toBe("ending_saved_with_takings");
    expect(state.inventory).toContain("coin_bag");
    expect(score(state)).toBe(50);
    expect(endingText(state)).toMatch(/keeping Miller Ives's coin-bag/i);
  });

  it("still allows a deliberate walk-off-with-the-money thief ending", () => {
    let state = raiseGateFromMillHouse(fresh());
    state = act(state, "go_south");
    state = act(state, "go_east");
    state = act(state, "use_coin_bag");
    state = act(state, "go_west");
    state = act(state, "use_coin_bag");

    expect(state.ended).toBe(true);
    expect(state.endingId).toBe("ending_thief");
    expect(endingText(state)).toMatch(/without reaching the Staith/i);
  });

  // bug_0640: STEAL's only effect is end_game, and applyEffects stops there, so the
  // dialogue close composed after it never landed. The thief ending kept Ives's
  // exchange live in its observation and through a save/load round trip.
  it("closes Ives's exchange when the thief ending fires mid-conversation", () => {
    let state = raiseGateFromMillHouse(fresh());
    state = act(state, "go_south");
    state = act(state, "go_east");
    state = act(state, "use_coin_bag");
    state = act(state, "go_west");
    state = act(state, "talk_ives");
    expect(activeDialogue(index, state)?.npc.id).toBe("ives");
    state = act(state, "use_coin_bag");

    expect(state.ended).toBe(true);
    expect(state.endingId).toBe("ending_thief");
    expect(state.vars["__dlg_ives"]).toBe(0);
    expect(activeDialogue(index, state)).toBeNull();
    expect(buildRpgObservation(index, state).dialogue).toBeNull();

    const restored = load(
      save(state, loaded.compiled.contentHash, "rpg", { worldQuestId: "tide_mill" }),
    ).state;
    expect(restored.vars["__dlg_ives"]).toBe(0);
    expect(activeDialogue(index, restored)).toBeNull();
    expect(buildRpgObservation(index, restored).dialogue).toBeNull();
  });
});
