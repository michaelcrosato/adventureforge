/**
 * SS-F07 full-slice paired proof. One real Albany pre-start boundary is forked
 * before Hayden's hill-road choice. Both forks then cross the public MCP quest
 * bridge, play the same clean three-cast lure plan at seed 26, fold a non-death
 * ending back into the overworld, and survive canonical snapshot replay.
 */
import { describe, expect, it } from "vitest";

import { createToolApi } from "../../src/mcp/tools.js";
import { ALBANY_DAWN_DISPATCH_CONTINUE_LABEL } from "../../src/world/journey_campaign.js";
import { loadOverworldManifest } from "../../src/world/source.js";

const ROOT = process.cwd();
const WORLD = loadOverworldManifest(ROOT);
const WOLF =
  WORLD.quests.find((quest) => quest.id === "wolf_winter") ??
  (() => {
    throw new Error("the Albany starting slice requires Wolf-Winter");
  })();
const REGISTRATION =
  WORLD.opening_registration ??
  (() => {
    throw new Error("the Albany starting slice requires registration");
  })();

const FULL = { compact_context: false, compact_result: false } as const;
const SEED = 26;
const RESIDENT_SHELTER = "albany:relief_resident_shelter";
const PARENT_MINUTES = 560;
const PARENT_SUPPLIES = 6;
const PARENT_FATIGUE = 0;
const PARENT_DECISIONS = 8;
const QUEST_AREA = "albany_city__transport_hub";

const CLEAN_LURE_TAIL = [
  "talk_houndsman",
  "ask_lure",
  "ask_commit_lure",
  "ask_leave",
  "go_west",
  "take_winter_feed_sack",
  "go_east",
  "go_north",
  "use_winter_feed_sack_on_downwind_feed_line",
  "go_south",
  "go_west",
  "go_up",
  "use_winter_feed_sack_on_loft_hatch",
  "go_east",
  "go_north",
  "use_winter_feed_sack_on_outer_scent_gate",
  "go_north",
] as const;

const ROUTES = {
  ridge: {
    approachId: "albany:wolf_approach_exposed_ridge",
    otherApproachId: "albany:wolf_approach_sheltered_stockway",
    lastMileAction: "use_exposed_ridge_last_mile",
    otherLastMileAction: "use_sheltered_stockway_last_mile",
    knowledgeId: "albany:knowledge_wolf_exposed_ridge",
    otherKnowledgeId: "albany:knowledge_wolf_sheltered_stockway",
    haydenMemory: "albany:memory_hayden_dispatched_exposed_ridge",
    otherHaydenMemory: "albany:memory_hayden_dispatched_sheltered_stockway",
    importRule: "import:wolf_winter_approach_exposed_ridge",
    otherImportRule: "import:wolf_winter_approach_sheltered_stockway",
    flag: "approach_exposed_ridge",
    otherFlag: "approach_sheltered_stockway",
    terms: { minutes: 30, supplies: 1, fatigue: 25 },
    after: {
      minutes: 590,
      timeLabel: "Day 1, 09:50",
      supplies: 5,
      fatigue: 25,
      travelCondition: "tired",
    },
    arrivalAlarm: 1,
    firstCastAlarm: 2,
    finalAlarm: 4,
    endingId: "ending_pack_diverted_cattle_scattered",
    returnSummary:
      "You reached Cade quickly by the exposed ridge. You saw the full byre, but the cattle saw you and became alarmed.",
  },
  stockway: {
    approachId: "albany:wolf_approach_sheltered_stockway",
    otherApproachId: "albany:wolf_approach_exposed_ridge",
    lastMileAction: "use_sheltered_stockway_last_mile",
    otherLastMileAction: "use_exposed_ridge_last_mile",
    knowledgeId: "albany:knowledge_wolf_sheltered_stockway",
    otherKnowledgeId: "albany:knowledge_wolf_exposed_ridge",
    haydenMemory: "albany:memory_hayden_dispatched_sheltered_stockway",
    otherHaydenMemory: "albany:memory_hayden_dispatched_exposed_ridge",
    importRule: "import:wolf_winter_approach_sheltered_stockway",
    otherImportRule: "import:wolf_winter_approach_exposed_ridge",
    flag: "approach_sheltered_stockway",
    otherFlag: "approach_exposed_ridge",
    terms: { minutes: 75, supplies: 2, fatigue: 10 },
    after: {
      minutes: 635,
      timeLabel: "Day 1, 10:35",
      supplies: 4,
      fatigue: 10,
      travelCondition: "ready",
    },
    arrivalAlarm: 0,
    firstCastAlarm: 1,
    finalAlarm: 3,
    endingId: "ending_pack_diverted",
    returnSummary:
      "You reached Cade by the sheltered stockway. The trip took longer, but you arrived less tired and kept the cattle calm.",
  },
} as const;

type ToolApi = ReturnType<typeof createToolApi>;
type RouteSpec = (typeof ROUTES)[keyof typeof ROUTES];

function fullView(api: ToolApi, sessionId: string) {
  return api.get_overworld_session({
    session_id: sessionId,
    include_observation: true,
  }).observation;
}

function exportSession(api: ToolApi, sessionId: string) {
  const exported = api.export_overworld_session({ session_id: sessionId });
  expect(exported.ok).toBe(true);
  if (!exported.ok) throw new Error("expected an overworld snapshot export");
  return exported;
}

function moveToVisibleArea(api: ToolApi, sessionId: string, areaId: string): void {
  const view = fullView(api, sessionId);
  if (view.currentArea?.id === areaId) return;
  const route = view.areaExits.find((candidate) => candidate.destination.id === areaId);
  if (!route) {
    throw new Error(
      `expected a visible Albany route from ${view.currentArea?.id ?? "none"} to ${areaId}`,
    );
  }
  api.move_overworld_session_area({
    ...FULL,
    session_id: sessionId,
    area_route_id: route.id,
  });
}

function buildAlbanyPreStartBoundary(api: ToolApi) {
  const started = api.start_overworld({ compact_context: false });
  const sessionId = started.session_id;
  const civicPoi = started.observation.pois[0];
  const rowan = started.observation.characters.find(
    (character) => character.id === REGISTRATION.contact,
  );
  if (!civicPoi || !rowan) throw new Error("expected Albany's civic opening");

  api.scout_overworld_session_poi({
    ...FULL,
    session_id: sessionId,
    poi_id: civicPoi.id,
  });
  api.talk_overworld_session_contact({
    ...FULL,
    session_id: sessionId,
    character_id: rowan.id,
  });
  api.choose_overworld_session_story({
    ...FULL,
    session_id: sessionId,
    choice: "albany:ledger_advocate",
  });
  api.choose_overworld_session_story({
    ...FULL,
    session_id: sessionId,
    choice: "albany:oath_full_compact_duty",
  });
  const sourced = api.choose_overworld_session_story({
    ...FULL,
    session_id: sessionId,
    choice: "albany:source_rowan_civic_docket",
  });
  const preparationArea = WORLD.opening_preparation?.area;
  if (!preparationArea) throw new Error("the Albany starting slice requires opening preparation");
  const preparationRoute = sourced.observation.areaExits.find(
    (candidate) => candidate.destination.id === preparationArea,
  );
  if (!preparationRoute) throw new Error("expected a route to the opening preparation board");
  api.move_overworld_session_area({
    ...FULL,
    session_id: sessionId,
    area_route_id: preparationRoute.id,
  });
  const prepared = api.choose_overworld_session_story({
    ...FULL,
    session_id: sessionId,
    story_choice_id: "albany:wolf_preparation",
    choice: "albany:prep_works_fortification",
  });
  expect(prepared.observation.quests.map((quest) => quest.id)).toContain(WOLF.id);
  api.choose_overworld_session_story({
    ...FULL,
    session_id: sessionId,
    story_choice_id: "albany:wolf_relief_allocation",
    choice: RESIDENT_SHELTER,
  });

  moveToVisibleArea(api, sessionId, WOLF.area);

  return { sessionId, exported: exportSession(api, sessionId) };
}

function launchFull(api: ToolApi, sessionId: string, spec: RouteSpec) {
  return api.start_overworld_session_quest({
    ...FULL,
    compact_observation: false,
    compact_actions: false,
    include_actions: true,
    session_id: sessionId,
    quest_id: WOLF.id,
    approach_id: spec.approachId,
    seed: SEED,
  });
}

function expectSanitizedQuestProjection(projected: unknown, spec: RouteSpec): void {
  const serialized = JSON.stringify(projected);
  expect(serialized).not.toMatch(/"effects"|"return_summary"|import:wolf_winter/);
  expect(serialized).not.toContain(spec.returnSummary);
  expect(serialized).not.toMatch(/knowledge_wolf_(?:exposed_ridge|sheltered_stockway)/);
  expect(serialized).not.toMatch(/memory_hayden_dispatched_(?:exposed_ridge|sheltered_stockway)/);
}

function assertFullLaunch(
  api: ToolApi,
  sessionId: string,
  launched: ReturnType<typeof launchFull>,
  spec: RouteSpec,
): void {
  expect(launched.quest.launch?.selected).toEqual({
    optionId: spec.approachId,
    minutesBefore: PARENT_MINUTES,
    minutesAfter: spec.after.minutes,
    suppliesBefore: PARENT_SUPPLIES,
    suppliesAfter: spec.after.supplies,
    fatigueBefore: PARENT_FATIGUE,
    fatigueAfter: spec.after.fatigue,
    travelConditionAfter: spec.after.travelCondition,
  });
  expect(launched.observation).toMatchObject({
    timeLabel: spec.after.timeLabel,
    supplies: spec.after.supplies,
    fatigue: spec.after.fatigue,
    travelCondition: spec.after.travelCondition,
  });
  expect(launched.journey).toMatchObject({
    acceptedDecisions: PARENT_DECISIONS + 1,
    decisionProof: {
      last: {
        number: PARENT_DECISIONS + 1,
        surface: "overworld",
        actionId: `quest_start:${WOLF.id}:${spec.approachId}`,
        reason: "situation_changed",
      },
    },
  });
  expectSanitizedQuestProjection(launched.quest, spec);

  const started = exportSession(api, sessionId).snapshot;
  expect(started).toMatchObject({
    minutes: spec.after.minutes,
    supplies: spec.after.supplies,
    fatigue: spec.after.fatigue,
    startedQuestIds: [WOLF.id],
    journey: { acceptedDecisions: PARENT_DECISIONS + 1 },
  });
  const questStart = started.journalEntries.find((entry) => entry.id === `quest:${WOLF.id}`);
  expect(questStart).toMatchObject({
    kind: "quest",
    questStartProof: {
      kind: "approach",
      approachId: spec.approachId,
      boundary: {
        acceptedDecisions: PARENT_DECISIONS + 1,
        decisionProofHash: launched.journey.decisionProof.hash,
        townId: "albany_city",
        areaId: QUEST_AREA,
        minutes: spec.after.minutes,
      },
    },
  });
  expect(
    started.openingLeadSourceDecisionTrail?.decisions.filter((decision) =>
      decision.actionId.startsWith(`quest_start:${WOLF.id}`),
    ),
  ).toEqual([
    {
      number: PARENT_DECISIONS + 1,
      surface: "overworld",
      actionId: `quest_start:${WOLF.id}:${spec.approachId}`,
      reason: "situation_changed",
    },
  ]);

  expect(started.character.knowledge).toContain(spec.knowledgeId);
  expect(started.character.knowledge).not.toContain(spec.otherKnowledgeId);
  expect(
    started.character.relationships.find(
      (relationship) => relationship.npcId === "albany:hayden_hale",
    ),
  ).toEqual({
    npcId: "albany:hayden_hale",
    trust: 0,
    regard: 0,
    owesPlayer: 0,
    playerOwes: 0,
    memories: [spec.haydenMemory],
  });
  expect(
    started.character.relationships.some((relationship) =>
      relationship.memories.includes(spec.otherHaydenMemory),
    ),
  ).toBe(false);

  const initial = api.get_state({
    session_id: launched.rpg_session_id,
    include_state: true,
  }).state;
  expect(initial.vars.cattle_alarm).toBe(0);
  expect(
    launched.rpg_session.observation.pressure_tracks?.find((track) => track.id === "cattle_alarm"),
  ).toMatchObject({
    id: "cattle_alarm",
    value: 0,
    band: { label: "Steady" },
  });
  expect(initial.campaignImportReceipt?.applied_rules).toEqual([
    spec.importRule,
    "import:wolf_winter_full_compact_duty",
    "import:wolf_winter_relief_mediation",
    "import:wolf_winter_relief_resident_shelter",
    "import:wolf_winter_works_fortification",
  ]);
  expect(initial.campaignImportReceipt?.applied_rules).not.toContain(spec.otherImportRule);
  expect(initial.flags[spec.flag]).toBe(true);
  expect(initial.flags[spec.otherFlag]).not.toBe(true);
  const initialActions = launched.rpg_session.observation.available_actions.map(
    (action) => action.id,
  );
  expect(initialActions).toContain(spec.lastMileAction);
  expect(initialActions).not.toContain(spec.otherLastMileAction);
  expect(initialActions).not.toContain("go_north");
}

function playCleanLure(
  api: ToolApi,
  overworldSessionId: string,
  launched: ReturnType<typeof launchFull>,
  spec: RouteSpec,
) {
  const route = [spec.lastMileAction, ...CLEAN_LURE_TAIL];
  let finalStep: ReturnType<ToolApi["step_action"]> | null = null;

  for (const actionId of route) {
    const step = api.step_action({
      session_id: launched.rpg_session_id,
      action_id: actionId,
      compact_observation: false,
      compact_events: false,
    });
    expect(step.ok, step.rejection_reason).toBe(true);
    if (step.ok !== true) throw new Error(`expected ${actionId} to succeed`);
    finalStep = step;

    if (actionId === spec.lastMileAction) {
      expect(api.sessions.get(launched.rpg_session_id).state.vars.cattle_alarm).toBe(
        spec.arrivalAlarm,
      );
    }
    if (actionId === "use_winter_feed_sack_on_downwind_feed_line") {
      const afterFirstCast = api.sessions.get(launched.rpg_session_id).state;
      expect(afterFirstCast.vars.cattle_alarm).toBe(spec.firstCastAlarm);
      expect(afterFirstCast.flags.yearling_redirected).toBe(true);
      expect(afterFirstCast.flags.lure_trail_fouled).not.toBe(true);
    }
  }

  if (!finalStep) throw new Error("the clean lure route must contain actions");
  expect(finalStep.questCompletion).toMatchObject({ endingId: spec.endingId });
  expect(finalStep.questCompletion?.quest.launch).toBeUndefined();
  expect(JSON.stringify(finalStep.questCompletion)).not.toMatch(
    /clean three-cast lure line|a clean lure reaches/,
  );
  expect(finalStep.journey).toMatchObject({
    status: "awaiting_choice",
    goal: {
      id: "albany_local_lead",
      status: "completed",
    },
  });
  expect(finalStep.journey.goal.completedAtDecision).toBe(finalStep.journey.acceptedDecisions);
  expect(finalStep.journey.acceptedDecisions).toBeLessThan(45);
  expect(finalStep.journey.pendingChoice?.options[0]?.id).toBe("continue");
  expect(finalStep.journey.pendingChoice?.options[0]?.label).toBe(
    ALBANY_DAWN_DISPATCH_CONTINUE_LABEL,
  );
  expect(finalStep.journey.pendingChoice?.options[1]?.id).toBe("end");

  const finalState = api.get_state({
    session_id: launched.rpg_session_id,
    include_state: true,
  }).state;
  expect(finalState).toMatchObject({
    ended: true,
    endingId: spec.endingId,
    vars: { cattle_alarm: spec.finalAlarm },
    flags: {
      yearling_redirected: true,
      flank_redirected: true,
      leader_redirected: true,
    },
  });
  expect(finalState.flags.lure_trail_fouled).not.toBe(true);
  const ending = api.sessions
    .get(launched.rpg_session_id)
    .index.pack.endings.find((candidate) => candidate.id === spec.endingId);
  expect(ending?.death).not.toBe(true);

  const transcript = api.get_transcript({
    session_id: launched.rpg_session_id,
    summary_only: false,
    compact_events: false,
    compact_summary: false,
  });
  expect(transcript.turns.slice(1).map((turn) => turn.action_id)).toEqual(route);
  expect(transcript.turns[1]?.action_id).toBe(spec.lastMileAction);
  expect(transcript.summary.ending_id).toBe(spec.endingId);

  const completed = exportSession(api, overworldSessionId);
  expect(completed.snapshot.completedQuestIds).toEqual([WOLF.id]);
  expect(completed.snapshot.questOutcomes).toContainEqual([WOLF.id, spec.endingId]);
  expect(
    completed.snapshot.character.knowledge.filter(
      (knowledgeId) => knowledgeId === spec.knowledgeId || knowledgeId === spec.otherKnowledgeId,
    ),
  ).toEqual([spec.knowledgeId]);
  const completion = completed.snapshot.journalEntries.find(
    (entry) => entry.id === `quest_done:${WOLF.id}`,
  );
  expect(completion?.kind).toBe("quest_done");
  expect(completion?.text).toContain(
    `${spec.returnSummary} Registration complete. Rowan Quill records`,
  );
  expect(completion?.text).toMatch(/Promise kept: give a truthful account\.$/u);
  expect(completion?.questCompletionBoundary?.acceptedDecisions).toBe(
    finalStep.journey.acceptedDecisions,
  );

  const restored = api.restore_overworld_session({
    ...FULL,
    snapshot: completed.snapshot,
  });
  expect(restored.snapshot_hash).toBe(completed.snapshot_hash);
  const replayed = exportSession(api, restored.session_id);
  expect(replayed.snapshot).toEqual(completed.snapshot);
  expect(
    replayed.snapshot.journalEntries.find((entry) => entry.id === `quest:${WOLF.id}`)
      ?.questStartProof,
  ).toMatchObject({ kind: "approach", approachId: spec.approachId });
  expect(
    replayed.snapshot.journalEntries.find((entry) => entry.id === `quest_done:${WOLF.id}`)?.text,
  ).toBe(completion?.text);
  expect(replayed.snapshot.character.knowledge).toContain(spec.knowledgeId);
  expect(replayed.snapshot.character.knowledge).not.toContain(spec.otherKnowledgeId);

  return { completed, finalState, route };
}

function assertCompactLaunchProjection(
  api: ToolApi,
  parentSnapshot: unknown,
  spec: RouteSpec,
): void {
  const restored = api.restore_overworld_session({
    compact_context: true,
    compact_result: true,
    snapshot: parentSnapshot,
  });
  const compact = api.start_overworld_session_quest({
    compact_context: true,
    compact_result: true,
    compact_actions: true,
    compact_observation: true,
    include_actions: true,
    session_id: restored.session_id,
    quest_id: WOLF.id,
    approach_id: spec.approachId,
    seed: SEED,
  });
  const launch = compact.quest[3];
  if (!launch) throw new Error("expected a compact quest-launch projection");
  expect(launch[3]).toBe(spec.approachId);
  const option = launch[2].find((candidate) => candidate[0] === spec.approachId);
  expect(option?.slice(2, 11)).toEqual([
    spec.terms.minutes,
    spec.terms.supplies,
    spec.terms.fatigue,
    true,
    spec.after.minutes,
    spec.after.supplies,
    spec.after.fatigue,
    spec.after.travelCondition,
    null,
  ]);
  expectSanitizedQuestProjection(compact.quest, spec);
}

describe("SS-F07 — hill approach survives the full Wolf-Winter return", () => {
  it("forks one Albany dispatch into exact ridge and stockway consequences", () => {
    const api = createToolApi({ root: ROOT });
    const parent = buildAlbanyPreStartBoundary(api);
    expect(parent.exported.snapshot).toMatchObject({
      currentId: "albany_city",
      currentAreaId: QUEST_AREA,
      minutes: PARENT_MINUTES,
      supplies: PARENT_SUPPLIES,
      fatigue: PARENT_FATIGUE,
      startedQuestIds: [],
      completedQuestIds: [],
      journey: { acceptedDecisions: PARENT_DECISIONS },
    });
    expect(fullView(api, parent.sessionId).timeLabel).toBe("Day 1, 09:20");

    for (const approachId of [undefined, "albany:wolf_approach_unknown"] as const) {
      const before = exportSession(api, parent.sessionId);
      expect(() =>
        api.start_overworld_session_quest({
          ...FULL,
          compact_observation: false,
          session_id: parent.sessionId,
          quest_id: WOLF.id,
          ...(approachId === undefined ? {} : { approach_id: approachId }),
          seed: SEED,
        }),
      ).toThrow(
        approachId === undefined
          ? /Choose an approach_id before starting The Wolf-Winter.*: albany:wolf_approach_exposed_ridge, albany:wolf_approach_sheltered_stockway.$/
          : /Unknown quest launch approach "albany:wolf_approach_unknown"/,
      );
      expect(exportSession(api, parent.sessionId)).toEqual(before);
    }

    const ridgeFork = api.restore_overworld_session({
      ...FULL,
      snapshot: parent.exported.snapshot,
    });
    const stockwayFork = api.restore_overworld_session({
      ...FULL,
      snapshot: parent.exported.snapshot,
    });
    const ridgeBefore = exportSession(api, ridgeFork.session_id);
    const stockwayBefore = exportSession(api, stockwayFork.session_id);
    expect(ridgeBefore.snapshot).toEqual(parent.exported.snapshot);
    expect(stockwayBefore.snapshot).toEqual(ridgeBefore.snapshot);
    expect(ridgeBefore.snapshot_hash).toBe(stockwayBefore.snapshot_hash);

    const ridgeLaunch = launchFull(api, ridgeFork.session_id, ROUTES.ridge);
    const stockwayLaunch = launchFull(api, stockwayFork.session_id, ROUTES.stockway);
    expect(ridgeLaunch.rpg_session_id).toBe("r1");
    expect(stockwayLaunch.rpg_session_id).toBe("r2");
    assertFullLaunch(api, ridgeFork.session_id, ridgeLaunch, ROUTES.ridge);
    assertFullLaunch(api, stockwayFork.session_id, stockwayLaunch, ROUTES.stockway);

    const ridge = playCleanLure(api, ridgeFork.session_id, ridgeLaunch, ROUTES.ridge);
    const stockway = playCleanLure(api, stockwayFork.session_id, stockwayLaunch, ROUTES.stockway);
    expect(ridge.route.slice(1)).toEqual(stockway.route.slice(1));
    expect(ridge.finalState.vars.cattle_alarm).toBe(4);
    expect(stockway.finalState.vars.cattle_alarm).toBe(3);
    expect(ridge.finalState.endingId).toBe("ending_pack_diverted_cattle_scattered");
    expect(stockway.finalState.endingId).toBe("ending_pack_diverted");

    assertCompactLaunchProjection(api, parent.exported.snapshot, ROUTES.ridge);
    assertCompactLaunchProjection(api, parent.exported.snapshot, ROUTES.stockway);
  });
});
