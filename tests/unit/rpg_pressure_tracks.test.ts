import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { GameSession } from "../../ui/src/engine.js";
import { makeStep } from "../../src/core/engine.js";
import {
  COMPACT_PRESSURE_LIMIT,
  compactRpgObservation,
} from "../../src/mcp/compact_rpg_observation.js";
import { buildRpgObservation } from "../../src/rpg/observation.js";
import { buildRpgRules, indexRpgPack, initStateForRpgPack } from "../../src/rpg/runner.js";
import { RpgPackSchema, type RpgPack } from "../../src/rpg/schema.js";
import { compileRpgSource, loadRpgSourceFile } from "../../src/rpg/source.js";
import { validateRpg } from "../../src/validate/rpg_validator.js";

const SYNTHETIC_PRESSURE_SOURCE = `
meta:
  id: pressure_fixture
  title: Pressure Fixture
  start_room: start
  vars_init: { hp: 20, attack: 3, defense: 2, cattle_alarm: 0 }
rooms:
  - id: start
    name: Start
    description: The herd is quiet.
    exits: [{ direction: east, to: finish }]
  - id: finish
    name: Finish
    description: The herd breaks against the gate.
    on_enter:
      - inc_var: { name: cattle_alarm, by: 4 }
pressure_tracks:
  - id: cattle_alarm
    title: Cattle Alarm
    var: cattle_alarm
    bands:
      - { min: 0, label: Steady, description: The herd still answers the keeper. }
      - { min: 2, label: Restless, description: The herd is crowding the inner rail. }
      - { min: 4, label: Breaking, description: The next shock will scatter cattle. }
win_conditions:
  - id: done
    conditions: [{ visited: finish }]
    ending: ending_done
endings:
  - id: ending_done
    title: Done
    text: The pressure test is complete.
enemies: []
`;

function compiledPressurePack(): RpgPack {
  const result = compileRpgSource(SYNTHETIC_PRESSURE_SOURCE);
  if (!result.ok) throw result.error;
  return result.compiled.pack;
}

// Derived from SYNTHETIC_PRESSURE_SOURCE by removing its one write to cattle_alarm
// (the "finish" room's on_enter inc_var) — the var is still declared in vars_init
// and still projected by the pressure track, but now nothing in the pack ever
// writes it: the DEAD_PRESSURE_TRACK fixture.
const SYNTHETIC_DEAD_PRESSURE_SOURCE = SYNTHETIC_PRESSURE_SOURCE.replace(
  "    on_enter:\n      - inc_var: { name: cattle_alarm, by: 4 }\n",
  "",
);

function compiledDeadPressurePack(): RpgPack {
  const result = compileRpgSource(SYNTHETIC_DEAD_PRESSURE_SOURCE);
  if (!result.ok) throw result.error;
  return result.compiled.pack;
}

function pressureTrack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "alarm",
    title: "Alarm",
    var: "alarm",
    bands: [
      { min: 0, label: "Quiet" },
      { min: 2, label: "Rising" },
    ],
    ...overrides,
  };
}

function baseRawPack(): Record<string, unknown> {
  return parseYaml(SYNTHETIC_PRESSURE_SOURCE) as Record<string, unknown>;
}

describe("RPG pressure-track authoring contract", () => {
  it("keeps pressure_tracks absent from legacy compiled pack shapes", () => {
    const loaded = loadRpgSourceFile("content/rpg/quests/sunken_barrow.yaml");
    if (!loaded.ok) throw loaded.error;

    expect(loaded.compiled.pack).not.toHaveProperty("pressure_tracks");
    const index = indexRpgPack(loaded.compiled.pack);
    const observation = buildRpgObservation(index, initStateForRpgPack(index, 1));
    expect(observation).not.toHaveProperty("pressure_tracks");
    expect(compactRpgObservation(observation, [])).not.toHaveProperty("pressure");
  });

  it.each([
    {
      label: "fewer than two bands",
      tracks: [pressureTrack({ bands: [{ min: 0, label: "Quiet" }] })],
      message: /at least 2/i,
    },
    {
      label: "unordered thresholds",
      tracks: [
        pressureTrack({
          bands: [
            { min: 0, label: "Quiet" },
            { min: 3, label: "Rising" },
            { min: 2, label: "Breaking" },
          ],
        }),
      ],
      message: /strictly increasing/i,
    },
    {
      label: "duplicate track ids",
      tracks: [pressureTrack(), pressureTrack({ var: "other_alarm" })],
      message: /duplicate pressure track id/i,
    },
    {
      label: "duplicate projected vars",
      tracks: [pressureTrack(), pressureTrack({ id: "other_alarm" })],
      message: /projected by more than one track/i,
    },
  ])("rejects $label", ({ tracks, message }) => {
    const parsed = RpgPackSchema.safeParse({ ...baseRawPack(), pressure_tracks: tracks });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.message).join(" ")).toMatch(message);
  });

  it("rejects an undeclared source var and an initial value below the authored floor", () => {
    const unknown = RpgPackSchema.parse({
      ...baseRawPack(),
      pressure_tracks: [pressureTrack({ var: "missing_alarm" })],
    });
    const below = RpgPackSchema.parse({
      ...baseRawPack(),
      pressure_tracks: [
        pressureTrack({
          var: "cattle_alarm",
          bands: [
            { min: 1, label: "Quiet" },
            { min: 2, label: "Rising" },
          ],
        }),
      ],
    });

    expect(validateRpg(unknown).findings.map((finding) => finding.code)).toContain(
      "PRESSURE_VAR_UNDECLARED",
    );
    expect(validateRpg(below).findings.map((finding) => finding.code)).toContain(
      "PRESSURE_INITIAL_BELOW_MIN",
    );
  });

  it("flags DEAD_PRESSURE_TRACK when no effect ever writes the track's var, and not when one does", () => {
    const alive = compiledPressurePack();
    expect(validateRpg(alive).findings.map((finding) => finding.code)).not.toContain(
      "DEAD_PRESSURE_TRACK",
    );

    const dead = compiledDeadPressurePack();
    const finding = validateRpg(dead).findings.find((f) => f.code === "DEAD_PRESSURE_TRACK");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
  });
});

describe("RPG pressure-track client parity", () => {
  it("resolves the same current and next bands in full and compact observations", () => {
    const pack = compiledPressurePack();
    expect(validateRpg(pack).findings).toEqual([]);
    const index = indexRpgPack(pack);
    const state = initStateForRpgPack(index, 11);
    const full = buildRpgObservation(index, state);

    expect(full.pressure_tracks).toEqual([
      {
        id: "cattle_alarm",
        title: "Cattle Alarm",
        var: "cattle_alarm",
        value: 0,
        band: {
          min: 0,
          label: "Steady",
          description: "The herd still answers the keeper.",
        },
        next: {
          min: 2,
          label: "Restless",
          description: "The herd is crowding the inner rail.",
        },
      },
    ]);
    expect(compactRpgObservation(full, []).pressure).toEqual([
      ["cattle_alarm", "Cattle Alarm", 0, 0, "Steady", 2, "Restless"],
    ]);

    const moved = makeStep(buildRpgRules(index))(state, { type: "MOVE", direction: "east" });
    expect(moved.ok).toBe(true);
    const breaking = buildRpgObservation(index, moved.state);
    expect(breaking.pressure_tracks?.[0]).toMatchObject({
      value: 4,
      band: { min: 4, label: "Breaking" },
      next: null,
    });
    expect(compactRpgObservation(breaking, []).pressure).toEqual([
      ["cattle_alarm", "Cattle Alarm", 4, 4, "Breaking"],
    ]);
  });

  it("bounds compact pressure rows and reports the omitted count", () => {
    const pack = compiledPressurePack();
    const index = indexRpgPack(pack);
    const full = buildRpgObservation(index, initStateForRpgPack(index, 11));
    const source = full.pressure_tracks?.[0];
    if (!source) throw new Error("expected the synthetic pressure track");
    const pressure_tracks = Array.from({ length: COMPACT_PRESSURE_LIMIT + 2 }, (_, index) => ({
      ...source,
      id: `pressure_${index}`,
      band: { ...source.band },
      next: source.next === null ? null : { ...source.next },
    }));

    const compact = compactRpgObservation({ ...full, pressure_tracks }, []);

    expect(compact.pressure).toHaveLength(COMPACT_PRESSURE_LIMIT);
    expect(compact.more).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
  });

  it("renders the structured pressure state through the browser RPG view", () => {
    const session = GameSession.start(SYNTHETIC_PRESSURE_SOURCE, 11);
    const opening = session.view();

    expect(opening.pressureTracks?.[0]).toMatchObject({
      id: "cattle_alarm",
      value: 0,
      band: { label: "Steady" },
      next: { min: 2, label: "Restless" },
    });
    expect(opening.facts).toContain(
      "pressure: Cattle Alarm — Steady (0; next Restless at 2) — The herd still answers the keeper.",
    );

    expect(session.choose("go_east").ok).toBe(true);
    const breaking = session.view();
    expect(breaking.pressureTracks?.[0]).toMatchObject({
      value: 4,
      band: { label: "Breaking" },
      next: null,
    });
    expect(breaking.facts).toContain(
      "pressure: Cattle Alarm — Breaking (4; at maximum) — The next shock will scatter cattle.",
    );
  });

  it("does not add pressure state to a legacy browser view", () => {
    const source = readFileSync("content/rpg/quests/sunken_barrow.yaml", "utf8");
    const view = GameSession.start(source, 1).view();

    expect(view).not.toHaveProperty("pressureTracks");
    expect(view.facts.some((fact) => fact.startsWith("pressure:"))).toBe(false);
  });
});
