/**
 * The route card keeps dispatch timing and the road's actual arrival tradeoff
 * visible without forecasting a strategy outcome before Cade discloses the
 * independent ground condition. Full, compact, browser, CLI, and MCP surfaces
 * share that neutral projection and preserve the authored preview exactly.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";

import { renderQuestLaunch } from "../../bin/overworld_play.js";
import { makeStep } from "../../src/core/engine.js";
import type { Rng } from "../../src/core/rng.js";
import type { GameState } from "../../src/core/state.js";
import { createToolApi } from "../../src/mcp/tools.js";
import {
  buildRpgRules,
  enumerateRpgActions,
  indexRpgPack,
  initStateForRpgPack,
} from "../../src/rpg/runner.js";
import { loadRpgSourceFile } from "../../src/rpg/source.js";
import { deriveQuestDispatchPresentationWindow } from "../../src/world/quest_dispatch_window.js";
import { loadOverworldManifest } from "../../src/world/source.js";
import { STATION_DISPATCH_BOARD_GUIDANCE_CHAR_LIMIT } from "../../src/world/station_dispatch_board.js";
import type { OverworldQuestView } from "../../src/world/session_local_discovery.js";
import { OverworldSession } from "../../src/world/session.js";
import {
  WOLF_HILL_ROUTE_TRADEOFF_SUMMARY_CHAR_LIMIT,
  wolfHillRoutePresentation,
  wolfHillRouteTradeoffParts,
} from "../../src/world/wolf_hill_route_presentation.js";
import { revealCurrentJourneyStoryOptions } from "../regression/support/journey_story.js";

const ROOT = process.cwd();
const WORLD = loadOverworldManifest(ROOT);
const WOLF_ID = "wolf_winter";
const RIDGE_ID = "albany:wolf_approach_exposed_ridge";
const STOCKWAY_ID = "albany:wolf_approach_sheltered_stockway";
const WOLF_QUEST =
  WORLD.quests.find((quest) => quest.id === WOLF_ID) ??
  (() => {
    throw new Error("The Albany starting slice requires Wolf-Winter.");
  })();
const AUTHORED_ROUTE_PREVIEWS = Object.fromEntries(
  WOLF_QUEST.launch?.options.map((option) => [option.id, option.preview]) ?? [],
) as Record<string, string | undefined>;
const WOLF_IMPORTS =
  WOLF_QUEST.campaign_imports ??
  (() => {
    throw new Error("Wolf-Winter requires campaign imports.");
  })();
const WOLF_SOURCE = loadRpgSourceFile("content/rpg/quests/wolf_winter.yaml");
if (!WOLF_SOURCE.ok) throw new Error("Wolf-Winter must compile.");
const WOLF_INDEX = indexRpgPack(WOLF_SOURCE.compiled.pack);
const NEUTRAL_RIDGE_SUMMARY =
  "Exposed Ridge — 30 minutes, 1 supply, +25 fatigue. Descending raises cattle alarm to 1, but you can see the byre and weather clearly. This road chooses no field plan.";
const NEUTRAL_STOCKWAY_SUMMARY =
  "Sheltered Stockway — 75 minutes, 2 supplies, +10 fatigue. Cattle alarm starts at 0, but hedges hide the byre and weather. This road chooses no field plan.";
const ROUTE_INDEPENDENCE_PREVIEW = "This road does not choose a field plan.";
const RIDGE_ENTRY_TIMING = "Descending raises cattle alarm to 1";

const ROUTE_CARD_CASES = [
  {
    label: "under full duty without Cade fodder",
    oathId: "albany:oath_full_compact_duty",
    reliefId: "albany:relief_resident_shelter",
    expected: {
      ridge: {
        alarm: 4,
      },
      stockway: {
        alarm: 3,
      },
    },
  },
  {
    label: "under full duty with Cade fodder",
    oathId: "albany:oath_full_compact_duty",
    reliefId: "albany:relief_cade_fodder",
    expected: {
      ridge: {
        alarm: 3,
      },
      stockway: {
        alarm: 3,
      },
    },
  },
  {
    label: "under aid-only without Cade fodder",
    oathId: "albany:oath_limited_aid_only",
    reliefId: "albany:relief_resident_shelter",
    expected: {
      ridge: {
        alarm: 3,
      },
      stockway: {
        alarm: 2,
      },
    },
  },
  {
    label: "under aid-only with Cade fodder",
    oathId: "albany:oath_limited_aid_only",
    reliefId: "albany:relief_cade_fodder",
    expected: {
      ridge: {
        alarm: 2,
      },
      stockway: {
        alarm: 2,
      },
    },
  },
] as const;

function areaPath(from: string, to: string): string[] {
  const queue: Array<{ area: string; routeIds: string[] }> = [{ area: from, routeIds: [] }];
  const seen = new Set([from]);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    if (current.area === to) return current.routeIds;
    for (const edge of WORLD.area_edges.filter(
      (candidate) => candidate.from_area === current.area || candidate.to_area === current.area,
    )) {
      const next = edge.from_area === current.area ? edge.to_area : edge.from_area;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push({ area: next, routeIds: [...current.routeIds, edge.id] });
    }
  }
  throw new Error(`No Albany area path from ${from} to ${to}.`);
}

function moveToArea(session: OverworldSession, areaId: string): void {
  const currentAreaId = session.view().currentArea?.id;
  if (!currentAreaId || currentAreaId === areaId) return;
  for (const routeId of areaPath(currentAreaId, areaId)) {
    let view = session.view();
    let route = view.areaExits.find((candidate) => candidate.id === routeId);
    if (!route || !view.discoveredAreaIds.includes(route.destination.id)) {
      session.exploreArea(view.currentArea!.id);
      view = session.view();
      route = view.areaExits.find((candidate) => candidate.id === routeId);
    }
    if (!route || !view.discoveredAreaIds.includes(route.destination.id)) {
      throw new Error(`Expected a visible mapped route to ${areaId}.`);
    }
    session.moveArea(route.id);
  }
}

function routeCard(
  oathChoiceId: string,
  reliefChoiceId: string,
  choices: Readonly<{
    registrationId?: string;
    sourceId?: string;
    preparationId?: string;
    allyId?: string;
  }> = {},
): {
  session: OverworldSession;
  quest: OverworldQuestView;
} {
  const session = new OverworldSession(WORLD);
  const opening = session.view();
  session.scoutPoi(opening.pois[0]!.id);
  session.talkToCharacter(WORLD.opening_registration!.contact);
  session.chooseJourneyStory(choices.registrationId ?? "albany:ledger_advocate");
  revealCurrentJourneyStoryOptions(session, WORLD.opening_relief_oath!.id);
  session.chooseJourneyStory(oathChoiceId);
  session.chooseJourneyStory(choices.sourceId ?? "albany:source_rowan_civic_docket");
  moveToArea(session, WORLD.opening_preparation!.area);
  session.chooseJourneyStory(choices.preparationId ?? "albany:prep_works_fortification");
  session.chooseJourneyStory(reliefChoiceId);
  if (choices.allyId) {
    session.talkToCharacter(WORLD.opening_ally!.contact);
    session.chooseJourneyStory(choices.allyId);
  }

  const quest = session.view().quests.find((candidate) => candidate.id === WOLF_ID);
  if (!quest?.launch) throw new Error("Expected the pre-commitment Wolf-Winter route card.");
  return { session, quest };
}

function dispatchBriefing(session: OverworldSession): string {
  const ridge = session.prepareQuestStart(WOLF_ID, RIDGE_ID).dispatchWindow;
  const stockway = session.prepareQuestStart(WOLF_ID, STOCKWAY_ID).dispatchWindow;
  expect(stockway).toEqual(ridge);
  const presentation = deriveQuestDispatchPresentationWindow({
    questId: WOLF_ID,
    journalEntries: session.snapshot().journalEntries,
    openingRegistration: WORLD.opening_registration!,
    openingReliefOath: WORLD.opening_relief_oath!,
    openingLeadSource: WORLD.opening_lead_source!,
    openingPreparation: WORLD.opening_preparation!,
    openingReliefAllocation: WORLD.opening_relief_allocation!,
    openingAlly: WORLD.opening_ally!,
  });
  if (presentation.status === "support_choices_open") {
    const { minimum, maximum } = presentation.finalMinutes;
    const finalRange =
      minimum === maximum ? `${String(minimum)}m` : `${String(minimum)}–${String(maximum)}m`;
    const timing =
      minimum > 60 ? "already late" : maximum <= 60 ? "all on time" : "support can delay dispatch";
    return (
      `Background, promise, and report are set. Current setup: ${String(presentation.committedMinutes)}m. ` +
      `Final setup: ${finalRange}; ${timing}. Optional support remains. ` +
      "Start Wolf-Winter to skip it."
    );
  }
  if (ridge.status === "delayed" && ridge.ledgerMinutes !== undefined) {
    return (
      `Setup took ${String(ridge.ledgerMinutes)}m, so the dispatch is late. Roads change arrival costs only. ` +
      "The first failed LURE, DRIVE, or HUNT raises cattle alarm by 1; a failed FORTIFY raises winter pressure by 1."
    );
  }
  if (ridge.status === "on_time" && ridge.ledgerMinutes !== undefined) {
    return (
      `Setup took ${String(ridge.ledgerMinutes)}m, so the dispatch is on time. Roads change arrival costs only. ` +
      "No late-dispatch penalty applies."
    );
  }
  return (
    "Dispatch timing is unverified. Roads change arrival costs only. " +
    "No late-dispatch penalty applies."
  );
}

function fullSummaries(quest: OverworldQuestView): Record<string, string | undefined> {
  return Object.fromEntries(
    quest.launch?.options.map((option) => [option.id, option.tradeoffSummary]) ?? [],
  );
}

function compactSummaries(session: OverworldSession): Record<string, string | null> {
  const compactQuest = (session.compactView().quests ?? []).find(
    ([questId]) => questId === WOLF_ID,
  );
  const launch = compactQuest?.[3];
  if (!launch) throw new Error("Expected the compact Wolf-Winter route card.");
  return Object.fromEntries(launch[2].map((option) => [option[0], option[13]]));
}

function expectCompactSharedDispatchOnce(
  session: OverworldSession,
  full: Record<string, string | undefined>,
  briefing: string,
): Record<string, string | null> {
  const compact = session.compactView();
  expect(compact.station_dispatch_board?.[2]).toBe(briefing);
  const summaries = compactSummaries(session);
  for (const optionId of [RIDGE_ID, STOCKWAY_ID]) {
    const canonical = full[optionId];
    if (!canonical) throw new Error(`Expected canonical route summary ${optionId}.`);
    expect(canonical.startsWith(`${briefing} `)).toBe(true);
    expect(summaries[optionId]).toBe(wolfHillRouteTradeoffParts(canonical)?.routeSummary);
  }
  expect(
    JSON.stringify({
      quests: compact.quests,
      quest_starts: compact.quest_starts,
      station_dispatch_board: compact.station_dispatch_board,
    }).split(briefing).length - 1,
  ).toBe(1);
  return summaries;
}

function compactPreview(session: OverworldSession, optionId: string): string | null {
  const compactQuest = (session.compactView().quests ?? []).find(
    ([questId]) => questId === WOLF_ID,
  );
  const option = compactQuest?.[3]?.[2].find(([id]) => id === optionId);
  if (!option) throw new Error(`Expected compact route option ${optionId}.`);
  return option[11];
}

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

function fixedRng(face: "best" | "worst"): Rng {
  return {
    next: () => (face === "best" ? 0.999999 : 0),
    int: (min, max) => (face === "best" ? max : min),
  };
}

function actRpg(state: GameState, actionId: string, face: "best" | "worst" = "best"): GameState {
  const actions = enumerateRpgActions(WOLF_INDEX, state);
  const option = actions.find((candidate) => candidate.id === actionId);
  expect(
    option,
    `${actionId} must be legal in ${state.current}; legal: ${actions
      .map((candidate) => candidate.id)
      .join(", ")}`,
  ).toBeDefined();
  if (!option) throw new Error(`Missing action ${actionId}.`);
  const result = makeStep(buildRpgRules(WOLF_INDEX, () => fixedRng(face)))(state, option.action);
  expect(result.ok, result.rejectionReason).toBe(true);
  return result.state;
}

function playForecastedFailedFirstCast(
  parent: OverworldSession,
  approachId: typeof RIDGE_ID | typeof STOCKWAY_ID,
): { alarm: number; recoveryAction: string | null } {
  const plan = parent.prepareQuestStart(WOLF_ID, approachId);
  let state = initStateForRpgPack(WOLF_INDEX, 72748, {
    character: plan.characterAfter,
    imports: WOLF_IMPORTS,
  });
  if (plan.dispatchWindow.status === "delayed") {
    state.flags.dispatch_opening_delayed = true;
  }
  const lastMile =
    approachId === RIDGE_ID ? "use_exposed_ridge_last_mile" : "use_sheltered_stockway_last_mile";
  for (const actionId of [
    lastMile,
    "talk_houndsman",
    "ask_lure",
    "ask_commit_lure",
    "ask_leave",
    "go_west",
    "take_winter_feed_sack",
    "go_east",
    "go_north",
  ]) {
    state = actRpg(state, actionId);
  }
  state = actRpg(state, "use_winter_feed_sack_on_downwind_feed_line", "worst");
  const recovery = enumerateRpgActions(WOLF_INDEX, state).find((option) =>
    ["set_paling_rail", "wedge_paling_rail"].includes(option.id),
  );
  return {
    alarm: state.vars.cattle_alarm ?? -1,
    recoveryAction: recovery?.id ?? null,
  };
}

function playForecastedCleanLure(
  parent: OverworldSession,
  approachId: typeof RIDGE_ID | typeof STOCKWAY_ID,
): { alarm: number; endingId: string | null } {
  const api = createToolApi({ root: ROOT });
  const restored = api.restore_overworld_session({
    compact_context: false,
    compact_result: false,
    snapshot: parent.snapshot(),
  });
  const launched = api.start_overworld_session_quest({
    compact_context: false,
    compact_result: false,
    compact_observation: false,
    compact_actions: false,
    include_actions: true,
    session_id: restored.session_id,
    quest_id: WOLF_ID,
    approach_id: approachId,
    seed: 26,
  });
  const lastMile =
    approachId === RIDGE_ID ? "use_exposed_ridge_last_mile" : "use_sheltered_stockway_last_mile";
  for (const actionId of [lastMile, ...CLEAN_LURE_TAIL]) {
    const step = api.step_action({
      session_id: launched.rpg_session_id,
      action_id: actionId,
      compact_observation: false,
      compact_events: false,
    });
    expect(step.ok, step.rejection_reason).toBe(true);
  }
  const state = api.get_state({
    session_id: launched.rpg_session_id,
    include_state: true,
  }).state;
  return {
    alarm: state.vars.cattle_alarm ?? -1,
    endingId: state.endingId,
  };
}

describe("Wolf-Winter conditional route tradeoff projection", () => {
  let server: ViteDevServer;
  let renderQuestNotice: (quest: OverworldQuestView) => string;

  beforeAll(async () => {
    const uiRoot = resolve(ROOT, "ui");
    server = await createServer({
      root: uiRoot,
      configFile: resolve(uiRoot, "vite.config.ts"),
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    const module = (await server.ssrLoadModule("/src/App.tsx")) as { QuestNotice: unknown };
    const requireFromUi = createRequire(resolve(uiRoot, "package.json"));
    const react = requireFromUi("react") as {
      createElement: (type: unknown, props: Record<string, unknown>) => unknown;
    };
    const reactDomServer = requireFromUi("react-dom/server") as {
      renderToStaticMarkup: (element: unknown) => string;
    };
    renderQuestNotice = (quest) =>
      reactDomServer.renderToStaticMarkup(
        react.createElement(module.QuestNotice, {
          quest,
          areaName: "Station Quarter",
          onStart: () => undefined,
        }),
      );
  }, 30_000);

  afterAll(async () => {
    await server.close();
  });

  it.each(ROUTE_CARD_CASES)(
    "keeps decisive full, compact, UI, and CLI terms exact $label",
    ({ oathId, reliefId, expected }) => {
      const { session, quest } = routeCard(oathId, reliefId);
      const briefing = dispatchBriefing(session);
      const ridgeFailure = playForecastedFailedFirstCast(session, RIDGE_ID);
      const stockwayFailure = playForecastedFailedFirstCast(session, STOCKWAY_ID);
      expect(ridgeFailure).toEqual({ alarm: 3, recoveryAction: "set_paling_rail" });
      expect(stockwayFailure).toEqual({ alarm: 2, recoveryAction: "set_paling_rail" });
      const expectedRidgeSummary = `${briefing} ${NEUTRAL_RIDGE_SUMMARY}`;
      const expectedStockwaySummary = `${briefing} ${NEUTRAL_STOCKWAY_SUMMARY}`;
      const snapshotBeforeProjection = session.snapshot();
      const full = fullSummaries(quest);
      const compact = expectCompactSharedDispatchOnce(session, fullSummaries(quest), briefing);
      const api = createToolApi({ root: ROOT });
      const restored = api.restore_overworld_session({
        compact_context: false,
        compact_result: false,
        snapshot: snapshotBeforeProjection,
      });
      const mcpQuest = api
        .get_overworld_session({
          session_id: restored.session_id,
          include_observation: true,
        })
        .observation.quests.find((candidate) => candidate.id === WOLF_ID);
      if (!mcpQuest?.launch) throw new Error("Expected the full MCP Wolf-Winter route card.");

      expect(full).toMatchObject({
        [RIDGE_ID]: expectedRidgeSummary,
        [STOCKWAY_ID]: expectedStockwaySummary,
      });
      expect(compact).toEqual({
        [RIDGE_ID]: NEUTRAL_RIDGE_SUMMARY,
        [STOCKWAY_ID]: NEUTRAL_STOCKWAY_SUMMARY,
      });
      expect(fullSummaries(mcpQuest)).toMatchObject({
        [RIDGE_ID]: expectedRidgeSummary,
        [STOCKWAY_ID]: expectedStockwaySummary,
      });
      for (const summary of [expectedRidgeSummary, expectedStockwaySummary]) {
        expect(summary.length).toBeLessThanOrEqual(WOLF_HILL_ROUTE_TRADEOFF_SUMMARY_CHAR_LIMIT);
      }

      const markup = renderQuestNotice(quest);
      const normalizedMarkup = markup.replaceAll("&#x27;", "'");
      expect(markup.match(/Tradeoff:/g)).toHaveLength(2);
      expect(markup).toContain(expectedRidgeSummary);
      expect(markup).toContain(expectedStockwaySummary);
      expect(markup).not.toContain("...");

      const cli = renderQuestLaunch(quest);
      expect(cli.match(/Tradeoff:/g)).toHaveLength(2);
      expect(cli).toContain(expectedRidgeSummary);
      expect(cli).toContain(expectedStockwaySummary);

      const ridgePreview = quest.launch?.options.find((option) => option.id === RIDGE_ID)?.preview;
      const stockwayPreview = quest.launch?.options.find(
        (option) => option.id === STOCKWAY_ID,
      )?.preview;
      const mcpRidgePreview = mcpQuest.launch.options.find(
        (option) => option.id === RIDGE_ID,
      )?.preview;
      const mcpStockwayPreview = mcpQuest.launch.options.find(
        (option) => option.id === STOCKWAY_ID,
      )?.preview;
      expect(ridgePreview).toBe(AUTHORED_ROUTE_PREVIEWS[RIDGE_ID]);
      expect(mcpRidgePreview).toBe(AUTHORED_ROUTE_PREVIEWS[RIDGE_ID]);
      expect(stockwayPreview).toBe(AUTHORED_ROUTE_PREVIEWS[STOCKWAY_ID]);
      expect(mcpStockwayPreview).toBe(AUTHORED_ROUTE_PREVIEWS[STOCKWAY_ID]);
      for (const surface of [ridgePreview, mcpRidgePreview, normalizedMarkup, cli]) {
        expect(surface).toContain(ROUTE_INDEPENDENCE_PREVIEW);
      }
      expect(compactPreview(session, RIDGE_ID)).toBeNull();
      for (const surface of [stockwayPreview, mcpStockwayPreview, normalizedMarkup, cli]) {
        expect(surface).toContain(ROUTE_INDEPENDENCE_PREVIEW);
      }
      expect(compactPreview(session, STOCKWAY_ID)).toBeNull();
      for (const surface of [
        expectedRidgeSummary,
        expectedStockwaySummary,
        ridgePreview,
        stockwayPreview,
        mcpRidgePreview,
        mcpStockwayPreview,
        normalizedMarkup,
        cli,
      ]) {
        expect(surface).not.toMatch(
          /lure|first cast|clean-cast|clean lure reaches|whole herd|scatters two cattle|fouled first cast|feed spent|fodder|aid-only/i,
        );
      }
      expect(full[RIDGE_ID]).toContain(RIDGE_ENTRY_TIMING);
      expect(compact[RIDGE_ID]).toContain(RIDGE_ENTRY_TIMING);
      expect(fullSummaries(mcpQuest)[RIDGE_ID]).toContain(RIDGE_ENTRY_TIMING);
      expect(markup).toContain(RIDGE_ENTRY_TIMING);
      expect(cli).toContain(RIDGE_ENTRY_TIMING);

      const ridgeRuntime = playForecastedCleanLure(session, RIDGE_ID);
      const stockwayRuntime = playForecastedCleanLure(session, STOCKWAY_ID);
      expect(ridgeRuntime).toEqual({
        alarm: expected.ridge.alarm,
        endingId:
          expected.ridge.alarm >= 4
            ? "ending_pack_diverted_cattle_scattered"
            : "ending_pack_diverted",
      });
      expect(stockwayRuntime).toEqual({
        alarm: expected.stockway.alarm,
        endingId:
          expected.stockway.alarm >= 4
            ? "ending_pack_diverted_cattle_scattered"
            : "ending_pack_diverted",
      });
      expect(full[RIDGE_ID]).not.toContain(`alarm ${ridgeRuntime.alarm}`);
      expect(full[STOCKWAY_ID]).not.toContain(`alarm ${stockwayRuntime.alarm}`);
      expect(session.snapshot()).toEqual(snapshotBeforeProjection);
    },
  );

  it("keeps route projection invariant to preselected LURE support", () => {
    const knowledgeSets = [
      [],
      ["albany:knowledge_relief_cade_fodder"],
      ["albany:knowledge_wolf_limited_aid_only"],
      ["albany:knowledge_relief_cade_fodder", "albany:knowledge_wolf_limited_aid_only"],
    ];
    for (const optionId of [RIDGE_ID, STOCKWAY_ID]) {
      const projections = knowledgeSets.map((knowledgeIds) =>
        wolfHillRoutePresentation({
          launchId: "albany:wolf_hill_approach",
          optionId,
          knowledgeIds,
        }),
      );
      expect(new Set(projections.map((projection) => projection?.tradeoffSummary))).toHaveLength(1);
      for (const projection of projections) {
        expect(projection).not.toHaveProperty("previewOverride");
        expect(projection?.tradeoffSummary).not.toMatch(
          /lure|fodder|aid-only|clean-cast|whole herd|scatters two cattle|fouled first cast|feed spent/i,
        );
        expect(projection?.tradeoffSummary.length).toBeLessThanOrEqual(
          WOLF_HILL_ROUTE_TRADEOFF_SUMMARY_CHAR_LIMIT,
        );
      }
    }
  });

  it("shows a delayed certified dispatch identically before either road commitment", () => {
    const { session, quest } = routeCard(
      "albany:oath_full_compact_duty",
      "albany:relief_resident_shelter",
      {
        registrationId: "albany:road_warden",
        sourceId: "albany:source_jamie_market_testimony",
        allyId: "albany:ally_june_cattle_first",
      },
    );
    const expectedBriefing =
      "Setup took 90m, so the dispatch is late. Roads change arrival costs only. " +
      "The first failed LURE, DRIVE, or HUNT raises cattle alarm by 1; a failed FORTIFY raises winter pressure by 1.";
    expect(dispatchBriefing(session)).toBe(expectedBriefing);

    const full = fullSummaries(quest);
    const compact = expectCompactSharedDispatchOnce(session, full, expectedBriefing);
    const ridgeFailure = playForecastedFailedFirstCast(session, RIDGE_ID);
    const stockwayFailure = playForecastedFailedFirstCast(session, STOCKWAY_ID);
    expect(ridgeFailure).toEqual({ alarm: 4, recoveryAction: "set_paling_rail" });
    expect(stockwayFailure).toEqual({ alarm: 3, recoveryAction: "set_paling_rail" });
    expect(full[RIDGE_ID]).not.toMatch(/fouled first cast|feed spent|recovery remains/i);
    expect(full[STOCKWAY_ID]).not.toMatch(/fouled first cast|feed spent|recovery remains/i);
    const delayedWindow = session.prepareQuestStart(WOLF_ID, RIDGE_ID).dispatchWindow;
    const delayedSummariesBySupport: Record<string, string[]> = {
      [RIDGE_ID]: [],
      [STOCKWAY_ID]: [],
    };
    for (const knowledgeIds of [
      [],
      ["albany:knowledge_relief_cade_fodder"],
      ["albany:knowledge_wolf_limited_aid_only"],
      ["albany:knowledge_relief_cade_fodder", "albany:knowledge_wolf_limited_aid_only"],
    ]) {
      for (const optionId of [RIDGE_ID, STOCKWAY_ID]) {
        const projection = wolfHillRoutePresentation({
          launchId: "albany:wolf_hill_approach",
          optionId,
          knowledgeIds,
          dispatchWindow: delayedWindow,
        });
        expect(projection?.tradeoffSummary).not.toMatch(
          /fouled first cast|feed spent|recovery remains|clean lure reaches|whole herd|scatters two cattle/i,
        );
        if (projection) delayedSummariesBySupport[optionId]!.push(projection.tradeoffSummary);
        expect(projection?.tradeoffSummary.length).toBeLessThanOrEqual(
          WOLF_HILL_ROUTE_TRADEOFF_SUMMARY_CHAR_LIMIT,
        );
      }
    }
    expect(new Set(delayedSummariesBySupport[RIDGE_ID])).toHaveLength(1);
    expect(new Set(delayedSummariesBySupport[STOCKWAY_ID])).toHaveLength(1);
    for (const optionId of [RIDGE_ID, STOCKWAY_ID]) {
      expect(full[optionId]?.startsWith(expectedBriefing)).toBe(true);
      expect(compact[optionId]).toBe(
        optionId === RIDGE_ID ? NEUTRAL_RIDGE_SUMMARY : NEUTRAL_STOCKWAY_SUMMARY,
      );
    }

    const api = createToolApi({ root: ROOT });
    const restored = api.restore_overworld_session({
      compact_context: false,
      compact_result: false,
      snapshot: session.snapshot(),
    });
    const mcpQuest = api
      .get_overworld_session({
        session_id: restored.session_id,
        include_observation: true,
      })
      .observation.quests.find((candidate) => candidate.id === WOLF_ID);
    if (!mcpQuest?.launch) throw new Error("Expected the full MCP Wolf-Winter route card.");
    expect(fullSummaries(mcpQuest)).toEqual(full);

    const launched = api.start_overworld_session_quest({
      compact_context: false,
      compact_result: false,
      compact_observation: false,
      compact_actions: false,
      include_actions: true,
      session_id: restored.session_id,
      quest_id: WOLF_ID,
      approach_id: RIDGE_ID,
      seed: 726,
    });
    const launchedState = api.get_state({
      session_id: launched.rpg_session_id,
      include_state: true,
    }).state;
    expect(launchedState.flags.dispatch_opening_delayed).toBe(true);
    expect(launchedState.embeddedLaunchOverlayReceipt).toMatchObject({
      world_quest_id: WOLF_ID,
      status: "delayed",
      ledger_minutes: 90,
      applied_flag: "dispatch_opening_delayed",
    });

    const markup = renderQuestNotice(quest);
    const cli = renderQuestLaunch(quest);
    expect(markup.split(expectedBriefing)).toHaveLength(3);
    expect(cli.split(expectedBriefing)).toHaveLength(3);
  });

  it("keeps a sealed on-time dispatch briefing once in the compact Station projection", () => {
    const { session, quest } = routeCard(
      "albany:oath_full_compact_duty",
      "albany:relief_resident_shelter",
      {
        registrationId: "albany:road_warden",
        sourceId: "albany:source_rowan_civic_docket",
        preparationId: "albany:prep_works_fortification",
        allyId: "albany:ally_june_cattle_first",
      },
    );
    const briefing =
      "Setup took 55m, so the dispatch is on time. Roads change arrival costs only. " +
      "No late-dispatch penalty applies.";
    expect(dispatchBriefing(session)).toBe(briefing);
    const full = fullSummaries(quest);
    expectCompactSharedDispatchOnce(session, full, briefing);
    expect(full[RIDGE_ID]).toBe(`${briefing} ${NEUTRAL_RIDGE_SUMMARY}`);
    expect(full[STOCKWAY_ID]).toBe(`${briefing} ${NEUTRAL_STOCKWAY_SUMMARY}`);
  });

  it("keeps the exact 65m open-support → 80m sealed dispatch trace truthful on every surface", () => {
    const { session, quest: beforeJune } = routeCard(
      "albany:oath_limited_aid_only",
      "albany:relief_resident_shelter",
      {
        registrationId: "albany:road_warden",
        sourceId: "albany:source_jamie_market_testimony",
        preparationId: "albany:prep_drover_route",
      },
    );
    const beforeBriefing =
      "Background, promise, and report are set. Current setup: 65m. Final setup: 65–80m; already late. " +
      "Optional support remains. Start Wolf-Winter to skip it.";
    for (const summary of Object.values(fullSummaries(beforeJune))) {
      expect(summary?.startsWith(beforeBriefing)).toBe(true);
    }

    session.talkToCharacter(WORLD.opening_ally!.contact);
    expect(session.view().questStarts).toEqual([]);
    expect(session.compactView().quest_starts).toBeUndefined();
    const pendingQuest = session.view().quests.find((candidate) => candidate.id === WOLF_ID);
    if (!pendingQuest?.launch) throw new Error("Expected the pending-June Wolf route card.");
    const pendingBriefing =
      "Background, promise, and report are set. Current setup: 65m. Final setup: 65–80m; already late. " +
      "Optional support remains. Start Wolf-Winter to skip it.";
    const pendingFull = fullSummaries(pendingQuest);
    const pendingCompact = compactSummaries(session);
    for (const optionId of [RIDGE_ID, STOCKWAY_ID]) {
      expect(pendingFull[optionId]?.startsWith(pendingBriefing)).toBe(true);
      expect(pendingCompact[optionId]).toBe(pendingFull[optionId]);
      expect(pendingFull[optionId]).not.toMatch(
        /unverified|neutral|no opening-delay failure pressure|fouled first cast/i,
      );
      expect(pendingFull[optionId]?.length).toBeLessThanOrEqual(
        WOLF_HILL_ROUTE_TRADEOFF_SUMMARY_CHAR_LIMIT,
      );
    }

    const pendingWindow = deriveQuestDispatchPresentationWindow({
      questId: WOLF_ID,
      journalEntries: session.snapshot().journalEntries,
      openingRegistration: WORLD.opening_registration!,
      openingReliefOath: WORLD.opening_relief_oath!,
      openingLeadSource: WORLD.opening_lead_source!,
      openingPreparation: WORLD.opening_preparation!,
      openingReliefAllocation: WORLD.opening_relief_allocation!,
      openingAlly: WORLD.opening_ally!,
    });
    expect(pendingWindow).toMatchObject({
      status: "support_choices_open",
      committedMinutes: 65,
      finalMinutes: { minimum: 65, maximum: 80 },
      receipt: { juneCommitment: { kind: "open_optional" } },
    });
    for (const knowledgeIds of [
      [],
      ["albany:knowledge_relief_cade_fodder"],
      ["albany:knowledge_wolf_limited_aid_only"],
      ["albany:knowledge_relief_cade_fodder", "albany:knowledge_wolf_limited_aid_only"],
    ]) {
      for (const optionId of [RIDGE_ID, STOCKWAY_ID]) {
        const projection = wolfHillRoutePresentation({
          launchId: "albany:wolf_hill_approach",
          optionId,
          knowledgeIds,
          dispatchWindow: pendingWindow,
        });
        expect(projection?.tradeoffSummary.startsWith(pendingBriefing)).toBe(true);
        expect(projection?.tradeoffSummary).not.toMatch(/unverified|fouled first cast/i);
        expect(projection?.tradeoffSummary.length).toBeLessThanOrEqual(
          WOLF_HILL_ROUTE_TRADEOFF_SUMMARY_CHAR_LIMIT,
        );
      }
    }

    const pendingMarkup = renderQuestNotice(pendingQuest);
    const pendingCli = renderQuestLaunch(pendingQuest);
    expect(pendingMarkup.match(/Start Wolf-Winter to skip it\./g)).toHaveLength(2);
    expect(pendingCli.split(pendingBriefing)).toHaveLength(3);
    const api = createToolApi({ root: ROOT });
    const restored = api.restore_overworld_session({
      compact_context: false,
      compact_result: false,
      snapshot: session.snapshot(),
    });
    const restoredQuest = api
      .get_overworld_session({
        session_id: restored.session_id,
        include_observation: true,
      })
      .observation.quests.find((candidate) => candidate.id === WOLF_ID);
    if (!restoredQuest?.launch) throw new Error("Expected restored pending-June route card.");
    expect(fullSummaries(restoredQuest)).toEqual(pendingFull);

    const strictWindow = session.prepareQuestStart(WOLF_ID, RIDGE_ID).dispatchWindow;
    expect(strictWindow).toMatchObject({
      status: "delayed",
      ledgerMinutes: 65,
      receipt: { juneCommitment: { kind: "declined_at_launch" } },
    });

    session.chooseJourneyStory("albany:ally_june_cattle_first");
    const afterJune = session.view().quests.find((candidate) => candidate.id === WOLF_ID);
    if (!afterJune?.launch) throw new Error("Expected the final June route card.");
    const afterBriefing =
      "Setup took 80m, so the dispatch is late. Roads change arrival costs only. " +
      "The first failed LURE, DRIVE, or HUNT raises cattle alarm by 1; a failed FORTIFY raises winter pressure by 1.";
    for (const summary of Object.values(fullSummaries(afterJune))) {
      expect(summary?.startsWith(afterBriefing)).toBe(true);
      expect(summary).not.toContain(pendingBriefing);
    }
  });

  it.each([
    {
      label: "guaranteed on time",
      oathId: "albany:oath_full_compact_duty",
      sourceId: "albany:source_rowan_civic_docket",
      preparationId: "albany:prep_works_fortification",
      committedMinutes: 40,
      maximumMinutes: 55,
      expectedBriefing:
        "Background, promise, and report are set. Current setup: 40m. Final setup: 40–55m; all on time. Optional support remains. Start Wolf-Winter to skip it.",
      expectedBytes: 152,
    },
    {
      label: "threshold crossing",
      oathId: "albany:oath_unaffiliated_personal_bond",
      sourceId: "albany:source_jamie_market_testimony",
      preparationId: "albany:prep_drover_route",
      committedMinutes: 60,
      maximumMinutes: 75,
      expectedBriefing:
        "Background, promise, and report are set. Current setup: 60m. Final setup: 60–75m; support can delay dispatch. Optional support remains. Start Wolf-Winter to skip it.",
      expectedBytes: 167,
    },
    {
      label: "guaranteed delayed",
      oathId: "albany:oath_limited_aid_only",
      sourceId: "albany:source_jamie_market_testimony",
      preparationId: "albany:prep_drover_route",
      committedMinutes: 65,
      maximumMinutes: 80,
      expectedBriefing:
        "Background, promise, and report are set. Current setup: 65m. Final setup: 65–80m; already late. Optional support remains. Start Wolf-Winter to skip it.",
      expectedBytes: 153,
    },
  ])(
    "classifies an open field-team range that is $label without inventing a final forecast",
    ({
      oathId,
      sourceId,
      preparationId,
      committedMinutes,
      maximumMinutes,
      expectedBriefing,
      expectedBytes,
    }) => {
      const { session } = routeCard(oathId, "albany:relief_resident_shelter", {
        registrationId: "albany:road_warden",
        sourceId,
        preparationId,
      });
      const boardQuest = session.view().quests.find((candidate) => candidate.id === WOLF_ID);
      if (!boardQuest?.launch) throw new Error("Expected the open-support route card.");
      const briefing = dispatchBriefing(session);
      expect(briefing).toBe(expectedBriefing);
      expect(Buffer.byteLength(briefing, "utf8")).toBe(expectedBytes);
      expect(briefing.length).toBeLessThanOrEqual(STATION_DISPATCH_BOARD_GUIDANCE_CHAR_LIMIT);
      expectCompactSharedDispatchOnce(session, fullSummaries(boardQuest), briefing);

      session.talkToCharacter(WORLD.opening_ally!.contact);
      const pendingWindow = deriveQuestDispatchPresentationWindow({
        questId: WOLF_ID,
        journalEntries: session.snapshot().journalEntries,
        openingRegistration: WORLD.opening_registration!,
        openingReliefOath: WORLD.opening_relief_oath!,
        openingLeadSource: WORLD.opening_lead_source!,
        openingPreparation: WORLD.opening_preparation!,
        openingReliefAllocation: WORLD.opening_relief_allocation!,
        openingAlly: WORLD.opening_ally!,
      });
      expect(pendingWindow).toMatchObject({
        status: "support_choices_open",
        committedMinutes,
        finalMinutes: { minimum: committedMinutes, maximum: maximumMinutes },
        receipt: { juneCommitment: { kind: "open_optional" } },
      });
      const pendingQuest = session.view().quests.find((candidate) => candidate.id === WOLF_ID);
      if (!pendingQuest?.launch) throw new Error("Expected the pending field-team route card.");
      for (const summary of Object.values(fullSummaries(pendingQuest))) {
        expect(summary?.startsWith(briefing)).toBe(true);
      }
      for (const optionId of [RIDGE_ID, STOCKWAY_ID]) {
        const summary = wolfHillRoutePresentation({
          launchId: "albany:wolf_hill_approach",
          optionId,
          dispatchWindow: pendingWindow,
        })?.tradeoffSummary;
        expect(summary).toContain(expectedBriefing);
        expect(summary).not.toMatch(/unverified|fouled first cast/i);
        expect(summary?.length).toBeLessThanOrEqual(WOLF_HILL_ROUTE_TRADEOFF_SUMMARY_CHAR_LIMIT);
      }
    },
  );
});
