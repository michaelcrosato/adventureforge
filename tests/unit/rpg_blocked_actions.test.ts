import { describe, expect, it } from "vitest";

import { resolve as resolveCli } from "../../bin/rpg_play.js";
import type { GameState } from "../../src/core/state.js";
import { enumerateRpgBaseActions } from "../../src/rpg/legal_actions.js";
import { buildRpgObservation } from "../../src/rpg/observation.js";
import {
  enumerateRpgActions,
  enumerateRpgBlockedActions,
  indexRpgPack,
  initStateForRpgPack,
} from "../../src/rpg/runner.js";
import {
  InteractionSchema,
  RPG_BLOCKED_ACTION_REASON_CHAR_LIMIT,
  RpgPackSchema,
  type Interaction,
  type RpgPack,
} from "../../src/rpg/schema.js";
import { validateRpgFoundation } from "../../src/validate/rpg_foundation_validator.js";

const BLOCKED_REASON = "Examine the patient and learn what the fever needs first.";

function blockedInteraction(overrides: Partial<Interaction> = {}): Interaction {
  return InteractionSchema.parse({
    verb: "USE",
    item: "herb",
    target: "patient",
    conditions: [{ has_flag: "treatment_ready" }],
    command_verb: "treat",
    command_template: "treat {target} with {item}",
    blocked_hint: {
      visible_when: [{ not_flag: "hint_hidden" }],
      reason: BLOCKED_REASON,
    },
    ...overrides,
  });
}

function makePack(interactions: Interaction[] = [blockedInteraction()]): RpgPack {
  return RpgPackSchema.parse({
    meta: {
      id: "blocked_action_fixture",
      title: "Blocked Action Fixture",
      start_room: "clinic",
      vars_init: {},
    },
    rooms: [
      {
        id: "clinic",
        name: "Clinic",
        description: "A fevered patient waits here.",
        objects: ["patient"],
        exits: [{ direction: "east", to: "finish" }],
      },
      {
        id: "finish",
        name: "Finish",
        description: "A quiet hall.",
        exits: [{ direction: "west", to: "clinic" }],
      },
    ],
    objects: [
      {
        id: "patient",
        name: "fevered patient",
        description: "The patient needs deliberate treatment.",
        interactions,
      },
      {
        id: "herb",
        name: "willow herb",
        description: "A bitter medicinal sprig.",
        held: true,
      },
    ],
    win_conditions: [{ id: "done", conditions: [{ visited: "finish" }], ending: "ending_done" }],
    endings: [{ id: "ending_done", title: "Done", text: "The fixture is complete." }],
  });
}

function setup(interactions?: Interaction[]): {
  pack: RpgPack;
  index: ReturnType<typeof indexRpgPack>;
  state: GameState;
} {
  const pack = makePack(interactions);
  const index = indexRpgPack(pack);
  return { pack, index, state: initStateForRpgPack(index, 1) };
}

describe("RPG blocked hint schema", () => {
  it("admits only target-bearing USE interactions and enforces the exported reason limit", () => {
    const validHint = {
      visible_when: [{ has_flag: "seen" }],
      reason: "x".repeat(RPG_BLOCKED_ACTION_REASON_CHAR_LIMIT),
    };

    expect(
      InteractionSchema.safeParse({ verb: "USE", target: "patient", blocked_hint: validHint })
        .success,
    ).toBe(true);
    expect(
      InteractionSchema.safeParse({
        verb: "USE",
        target: "patient",
        blocked_hint: { ...validHint, reason: `${validHint.reason}x` },
      }).success,
    ).toBe(false);
    expect(
      InteractionSchema.safeParse({
        verb: "USE",
        target: "patient",
        blocked_hint: { visible_when: [], reason: "Not yet." },
      }).success,
    ).toBe(false);
    expect(InteractionSchema.safeParse({ verb: "USE", blocked_hint: validHint }).success).toBe(
      false,
    );
    expect(
      InteractionSchema.safeParse({ verb: "READ", target: "patient", blocked_hint: validHint })
        .success,
    ).toBe(false);
  });
});

describe("enumerateRpgBlockedActions", () => {
  it("projects a gated USE with the same stable identity and natural command, without payload leakage", () => {
    const { index, state } = setup();

    expect(
      enumerateRpgActions(index, state).some((option) => option.id === "use_herb_on_patient"),
    ).toBe(false);
    expect(enumerateRpgBlockedActions(index, state)).toEqual([
      {
        id: "use_herb_on_patient",
        command: "treat fevered patient with willow herb",
        reason: BLOCKED_REASON,
      },
    ]);
    expect(Object.keys(enumerateRpgBlockedActions(index, state)[0]!).sort()).toEqual([
      "command",
      "id",
      "reason",
    ]);
  });

  it("requires hint visibility, a present target, a held item, and failing interaction conditions", () => {
    const { index, state } = setup();

    expect(
      enumerateRpgBlockedActions(index, {
        ...state,
        flags: { ...state.flags, hint_hidden: true },
      }),
    ).toEqual([]);
    expect(enumerateRpgBlockedActions(index, { ...state, inventory: [] })).toEqual([]);
    expect(
      enumerateRpgBlockedActions(index, {
        ...state,
        current: "finish",
        visited: { ...state.visited, finish: true },
      }),
    ).toEqual([]);

    const ready = { ...state, flags: { ...state.flags, treatment_ready: true } };
    expect(enumerateRpgBlockedActions(index, ready)).toEqual([]);
    expect(enumerateRpgActions(index, ready).map((option) => option.id)).toContain(
      "use_herb_on_patient",
    );
  });

  it("deduplicates authored rows and suppresses a blocked id when any sibling is legal", () => {
    const duplicate = blockedInteraction({
      blocked_hint: {
        visible_when: [{ not_flag: "hint_hidden" }],
        reason: "A duplicate explanation must not create a duplicate row.",
      },
    });
    const duplicated = setup([blockedInteraction(), duplicate]);
    expect(enumerateRpgBlockedActions(duplicated.index, duplicated.state)).toEqual([
      {
        id: "use_herb_on_patient",
        command: "treat fevered patient with willow herb",
        reason: BLOCKED_REASON,
      },
    ]);

    const legalSibling = blockedInteraction({
      conditions: [{ not_flag: "treatment_ready" }],
      blocked_hint: undefined,
    });
    const mixed = setup([blockedInteraction(), legalSibling]);
    expect(enumerateRpgActions(mixed.index, mixed.state).map((option) => option.id)).toContain(
      "use_herb_on_patient",
    );
    expect(enumerateRpgBlockedActions(mixed.index, mixed.state)).toEqual([]);
  });

  it("lets an exact legal CLI command win a blocked-command collision", () => {
    const pack = RpgPackSchema.parse({
      meta: {
        id: "blocked_command_collision",
        title: "Blocked Command Collision",
        start_room: "study",
        vars_init: {},
      },
      rooms: [
        {
          id: "study",
          name: "Study",
          description: "Two apparently identical cases rest on a table.",
          objects: ["blocked_case", "legal_case"],
          exits: [{ direction: "east", to: "finish" }],
        },
        {
          id: "finish",
          name: "Finish",
          description: "A quiet hall.",
          exits: [{ direction: "west", to: "study" }],
        },
      ],
      objects: [
        {
          id: "blocked_case",
          name: "sealed case",
          description: "The sealed case resists study.",
          interactions: [
            {
              verb: "USE",
              target: "blocked_case",
              command_verb: "study",
              conditions: [{ has_flag: "blocked_ready" }],
              blocked_hint: {
                visible_when: [{ not_flag: "blocked_ready" }],
                reason: BLOCKED_REASON,
              },
            },
          ],
        },
        {
          id: "legal_case",
          name: "sealed case",
          description: "This case can be studied now.",
          interactions: [
            {
              verb: "USE",
              target: "legal_case",
              command_verb: "study",
              conditions: [{ not_flag: "legal_retired" }],
              effects: [{ narrate: "You study the open case." }],
            },
          ],
        },
      ],
      win_conditions: [{ id: "done", conditions: [{ visited: "finish" }], ending: "ending" }],
      endings: [{ id: "ending", title: "Done", text: "The fixture is complete." }],
    });
    const index = indexRpgPack(pack);
    const state = initStateForRpgPack(index, 1);

    expect(enumerateRpgBlockedActions(index, state)).toEqual([
      expect.objectContaining({ command: "study sealed case", reason: BLOCKED_REASON }),
    ]);
    expect(
      enumerateRpgActions(index, state).find((option) => option.command === "study sealed case")
        ?.action,
    ).toEqual({ type: "USE", target: "legal_case" });
    expect(resolveCli(index, state, "study sealed case")).toEqual({
      ok: true,
      action: { type: "USE", target: "legal_case" },
    });

    const blockedOnly = {
      ...state,
      flags: { ...state.flags, legal_retired: true },
    };
    const before = structuredClone(blockedOnly);
    expect(resolveCli(index, blockedOnly, "study sealed case")).toEqual({
      ok: false,
      reason: BLOCKED_REASON,
    });
    expect(blockedOnly).toEqual(before);
  });
});

describe("RPG blocked hint validator integration", () => {
  it("validates feasibility, references, and contradictions in visible_when", () => {
    const impossible = makePack([
      blockedInteraction({
        blocked_hint: { visible_when: [{ has_flag: "never_set" }], reason: BLOCKED_REASON },
      }),
    ]);
    expect(
      validateRpgFoundation(impossible).findings.some(
        (finding) =>
          finding.code === "IMPOSSIBLE_GATE" && finding.where.includes("blocked_hint:visible_when"),
      ),
    ).toBe(true);

    const dangling = makePack([
      blockedInteraction({
        blocked_hint: {
          visible_when: [{ any_of: [{ in_room: "missing_annex" }, { not_flag: "hidden" }] }],
          reason: BLOCKED_REASON,
        },
      }),
    ]);
    expect(
      validateRpgFoundation(dangling).findings.some(
        (finding) =>
          finding.code === "UNRESOLVED_ROOM_REFERENCE" &&
          finding.where.includes("room:missing_annex"),
      ),
    ).toBe(true);

    const contradictory = makePack([
      blockedInteraction({
        blocked_hint: {
          visible_when: [{ has_flag: "seen" }, { not_flag: "seen" }],
          reason: BLOCKED_REASON,
        },
      }),
    ]);
    expect(
      validateRpgFoundation(contradictory).findings.some(
        (finding) =>
          finding.code === "UNSATISFIABLE_CONDITION" &&
          finding.where.includes("blocked_hint:visible_when"),
      ),
    ).toBe(true);
  });

  it("counts a flag read only by visible_when as live game state", () => {
    const pack = makePack([
      blockedInteraction({
        effects: [{ set_flag: "hint_enabled" }],
        blocked_hint: {
          visible_when: [{ has_flag: "hint_enabled" }],
          reason: BLOCKED_REASON,
        },
      }),
    ]);

    expect(
      validateRpgFoundation(pack).findings.some(
        (finding) => finding.code === "INERT_FLAG" && finding.message.includes('"hint_enabled"'),
      ),
    ).toBe(false);
  });
});

describe("enumerateRpgBlockedActions with a caller-supplied legal list", () => {
  // The observation hands its own enumeration of the state to the blocked pass instead of
  // enumerating the base actions a second time. That must never change which rows appear.
  const blocked = setup();
  const legalSibling = setup([
    blockedInteraction(),
    blockedInteraction({ conditions: [{ not_flag: "treatment_ready" }], blocked_hint: undefined }),
  ]);
  const ready = {
    ...blocked,
    state: { ...blocked.state, flags: { ...blocked.state.flags, treatment_ready: true } },
  };

  it.each([
    ["a visible blocked row", blocked],
    ["a legal sibling suppressing the row", legalSibling],
    ["an open gate (row legal, nothing blocked)", ready],
  ])("matches the self-enumerated rows for %s", (_label, { index, state }) => {
    const own = enumerateRpgBlockedActions(index, state);
    expect(enumerateRpgBlockedActions(index, state, enumerateRpgActions(index, state))).toEqual(
      own,
    );
    expect(enumerateRpgBlockedActions(index, state, enumerateRpgBaseActions(index, state))).toEqual(
      own,
    );
    expect(buildRpgObservation(index, state).blocked_actions).toEqual(own);
  });

  it("ignores appended combat rows: only a legal BASE row suppresses a blocked id", () => {
    // enumerateRpgActions appends ATTACK/MANEUVER rows to the base list. A combat row that
    // happened to share a blocked row's id never suppressed it when the blocked pass
    // enumerated the base list itself, so it must not when handed the full list either.
    const { index, state } = blocked;
    const withCombat = [
      ...enumerateRpgActions(index, state),
      {
        id: "use_herb_on_patient",
        command: "attack patient",
        action: { type: "ATTACK" as const, enemy: "patient" },
      },
    ];
    expect(enumerateRpgBlockedActions(index, state, withCombat)).toEqual(
      enumerateRpgBlockedActions(index, state),
    );
    expect(enumerateRpgBlockedActions(index, state)).toHaveLength(1);
  });
});
