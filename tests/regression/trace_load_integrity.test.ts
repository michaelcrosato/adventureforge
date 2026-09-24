/**
 * Trace-load integrity gate — the REJECTION-DIRECTION oracle for the trace
 * boundary (bug_0190), extending the §16 load-integrity arc (bug_0181–0184) from
 * the SAVE load to the TRACE load.
 *
 * `replay_trace` / `inspect_trace` each `JSON.parse(readFileSync(trace_path))` an
 * UNTRUSTED on-disk trace and feed `trace.initial_state` straight into the engine
 * (replay.ts:45 runActions; inspect's own per-step loop + diagnose). The
 * content-hash check on each handler guards WHICH source the trace was recorded
 * against — NOT WHETHER the state is well-formed — so a forged trace carrying the
 * CORRECT content_hash and a poisoned `initial_state` previously sailed past it.
 * `Trace.initial_state` is a bare `GameState` with no Zod schema, so the same
 * three sub-holes the save arc named were reachable: (a) finiteness (1e999 ->
 * Infinity -> always-true var_gte, conditions.ts:75), (b/c) referential (a phantom
 * `current` / `endingId` renders the game from a symbol the pack never declares).
 *
 * This is the SoundnessBench (arXiv:2412.03154) rejection oracle: a checker is
 * credibly sound only if it rejects instances that are known-bad BY CONSTRUCTION.
 * Each WITNESS forges ONE invalid condition in a CLEAN recorded trace and asserts BOTH
 * `replay_trace` AND `inspect_trace` throw `SaveIntegrityError`. The GREEN
 * false-rejection guards prove a legitimate fresh-init trace — and a legitimately
 * mid-game RPG trace — still replays + inspects unchanged, so the gate never
 * false-rejects a state a real recording could carry.
 *
 * GENUINE-WITNESS NOTE: with the two-line gate reverted in BOTH tools.ts handlers,
 * the poisoned state reaches the engine and replay/inspect return WITHOUT throwing,
 * so every WITNESS case below FAILS pre-change (verified by reverting the gate).
 * These are not vacuous greens.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createToolApi } from "../../src/mcp/tools.js";
import { loadRpgSourceFile } from "../../src/rpg/source.js";
import { indexRpgPack, buildRpgRules, initStateForRpgPack } from "../../src/rpg/runner.js";
import { recordTrace, runActions, type Trace } from "../../src/trace/record.js";
import { SaveIntegrityError } from "../../src/persist/save_load.js";
import type { GameState } from "../../src/core/state.js";
import type { RpgAction } from "../../src/api/types.js";

const ROOT = process.cwd();
const PACK = "content/rpg/quests/sunken_barrow.yaml";
const api = () => createToolApi({ root: ROOT });

// A real 5-action route through sunken_barrow's opening and shade dialogue.
const ACTIONS: RpgAction[] = [
  { type: "MOVE", direction: "down" },
  { type: "TAKE", item: "iron_bar" },
  { type: "MOVE", direction: "west" },
  { type: "TALK", npc: "reaver_shade" },
  { type: "ASK", npc: "reaver_shade", topic: "ask_wight" },
];

let cleanTrace: Trace;
let midGameTrace: Trace;

const FIXTURE = (name: string) => `traces/bug_0190_${name}.json`;
const generatedFixtures = new Set<string>();

function writeBytes(path: string, contents: string): void {
  mkdirSync("traces", { recursive: true });
  writeFileSync(path, contents);
  generatedFixtures.add(path);
}

function write(path: string, trace: Trace) {
  writeBytes(path, JSON.stringify(trace));
}

beforeAll(() => {
  const compiled = loadRpgSourceFile(PACK);
  if (!compiled.ok) throw new Error("pack must compile");
  const index = indexRpgPack(compiled.compiled.pack);
  const rules = buildRpgRules(index);
  const meta = {
    trace_id: "tr_0190",
    content_hash: compiled.compiled.contentHash,
    worldQuestId: "sunken_barrow",
  };
  // GREEN guard #1 base: a clean fresh-init recorded trace.
  cleanTrace = recordTrace(rules, initStateForRpgPack(index, 1), ACTIONS, meta);

  // GREEN guard #2 base: a legitimately MID-GAME initial_state (current = a real
  // non-start room reached by stepping, endingId still null), then record a short
  // tail from THERE — proving the gate accepts any state a real recording carries,
  // not only the init state. After "down" the player is in a real non-start room.
  const midState = runActions(rules, initStateForRpgPack(index, 1), [
    { type: "MOVE", direction: "down" },
  ]).finalState;
  midGameTrace = recordTrace(rules, midState, [{ type: "TAKE", item: "iron_bar" }], meta);
});

afterAll(() => {
  for (const path of generatedFixtures) rmSync(path, { force: true });
});

describe("bug_0190 — trace-load integrity gate: forged-trace REJECTION (§16 trace twin)", () => {
  it("WITNESS (mode) omitted trace mode — both handlers throw before stepping", () => {
    const { mode: _drop, ...withoutMode } = cleanTrace;
    write(FIXTURE("missing_mode"), withoutMode as Trace);
    const path = FIXTURE("missing_mode");
    expect(() => api().replay_trace({ trace_path: path })).toThrow(SaveIntegrityError);
    expect(() => api().replay_trace({ trace_path: path })).toThrow(/Trace mode/);
    expect(() => api().inspect_trace({ trace_path: path })).toThrow(SaveIntegrityError);
    expect(() => api().inspect_trace({ trace_path: path })).toThrow(/Trace mode/);
  });

  it("WITNESS (a) finiteness: initial_state.vars -> Infinity (1e999) — both handlers throw", () => {
    // Splice the literal 1e999 token into the serialized trace so it parses back to
    // Infinity (JSON.stringify(Infinity) === "null", so this is unforgeable through a
    // normal recorder — exactly a known-bad-by-construction instance). An un-gated
    // Infinity var flows into conditions.ts:75 var_gte and makes it always-true.
    const SENTINEL = 4242421337;
    const poisoned: Trace = {
      ...cleanTrace,
      initial_state: { ...cleanTrace.initial_state, vars: { hp: SENTINEL } },
    };
    const forged = JSON.stringify(poisoned).replace(String(SENTINEL), "1e999");
    // Sanity: the forged bytes really carry Infinity, not the sentinel.
    expect(
      (JSON.parse(forged) as { initial_state: { vars: { hp: number } } }).initial_state.vars.hp,
    ).toBe(Number.POSITIVE_INFINITY);
    const path = FIXTURE("infinity");
    writeBytes(path, forged);
    // Genuine witness: with the gate reverted, both calls return WITHOUT throwing.
    expect(() => api().replay_trace({ trace_path: path })).toThrow(SaveIntegrityError);
    expect(() => api().inspect_trace({ trace_path: path })).toThrow(SaveIntegrityError);
  });

  it("WITNESS (b) referential: phantom initial_state.current — both handlers throw /unknown room/", () => {
    const poisoned: Trace = {
      ...cleanTrace,
      initial_state: { ...cleanTrace.initial_state, current: "no_such_room" },
    };
    write(FIXTURE("phantom_current"), poisoned);
    const path = FIXTURE("phantom_current");
    expect(() => api().replay_trace({ trace_path: path })).toThrow(SaveIntegrityError);
    expect(() => api().replay_trace({ trace_path: path })).toThrow(/unknown room/);
    expect(() => api().inspect_trace({ trace_path: path })).toThrow(SaveIntegrityError);
    expect(() => api().inspect_trace({ trace_path: path })).toThrow(/unknown room/);
  });

  it("WITNESS (c) referential: phantom initial_state.endingId — both handlers throw /unknown ending/", () => {
    const poisoned: Trace = {
      ...cleanTrace,
      initial_state: { ...cleanTrace.initial_state, ended: true, endingId: "ending_phantom" },
    };
    write(FIXTURE("phantom_ending"), poisoned);
    const path = FIXTURE("phantom_ending");
    expect(() => api().replay_trace({ trace_path: path })).toThrow(SaveIntegrityError);
    expect(() => api().replay_trace({ trace_path: path })).toThrow(/unknown ending/);
    expect(() => api().inspect_trace({ trace_path: path })).toThrow(SaveIntegrityError);
    expect(() => api().inspect_trace({ trace_path: path })).toThrow(/unknown ending/);
  });

  it("WITNESS (d) referential: phantom initial_state flag — both handlers throw /unknown flag/", () => {
    const poisoned: Trace = {
      ...cleanTrace,
      initial_state: { ...cleanTrace.initial_state, flags: { no_such_flag: true } },
    };
    write(FIXTURE("phantom_flag"), poisoned);
    const path = FIXTURE("phantom_flag");
    expect(() => api().replay_trace({ trace_path: path })).toThrow(SaveIntegrityError);
    expect(() => api().replay_trace({ trace_path: path })).toThrow(/unknown flag/);
    expect(() => api().inspect_trace({ trace_path: path })).toThrow(SaveIntegrityError);
    expect(() => api().inspect_trace({ trace_path: path })).toThrow(/unknown flag/);
  });

  it("WITNESS (e) referential: phantom initial_state var — both handlers throw /unknown var/", () => {
    const poisoned: Trace = {
      ...cleanTrace,
      initial_state: {
        ...cleanTrace.initial_state,
        vars: { ...cleanTrace.initial_state.vars, no_such_var: 1 },
      },
    };
    write(FIXTURE("phantom_var"), poisoned);
    const path = FIXTURE("phantom_var");
    expect(() => api().replay_trace({ trace_path: path })).toThrow(SaveIntegrityError);
    expect(() => api().replay_trace({ trace_path: path })).toThrow(/unknown var/);
    expect(() => api().inspect_trace({ trace_path: path })).toThrow(SaveIntegrityError);
    expect(() => api().inspect_trace({ trace_path: path })).toThrow(/unknown var/);
  });
});

describe("bug_0190 — trace-load integrity gate: GREEN false-rejection guards", () => {
  it("a clean fresh-init recorded trace still replays + inspects unchanged", () => {
    write(FIXTURE("clean"), cleanTrace);
    const path = FIXTURE("clean");
    const replay = api().replay_trace({ trace_path: path }) as { ok: boolean };
    expect(replay.ok).toBe(true);
    const inspect = api().inspect_trace({ trace_path: path }) as {
      ok: boolean;
      hash_ok: boolean;
      steps: number;
      diverged_at_step: number | null;
    };
    expect(inspect.ok).toBe(true);
    expect(inspect.hash_ok).toBe(true);
    expect(inspect.steps).toBe(5);
    expect(inspect.diverged_at_step).toBeNull();
  });

  it("a legitimately MID-GAME RPG trace (current = a real reached room) still replays + inspects", () => {
    // Sanity: this trace's initial_state is NOT the init state — it is a real
    // non-start room with empty inventory and endingId null, exactly what a save
    // recorded mid-playthrough would carry. The gate must accept it.
    const init = (() => {
      const compiled = loadRpgSourceFile(PACK);
      if (!compiled.ok) throw new Error("pack must compile");
      return initStateForRpgPack(indexRpgPack(compiled.compiled.pack), 1) as GameState;
    })();
    expect(midGameTrace.initial_state.current).not.toBe(init.current);
    expect(midGameTrace.initial_state.endingId).toBeNull();

    write(FIXTURE("midgame"), midGameTrace);
    const path = FIXTURE("midgame");
    const replay = api().replay_trace({ trace_path: path }) as { ok: boolean };
    expect(replay.ok).toBe(true);
    const inspect = api().inspect_trace({ trace_path: path }) as {
      ok: boolean;
      hash_ok: boolean;
    };
    expect(inspect.ok).toBe(true);
    expect(inspect.hash_ok).toBe(true);
  });
});
