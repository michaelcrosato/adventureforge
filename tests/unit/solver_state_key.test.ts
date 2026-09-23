import { describe, it, expect } from "vitest";
import { evalCondition } from "../../src/core/conditions.js";
import { isLocked } from "../../src/core/object_locations.js";
import type { GameState, ObjectRuntime } from "../../src/core/state.js";
import { stateKey } from "../../src/solve/exhaustive_endings.js";

/**
 * The solver's dedupe fingerprint (`stateKey`, src/solve/exhaustive_endings.ts). Every
 * census proof BFSes a pack's reachable region deduping on it, so it must be TOTAL over
 * what the engine can read: two states it maps to one key are treated as one, and the
 * second is never explored.
 *
 * The lock was folded to a boolean (`o.locked ? 1 : 0`), mapping "no runtime entry" and
 * "explicitly unlocked during play" to the same code. The engine tells those apart twice
 * over: `is_explicitly_unlocked` holds only for an explicit `locked: false`, and `isLocked`
 * falls back to the pack's static flag only when there is no runtime entry. So a pack whose
 * route turned on an explicit unlock could have had its unlocked branch deduped away. No
 * shipped pack declares a lock, which is why no proof went red; this pins the fix.
 */

function state(objectState: Record<string, ObjectRuntime>): GameState {
  return {
    seed: 7,
    step: 12,
    current: "mill_race",
    visited: { yard: true, mill_race: true, loft: false },
    flags: { sluice_open: true, asked_pell: true, gate_jammed: false },
    vars: { score: 3, hp: 10, attack: 2 },
    inventory: ["weir_iron", "lantern"],
    objectState,
    journal: ["The race runs high."],
    questStage: { mill: "flooded", ferry: "waiting" },
    ended: false,
    endingId: null,
  };
}

const OTHERS: Record<string, ObjectRuntime> = {
  lantern: { takenBy: "player", room: "yard" },
  sluice: { open: false },
};
const untouched = state({ ...OTHERS, trapdoor: { open: true } });
const unlocked = state({ ...OTHERS, trapdoor: { open: true, locked: false } });
const locked = state({ ...OTHERS, trapdoor: { open: true, locked: true } });

describe("stateKey — lock state is the engine's tri-state, not a boolean", () => {
  it("states differing only in an explicit unlock get different keys", () => {
    expect(stateKey(unlocked)).not.toBe(stateKey(untouched));
    expect(stateKey(unlocked)).not.toBe(stateKey(locked));
    expect(stateKey(untouched)).not.toBe(stateKey(locked));
  });

  it("the three states really are distinguishable by the engine (non-vacuity)", () => {
    const explicitlyUnlocked = { is_explicitly_unlocked: "trapdoor" };
    expect(evalCondition(explicitlyUnlocked, unlocked)).toBe(true);
    expect(evalCondition(explicitlyUnlocked, untouched)).toBe(false);
    // With a statically locked trapdoor, "no entry" reads as locked and "explicitly
    // unlocked" as open to the UNLOCK verb — the other reader the old key conflated.
    const index = {
      objects: new Map([["trapdoor", { locked: true }]]),
      homeRoom: new Map<string, string>(),
      containerOf: new Map<string, string>(),
    };
    expect(isLocked(index, untouched, "trapdoor")).toBe(true);
    expect(isLocked(index, unlocked, "trapdoor")).toBe(false);
    expect(isLocked(index, locked, "trapdoor")).toBe(true);
  });

  it("a state with no explicit unlock keeps its historical key byte-for-byte", () => {
    // Frozen from the pre-change implementation: lock-free states (every shipped pack's)
    // must fingerprint exactly as before, so the proofs' state counts cannot move.
    expect(stateKey(untouched)).toBe(
      "mill_race|mill_race,yard|asked_pell,sluice_open|lantern,weir_iron|attack=2,hp=10,score=3|" +
        "lantern:00:player:yard;sluice:00::;trapdoor:10::|ferry=waiting,mill=flooded|",
    );
    expect(stateKey(locked)).toContain("trapdoor:11::");
    expect(stateKey({ ...untouched, ended: true, endingId: "saved_mill" })).toMatch(
      /\|Esaved_mill$/,
    );
  });

  it("step and journal stay out of the key (they would defeat dedupe)", () => {
    expect(stateKey({ ...untouched, step: 99, journal: [] })).toBe(stateKey(untouched));
  });
});
