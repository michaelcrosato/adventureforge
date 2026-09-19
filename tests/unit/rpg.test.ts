/**
 * Stage 4 mechanic unit tests (spec §14: "Unit tests for the new mechanic").
 *
 * Covers the gated core DSL additions (set_quest_stage / quest_stage) and the
 * seeded combat + skill-check resolvers. The determinism contract is the point:
 * the same (state) always yields the same rolls, because randomness is derived
 * only from (seed, step).
 */
import { describe, it, expect } from "vitest";
import { applyEffect } from "../../src/core/effects.js";
import { makeStep } from "../../src/core/engine.js";
import { evalCondition } from "../../src/core/conditions.js";
import { initState, type GameState } from "../../src/core/state.js";
import { resolveSkillCheck } from "../../src/core/skill_check.js";
import type { Rng } from "../../src/core/rng.js";
import { resolveAttack, enemyHp, enemyAlive } from "../../src/rpg/combat.js";
import { enemyHpVar, RpgPackSchema, type Enemy } from "../../src/rpg/schema.js";
import { loadRpgSourceFile } from "../../src/rpg/source.js";
import { buildRpgRules, indexRpgPack, initStateForRpgPack } from "../../src/rpg/runner.js";
import { isObjectVisibleInRoom, indexRpgModel } from "../../src/rpg/model.js";
import type { RpgAction } from "../../src/api/types.js";

const baseState = () => ({
  ...initState({ seed: 1, start: "room" }),
  vars: { hp: 20, attack: 4, defense: 2, might: 3 },
});

const wight: Enemy = {
  id: "wight",
  name: "wight",
  description: "x",
  room: "room",
  hp: 12,
  attack: 3,
  defense: 1,
  defeat_flag: "wight_slain",
  death_ending: "ending_fallen",
  on_defeat: [{ set_flag: "spoils" }],
};

function minimalPackWithVars(varsInit: Record<string, number>) {
  return {
    meta: {
      id: "vars_fixture",
      title: "Vars Fixture",
      start_room: "room",
      vars_init: varsInit,
    },
    rooms: [{ id: "room", name: "Room", description: "A room." }],
    win_conditions: [{ id: "win", conditions: [{ has_flag: "won" }], ending: "ending_win" }],
    endings: [{ id: "ending_win", title: "Win", text: "Done." }],
  };
}

describe("gated DSL: quest stages (§13, §14)", () => {
  it("set_quest_stage writes questStage and quest_stage reads it", () => {
    const s0 = initState({ seed: 1, start: "a" });
    const { state, event } = applyEffect({ set_quest_stage: { quest: "main", stage: "act2" } }, s0);
    expect(state.questStage["main"]).toBe("act2");
    expect(event).toMatchObject({
      type: "state_change",
      effect: "set_quest_stage",
      quest: "main",
      stage: "act2",
    });
    expect(evalCondition({ quest_stage: { quest: "main", stage: "act2" } }, state)).toBe(true);
    expect(evalCondition({ quest_stage: { quest: "main", stage: "act1" } }, state)).toBe(false);
    expect(evalCondition({ quest_stage: { quest: "main", stage: "act2" } }, s0)).toBe(false);
  });

  it("does not mutate the input state (purity, §8.1)", () => {
    const s0 = initState({ seed: 1, start: "a" });
    applyEffect({ set_quest_stage: { quest: "q", stage: "s" } }, s0);
    expect(s0.questStage).toEqual({});
  });
});

describe("seeded combat (§8.5)", () => {
  it("resolveAttack is deterministic for a fixed state", () => {
    const s = baseState();
    expect(resolveAttack(s, wight)).toEqual(resolveAttack(s, wight));
  });

  it("a full fight is reproducible and ends with the wight defeated", () => {
    const fight = (): { hp: number; flags: Record<string, boolean>; rounds: number } => {
      let state: GameState = baseState();
      let rounds = 0;
      while (enemyAlive(state, wight) && (state.vars["hp"] ?? 0) > 0 && rounds < 50) {
        const res = resolveAttack(state, wight);
        for (const e of res.effects) state = applyEffect(e, state).state;
        state = { ...state, step: state.step + 1 }; // engine advances the step each round
        rounds++;
      }
      return { hp: state.vars["hp"] ?? 0, flags: state.flags, rounds };
    };
    const a = fight();
    const b = fight();
    expect(a).toEqual(b); // identical outcome — fully replayable
    expect(a.flags["wight_slain"]).toBe(true);
    expect(a.flags["spoils"]).toBe(true); // on_defeat fired
    expect(a.hp).toBeGreaterThan(0);
  });

  it("enemy HP tracking uses the hidden var", () => {
    const s = baseState();
    expect(enemyHp(s, wight)).toBe(12);
    const wounded = { ...s, vars: { ...s.vars, [enemyHpVar("wight")]: 3 } };
    expect(enemyHp(wounded, wight)).toBe(3);
    expect(enemyAlive({ ...s, vars: { ...s.vars, [enemyHpVar("wight")]: 0 } }, wight)).toBe(false);
  });
});

describe("seeded skill checks (§8.5)", () => {
  const check = {
    skill: "might",
    difficulty: 12,
    on_success: [{ set_flag: "moved" } as const],
    on_failure: [{ narrate: "nope" } as const],
  };

  it("is deterministic for a fixed state", () => {
    const s = baseState();
    expect(resolveSkillCheck(s, check)).toEqual(resolveSkillCheck(s, check));
  });

  it("a high skill makes an easy check always pass at some step", () => {
    // d20 + 3 vs 12 — at least one of several steps must succeed.
    let succeeded = false;
    for (let step = 0; step < 10; step++) {
      const s = { ...baseState(), step };
      const res = resolveSkillCheck(s, check);
      if (res.effects.some((e) => "set_flag" in e && e.set_flag === "moved")) succeeded = true;
    }
    expect(succeeded).toBe(true);
  });

  it("applies matching conditional failure consequences only after a failed roll", () => {
    const conditional = {
      ...check,
      difficulty: 20,
      on_failure_when: [
        {
          conditions: [{ has_flag: "opening_delayed" } as const],
          effects: [{ inc_var: { name: "pressure", by: 1 } } as const],
        },
      ],
    };
    const roll = (value: number): Rng => ({ next: () => 0, int: () => value });
    const delayed = {
      ...baseState(),
      flags: { opening_delayed: true },
    };

    expect(resolveSkillCheck(delayed, conditional, roll(1)).effects).toContainEqual({
      inc_var: { name: "pressure", by: 1 },
    });
    expect(resolveSkillCheck(baseState(), conditional, roll(1)).effects).not.toContainEqual({
      inc_var: { name: "pressure", by: 1 },
    });
    expect(resolveSkillCheck(delayed, conditional, roll(20)).effects).not.toContainEqual({
      inc_var: { name: "pressure", by: 1 },
    });
  });
});

describe("RPG action boundary", () => {
  it("rejects non-RPG CHOOSE actions before RPG resolution", () => {
    const loaded = loadRpgSourceFile("content/rpg/quests/sunken_barrow.yaml");
    if (!loaded.ok) throw new Error("sunken_barrow must compile");
    const index = indexRpgPack(loaded.compiled.pack);
    const rules = buildRpgRules(index);
    const state = initStateForRpgPack(index, 1);
    const legacyAction = { type: "CHOOSE", choiceId: "legacy_choice" } as unknown as RpgAction;
    const result = makeStep(rules)(state, legacyAction);
    expect(result.ok).toBe(false);
    expect(result.state).toBe(state);
  });
});

describe("RPG pack state initialization boundary", () => {
  it("rejects non-finite meta.vars_init values before engine state creation", () => {
    expect(RpgPackSchema.safeParse(minimalPackWithVars({ hp: Infinity })).success).toBe(false);
    expect(RpgPackSchema.safeParse(minimalPackWithVars({ hp: NaN })).success).toBe(false);
  });

  it("accepts finite meta.vars_init values", () => {
    const parsed = RpgPackSchema.safeParse(minimalPackWithVars({ hp: 20, attack: 4 }));

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.meta.vars_init).toEqual({ hp: 20, attack: 4 });
  });

  it("indexes RPG sources without a duplicate package-era rpgPack alias", () => {
    const parsed = RpgPackSchema.parse(minimalPackWithVars({ hp: 20, attack: 4 }));
    const index = indexRpgPack(parsed);

    expect(index.pack).toBe(parsed);
    expect("rpgPack" in index).toBe(false);
  });
});

describe("nested container visibility", () => {
  it("correctly evaluates visibility through nested containers", () => {
    const pack = {
      meta: {
        id: "nested_containers_fixture",
        title: "Nested Containers",
        start_room: "room1",
        vars_init: {},
      },
      rooms: [{ id: "room1", name: "Room 1", description: "Room 1.", objects: ["outer_box"] }],
      objects: [
        {
          id: "outer_box",
          name: "outer box",
          description: "An outer box.",
          openable: true,
          contents: ["inner_box"],
          interactions: [],
        },
        {
          id: "inner_box",
          name: "inner box",
          description: "An inner box.",
          openable: true,
          contents: ["jewel"],
          interactions: [],
        },
        {
          id: "jewel",
          name: "jewel",
          description: "A shiny jewel.",
          takeable: true,
          interactions: [],
        },
      ],
      win_conditions: [{ id: "win", conditions: [{ has_flag: "won" }], ending: "ending_win" }],
      endings: [{ id: "ending_win", title: "Win", text: "Done." }],
    };

    const parsed = RpgPackSchema.parse(pack);
    const index = indexRpgModel(parsed);
    let state = initState({ seed: 1, start: "room1" });

    // Both containers closed initially -> jewel is not visible
    expect(isObjectVisibleInRoom(index, state, "jewel", "room1")).toBe(false);

    // Open outer_box only -> inner_box visible, but jewel inside closed inner_box is not visible
    state = {
      ...state,
      objectState: { ...state.objectState, outer_box: { open: true } },
    };
    expect(isObjectVisibleInRoom(index, state, "inner_box", "room1")).toBe(true);
    expect(isObjectVisibleInRoom(index, state, "jewel", "room1")).toBe(false);

    // Open inner_box as well -> jewel is now visible
    state = {
      ...state,
      objectState: {
        ...state.objectState,
        outer_box: { open: true },
        inner_box: { open: true },
      },
    };
    expect(isObjectVisibleInRoom(index, state, "jewel", "room1")).toBe(true);
  });
});
