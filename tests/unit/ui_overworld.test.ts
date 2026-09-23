import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createServer } from "vite";
import { buildCampaignCharacterState } from "../../src/world/campaign_character_state.js";
import { buildCampaignCharacterView } from "../../src/world/campaign_character_view.js";
import type { OverworldManifest } from "../../src/world/overworld.js";
import { loadOverworldManifest } from "../../src/world/source.js";
import {
  OVERWORLD_COMPACT_COMPLETED_ARC_LIMIT,
  OVERWORLD_COMPACT_LABEL_CHAR_LIMIT,
  OVERWORLD_COMPACT_LOCAL_REF_LIMIT,
  OVERWORLD_COMPACT_MOVEMENT_LIMIT,
  OVERWORLD_COMPACT_RENOWN_LIMIT,
  OVERWORLD_COMPACT_RISK_CHAR_LIMIT,
  OVERWORLD_COMPACT_ROAD_EVENT_SUMMARY_CHAR_LIMIT,
  OVERWORLD_COMPACT_ROUTE_STEP_LIMIT,
  OVERWORLD_COMPACT_SERVICE_SUMMARY_CHAR_LIMIT,
  OVERWORLD_COMPACT_TITLE_CHAR_LIMIT,
  OVERWORLD_COMPACT_VIEW_VERSION,
  cloneOverworldCompactView,
  compactRouteOption,
  compactOverworldView,
} from "../../src/world/compact_view.js";
import { buildOverworldSessionCompactView } from "../../src/world/session_compact_view.js";
import { OVERWORLD_CONTENT_HASH_MISMATCH_WARNING } from "../../src/world/session_snapshot_restore.js";
import { questCompletionMinutes } from "../../src/world/session_quests.js";
import {
  INITIAL_JOURNEY_GOAL_GUIDANCE,
  type JourneyPresentation,
} from "../../src/world/journey_contract.js";
import { cloneOverworldView } from "../../src/world/session_view_clone.js";
import type { OverworldQuestView } from "../../src/world/session_local_discovery.js";
import {
  OverworldSession,
  OverworldSession as UiOverworldSession,
} from "../../ui/src/overworld.js";
import { revealCurrentJourneyStoryOptions } from "../regression/support/journey_story.js";

const world = loadOverworldManifest(process.cwd());

function populatedUiCharacter() {
  return buildCampaignCharacterView(
    buildCampaignCharacterState({
      background: "background:road_warden",
      skills: [{ skillId: "skill:fieldcraft", rank: 3 }],
      values: [{ valueId: "value:keep_promises", strength: 4 }],
      health: { current: 23, max: 30 },
      wounds: [{ woundId: "wound:wolf_bite", severity: 2, treatment: "stabilized" }],
      equipment: [
        {
          equipmentId: "equipment:warden_spear_1",
          itemId: "item:warden_spear",
          quantity: 1,
          condition: 76,
          equipped: true,
        },
      ],
      money: 18,
      abilities: ["ability:brace"],
      knowledge: ["knowledge:wolf_spoor"],
      promises: [
        {
          promiseId: "promise:return_wagon",
          recipientId: "npc:hayden_hale",
          status: "active",
        },
      ],
      companions: ["albany:june_pike"],
      crimes: [
        {
          crimeId: "crime:steading_trespass",
          jurisdictionId: "jurisdiction:albany_hinterland",
          severity: 1,
          status: "suspected",
        },
      ],
      relationships: [
        {
          npcId: "npc:old_cade",
          trust: 25,
          regard: -25,
          owesPlayer: 2,
          playerOwes: 1,
          memories: ["memory:kept_watch"],
        },
      ],
      factionStanding: [{ factionId: "faction:road_wardens", standing: 60 }],
    }),
  );
}

function roadPath(from: string, to: string): string[] {
  const queue: { town: string; roadIds: string[] }[] = [{ town: from, roadIds: [] }];
  const seen = new Set<string>([from]);
  for (let i = 0; i < queue.length; i += 1) {
    const cur = queue[i]!;
    if (cur.town === to) return cur.roadIds;
    for (const edge of world.edges.filter(
      (candidate) => candidate.from === cur.town || candidate.to === cur.town,
    )) {
      const next = edge.from === cur.town ? edge.to : edge.from;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push({ town: next, roadIds: [...cur.roadIds, edge.id] });
    }
  }
  throw new Error(`No road path from ${from} to ${to}.`);
}

function travelTo(session: OverworldSession, townId: string): void {
  for (const roadId of roadPath(session.view().current.id, townId)) {
    session.travel(roadId);
    if (session.view().pendingRoadEncounter) session.resolveRoadEncounter("press_on");
  }
}

function areaPath(from: string, to: string): string[] {
  const queue: { area: string; routeIds: string[] }[] = [{ area: from, routeIds: [] }];
  const seen = new Set<string>([from]);
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i]!;
    if (current.area === to) return current.routeIds;
    for (const edge of world.area_edges.filter(
      (candidate) => candidate.from_area === current.area || candidate.to_area === current.area,
    )) {
      const next = edge.from_area === current.area ? edge.to_area : edge.from_area;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push({ area: next, routeIds: [...current.routeIds, edge.id] });
    }
  }
  throw new Error(`No area path from ${from} to ${to}.`);
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

function moveToOpeningPreparation(session: OverworldSession): void {
  const areaId = world.opening_preparation?.area;
  if (!areaId) return;
  moveToArea(session, areaId);
}

function settleOpeningRegistration(session: OverworldSession): void {
  if (session.journey().storyChoice?.kind === "registration") {
    session.chooseJourneyStory("albany:ledger_advocate");
  }
  if (session.journey().storyChoice?.kind === "relief_oath") {
    revealCurrentJourneyStoryOptions(session, world.opening_relief_oath!.id);
    session.chooseJourneyStory("albany:oath_limited_aid_only");
  }
  if (session.journey().storyChoice?.kind === "lead_source") {
    session.chooseJourneyStory("albany:source_rowan_civic_docket");
    moveToOpeningPreparation(session);
  }
  if (session.view().departureInteractions[0]?.kind === "preparation") {
    session.chooseJourneyStory("albany:prep_works_fortification");
  }
  settleReliefAllocation(session);
}

function settleReliefAllocation(session: OverworldSession): void {
  if (session.view().departureInteractions[0]?.kind === "relief_allocation") {
    session.chooseJourneyStory("albany:relief_resident_shelter");
  }
}

function startVisibleQuest(
  session: OverworldSession,
  quest: OverworldQuestView,
): ReturnType<OverworldSession["startQuest"]> {
  settleReliefAllocation(session);
  const approach = quest.launch?.options.find((option) => option.projection?.available === true);
  return approach ? session.startQuest(quest.id, approach.id) : session.startQuest(quest.id);
}

function resolveCurrentTownEvent(session: OverworldSession): void {
  const view = session.view();
  const event = view.events.find((candidate) => !view.resolvedEventIds.includes(candidate.id));
  if (!event) throw new Error(`No unresolved event in ${view.current.id}.`);
  session.scoutPoi(view.pois[0]!.id);
  session.talkToCharacter(view.characters[0]!.id);
  settleOpeningRegistration(session);
  moveToArea(session, event.area);
  session.investigateEvent(event.id);
  session.resolveEvent(event.id, event.authored_scene?.options[0]?.id);
}

function completeAlbanyFirstGoal(session: OverworldSession): void {
  const opening = session.view();
  session.scoutPoi(opening.pois[0]!.id);
  session.talkToCharacter(opening.characters[0]!.id);
  settleOpeningRegistration(session);
  const quest = session.view().quests.find((candidate) => candidate.id === "wolf_winter");
  if (!quest) throw new Error("Expected the Albany Wolf-Winter lead.");
  if (session.view().currentArea?.id !== quest.area) {
    const route = session
      .view()
      .areaExits.find((candidate) => candidate.destination.id === quest.area);
    if (!route) throw new Error("Expected a route to the Albany lead.");
    session.moveArea(route.id);
  }
  startVisibleQuest(session, quest);
  session.completeQuest(quest.id, {
    endingId: "ending_held",
    endingTitle: "The Byre Held",
    death: false,
  });
}

function reachAlbanyStoryChoice(session: OverworldSession): void {
  completeAlbanyFirstGoal(session);
  session.chooseJourney("continue");
}

function authorMarketHouseholdPolicy(): UiOverworldSession {
  const session = new OverworldSession(world);
  reachAlbanyStoryChoice(session);
  session.chooseJourneyStory("send_wardens_north");
  moveToArea(session, "albany_city__market");
  session.scoutPoi("albany_city__market__poi");
  session.talkToCharacter("albany_city__market__contact");
  session.investigateEvent("albany_city__market__event");
  session.resolveEvent("albany_city__market__event", "hold_household_kitchen_prices");
  return UiOverworldSession.restore(world, session.snapshot());
}

describe("OverworldSession", () => {
  it("starts in Albany with roads, local discoveries, and no global quest list", () => {
    const session = new OverworldSession(world);
    const view = session.view();
    expect(session.journey()).toMatchObject({
      status: "active",
      goal: {
        text: "Complete Wolf-Winter in Albany.",
        status: "active",
      },
      acceptedDecisions: 0,
      baselineDecisions: 40,
      nextCheckpoint: 40,
      goalGuidance: INITIAL_JOURNEY_GOAL_GUIDANCE,
      pendingChoice: null,
    });

    expect(view.current.id).toBe("albany_city");
    expect(view.exits.length).toBeGreaterThan(3);
    expect(view.exits.length).toBeLessThan(12);
    expect(view.quests).toEqual([]);
    expect(view.hiddenQuestCount).toBeGreaterThan(0);
    expect(view.hiddenQuestCount).toBeLessThan(world.quests.length);
    expect(view.characters.length).toBeGreaterThan(0);
    expect(view.events.length).toBeGreaterThan(0);
    expect(view.areas).toHaveLength(1);
    expect(view.areas[0]?.home).toBe(view.current.id);
    expect(view.currentArea?.id).toBe(view.areas[0]?.id);
    expect(view.areaExits).toEqual([]);
    expect(view.hiddenAreaCount).toBeGreaterThan(0);
    expect(view.discoveredAreaIds).toEqual(view.areas.map((area) => area.id));
    expect(view.visitedAreaIds).toEqual([]);
    expect(view.pois.every((poi) => poi.area === view.currentArea?.id)).toBe(true);
    expect(view.characters.every((character) => character.area === view.currentArea?.id)).toBe(
      true,
    );
    expect(view.events.every((event) => event.area === view.currentArea?.id)).toBe(true);
    expect(view.sites).toEqual([]);
    expect(view.hiddenSiteCount).toBeGreaterThan(0);
    expect(view.jobs).toEqual([]);
    expect(view.rememberedJobs).toEqual([]);
    expect(view.hiddenJobCount).toBeGreaterThan(0);
    expect(view.discoveredJobIds).toEqual([]);
    expect(view.completedJobIds).toEqual([]);
    expect(view.routeOptions.map((route) => route.destination.id)).toContain("colonie_town");
    expect(view.discovered.length).toBeLessThan(world.nodes.length);
    expect(view.supplies).toBe(6);
    expect(view.maxSupplies).toBe(8);
    expect(view.fatigue).toBe(0);
    expect(view.travelCondition).toBe("ready");
    expect(view.pendingRoadEncounter).toBeNull();
    expect(view.character).toMatchObject({
      background: null,
      health: { current: 30, max: 30 },
      money: 0,
      skills: [],
      equipment: [],
      companions: [],
      relationships: [],
      factionStanding: [],
    });
    expect(session.compactView().character).toEqual([
      null,
      [30, 30],
      0,
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ]);
    const colonieOption = view.routeOptions.find(
      (route) => route.destination.id === "colonie_town",
    );
    expect(colonieOption).toBeDefined();
    expect(colonieOption?.estimate.baseMinutes).toBe(colonieOption?.totalMinutes);
    expect(colonieOption?.estimate.delayMinutes).toBe(0);
    expect(colonieOption?.estimate.elapsedMinutes).toBe(colonieOption?.totalMinutes);
    expect(colonieOption?.estimate.suppliesNeeded).toBeGreaterThan(0);
    expect(colonieOption?.estimate.fatigueGained).toBeGreaterThan(0);

    const openingText = [
      view.current.description,
      view.currentArea?.summary,
      view.currentArea?.discovery,
      view.pois[0]?.summary,
      view.characters[0]?.summary,
      view.characters[0]?.agenda,
      view.events[0]?.summary,
    ].join(" ");
    expect(openingText).toContain("This area holds the notice board");
    expect(openingText).toContain("Scout Albany Civic Center Notice Board");
    expect(openingText).toContain("Rowan Quill is Albany's records clerk");
    expect(openingText).toContain("Explore it to find official work, regional leads");
    expect(openingText).toContain("Rowan handles registration, emergency authority");
    expect(openingText).toContain("Optional civic filing. It does not complete Wolf-Winter.");
    expect(openingText).not.toMatch(
      /concrete local lead point|local problems|hidden count|tutorial|command/i,
    );
  });

  it("presents the authored aftermath as the UI's only legal choice without hidden solution data", () => {
    const session = new OverworldSession(world);
    reachAlbanyStoryChoice(session);
    const journey = session.journey();
    const snapshotHash = session.snapshotHash();

    expect(journey).toMatchObject({
      status: "active",
      goal: {
        version: 1,
        id: "albany_local_lead",
        status: "completed",
      },
      pendingChoice: null,
      storyChoice: {
        id: "albany_dawn_dispatch",
        options: [{ id: "send_wagon_to_cade" }, { id: "send_wardens_north" }],
      },
    });
    expect(Object.keys(journey.goal).sort()).toEqual([
      "completedAtDecision",
      "id",
      "status",
      "text",
      "version",
    ]);
    expect(Object.keys(journey.storyChoice!).sort()).toEqual(["id", "message", "options"]);
    for (const option of journey.storyChoice!.options) {
      expect(Object.keys(option).sort()).toEqual(["consequence", "id", "label"]);
    }
    expect(JSON.stringify({ goal: journey.goal, storyChoice: journey.storyChoice })).not.toMatch(
      /targetQuestId|endingId|ending_held|wolf_winter|content\/rpg|win_conditions|maneuver_/i,
    );
    expect(session.view().serviceActions).toEqual([]);
    expect("service_actions" in session.compactView()).toBe(false);

    expect(() => session.restAtTown()).toThrow(/choose the open story option/i);
    expect(session.snapshotHash()).toBe(snapshotHash);

    const beforeDecision = journey.acceptedDecisions;
    const selected = session.chooseJourneyStory("send_wardens_north");
    expect(selected).toMatchObject({
      storyChoiceId: "albany_dawn_dispatch",
      choiceId: "send_wardens_north",
      journeyDecision: { countsTowardJourney: true, reason: "situation_changed" },
      goal: {
        version: 2,
        id: "travel_north_with_albany_wardens",
        text: expect.stringContaining("Queensbury Market Streets"),
        status: "active",
      },
    });
    expect(session.journey()).toMatchObject({
      status: "active",
      acceptedDecisions: beforeDecision + 1,
      storyChoice: null,
      goal: { version: 2, id: "travel_north_with_albany_wardens" },
      goalGuidance:
        "Next road: Saratoga Springs city. Queensbury town is 2 roads away, about 60 travel minutes.",
    });
    expect(JSON.stringify(session.journey().goalGuidance)).not.toMatch(
      /targetQuestId|endingId|wolf_winter|content\/rpg|win_conditions|maneuver_/i,
    );
    expect(session.view().serviceActions.map((action) => action.action)).toEqual([
      "resupply",
      "rest",
    ]);
  });

  it("restores an initial snapshot without changing its goal proof while presenting current guidance", () => {
    const source = new OverworldSession(world);
    const snapshot = structuredClone(source.snapshot());
    const restored = OverworldSession.restore(world, snapshot);

    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.journey()).toMatchObject({
      goal: {
        text: "Complete Wolf-Winter in Albany.",
        status: "active",
      },
      goalGuidance: INITIAL_JOURNEY_GOAL_GUIDANCE,
    });
  });

  it("renders state-neutral return-opportunity guidance at the first-goal pause and dawn story", async () => {
    const session = new OverworldSession(world);
    completeAlbanyFirstGoal(session);
    const pendingJourney = session.journey();
    expect(pendingJourney.pendingChoice?.reasons).toContain("goal_completed");
    expect(pendingJourney.pendingChoice?.options).toEqual([
      {
        id: "continue",
        label: "Continue: decide the dawn wagon, then take the Gallowmere lead",
        consequence:
          "Assign Albany's only dawn relief wagon. Then find Hedrick in Queensbury and complete The Gallowmere. Keep all progress and continue. The next Continue/End choice appears when you complete a goal or reach the first safe break on or after decision 40.",
      },
      {
        id: "end",
        label: "End here",
        consequence: "End this journey and keep its read-only record. You cannot resume it.",
      },
    ]);
    expect(pendingJourney.pendingChoice?.continuationPreview).toEqual({
      id: "albany_dawn_dispatch",
      message:
        "Wolf-Winter is complete. Send Albany's only dawn relief wagon to Cade or north with the wardens. Your next goal is The Gallowmere in Queensbury.",
      options: [
        {
          id: "send_wagon_to_cade",
          label: "Send the wagon back to Cade",
          consequence: expect.stringContaining("replacement timber and repairs Cade's outer fence"),
        },
        {
          id: "send_wardens_north",
          label: "Send the wagon and wardens north",
          consequence: expect.stringContaining("Cade has no repair timber"),
        },
      ],
    });
    const restoredPause = OverworldSession.restore(world, structuredClone(session.snapshot()));
    expect(restoredPause.journey()).toEqual(pendingJourney);
    const beforeRejectedDispatch = session.snapshotHash();
    const beforeRejectedDispatchDecisions = pendingJourney.acceptedDecisions;
    expect(() => session.chooseJourneyStory("send_wagon_to_cade", "albany_dawn_dispatch")).toThrow(
      /choose whether to continue or end/i,
    );
    expect(session.snapshotHash()).toBe(beforeRejectedDispatch);
    expect(session.journey().acceptedDecisions).toBe(beforeRejectedDispatchDecisions);
    expect(session.journey().storyChoice).toBeNull();
    const deferredLeadCount = pendingJourney.opportunities?.deferredLeadCount;
    expect(deferredLeadCount).toBe(4);
    if (!deferredLeadCount) throw new Error("Expected deferred Albany opportunity leads.");
    const expectedDeferredGuidance =
      "Choose the current journey option first. 4 optional follow-up leads remain. Complete any other required choice. The leads return when play resumes.";
    expect(pendingJourney.opportunities).toEqual({
      guidance: expectedDeferredGuidance,
      leads: [],
      deferredLeadCount,
    });

    session.chooseJourney("continue");
    const dawnJourney = session.journey();
    expect(dawnJourney.storyChoice?.id).toBe("albany_dawn_dispatch");
    expect(dawnJourney.opportunities).toEqual(pendingJourney.opportunities);

    const uiRoot = resolve(process.cwd(), "ui");
    const server = await createServer({
      root: uiRoot,
      configFile: resolve(uiRoot, "vite.config.ts"),
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    try {
      const [choiceModule, storyModule] = await Promise.all([
        server.ssrLoadModule("/src/JourneyChoiceScreen.tsx"),
        server.ssrLoadModule("/src/JourneyStoryChoiceScreen.tsx"),
      ]);
      const requireFromUi = createRequire(resolve(uiRoot, "package.json"));
      const react = requireFromUi("react") as {
        createElement: (type: unknown, props: Record<string, unknown>) => unknown;
      };
      const reactDomServer = requireFromUi("react-dom/server") as {
        renderToStaticMarkup: (element: unknown) => string;
      };
      const markups = [
        reactDomServer.renderToStaticMarkup(
          react.createElement(choiceModule.JourneyChoiceScreen, {
            journey: pendingJourney,
            onChoose: () => undefined,
          }),
        ),
        reactDomServer.renderToStaticMarkup(
          react.createElement(storyModule.JourneyStoryChoiceScreen, {
            journey: dawnJourney,
            onChoose: () => undefined,
          }),
        ),
      ];

      for (const markup of markups) {
        expect(markup).toContain("Optional work");
        expect(markup).toContain(expectedDeferredGuidance);
        expect(markup).toContain("Choose the current journey option first");
        expect(markup).toContain("Complete any other required choice");
        expect(markup).toContain("The leads return when play resumes");
        expect(markup).not.toContain("finish this journey decision first");
        expect(markup).not.toContain("Jamie Tanner&#x27;s Winter Price Policy");
        expect(markup).not.toContain("journey-opportunity-list");
        expect(markup).not.toContain("keep your objective");
      }
      const pendingMarkup = markups[0];
      if (!pendingMarkup) throw new Error("Expected journey-pause markup.");
      expect(pendingMarkup).toContain(
        "Continue: decide the dawn wagon, then take the Gallowmere lead",
      );
      expect(pendingMarkup).toContain(
        "Assign Albany&#x27;s only dawn relief wagon. Then find Hedrick in Queensbury and complete The Gallowmere.",
      );
      expect(pendingMarkup).toContain("End here");
      expect(pendingMarkup).toContain("If you continue: choose dawn relief");
      expect(pendingMarkup).toContain("You cannot choose these options yet");
      expect(pendingMarkup.match(/<button/g)).toHaveLength(2);
      for (const option of pendingJourney.pendingChoice!.continuationPreview!.options) {
        expect(pendingMarkup).toContain(option.label);
        expect(pendingMarkup).toContain(option.consequence.replaceAll("'", "&#x27;"));
      }
    } finally {
      await server.close();
    }
  });

  it("routes visible story-choice ids through generic app plumbing", () => {
    const app = readFileSync("ui/src/App.tsx", "utf8");
    const overworldScreen = readFileSync("ui/src/OverworldPlayScreen.tsx", "utf8");
    const screen = readFileSync("ui/src/JourneyStoryChoiceScreen.tsx", "utf8");
    const styles = readFileSync("ui/src/styles.css", "utf8");
    const handlerStart = app.indexOf("function chooseJourneyStory(choiceId: string)");
    const handlerEnd = app.indexOf("if (tutorialOpen)", handlerStart);
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handler = app.slice(handlerStart, handlerEnd);
    const logHelperStart = app.indexOf("export function journeyStoryChoiceLogEntries(");
    const logHelperEnd = app.indexOf("export default function App", logHelperStart);
    const logHelper = app.slice(logHelperStart, logHelperEnd);

    expect(handler).toContain("inspectedDepartureStory ?? journey.storyChoice");
    expect(handler).toContain("worldSession.chooseJourneyStory(");
    expect(handler).toContain("inspectedDepartureStory?.id");
    expect(handler).toContain("journeyStoryChoiceLogEntries(storyChoice?.kind, result)");
    expect(logHelperStart).toBeGreaterThanOrEqual(0);
    expect(logHelperEnd).toBeGreaterThan(logHelperStart);
    expect(logHelper).toContain("if (result.displaySummary)");
    expect(logHelper).toContain("Background chosen");
    expect(logHelper).toContain("Report chosen");
    expect(logHelper).toContain("Field kit chosen");
    expect(logHelper).toContain("Relief wagon choice made");
    expect(logHelper).toContain("Wolf-Winter promise chosen");
    expect(logHelper).toContain("Riding choice made");
    expect(logHelper).toContain("Choice made");
    expect(logHelper).toContain("Current goal: ${result.goal.text}");
    expect(handler).not.toMatch(/AlbanyDawnDispatchChoiceId|Albany dawn dispatch/i);
    expect(handler).not.toMatch(
      /targetQuestId|targetTownId|targetAreaId|questOutcomeIds|endingId|content\/rpg/i,
    );
    expect(app).toContain("for (const interaction of worldView.departureInteractions)");
    expect(app).toContain("worldSession.inspectJourneyStory(storyChoiceId)");
    expect(app).toContain("onChoose: () => inspectDepartureStory(interaction.id)");
    expect(app).toContain('support?.terms ?? "Review before choosing"');
    expect(app).toContain("stationSupportPresentation(worldView.stationDispatchBoard");
    expect(app).toContain("sections={worldActionSections}");
    expect(overworldScreen).toContain('panel === "terms"');
    expect(overworldScreen).toContain("section.actions.map((action)");
    expect(screen).toContain("Journey choice");
    expect(screen).toContain("Choose what follows");
    expect(screen).toContain("Choose your background");
    expect(screen).toContain("Wolf-Winter report");
    expect(screen).toContain("Choose the report you trust");
    expect(screen).toContain("Optional field kit");
    expect(screen).toContain("Choose one field kit");
    expect(screen).toContain("Optional relief wagon");
    expect(screen).toContain("Choose where Albany's relief wagon goes");
    expect(screen).toContain("Wolf-Winter promise");
    expect(screen).toContain("Choose one Wolf-Winter promise");
    expect(screen).toContain("Optional second rider");
    expect(screen).toContain("Choose a second rider or ride alone");
    expect(screen).toContain('" journey-choice-actions-registration"');
    const choiceCardStart = screen.indexOf('className="journey-choice-card"');
    const chooseButtonStart = screen.indexOf(
      '<button type="button" onClick={() => onChoose(option.id)}>',
      choiceCardStart,
    );
    const chooseButtonEnd = screen.indexOf("</button>", chooseButtonStart);
    const fullTermsStart = screen.indexOf(
      '<details className="journey-choice-details">',
      chooseButtonEnd,
    );
    expect(choiceCardStart).toBeGreaterThanOrEqual(0);
    expect(chooseButtonStart).toBeGreaterThan(choiceCardStart);
    expect(chooseButtonEnd).toBeGreaterThan(chooseButtonStart);
    expect(fullTermsStart).toBeGreaterThan(chooseButtonEnd);
    expect(screen).toContain('className="journey-choice-summary"');
    expect(screen).toContain('className="journey-choice-trigger"');
    expect(screen).toContain('className="journey-choice-cost"');
    expect(screen).toContain("const usesRoleplayReceipt =");
    expect(screen).toContain(
      'const usesTriggerCategory = conciseSummary?.fieldTriggerScope === "category";',
    );
    expect(screen).toContain("const roleplaySummaryLabel =");
    for (const label of [
      '"Background:"',
      '"Ready-made plan:"',
      '"Wolf-Winter promise:"',
      '"Report:"',
      '"Field kit:"',
      '"Relief wagon:"',
      '"Riding choice:"',
    ]) {
      expect(screen).toContain(label);
    }
    expect(screen).toContain("`Show full terms for ${option.label}`");
    expect(styles).toContain(".journey-choice-actions .journey-choice-card > button");
    expect(styles).toContain(
      ".journey-choice-actions:not(.journey-choice-actions-registration)\n  .journey-choice-card:first-child\n  > button",
    );
    expect(styles).toContain(".journey-choice-details summary");
    expect(screen).not.toMatch(/Albany Station Quarter|dawn dispatch/i);
  });

  it("authorizes authored local-job buttons from exact projected choices", () => {
    const app = readFileSync("ui/src/App.tsx", "utf8");
    const screen = readFileSync("ui/src/OverworldPlayScreen.tsx", "utf8");
    const modelStart = app.indexOf("const jobActions: WorldActionCard[] = []");
    const modelEnd = app.indexOf('worldActionSections.push({ id: "jobs"', modelStart);
    expect(modelStart).toBeGreaterThanOrEqual(0);
    expect(modelEnd).toBeGreaterThan(modelStart);
    const model = app.slice(modelStart, modelEnd);

    expect(app).toContain("worldView.jobChoices.map(([jobId, optionId])");
    expect(model).toContain("job.authored_scene.options.map((option)");
    expect(model).toContain("legalJobChoiceKeys.has(jobChoiceKey(job.id, option.id))");
    expect(model).toContain(
      'disabledReason: completed ? "This job is complete." : "Requirements not met."',
    );
    expect(model).toContain("worldSession.workLocalJob(job.id, option.id)");
    expect(model).not.toContain("sceneReady");
    expect(screen).toContain("action.disabledReason !== undefined");
    expect(screen).toContain("disabled={disabled}");
    expect(screen).toContain("disabled ? undefined : action.onChoose");
  });

  it("builds job actions only from the projected view and labels empty sections truthfully", () => {
    const app = readFileSync("ui/src/App.tsx", "utf8");
    const screen = readFileSync("ui/src/OverworldPlayScreen.tsx", "utf8");
    const modelStart = app.indexOf("const jobActions: WorldActionCard[] = []");
    const modelEnd = app.indexOf('worldActionSections.push({ id: "jobs"', modelStart);
    expect(modelStart).toBeGreaterThanOrEqual(0);
    expect(modelEnd).toBeGreaterThan(modelStart);
    const model = app.slice(modelStart, modelEnd);

    expect(model).toContain("for (const job of worldView.jobs)");
    expect(model).not.toContain("OVERWORLD.jobs");
    expect(screen).toContain("No actions are available in this category.");
    expect(screen).not.toContain("undiscovered local");
    expect(screen).not.toContain("No local jobs mapped yet.");
  });

  it("omits policy-hidden authored Market job options from the rendered app", async () => {
    const uiSession = authorMarketHouseholdPolicy();
    const job = uiSession
      .view()
      .jobs.find((candidate) => candidate.id === "albany_city__market__job");
    expect(job?.authored_scene?.options.map((option) => option.id)).toEqual([
      "release_price_hold_operational",
      "audit_price_hold_household_chain",
    ]);
    expect(uiSession.view().jobChoices).toEqual([
      ["albany_city__market__job", "release_price_hold_operational"],
      ["albany_city__market__job", "audit_price_hold_household_chain"],
    ]);

    const persistedSnapshot = uiSession.snapshot();
    persistedSnapshot.worldHash = "0".repeat(64);
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) =>
            key === "adventureforge:new-york-overworld:v1"
              ? JSON.stringify(persistedSnapshot)
              : null,
          removeItem: () => undefined,
          setItem: () => undefined,
        },
      },
    });

    const uiRoot = resolve(process.cwd(), "ui");
    const server = await createServer({
      root: uiRoot,
      configFile: resolve(uiRoot, "vite.config.ts"),
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    try {
      const module = (await server.ssrLoadModule("/src/App.tsx")) as { default: unknown };
      const requireFromUi = createRequire(resolve(uiRoot, "package.json"));
      const react = requireFromUi("react") as {
        createElement: (type: unknown, props: Record<string, unknown>) => unknown;
      };
      const reactDomServer = requireFromUi("react-dom/server") as {
        renderToStaticMarkup: (element: unknown) => string;
      };
      const markup = reactDomServer.renderToStaticMarkup(react.createElement(module.default, {}));

      expect(markup).toContain("Jamie&#x27;s Disputed Crates");
      expect(markup).toContain("Release the Household-Price Crates");
      expect(markup).toContain("30 min · renown 3");
      // The focused scene shows one relevant job; the Exact terms panel receives
      // the complete section model built from every engine-projected option.
      expect(markup).not.toContain("Audit the price-hold household chain in public");
      const app = readFileSync("ui/src/App.tsx", "utf8");
      const screen = readFileSync("ui/src/OverworldPlayScreen.tsx", "utf8");
      const jobModelStart = app.indexOf("const jobActions: WorldActionCard[] = []");
      const jobModelEnd = app.indexOf('worldActionSections.push({ id: "jobs"', jobModelStart);
      const jobModel = app.slice(jobModelStart, jobModelEnd);
      expect(jobModel).toContain("job.authored_scene.options.map((option)");
      expect(jobModel).toContain("legalJobChoiceKeys.has(jobChoiceKey(job.id, option.id))");
      expect(screen).toContain("sections.map((section)");
      expect(screen).toContain("section.actions.map((action)");
      expect(markup).not.toContain("Release the open-bid crates from the visible buyer board");
      expect(markup).not.toContain("Earn 1 Capital / Mohawk renown");
      expect(markup).not.toContain("Audit the open-bid public chain");
      expect(markup).not.toContain("Earn 4 Capital / Mohawk renown");
      expect(markup).not.toContain('disabled=""');
      expect(markup).toContain(`Warning: ${OVERWORLD_CONTENT_HASH_MISMATCH_WARNING}`);
    } finally {
      await server.close();
      if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("renders embedded character death as a mandatory ending, not voluntary continuation", async () => {
    const app = readFileSync("ui/src/App.tsx", "utf8");
    const deathBranchStart = app.indexOf("} else if (ending?.death)");
    const deathBranchEnd = app.indexOf("setLog((prev)", deathBranchStart);
    expect(deathBranchStart).toBeGreaterThanOrEqual(0);
    expect(deathBranchEnd).toBeGreaterThan(deathBranchStart);
    expect(app.slice(deathBranchStart, deathBranchEnd)).toContain(
      "worldSession.recordQuestCharacterDeath(activeQuest.id, {",
    );

    const session = new OverworldSession(world);
    expect(() =>
      session.recordQuestCharacterDeath("wolf_winter", {
        endingId: "ending_pulled_down",
        death: true,
      }),
    ).toThrow(/exact unfinished started quest/i);
    const opening = session.view();
    session.scoutPoi(opening.pois[0]!.id);
    session.talkToCharacter(opening.characters[0]!.id);
    settleOpeningRegistration(session);
    const quest = session.view().quests.find((candidate) => candidate.id === "wolf_winter");
    if (!quest) throw new Error("Expected the Albany Wolf-Winter lead.");
    if (session.view().currentArea?.id !== quest.area) {
      const route = session
        .view()
        .areaExits.find((candidate) => candidate.destination.id === quest.area);
      if (!route) throw new Error("Expected a route to the Albany lead.");
      session.moveArea(route.id);
    }
    startVisibleQuest(session, quest);
    session.recordQuestCharacterDeath(quest.id, {
      endingId: "ending_pulled_down",
      death: true,
    });
    const pendingSnapshot = JSON.parse(JSON.stringify(session.snapshot())) as ReturnType<
      typeof session.snapshot
    >;
    const restored = OverworldSession.restore(world, pendingSnapshot);
    const pendingJourney = restored.journey();
    expect(pendingJourney.pendingChoice?.options.map((option) => option.id)).toEqual(["end"]);
    expect(restored.view().serviceActions).toEqual([]);
    expect("service_actions" in restored.compactView()).toBe(false);

    const uiRoot = resolve(process.cwd(), "ui");
    const server = await createServer({
      root: uiRoot,
      configFile: resolve(uiRoot, "vite.config.ts"),
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    try {
      const choiceModule = (await server.ssrLoadModule("/src/JourneyChoiceScreen.tsx")) as {
        JourneyChoiceScreen: unknown;
      };
      const endedModule = (await server.ssrLoadModule("/src/JourneyEndedScreen.tsx")) as {
        JourneyEndedScreen: unknown;
      };
      const requireFromUi = createRequire(resolve(uiRoot, "package.json"));
      const react = requireFromUi("react") as {
        createElement: (type: unknown, props: Record<string, unknown>) => unknown;
      };
      const reactDomServer = requireFromUi("react-dom/server") as {
        renderToStaticMarkup: (element: unknown) => string;
      };

      const choiceMarkup = reactDomServer.renderToStaticMarkup(
        react.createElement(choiceModule.JourneyChoiceScreen, {
          journey: pendingJourney,
          onChoose: () => undefined,
        }),
      );
      expect(choiceMarkup).toContain("Your character died");
      expect(choiceMarkup).toContain("End this journey");
      expect(choiceMarkup.match(/<button/g)).toHaveLength(1);
      expect(choiceMarkup).not.toContain("Continue this journey?");

      restored.chooseJourney("end");
      expect(restored.view().serviceActions).toEqual([]);
      const endedMarkup = reactDomServer.renderToStaticMarkup(
        react.createElement(endedModule.JourneyEndedScreen, {
          journey: restored.journey(),
          onNewJourney: () => undefined,
        }),
      );
      expect(endedMarkup).toContain("Your character died after");
      expect(endedMarkup).toContain("unfinished goal and journey history");
      expect(endedMarkup).toContain("Continue/end choices");
      expect(endedMarkup).not.toContain("You chose to end");
      expect(endedMarkup).not.toContain("Continuation choices");
    } finally {
      await server.close();
    }
  });

  it("keeps service legality and projected costs in the Night Watch action model", async () => {
    const uiRoot = resolve(process.cwd(), "ui");
    const server = await createServer({
      root: uiRoot,
      configFile: resolve(uiRoot, "vite.config.ts"),
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    try {
      const module = (await server.ssrLoadModule("/src/OverworldPlayScreen.tsx")) as {
        OverworldPlayScreen: unknown;
      };
      const presenter = (await server.ssrLoadModule("/src/worldActionPresentation.ts")) as {
        activateProjectedService: (
          session: Record<string, () => unknown>,
          action: "care" | "rest" | "resupply",
        ) => unknown;
        presentServiceSection: (
          view: ReturnType<OverworldSession["view"]>,
          session: OverworldSession,
          run: (action: () => unknown) => void,
        ) => {
          id: string;
          actions: Array<{
            id: string;
            title: string;
            terms: string;
            disabledReason?: string;
            onChoose: () => void;
          }>;
        };
        primaryWorldSectionIds: (
          sections: Array<{
            id: string;
            title: string;
            actions: Array<{ id: string; disabledReason?: string }>;
          }>,
          pendingRoadEncounter: boolean,
          hasLegalDispatchAction: boolean,
        ) => string[];
      };
      const requireFromUi = createRequire(resolve(uiRoot, "package.json"));
      const react = requireFromUi("react") as {
        createElement: (type: unknown, props: Record<string, unknown>) => unknown;
      };
      const reactDomServer = requireFromUi("react-dom/server") as {
        renderToStaticMarkup: (element: unknown) => string;
      };
      const session = new OverworldSession(world);
      const view = session.view();
      const serviceSection = presenter.presentServiceSection(view, session, () => undefined);
      expect(serviceSection.id).toBe("services");
      expect(serviceSection.actions.map((action) => action.id)).toEqual(
        view.serviceActions.map((action) => `service:${action.action}`),
      );
      for (const projected of view.serviceActions) {
        const action = serviceSection.actions.find(
          (candidate) => candidate.id === `service:${projected.action}`,
        );
        expect(action?.terms).toContain(`${projected.minutes} min`);
        expect(action?.terms).toContain(
          `supplies ${projected.suppliesBefore}→${projected.suppliesAfter}`,
        );
        expect(action?.terms).toContain(
          `fatigue ${projected.fatigueBefore}→${projected.fatigueAfter}`,
        );
        expect(action?.disabledReason).toBe(projected.available ? undefined : projected.message);
      }

      const invoked: string[] = [];
      const fakeSession = {
        careAtTown: () => invoked.push("care"),
        restAtTown: () => invoked.push("rest"),
        resupplyAtTown: () => invoked.push("resupply"),
      };
      for (const action of ["care", "rest", "resupply"] as const) {
        presenter.activateProjectedService(fakeSession, action);
      }
      expect(invoked).toEqual(["care", "rest", "resupply"]);

      expect(
        presenter.primaryWorldSectionIds(
          [
            {
              id: "future-gameplay-shape",
              title: "Future gameplay shape",
              actions: [{ id: "future:act" }],
            },
          ],
          false,
          false,
        ),
      ).toEqual(["future-gameplay-shape"]);
      const markup = reactDomServer.renderToStaticMarkup(
        react.createElement(module.OverworldPlayScreen, {
          world: view,
          journey: session.journey(),
          latestConsequence: "The relief stores fill the field pack.",
          log: [],
          sections: [
            {
              id: "services",
              title: "Town services",
              actions: [
                {
                  id: "service:resupply",
                  group: "Service",
                  title: "Resupply",
                  summary: "The relief stores fill the field pack.",
                  terms:
                    "15 min · supplies 2→8 · fatigue 12→12 · Fill the field pack from Albany's reserved relief stock.",
                  buttonLabel: "Use service",
                  tone: "lichen",
                  onChoose: () => undefined,
                },
              ],
            },
          ],
          prioritySectionIds: ["services"],
          panel: "scene",
          error: null,
          onPanelChange: () => undefined,
          onNewJourney: () => undefined,
          onOpenTutorial: () => undefined,
        }),
      );

      expect(markup).toContain('class="nw-action-kind"');
      expect(markup).toContain("<h2>Resupply</h2>");
      expect(markup).toContain("The relief stores fill the field pack.");
      expect(markup).toContain("15 min · supplies 2→8 · fatigue 12→12");
      expect(markup).toContain("Fill the field pack from Albany&#x27;s reserved relief stock.");
      expect(markup).toContain("Use service");

      const unavailable = reactDomServer.renderToStaticMarkup(
        react.createElement(module.OverworldPlayScreen, {
          world: view,
          journey: session.journey(),
          latestConsequence: "No service used.",
          log: [],
          sections: [
            {
              id: "services",
              title: "Town services",
              actions: [
                {
                  id: "service:rest",
                  group: "Service",
                  title: "Rest",
                  summary: "There is no inn or healer here to rest safely.",
                  buttonLabel: "Use service",
                  tone: "lichen",
                  disabledReason: "There is no inn or healer here to rest safely.",
                  onChoose: () => undefined,
                },
              ],
            },
          ],
          prioritySectionIds: ["services"],
          panel: "terms",
          error: null,
          onPanelChange: () => undefined,
          onNewJourney: () => undefined,
          onOpenTutorial: () => undefined,
        }),
      );
      expect(unavailable).toContain('disabled=""');
      expect(unavailable).toContain("Unavailable");
      expect(unavailable).toContain("There is no inn or healer here to rest safely.");
    } finally {
      await server.close();
    }
  });

  it("wires June's optional departure lead into the live action list and renders the recap", async () => {
    const session = new OverworldSession(world);
    session.scoutPoi(session.view().pois[0]!.id);
    session.talkToCharacter(world.opening_registration!.contact);
    session.chooseJourneyStory(world.opening_registration!.profiles[0]!.id);
    revealCurrentJourneyStoryOptions(session, world.opening_relief_oath!.id);
    session.chooseJourneyStory(world.opening_relief_oath!.options[0]!.id);
    session.chooseJourneyStory(world.opening_lead_source!.options[0]!.id);
    moveToOpeningPreparation(session);
    const recap = session.view().departureRecap;
    if (!recap) throw new Error("expected the accumulated departure recap");
    const initiallyReady = session.view().departureContactLeads[0];
    if (!initiallyReady?.action) throw new Error("expected June's ready departure contact action");
    session.chooseJourneyStory(
      world.opening_preparation!.profiles[0]!.id,
      world.opening_preparation!.id,
    );
    const ready = session.view().departureContactLeads[0];
    if (!ready?.action) throw new Error("expected June's ready departure contact action");

    const app = readFileSync("ui/src/App.tsx", "utf8");
    const overworldScreen = readFileSync("ui/src/OverworldPlayScreen.tsx", "utf8");
    const recapComponent = readFileSync("ui/src/DepartureRecap.tsx", "utf8");
    const storyChoiceScreen = readFileSync("ui/src/JourneyStoryChoiceScreen.tsx", "utf8");
    expect(app).toContain("for (const lead of worldView.departureContactLeads)");
    expect(app).toContain("if (!lead.action) return");
    expect(app).toContain("worldSession.talkToCharacter(lead.action!.arguments.character_id)");
    expect(app).toContain(
      "disabledReason: `Choose a field kit before asking ${lead.contactName}.`",
    );
    expect(app).toContain("worldView.departureRecap");
    expect(app).toContain("departureRecap={worldView.departureRecap}");
    expect(overworldScreen).toContain(
      "{world.departureRecap && <DepartureRecap recap={world.departureRecap} />}",
    );
    expect(recapComponent).toContain('<details className="departure-recap-slots">');
    expect(recapComponent).toContain('entryScope === "already_set"');
    expect(recapComponent).toContain('"Review what is already set"');
    expect(recapComponent).toContain('"Review what is set and still optional"');
    expect(recapComponent).toContain('className="departure-recap-selected"');
    expect(recapComponent).toContain('<details className="departure-recap-terms">');
    expect(recapComponent).toContain("<summary>Review selected costs and effects</summary>");
    expect(recapComponent).not.toContain("Active field term: {entry.activeFieldTerm}");
    expect(recapComponent).toContain("Departure ready: {recap.dispatch.minutes} min");
    expect(recapComponent).toContain("Leave now: {recap.dispatch.minutes} min");
    expect(recapComponent).toContain("Departure plan complete: {recap.dispatch.minutes} min");
    expect(recapComponent).toContain("You may still add a");
    expect(recapComponent).toContain("second rider.");
    expect(storyChoiceScreen).toContain('departureRecap?: OverworldView["departureRecap"]');
    expect(storyChoiceScreen).toContain(
      "{departureRecap && <DepartureRecap recap={departureRecap} headingLevel={2} />}",
    );
    expect(storyChoiceScreen.indexOf("<DepartureRecap")).toBeLessThan(
      storyChoiceScreen.indexOf("<JourneyOpportunityLeads"),
    );
    expect(overworldScreen).toContain("action.disabledReason !== undefined");
    expect(overworldScreen).toContain("disabled={disabled}");

    const uiRoot = resolve(process.cwd(), "ui");
    const server = await createServer({
      root: uiRoot,
      configFile: resolve(uiRoot, "vite.config.ts"),
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    try {
      const module = (await server.ssrLoadModule("/src/DepartureRecap.tsx")) as {
        DepartureRecap: unknown;
      };
      const requireFromUi = createRequire(resolve(uiRoot, "package.json"));
      const react = requireFromUi("react") as {
        createElement: (type: unknown, props: Record<string, unknown>) => unknown;
      };
      const reactDomServer = requireFromUi("react-dom/server") as {
        renderToStaticMarkup: (element: unknown) => string;
      };
      const recapMarkup = reactDomServer.renderToStaticMarkup(
        react.createElement(module.DepartureRecap, { recap }),
      );
      const projectedPromiseTitle = world.opening_relief_oath!.options[0]!.title.replace(
        /\bDuty\b/gu,
        "Promise",
      );
      expect(recapMarkup).toContain("The Wolf-Winter departure plan");
      expect(recapMarkup).toContain(world.opening_registration!.profiles[0]!.title);
      expect(recapMarkup).toContain(projectedPromiseTitle);
      expect(recapMarkup).toContain(
        world.opening_lead_source!.options[0]!.title.replace("'", "&#x27;"),
      );
      expect(recapMarkup).toContain("Open (optional)");
      expect(recapMarkup).not.toContain("Available after choosing a field kit");
      expect(recapMarkup).toContain('<details class="departure-recap-slots">');
      expect(recapMarkup).toContain("<summary>Review what is set and still optional</summary>");
      const slotDetailsIndex = recapMarkup.indexOf('<details class="departure-recap-slots">');
      const firstTier = recapMarkup.slice(0, slotDetailsIndex);
      expect(firstTier).toContain("Selected plan:");
      expect(firstTier).toContain(world.opening_registration!.profiles[0]!.title);
      expect(firstTier).toContain(projectedPromiseTitle);
      expect(firstTier).toContain(
        world.opening_lead_source!.options[0]!.title.replace("'", "&#x27;"),
      );
      expect(firstTier).not.toContain("Open (optional)");
      expect(recapMarkup).toContain('<details class="departure-recap-terms">');
      expect(recapMarkup).toContain("<summary>Review what is set and still optional</summary>");
      expect(recapMarkup).not.toMatch(/<details[^>]*\sopen(?:=|>)/);
      expect(recapMarkup).toContain(recap.entries[0]!.activeFieldTerm!.replaceAll("'", "&#x27;"));
    } finally {
      await server.close();
    }
  });

  it("titles Station support actions and logs each story choice by its display summary", async () => {
    const session = new OverworldSession(world);
    session.scoutPoi(session.view().pois[0]!.id);
    session.talkToCharacter(world.opening_registration!.contact);
    session.chooseJourneyStory(world.opening_registration!.profiles[0]!.id);
    revealCurrentJourneyStoryOptions(session, world.opening_relief_oath!.id);
    session.chooseJourneyStory(world.opening_relief_oath!.options[0]!.id);
    session.chooseJourneyStory(world.opening_lead_source!.options[0]!.id);
    moveToOpeningPreparation(session);
    const view = session.view();
    const board = view.stationDispatchBoard;
    const quest = view.quests.find((candidate) => candidate.id === board?.questId);
    if (!board || !quest?.launch) throw new Error("expected a complete Station dispatch board");
    expect(board.support).toHaveLength(3);
    expect(board.launch.approaches).toHaveLength(2);

    const uiRoot = resolve(process.cwd(), "ui");
    const server = await createServer({
      root: uiRoot,
      configFile: resolve(uiRoot, "vite.config.ts"),
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    try {
      const module = (await server.ssrLoadModule("/src/App.tsx")) as {
        stationSupportActionTitle: (
          slot: "preparation" | "relief_allocation" | "field_team",
        ) => string;
        journeyStoryChoiceLogEntries: (
          kind: "relief_oath" | "relief_allocation" | "ally",
          result: ReturnType<OverworldSession["chooseJourneyStory"]>,
        ) => string[];
      };
      expect(module.stationSupportActionTitle("preparation")).toBe("Field kit");
      expect(module.stationSupportActionTitle("relief_allocation")).toBe("Relief wagon");
      expect(module.stationSupportActionTitle("field_team")).toBe("Second rider");

      const preparation = world.opening_preparation!;
      const allocation = world.opening_relief_allocation!;
      const ally = world.opening_ally!;
      session.chooseJourneyStory(preparation.profiles[0]!.id, preparation.id);
      const sentWagonResult = session.chooseJourneyStory(allocation.options[0]!.id, allocation.id);
      expect(module.journeyStoryChoiceLogEntries("relief_allocation", sentWagonResult)[0]).toBe(
        sentWagonResult.displaySummary,
      );
      expect(sentWagonResult.displaySummary).toContain(
        `Relief wagon choice made — ${allocation.options[0]!.title}.`,
      );
      expect(sentWagonResult.displaySummary).not.toContain("Relief wagon chosen");
      expect(sentWagonResult.displaySummary).not.toContain(sentWagonResult.consequence);
      session.talkToCharacter(ally.contact);
      const solo = ally.options.find((option) => option.id === ally.solo_option_id)!;
      const soloResult = session.chooseJourneyStory(solo.id);
      expect(module.journeyStoryChoiceLogEntries("ally", soloResult)[0]).toBe(
        soloResult.displaySummary,
      );
      expect(soloResult.displaySummary).not.toContain(soloResult.consequence);
      const openStationSupportSession = (): OverworldSession => {
        const supportSession = new OverworldSession(world);
        supportSession.scoutPoi(supportSession.view().pois[0]!.id);
        supportSession.talkToCharacter(world.opening_registration!.contact);
        const supportDoctrine = world.opening_registration!.doctrines![0]!;
        supportSession.chooseJourneyStory(supportDoctrine.profile_id);
        supportSession.chooseJourneyStory(supportDoctrine.id);
        moveToOpeningPreparation(supportSession);
        supportSession.chooseJourneyStory(preparation.profiles[0]!.id, preparation.id);
        return supportSession;
      };
      for (const option of allocation.options.slice(1)) {
        const supportSession = openStationSupportSession();
        const result = supportSession.chooseJourneyStory(option.id, allocation.id);
        const entry = module.journeyStoryChoiceLogEntries("relief_allocation", result)[0];
        expect(entry).toBe(result.displaySummary);
        expect(entry).toContain(`Relief wagon choice made — ${option.title}.`);
        expect(entry).not.toContain("Relief wagon chosen");
        expect(entry).not.toContain(result.consequence);
        expect(entry).not.toContain("Relief wagon sent");
      }
      const relaySession = openStationSupportSession();
      relaySession.talkToCharacter(ally.contact);
      const relay = ally.options.find((option) => option.id === "albany:ally_june_relay_only")!;
      const relayResult = relaySession.chooseJourneyStory(relay.id);
      const relayEntry = module.journeyStoryChoiceLogEntries("ally", relayResult)[0];
      expect(relayEntry).toBe(relayResult.displaySummary);
      expect(relayEntry).not.toContain(relayResult.consequence);
      expect(relayEntry).not.toContain("Second rider chosen");

      const packetSession = new OverworldSession(world);
      const registration = world.opening_registration!;
      const doctrine = registration.doctrines![0]!;
      packetSession.scoutPoi(packetSession.view().pois[0]!.id);
      packetSession.talkToCharacter(registration.contact);
      packetSession.chooseJourneyStory(doctrine.profile_id);
      const packetResult = packetSession.chooseJourneyStory(doctrine.id);
      const immediateLog = module.journeyStoryChoiceLogEntries("relief_oath", packetResult);
      expect(immediateLog[0]).toBe(packetResult.displaySummary);
      expect(immediateLog[0]).toContain("Quick setup chosen. Background:");
      expect(immediateLog[0]).not.toMatch(
        /\b(role|duty|source|preparation|relief allocation|field-team)\b/iu,
      );
      expect(immediateLog[0]).not.toContain(packetResult.consequence);
      expect(immediateLog[1]).toBe(`Current goal: ${packetResult.goal.text}`);
    } finally {
      await server.close();
    }
  });

  it("renders current departure recap slots independently while preserving legacy copy", async () => {
    const session = new OverworldSession(world);
    session.scoutPoi(session.view().pois[0]!.id);
    session.talkToCharacter(world.opening_registration!.contact);
    session.chooseJourneyStory(world.opening_registration!.profiles[0]!.id);
    revealCurrentJourneyStoryOptions(session, world.opening_relief_oath!.id);
    session.chooseJourneyStory(world.opening_relief_oath!.options[0]!.id);
    session.chooseJourneyStory(world.opening_lead_source!.options[0]!.id);
    moveToOpeningPreparation(session);
    const recap = session.view().departureRecap;
    if (!recap?.dispatch) throw new Error("expected the authenticated open departure recap");
    const dispatch = recap.dispatch;

    const uiRoot = resolve(process.cwd(), "ui");
    const server = await createServer({
      root: uiRoot,
      configFile: resolve(uiRoot, "vite.config.ts"),
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    try {
      const module = (await server.ssrLoadModule("/src/DepartureRecap.tsx")) as {
        DepartureRecap: unknown;
      };
      const requireFromUi = createRequire(resolve(uiRoot, "package.json"));
      const react = requireFromUi("react") as {
        createElement: (type: unknown, props: Record<string, unknown>) => unknown;
      };
      const reactDomServer = requireFromUi("react-dom/server") as {
        renderToStaticMarkup: (element: unknown) => string;
      };
      const renderRecap = (value: typeof recap): string =>
        reactDomServer.renderToStaticMarkup(
          react.createElement(module.DepartureRecap, { recap: value }),
        );
      const renderSlots = (remainingOptional: typeof dispatch.remainingOptional): string =>
        renderRecap({
          ...recap,
          dispatch: { ...dispatch, remainingOptional },
        });

      const allOpen = renderSlots(["preparation", "relief_allocation", "field_team"]);
      expect(allOpen).toContain(
        `Departure ready: ${String(dispatch.minutes)} min; field kit, relief wagon, and second rider remain optional.`,
      );
      expect(allOpen.match(/Open \(optional\)/g) ?? []).toHaveLength(3);
      expect(allOpen).not.toContain("Available after choosing a field kit");
      expect(renderSlots(["preparation", "field_team"])).toContain(
        "field kit and second rider remain optional.",
      );
      expect(renderSlots(["relief_allocation"])).toContain("relief wagon remains optional.");

      const legacy = renderRecap({
        ...recap,
        entries: recap.entries.map((entry) =>
          entry.slot === "relief_allocation"
            ? { ...entry, status: "available_after_preparation" as const, title: null }
            : entry,
        ),
      });
      expect(legacy).toContain("Available after choosing a field kit");
    } finally {
      await server.close();
    }
  });

  it("splits the dispatch quest from the notice board and wires launch approaches inline", async () => {
    const uiRoot = resolve(process.cwd(), "ui");
    const server = await createServer({
      root: uiRoot,
      configFile: resolve(uiRoot, "vite.config.ts"),
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    try {
      const module = (await server.ssrLoadModule("/src/App.tsx")) as {
        splitQuestNotices: (view: {
          departureRecap: { questId: string } | null;
          quests: readonly OverworldQuestView[];
          questStarts: readonly (readonly [string, string | null])[];
        }) => {
          departureQuest: OverworldQuestView | null;
          noticeBoardQuests: readonly OverworldQuestView[];
        };
      };
      const quest: OverworldQuestView = {
        id: "test_launch_quest",
        title: "The Hill Dispatch",
        home: "albany_city",
        area: "albany_city__transport_hub",
        discovery: "Two winter routes leave the station quarter.",
        visibility: "local_notice_board",
        launch: {
          id: "test:hill_launch",
          prompt: "Which road do you commit to?",
          options: [
            {
              id: "test:ridge",
              title: "Take the Exposed Ridge",
              summary: "Spend less supply but arrive winded.",
              preview: "The ridge is fast and visible from the valley.",
              consequence: "You accept the wind and reach the steading first.",
              tradeoffSummary:
                "Hill lip 0; final descent 1; first lure DC 10; a clean lure reaches alarm 4 and scatters two cattle.",
              terms: { minutes: 30, supplies: 1, fatigue: 25 },
              projection: {
                available: true,
                minutesAfter: 510,
                suppliesAfter: 5,
                fatigueAfter: 25,
                travelConditionAfter: "tired",
              },
            },
            {
              id: "test:stockway",
              title: "Take the Sheltered Stockway",
              summary: "Spend more supply to stay fresh.",
              preview: "The stockway follows the quiet lee of the hill.",
              consequence: "You trade provisions and daylight for a quiet arrival.",
              terms: { minutes: 75, supplies: 2, fatigue: 10 },
              projection: {
                available: false,
                minutesAfter: 555,
                suppliesAfter: null,
                fatigueAfter: null,
                travelConditionAfter: null,
                blockedReason: "Requires 2 supplies; you have 1.",
              },
            },
          ],
        },
      };
      const otherQuest: OverworldQuestView = {
        ...quest,
        id: "test_other_quest",
        title: "Another Notice",
      };
      const split = module.splitQuestNotices({
        departureRecap: { questId: quest.id },
        quests: [quest, otherQuest],
        questStarts: [[quest.id, quest.launch!.options[0]!.id]],
      });
      expect(split.departureQuest?.id).toBe(quest.id);
      expect(split.noticeBoardQuests.map((candidate) => candidate.id)).toEqual([otherQuest.id]);
      const gatedSplit = module.splitQuestNotices({
        departureRecap: { questId: quest.id },
        quests: [quest, otherQuest],
        questStarts: [],
      });
      expect(gatedSplit.departureQuest).toBeNull();
      expect(gatedSplit.noticeBoardQuests.map((candidate) => candidate.id)).toEqual([
        quest.id,
        otherQuest.id,
      ]);
    } finally {
      await server.close();
    }

    const app = readFileSync("ui/src/App.tsx", "utf8");
    expect(app).toContain("worldSession.prepareQuestStart(quest.id, approachId)");
    expect(app).toContain("plan.characterAfter");
    expect(app).toContain("worldSession.commitQuestStart(plan)");
    expect(app).toContain("quest.launch.options.map((option)");
    expect(app).toContain("summary: option.preview");
    expect(app).toContain("option.projection?.blockedReason");
    expect(app).toContain("onChoose: () => startQuest(quest, option.id)");
  });

  it("renders registration choices without claiming a goal was completed or replaced", async () => {
    const uiRoot = resolve(process.cwd(), "ui");
    const server = await createServer({
      root: uiRoot,
      configFile: resolve(uiRoot, "vite.config.ts"),
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    try {
      const module = (await server.ssrLoadModule("/src/JourneyStoryChoiceScreen.tsx")) as {
        JourneyStoryChoiceScreen: unknown;
      };
      const requireFromUi = createRequire(resolve(uiRoot, "package.json"));
      const react = requireFromUi("react") as {
        createElement: (type: unknown, props: Record<string, unknown>) => unknown;
      };
      const reactDomServer = requireFromUi("react-dom/server") as {
        renderToStaticMarkup: (element: unknown) => string;
      };
      const journey = new OverworldSession(world).journey();
      const registrationJourney = {
        ...journey,
        storyChoice: {
          id: "albany_registration",
          kind: "registration",
          message: "Which lived history goes on Rowan's relief docket?",
          options: ["stockhand", "ledger_runner", "road_volunteer", "clinic_aide"].map((id) => ({
            id,
            label: id,
            consequence: `Carry ${id} into the journey.`,
          })),
        },
      };
      const markup = reactDomServer.renderToStaticMarkup(
        react.createElement(module.JourneyStoryChoiceScreen, {
          journey: registrationJourney,
          onChoose: () => undefined,
        }),
      );

      expect(markup).toContain("Choose your background");
      expect(markup).toContain("Current objective");
      expect(markup).toContain(
        "Your background stays with this character. Choose the experience you want to carry.",
      );
      expect(markup.match(/<button/g)).toHaveLength(4);
      expect(markup).not.toContain("Goal just completed");
      expect(markup).not.toContain("sets your next objective");
    } finally {
      await server.close();
    }
  });

  it("renders Albany lead-source choices without claiming a completed or replaced goal", async () => {
    const uiRoot = resolve(process.cwd(), "ui");
    const server = await createServer({
      root: uiRoot,
      configFile: resolve(uiRoot, "vite.config.ts"),
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    try {
      const module = (await server.ssrLoadModule("/src/JourneyStoryChoiceScreen.tsx")) as {
        JourneyStoryChoiceScreen: unknown;
      };
      const requireFromUi = createRequire(resolve(uiRoot, "package.json"));
      const react = requireFromUi("react") as {
        createElement: (type: unknown, props: Record<string, unknown>) => unknown;
      };
      const reactDomServer = requireFromUi("react-dom/server") as {
        renderToStaticMarkup: (element: unknown) => string;
      };
      const journey = new OverworldSession(world).journey();
      const leadSourceJourney = {
        ...journey,
        storyChoice: {
          id: "albany_wolf_winter_source",
          kind: "lead_source",
          message: "Which Albany source certifies the relief packet?",
          options: ["reese_manifest", "emery_survey", "decline_source"].map((id) => ({
            id,
            label: id,
            consequence: `Carry ${id} evidence into the journey.`,
          })),
        },
      };
      const markup = reactDomServer.renderToStaticMarkup(
        react.createElement(module.JourneyStoryChoiceScreen, {
          journey: leadSourceJourney,
          onChoose: () => undefined,
        }),
      );

      expect(markup).toContain("Wolf-Winter report");
      expect(markup).toContain("Choose the report you trust");
      expect(markup).toContain("Current objective");
      expect(markup).toContain(
        "Your report changes later quest approaches. Your current goal stays the same.",
      );
      expect(markup.match(/<button/g)).toHaveLength(3);
      expect(markup).not.toContain("Goal just completed");
      expect(markup).not.toContain("sets your next objective");
    } finally {
      await server.close();
    }
  });

  it("defers Wolf-Winter route terms to launch while rendering the optional Station interaction", async () => {
    const session = new OverworldSession(world);
    const opening = session.view();
    session.scoutPoi(opening.pois[0]!.id);
    session.talkToCharacter(world.opening_registration!.contact);
    session.chooseJourneyStory("albany:ledger_advocate");
    revealCurrentJourneyStoryOptions(session, world.opening_relief_oath!.id);
    session.chooseJourneyStory("albany:oath_limited_aid_only");
    session.chooseJourneyStory("albany:source_rowan_civic_docket");
    moveToOpeningPreparation(session);
    const beforeInspection = session.snapshot();
    const storyChoice = session.inspectJourneyStory("albany:wolf_preparation");
    const journey = { ...session.journey(), storyChoice };
    const departureRecap = session.view().departureRecap;
    if (!departureRecap)
      throw new Error("expected authenticated Station recall beside preparation");
    expect(storyChoice.kind).toBe("preparation");
    expect(session.snapshot()).toEqual(beforeInspection);

    const uiRoot = resolve(process.cwd(), "ui");
    const server = await createServer({
      root: uiRoot,
      configFile: resolve(uiRoot, "vite.config.ts"),
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    try {
      const module = (await server.ssrLoadModule("/src/JourneyStoryChoiceScreen.tsx")) as {
        JourneyStoryChoiceScreen: unknown;
      };
      const requireFromUi = createRequire(resolve(uiRoot, "package.json"));
      const react = requireFromUi("react") as {
        createElement: (type: unknown, props: Record<string, unknown>) => unknown;
      };
      const reactDomServer = requireFromUi("react-dom/server") as {
        renderToStaticMarkup: (element: unknown) => string;
      };
      const renderStoryScreen = (
        activeJourney: JourneyPresentation,
        recap: typeof departureRecap,
        dismissible: boolean,
      ) =>
        reactDomServer.renderToStaticMarkup(
          react.createElement(module.JourneyStoryChoiceScreen, {
            journey: activeJourney,
            departureRecap: recap,
            onChoose: () => undefined,
            ...(dismissible ? { onDismiss: () => undefined } : {}),
          }),
        );
      const assertRecapRows = (
        screenMarkup: string,
        recap: typeof departureRecap,
        expectedSelected: number,
        expectedOpen: number,
      ): void => {
        const recapStart = screenMarkup.indexOf(
          '<section aria-label="The Wolf-Winter departure plan">',
        );
        const recapEnd = screenMarkup.indexOf("</section>", recapStart);
        expect(recapStart).toBeGreaterThanOrEqual(0);
        expect(recapEnd).toBeGreaterThan(recapStart);
        const recapMarkup = screenMarkup.slice(recapStart, recapEnd);
        const selectedEntries = recap.entries.filter((entry) => entry.status === "selected");
        expect(selectedEntries).toHaveLength(expectedSelected);
        for (const entry of selectedEntries) {
          expect(recapMarkup).toContain(entry.title!.replaceAll("'", "&#x27;"));
        }
        expect(recap.entries.filter((entry) => entry.status === "open_optional")).toHaveLength(
          expectedOpen,
        );
        expect(recapMarkup.match(/Open \(optional\)/g) ?? []).toHaveLength(expectedOpen);
        const selectedTitles = new Set(selectedEntries.map((entry) => entry.title));
        for (const alternative of [
          ...world.opening_preparation!.profiles,
          ...world.opening_relief_allocation!.options,
          ...world.opening_ally!.options,
        ]) {
          if (!selectedTitles.has(alternative.title)) {
            expect(recapMarkup).not.toContain(alternative.title.replaceAll("'", "&#x27;"));
          }
        }
      };
      const markup = renderStoryScreen(journey, departureRecap, true);

      expect(markup).toContain(
        "You can leave Albany Station now or choose one field kit. The relief wagon and June are separate choices.",
      );
      expect(markup).not.toContain("Old Cade");
      expect(markup).not.toContain("wolf pack coming down with the weather");
      expect(markup).not.toContain("Take the Exposed Ridge Road");
      expect(markup).not.toContain("Take the Sheltered Stockway");
      expect(markup).toContain("<b>Cost:</b>");
      expect(markup).toContain("<b>Give up:</b>");
      expect(markup).toContain("The Wolf-Winter departure plan");
      assertRecapRows(markup, departureRecap, 3, 3);
      expect(markup).not.toContain("clean three-cast lure line");
      expect(markup).toContain("Return to the Station without choosing");
      expect(markup.match(/<button/g)).toHaveLength(4);

      const noRecapMarkup = reactDomServer.renderToStaticMarkup(
        react.createElement(module.JourneyStoryChoiceScreen, {
          journey,
          onChoose: () => undefined,
          onDismiss: () => undefined,
        }),
      );
      expect(noRecapMarkup).not.toContain("The Wolf-Winter departure plan");

      const preparation = world.opening_preparation!;
      const allocation = world.opening_relief_allocation!;
      const ally = world.opening_ally!;
      session.chooseJourneyStory(preparation.profiles[0]!.id, preparation.id);
      const allocationStory = session.inspectJourneyStory(allocation.id);
      const allocationRecap = session.view().departureRecap;
      if (!allocationRecap) throw new Error("expected Station recall beside relief allocation");
      const allocationMarkup = renderStoryScreen(
        { ...session.journey(), storyChoice: allocationStory },
        allocationRecap,
        true,
      );
      expect(allocationMarkup).toContain("Choose where Albany&#x27;s relief wagon goes");
      expect(allocationMarkup).toContain(
        "You can leave Albany Station now or assign the relief wagon. The field kit and June are separate choices.",
      );
      assertRecapRows(allocationMarkup, allocationRecap, 4, 2);

      session.chooseJourneyStory(allocation.options[0]!.id, allocation.id);
      session.talkToCharacter(ally.contact);
      const allyJourney = session.journey();
      if (allyJourney.storyChoice?.kind !== "ally") {
        throw new Error("expected active Station field-team choice");
      }
      const allyRecap = session.view().departureRecap;
      if (!allyRecap) throw new Error("expected Station recall beside field-team choice");
      const allyMarkup = renderStoryScreen(allyJourney, allyRecap, false);
      expect(allyMarkup).toContain("Choose a second rider or ride alone");
      expect(allyMarkup).toContain(
        "You can leave Albany Station alone or ask June Pike to join. The field kit and relief wagon are separate choices.",
      );
      assertRecapRows(allyMarkup, allyRecap, 5, 1);
    } finally {
      await server.close();
    }
  });

  it("renders all three relief-oath terms with their complete binding consequences", async () => {
    const uiRoot = resolve(process.cwd(), "ui");
    const server = await createServer({
      root: uiRoot,
      configFile: resolve(uiRoot, "vite.config.ts"),
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    try {
      const module = (await server.ssrLoadModule("/src/JourneyStoryChoiceScreen.tsx")) as {
        JourneyStoryChoiceScreen: unknown;
      };
      const requireFromUi = createRequire(resolve(uiRoot, "package.json"));
      const react = requireFromUi("react") as {
        createElement: (type: unknown, props: Record<string, unknown>) => unknown;
      };
      const reactDomServer = requireFromUi("react-dom/server") as {
        renderToStaticMarkup: (element: unknown) => string;
      };
      const journey = new OverworldSession(world).journey();
      const oathJourney = {
        ...journey,
        storyChoice: {
          id: "albany:wolf_relief_oath",
          kind: "relief_oath",
          message: "Choose the Wolf-Winter term that will bind this dispatch.",
          options: [
            [
              "full",
              "Take Full Compact Duty",
              "Access: boundary annex. Duty: public seals. Actual cost: 10 minutes.",
            ],
            [
              "limited",
              "Negotiate Aid-Only Duty",
              "Access: witnessed count. Duty: no property authority. Actual cost: 5 minutes.",
            ],
            [
              "unaffiliated",
              "Remain an Unaffiliated Helper",
              "Access: service cut. Duty: personal bond. Actual cost: 0 minutes.",
            ],
          ].map(([id, label, consequence]) => ({ id, label, consequence })),
        },
      };
      const markup = reactDomServer.renderToStaticMarkup(
        react.createElement(module.JourneyStoryChoiceScreen, {
          journey: oathJourney,
          onChoose: () => undefined,
        }),
      );

      expect(markup).toContain("Wolf-Winter promise");
      expect(markup).toContain("Choose one Wolf-Winter promise");
      expect(markup).toContain("Current objective");
      expect(markup).toContain("access, cost, field effect, and return terms");
      expect(markup).toContain(
        "Access: boundary annex. Duty: public seals. Actual cost: 10 minutes.",
      );
      expect(markup).toContain(
        "Access: witnessed count. Duty: no property authority. Actual cost: 5 minutes.",
      );
      expect(markup).toContain("Access: service cut. Duty: personal bond. Actual cost: 0 minutes.");
      expect(markup.match(/<button/g)).toHaveLength(3);
      expect(markup).not.toContain("Goal just completed");
      expect(markup).not.toContain("sets your next objective");
    } finally {
      await server.close();
    }
  });

  it("drives a real relief-oath button to the same snapshot as direct production play", async () => {
    const uiSession = new OverworldSession(world);
    const opening = uiSession.view();
    uiSession.scoutPoi(opening.pois[0]!.id);
    uiSession.talkToCharacter(opening.characters[0]!.id);
    expect(uiSession.journey().storyChoice?.kind).toBe("registration");
    uiSession.chooseJourneyStory("albany:ledger_advocate");

    const journey = uiSession.journey();
    if (journey.storyChoice?.kind !== "relief_oath") {
      throw new Error("Expected the production opening relief-oath prompt.");
    }
    const selectedIndex = journey.storyChoice.options.findIndex(
      (option) => option.id === "albany:oath_limited_aid_only",
    );
    if (selectedIndex < 0) throw new Error("Expected the authored aid-only oath term.");
    const selectedOption = journey.storyChoice.options[selectedIndex]!;
    const beforeChoice = uiSession.snapshot();
    const directSession = OverworldSession.restore(world, beforeChoice);

    const uiRoot = resolve(process.cwd(), "ui");
    const server = await createServer({
      root: uiRoot,
      configFile: resolve(uiRoot, "vite.config.ts"),
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    try {
      const module = (await server.ssrLoadModule("/src/JourneyStoryChoiceScreen.tsx")) as {
        JourneyStoryChoiceScreen: (props: {
          journey: ReturnType<OverworldSession["journey"]>;
          onChoose: (choiceId: string) => void;
        }) => unknown;
      };
      const requireFromUi = createRequire(resolve(uiRoot, "package.json"));
      const react = requireFromUi("react") as {
        Children: { toArray: (children: unknown) => unknown[] };
        __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
          ReactCurrentDispatcher: { current: unknown };
        };
        createElement: (type: unknown, props: Record<string, unknown>) => unknown;
        isValidElement: (value: unknown) => boolean;
      };
      const reactDomServer = requireFromUi("react-dom/server") as {
        renderToStaticMarkup: (element: unknown) => string;
      };
      const selectedByUi: string[] = [];
      let uiResult: ReturnType<OverworldSession["chooseJourneyStory"]> | undefined;
      const componentProps = {
        journey,
        onChoose: (choiceId: string): void => {
          selectedByUi.push(choiceId);
          uiResult = uiSession.chooseJourneyStory(choiceId);
        },
      };
      const markup = reactDomServer.renderToStaticMarkup(
        react.createElement(module.JourneyStoryChoiceScreen, componentProps),
      );

      expect(markup).toContain("Wolf-Winter promise");
      expect(markup).toContain(journey.storyChoice.message);
      expect(markup).toContain(selectedOption.label);
      expect(markup).toContain("Cost:");
      expect(markup).toContain("Give up:");
      expect(markup).toContain(selectedOption.consequence.replaceAll("'", "&#x27;"));
      expect(markup).not.toContain("Bounded authority becomes a named value");
      expect(markup.match(/<button/g)).toHaveLength(journey.storyChoice.options.length);

      type ReactElementNode = {
        type: unknown;
        props: { children?: unknown; onClick?: unknown };
      };
      const dispatcher =
        react.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
      const previousDispatcher = dispatcher.current;
      dispatcher.current = {
        useEffect: () => undefined,
        useRef: <T>(initialValue: T) => ({ current: initialValue }),
        useState: <T>(initialValue: T) => [initialValue, () => undefined] as const,
      };
      let elementTree: unknown;
      try {
        elementTree = module.JourneyStoryChoiceScreen(componentProps);
      } finally {
        dispatcher.current = previousDispatcher;
      }
      const buttons: ReactElementNode[] = [];
      const collectButtons = (node: unknown): void => {
        if (!react.isValidElement(node)) return;
        const element = node as ReactElementNode;
        if (element.type === "button") buttons.push(element);
        for (const child of react.Children.toArray(element.props.children)) {
          collectButtons(child);
        }
      };
      collectButtons(elementTree);
      expect(buttons).toHaveLength(journey.storyChoice.options.length);
      const onClick = buttons[selectedIndex]?.props.onClick;
      if (typeof onClick !== "function") {
        throw new Error("Expected the production relief-oath button click handler.");
      }

      onClick();
      const directResult = directSession.chooseJourneyStory(selectedOption.id);

      expect(selectedByUi).toEqual([selectedOption.id]);
      expect(uiResult).toEqual(directResult);
      expect(uiSession.journey()).toEqual(directSession.journey());
      expect(uiSession.snapshot()).toEqual(directSession.snapshot());
      expect(uiSession.snapshotHash()).toBe(directSession.snapshotHash());
      expect(uiSession.snapshot().minutes).toBe(beforeChoice.minutes + 5);
      expect(uiSession.journey().storyChoice?.kind).toBe("lead_source");
    } finally {
      await server.close();
    }
  });

  it("renders ally commitments with an honest current-objective and field-terms frame", async () => {
    const uiRoot = resolve(process.cwd(), "ui");
    const server = await createServer({
      root: uiRoot,
      configFile: resolve(uiRoot, "vite.config.ts"),
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    try {
      const module = (await server.ssrLoadModule("/src/JourneyStoryChoiceScreen.tsx")) as {
        JourneyStoryChoiceScreen: unknown;
      };
      const requireFromUi = createRequire(resolve(uiRoot, "package.json"));
      const react = requireFromUi("react") as {
        createElement: (type: unknown, props: Record<string, unknown>) => unknown;
      };
      const reactDomServer = requireFromUi("react-dom/server") as {
        renderToStaticMarkup: (element: unknown) => string;
      };
      const journey = new OverworldSession(world).journey();
      const allyJourney = {
        ...journey,
        storyChoice: {
          id: "albany_wolf_ally",
          kind: "ally",
          message: "Capability: June can hold the cattle line. Condition: cattle come first.",
          options: ["join", "relay", "solo"].map((id, index) => ({
            id,
            label: id,
            consequence: `Preview ${id}. Actual cost: ${String(index * 5)} minutes.`,
          })),
        },
      };
      const markup = reactDomServer.renderToStaticMarkup(
        react.createElement(module.JourneyStoryChoiceScreen, {
          journey: allyJourney,
          onChoose: () => undefined,
        }),
      );

      expect(markup).toContain("Optional second rider");
      expect(markup).toContain("Choose a second rider or ride alone");
      expect(markup).toContain("Current objective");
      expect(markup).toContain("Capability: June can hold the cattle line");
      expect(markup).toContain("Condition: cattle come first");
      expect(markup).toContain("Actual cost");
      expect(markup).toContain("Actual cost: 10 minutes");
      expect(markup.match(/<button/g)).toHaveLength(3);
      expect(markup).not.toContain("Goal just completed");
      expect(markup).not.toContain("sets your next objective");
    } finally {
      await server.close();
    }
  });

  it("renders the fully populated canonical character as a semantic read-only record", async () => {
    const screen = readFileSync("ui/src/OverworldPlayScreen.tsx", "utf8");
    expect(screen).toContain(
      'panel === "character" && <CampaignCharacterPanel character={world.character} />',
    );

    const uiRoot = resolve(process.cwd(), "ui");
    const server = await createServer({
      root: uiRoot,
      configFile: resolve(uiRoot, "vite.config.ts"),
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    try {
      const module = (await server.ssrLoadModule("/src/CampaignCharacterPanel.tsx")) as {
        CampaignCharacterPanel: unknown;
      };
      const requireFromUi = createRequire(resolve(uiRoot, "package.json"));
      const react = requireFromUi("react") as {
        createElement: (type: unknown, props: Record<string, unknown>) => unknown;
      };
      const reactDomServer = requireFromUi("react-dom/server") as {
        renderToStaticMarkup: (element: unknown) => string;
      };
      const markup = reactDomServer.renderToStaticMarkup(
        react.createElement(module.CampaignCharacterPanel, {
          character: populatedUiCharacter(),
        }),
      );

      expect(markup).toMatch(
        /^<details class="character-panel"><summary class="character-heading"><h2 class="character-heading-layout">[\s\S]*<\/h2><\/summary>/,
      );
      expect(markup.match(/<h3>/g)).toHaveLength(11);
      for (const visibleText of [
        "Your Record",
        "Road Warden",
        "Fieldcraft",
        "Keep Promises",
        "Warden Spear",
        "Wolf Bite",
        "Brace",
        "Wolf Spoor",
        "Hayden Hale",
        "June Pike",
        "Albany Hinterland",
        "Old Cade",
        "Kept Watch",
        "Road Wardens",
        "Read only",
      ]) {
        expect(markup).toContain(visibleText);
      }
      expect(markup).not.toMatch(/<(?:button|input|select|textarea)\b/);
    } finally {
      await server.close();
    }
  });

  it("keeps Albany's first scout, talk, and explore choices on the same reveal loop", () => {
    const scoutSession = new OverworldSession(world);
    const scoutStart = scoutSession.view();
    const scouted = scoutSession.scoutPoi(scoutStart.pois[0]!.id);
    expect(scouted.discoveredAreas?.map((area) => area.id)).toEqual(["albany_city__market"]);
    expect(scouted.discoveredJobs?.map((job) => job.id)).toEqual(["albany_city__civic_core__job"]);
    expect(scouted.discoveredSites?.map((site) => site.id)).toEqual([
      "albany_city__civic_core__site",
    ]);
    expect(scouted.discoveredQuests).toEqual([]);

    const talkSession = new OverworldSession(world);
    const talkStart = talkSession.view();
    const talked = talkSession.talkToCharacter(talkStart.characters[0]!.id);
    expect(talked.discoveredAreas?.map((area) => area.id)).toEqual(["albany_city__market"]);
    expect(talked.discoveredJobs?.map((job) => job.id)).toEqual(["albany_city__civic_core__job"]);
    expect(talked.discoveredSites?.map((site) => site.id)).toEqual([
      "albany_city__civic_core__site",
    ]);
    expect(talked.discoveredQuests).toEqual([]);

    const exploreSession = new OverworldSession(world);
    const exploreStart = exploreSession.view();
    const explored = exploreSession.exploreArea(exploreStart.currentArea!.id);
    expect(explored.discoveredAreas?.map((area) => area.id)).toEqual(["albany_city__market"]);
    expect(explored.discoveredJobs?.map((job) => job.id)).toEqual(["albany_city__civic_core__job"]);
    expect(explored.discoveredSites?.map((site) => site.id)).toEqual([
      "albany_city__civic_core__site",
    ]);
    expect(explored.discoveredQuests).toEqual([]);
  });

  it("returns the freshly discovered Civic job without leaking unavailable authored options", () => {
    const civicJob = world.local_jobs.find((job) => job.id === "albany_city__civic_core__job");
    if (!civicJob?.authored_scene) throw new Error("expected the authored Civic return job");
    const authoredOptions = civicJob.authored_scene.options.map((option) => ({ ...option }));
    const session = new UiOverworldSession(world);

    const result = session.scoutPoi(session.view().pois[0]!.id);
    const discovered = result.discoveredJobs?.find((job) => job.id === civicJob.id);

    expect(discovered).toMatchObject({ id: civicJob.id, title: civicJob.title });
    expect(discovered?.authored_scene?.options).toEqual([]);
    expect(session.view().jobs.map((job) => job.id)).not.toContain(civicJob.id);
    const serialized = JSON.stringify(discovered);
    for (const option of authoredOptions) {
      expect(serialized).not.toContain(option.id);
      expect(serialized).not.toContain(option.title);
      expect(serialized).not.toContain(option.preview);
    }
    expect(civicJob.authored_scene.options).toEqual(authoredOptions);
  });

  it("maps local areas progressively before exhausting a town", () => {
    const session = new OverworldSession(world);
    const start = session.view();
    const localAreas = world.areas
      .filter((area) => area.home === start.current.id)
      .sort((a, b) => a.travel_minutes - b.travel_minutes || a.name.localeCompare(b.name));
    const firstArea = start.areas[0]!;

    expect(localAreas.length).toBeGreaterThan(1);
    expect(start.areas.map((area) => area.id)).toEqual([localAreas[0]!.id]);

    const explored = session.exploreArea(firstArea.id);
    expect(explored.minutes).toBe(firstArea.travel_minutes);
    expect(explored.entry.kind).toBe("area");
    expect(explored.discoveredAreas?.map((area) => area.id)).toEqual([localAreas[1]!.id]);
    expect(explored.discoveredJobs).toHaveLength(1);
    expect(explored.discoveredSites).toHaveLength(1);
    expect(explored.discoveredQuests).toEqual([]);

    const after = session.view();
    expect(after.visitedAreaIds).toContain(firstArea.id);
    expect(after.areas.map((area) => area.id)).toEqual(
      localAreas.slice(0, 2).map((area) => area.id),
    );
    expect(after.currentArea?.id).toBe(firstArea.id);
    expect(after.areaExits.map((exit) => exit.destination.id)).toEqual([localAreas[1]!.id]);
    expect(after.hiddenAreaCount).toBe(localAreas.length - 2);
    expect(after.journal[0]?.title).toContain(firstArea.name);

    const repeated = session.exploreArea(firstArea.id);
    expect(repeated.alreadyKnown).toBe(true);
    expect(repeated.minutes).toBe(0);
    expect(repeated.discoveredAreas).toEqual([]);
    expect(repeated.discoveredJobs).toEqual([]);
    expect(repeated.discoveredSites).toEqual([]);
    expect(repeated.discoveredQuests).toEqual([]);
  });

  it("moves through discovered local area routes inside a town", () => {
    const session = new OverworldSession(world);
    const start = session.view();
    const firstArea = start.areas[0]!;
    session.exploreArea(firstArea.id);
    const mapped = session.view();
    const route = mapped.areaExits[0]!;
    const destination = route.destination;

    expect(() => session.exploreArea(destination.id)).toThrow(/Move to that local area/i);
    const moved = session.moveArea(route.id);
    expect(moved).toMatchObject({
      from: firstArea,
      to: destination,
      route: route.route,
      minutes: route.travel_minutes,
    });

    const after = session.view();
    expect(after.currentArea?.id).toBe(destination.id);
    expect(after.areaExits.map((exit) => exit.destination.id)).toContain(firstArea.id);
    expect(after.timeLabel).not.toBe(mapped.timeLabel);

    const explored = session.exploreArea(destination.id);
    expect(explored.entry.kind).toBe("area");
    expect(explored.entry.title).toContain(destination.name);
  });

  it("reveals and completes local jobs tied to mapped areas", () => {
    const genericWorld = structuredClone(world);
    const genericJob = genericWorld.local_jobs.find((job) => job.home === genericWorld.start);
    if (!genericJob) throw new Error("expected a generic local-job fixture");
    delete genericJob.authored_scene;
    const session = new OverworldSession(genericWorld);
    const start = session.view();
    const hiddenJob = genericWorld.local_jobs.find((job) => job.home === start.current.id);
    expect(hiddenJob).toBeDefined();
    expect(() => session.workLocalJob(hiddenJob!.id)).toThrow(/Take fresh local actions/i);

    const explored = session.exploreArea(start.areas[0]!.id);
    expect(explored.discoveredJobs).toHaveLength(1);
    const job = session.view().jobs[0]!;
    expect(job.area).toBe(start.areas[0]!.id);
    expect(session.view().discoveredJobIds).toContain(job.id);

    const worked = session.workLocalJob(job.id);
    expect(worked.minutes).toBe(job.minutes);
    expect(worked.entry).toMatchObject({
      kind: "job",
      title: `Completed ${job.title}`,
    });

    const after = session.view();
    expect(after.completedJobIds).toContain(job.id);
    expect(after.jobs.map((candidate) => candidate.id)).not.toContain(job.id);
    expect(after.rememberedJobs.map((candidate) => candidate.id)).not.toContain(job.id);
    expect(after.regionRenown[start.current.region]).toBe(job.difficulty);
    expect(after.journal[0]?.kind).toBe("job");

    const compactAfter = session.compactView();
    expect(compactAfter.jobs?.map(([id]) => id) ?? []).not.toContain(job.id);
    expect(compactAfter.remembered_jobs?.map(([id]) => id) ?? []).not.toContain(job.id);
    expect(compactAfter.ids.completed_jobs ?? []).toContain(job.id);
    expect(compactAfter.journal?.[0]?.[0]).toBe("job");

    const repeated = session.workLocalJob(job.id);
    expect(repeated.alreadyKnown).toBe(true);
    expect(repeated.minutes).toBe(0);
    expect(repeated.discoveredJobs).toEqual([]);
  });

  it("remembers unfinished jobs discovered outside the current local area", () => {
    const genericWorld = structuredClone(world);
    const rememberedJob = genericWorld.local_jobs.find(
      (job) => job.id === "albany_city__market__job",
    );
    if (!rememberedJob) throw new Error("Expected Albany Market's local-job fixture.");
    delete rememberedJob.authored_scene;
    const session = new OverworldSession(genericWorld);
    const start = session.view();
    const currentAreaId = start.currentArea!.id;

    session.talkToCharacter(start.characters[0]!.id);
    settleOpeningRegistration(session);
    moveToArea(session, "albany_city__market");
    const marketPoi = session.view().pois.find((poi) => poi.id === "albany_city__market__poi");
    if (!marketPoi) throw new Error("Expected Albany Market's visible POI.");
    session.scoutPoi(marketPoi.id);
    expect(rememberedJob.area).not.toBe(currentAreaId);
    expect(session.view().discoveredJobIds).toContain(rememberedJob.id);
    moveToArea(session, currentAreaId);

    const afterDiscovery = session.view();
    expect(afterDiscovery.currentArea?.id).toBe(currentAreaId);
    expect(afterDiscovery.jobs.map((job) => job.id)).not.toContain(rememberedJob.id);
    expect(afterDiscovery.rememberedJobs.map((job) => job.id)).toContain(rememberedJob.id);
    expect(afterDiscovery.rememberedJobs.find((job) => job.id === rememberedJob.id)).toMatchObject({
      id: rememberedJob.id,
      area: rememberedJob.area,
    });
    expect(() => session.workLocalJob(rememberedJob.id)).toThrow(/Move to that local area/i);

    const compactAfterDiscovery = session.compactView();
    expect(compactAfterDiscovery.jobs?.map(([id]) => id) ?? []).not.toContain(rememberedJob.id);
    expect(compactAfterDiscovery.remembered_jobs).toContainEqual([
      rememberedJob.id,
      rememberedJob.title,
      rememberedJob.area,
    ]);

    const routeToRememberedJob = afterDiscovery.areaExits.find(
      (exit) => exit.destination.id === rememberedJob.area,
    );
    expect(routeToRememberedJob).toBeDefined();
    session.moveArea(routeToRememberedJob!.id);

    const inJobArea = session.view();
    expect(inJobArea.currentArea?.id).toBe(rememberedJob.area);
    expect(inJobArea.jobs.map((job) => job.id)).toContain(rememberedJob.id);
    expect(inJobArea.rememberedJobs.map((job) => job.id)).not.toContain(rememberedJob.id);

    session.workLocalJob(rememberedJob.id);
    const afterCompletion = session.view();
    expect(afterCompletion.completedJobIds).toContain(rememberedJob.id);
    expect(afterCompletion.jobs.map((job) => job.id)).not.toContain(rememberedJob.id);
    expect(afterCompletion.rememberedJobs.map((job) => job.id)).not.toContain(rememberedJob.id);
  });

  it("advances location, clock, supplies, and fatigue by the selected road travel time", () => {
    const session = new OverworldSession(world);
    const before = session.view();
    const road = before.exits.find((exit) => exit.destination.id === "colonie_town");
    expect(road).toBeDefined();

    const entry = session.travel(road!.id);
    const after = session.view();
    expect(after.current.id).toBe(`road:${road!.id}`);
    expect(after.current.name).toBe(`On ${road!.route}: Albany city to Colonie town`);
    expect(after.current.description).toContain("You are between Albany city and Colonie town");
    expect(after.currentArea).toBeNull();
    expect(after.exits).toEqual([]);
    expect(after.areaExits).toEqual([]);
    expect(after.areas).toEqual([]);
    expect(after.jobs).toEqual([]);
    expect(after.routeOptions).toEqual([]);
    expect(after.serviceActions).toEqual([]);
    expect(entry.baseMinutes).toBe(road!.travel_minutes);
    expect(entry.delayMinutes).toBe(0);
    expect(entry.minutes).toBe(road!.travel_minutes);
    expect(entry.roadEvent?.edge).toBe(road!.id);
    expect(entry.suppliesUsed).toBeGreaterThan(0);
    expect(entry.suppliesAfter).toBeLessThan(before.supplies);
    expect(entry.fatigueGained).toBeGreaterThan(0);
    expect(entry.fatigueAfter).toBeGreaterThan(before.fatigue);
    expect(after.log[0]).toMatchObject({
      edgeId: road!.id,
      fromId: "albany_city",
      toId: "colonie_town",
      from: "Albany city",
      to: "Colonie town",
      baseMinutes: road!.travel_minutes,
      delayMinutes: 0,
      minutes: entry.minutes,
      suppliesUsed: entry.suppliesUsed,
      suppliesAfter: entry.suppliesAfter,
      fatigueGained: entry.fatigueGained,
      fatigueAfter: entry.fatigueAfter,
    });
    expect(after.supplies).toBe(entry.suppliesAfter);
    expect(after.fatigue).toBe(entry.fatigueAfter);
    expect(after.pendingRoadEncounter).toMatchObject({
      edgeId: road!.id,
      from: "Albany city",
      to: "Colonie town",
    });
    expect(after.pendingRoadEncounter?.timing).toBe(
      `Road encounter from Albany city to Colonie town at ${after.pendingRoadEncounter?.arrivedAt}. Resolve it before taking actions in Colonie town.`,
    );
    expect(after.pendingRoadEncounter?.options.map((option) => option.strategy)).toEqual([
      "cautious_scout",
      "assist_travelers",
      "press_on",
    ]);
    expect(session.compactView()).toEqual(compactOverworldView(after));
    expect("service_actions" in session.compactView()).toBe(false);
    expect(() => session.planRoute("albany_city")).toThrow(/pending road encounter/i);
    session.resolveRoadEncounter("press_on");
    expect(session.view().current.id).toBe("colonie_town");
    expect(session.view().serviceActions).toHaveLength(2);
    const backRoute = session.planRoute("albany_city");
    expect(backRoute.totalMinutes).toBe(road!.travel_minutes);
    expect(backRoute.steps.map((step) => step.to.id)).toEqual(["albany_city"]);
    expect(backRoute.estimate.baseMinutes).toBe(backRoute.totalMinutes);
    expect(backRoute.estimate.suppliesUsed).toBe(backRoute.estimate.suppliesNeeded);
    expect(backRoute.estimate.supplyDeficit).toBe(0);
    expect(after.timeLabel).not.toBe(before.timeLabel);
  });

  it("requires and resolves road encounter choices before the next road leg", () => {
    const session = new OverworldSession(world);
    const road = session.view().exits.find((exit) => exit.destination.id === "colonie_town");
    expect(road).toBeDefined();
    session.travel(road!.id);
    const arrived = session.view();
    const encounter = arrived.pendingRoadEncounter;
    expect(encounter?.event.edge).toBe(road!.id);
    expect(arrived.current.id).toBe(`road:${road!.id}`);
    expect(arrived.exits).toEqual([]);
    expect(() => session.travel(road!.id)).toThrow(/pending road encounter/i);

    const option = encounter!.options.find(
      (candidate) => candidate.strategy === "assist_travelers",
    );
    expect(option).toBeDefined();
    const resolved = session.resolveRoadEncounter("assist_travelers");
    expect(resolved).toMatchObject({
      strategy: "assist_travelers",
      minutes: option!.minutes,
      suppliesUsed: option!.suppliesCost,
      fatigueGained: option!.fatigueGained,
      renownGained: option!.renownGained,
    });
    const after = session.view();
    expect(after.pendingRoadEncounter).toBeNull();
    expect(after.journal[0]).toMatchObject({
      kind: "road",
      title: `${option!.label}: ${encounter!.event.title}`,
    });
    expect(after.journal[0]?.text).toContain("Road encounter from Albany city to Colonie town");
    expect(after.journal[0]?.text).toContain("You arrive in Colonie town.");
    expect(after.current.id).toBe("colonie_town");
    expect(after.currentArea?.home).toBe("colonie_town");
    expect(session.compactView()).toEqual(compactOverworldView(after));
    expect(after.regionRenown[arrived.current.region]).toBe(option!.renownGained);
    const returnRoad = after.exits.find((candidate) => candidate.destination.id === "albany_city");
    expect(returnRoad).toBeDefined();
    const returned = session.travel(returnRoad!.id);
    const returnedView = session.view();
    expect(returned.edgeId).toBe(road!.id);
    expect(returned.roadEvent).toBeNull();
    expect(returnedView.pendingRoadEncounter).toBeNull();
    expect(returnedView.log[0]?.roadEvent).toBeNull();
    expect(session.snapshot().travelLog[0]?.roadEventId).toBeNull();
  });

  it("disables every non-encounter Night Watch action while route trouble is pending", () => {
    const app = readFileSync("ui/src/App.tsx", "utf8");
    const guardStart = app.indexOf(
      "if (worldView.pendingRoadEncounter) {",
      app.indexOf('id: "roads"'),
    );
    const priorityStart = app.indexOf("const hasLegalDispatchAction", guardStart);
    expect(guardStart).toBeGreaterThanOrEqual(0);
    expect(priorityStart).toBeGreaterThan(guardStart);
    const guard = app.slice(guardStart, priorityStart);

    expect(guard).toContain('if (section.id === "encounter") continue');
    expect(guard).toContain("for (const action of section.actions)");
    expect(guard).toContain("action.disabledReason = encounterBlock");
    expect(guard).toContain("Resolve the pending road encounter before taking another action.");
  });

  it("round-trips stateful sessions through content-bound snapshots", () => {
    const session = new OverworldSession(world);
    const start = session.view();
    const road = start.exits.find((exit) => exit.destination.id === "colonie_town");
    expect(road).toBeDefined();

    session.scoutPoi(start.pois[0]!.id);
    session.exploreArea(start.areas[0]!.id);
    session.travel(road!.id);
    const before = session.view();
    expect(before.pendingRoadEncounter).toBeDefined();

    const snapshot = JSON.parse(JSON.stringify(session.snapshot())) as ReturnType<
      typeof session.snapshot
    >;
    expect(snapshot.pendingRoadEncounter).toEqual({ edgeId: road!.id });
    expect(snapshot.pendingRoadEncounter).not.toHaveProperty("event");
    expect(snapshot.pendingRoadEncounter).not.toHaveProperty("options");
    expect(JSON.stringify(snapshot.pendingRoadEncounter).length).toBeLessThan(
      JSON.stringify(before.pendingRoadEncounter).length / 4,
    );
    expect(snapshot.travelLog[0]).toMatchObject({
      edgeId: road!.id,
      fromId: start.current.id,
      toId: road!.destination.id,
      roadEventId: before.log[0]!.roadEvent?.id,
      minutes: before.log[0]!.minutes,
      arrivedAt: before.log[0]!.arrivedAt,
    });
    expect(snapshot.travelLog[0]).not.toHaveProperty("roadEvent");
    expect(snapshot.travelLog[0]).not.toHaveProperty("from");
    expect(snapshot.travelLog[0]).not.toHaveProperty("to");
    expect(snapshot.travelLog[0]).not.toHaveProperty("route");
    expect(snapshot.travelLog[0]).not.toHaveProperty("distanceMi");
    expect(snapshot.travelLog[0]).not.toHaveProperty("baseMinutes");
    expect(JSON.stringify(snapshot.travelLog[0]).length).toBeLessThan(
      JSON.stringify(before.log[0]).length / 2,
    );
    const restored = OverworldSession.restore(world, snapshot);
    expect(restored.view()).toEqual(before);
    expect(() => restored.travel(road!.id)).toThrow(/pending road encounter/i);

    restored.resolveRoadEncounter("press_on");
    expect(restored.view().pendingRoadEncounter).toBeNull();
    expect(restored.view().journal[0]?.kind).toBe("road");

    const staleWorldSnapshot = {
      ...session.snapshot(),
      worldHash: "0".repeat(64),
    };
    const restoredAcrossContentRevision = OverworldSession.restore(world, staleWorldSnapshot);
    expect(restoredAcrossContentRevision.snapshot()).toEqual(session.snapshot());
    expect(restoredAcrossContentRevision.restoreWarnings()).toEqual([
      OVERWORLD_CONTENT_HASH_MISMATCH_WARNING,
    ]);

    const corruptSnapshot = {
      ...session.snapshot(),
      currentId: "missing_town",
    };
    expect(() => OverworldSession.restore(world, corruptSnapshot)).toThrow(/unknown current town/i);

    const validSnapshot = session.snapshot();
    const duplicateAreaMapSnapshot = {
      ...validSnapshot,
      currentAreaByTown: [validSnapshot.currentAreaByTown[0]!, validSnapshot.currentAreaByTown[0]!],
    };
    expect(() => OverworldSession.restore(world, duplicateAreaMapSnapshot)).toThrow(
      /duplicate area-map town/i,
    );

    const duplicateRenownSnapshot = {
      ...validSnapshot,
      regionRenown: [
        [start.current.region, 1],
        [start.current.region, 2],
      ],
    };
    expect(() => OverworldSession.restore(world, duplicateRenownSnapshot)).toThrow(
      /duplicate renown region/i,
    );

    const undiscoveredCurrentAreaSnapshot = {
      ...validSnapshot,
      discoveredAreaIds: validSnapshot.discoveredAreaIds.filter(
        (id) => id !== validSnapshot.currentAreaId,
      ),
    };
    expect(() => OverworldSession.restore(world, undiscoveredCurrentAreaSnapshot)).toThrow(
      /current area is not discovered/i,
    );

    const tamperedPendingRoadSnapshot = JSON.parse(JSON.stringify(validSnapshot)) as ReturnType<
      typeof session.snapshot
    >;
    expect(tamperedPendingRoadSnapshot.pendingRoadEncounter).toBeDefined();
    tamperedPendingRoadSnapshot.pendingRoadEncounter!.edgeId = "missing_road";
    expect(() => OverworldSession.restore(world, tamperedPendingRoadSnapshot)).toThrow(
      /unknown pending road/i,
    );

    const tamperedTravelLogSnapshot = JSON.parse(JSON.stringify(validSnapshot)) as ReturnType<
      typeof session.snapshot
    >;
    tamperedTravelLogSnapshot.travelLog[0]!.edgeId = "missing_road";
    delete tamperedTravelLogSnapshot.travelLog[0]!.roadEventId;
    expect(() => OverworldSession.restore(world, tamperedTravelLogSnapshot)).toThrow(
      /unknown travel road/i,
    );
  });

  it("caps compact context id lists while keeping counts and truncation flags", () => {
    const session = new OverworldSession(world);
    for (let i = 0; i < 120 && session.view().discovered.length <= 24; i += 1) {
      let view = session.view();
      if (view.pendingRoadEncounter) session.resolveRoadEncounter("press_on");
      view = session.view();
      const next =
        view.exits.find(
          (exit) => !view.discovered.some((town) => town.id === exit.destination.id),
        ) ?? view.exits[i % view.exits.length];
      if (!next) break;
      session.travel(next.id);
    }
    if (session.view().pendingRoadEncounter) session.resolveRoadEncounter("press_on");

    const view = session.view();
    expect(view.discovered.length).toBeGreaterThan(24);
    const compact = compactOverworldView(view);
    expect(session.compactView()).toEqual(compact);
    expect(compact.v).toBe(OVERWORLD_COMPACT_VIEW_VERSION);
    expect(compact.hidden).toEqual([
      view.hiddenAreaCount,
      view.hiddenJobCount,
      view.hiddenSiteCount,
      view.hiddenQuestCount,
    ]);
    expect(compact.progress).toEqual([view.visitedCount, view.totalTowns]);
    expect(compact.ids.discovered_towns).toHaveLength(16);
    expect(compact.id_counts).toHaveLength(11);
    expect(compact.id_counts[0]).toBe(view.discovered.length);
    expect(compact.ids_truncated).toContain("discovered_towns");
    expect(compact.id_counts[8]).toBe(view.startedQuestIds.length);
    expect(compact.id_counts[9]).toBe(view.completedQuestIds.length);
    expect(compact.id_counts[10]).toBe(view.resolvedEventIds.length);
    expect(compact.ids_truncated).not.toContain("resolved_events");
    if (view.resolvedEventIds.length === 0) {
      expect("resolved_events" in compact.ids).toBe(false);
    }
  });

  it("projects and detaches one-time service terms in compact context", () => {
    const view = new OverworldSession(world).view();
    const longSummary = "dispatch terms ".repeat(40);
    const sourceOffers = [
      {
        id: "albany:service:rest",
        action: "rest" as const,
        title: "Rest under Rowan's relief seal",
        summary: `Emery Sloane opens the shelter. ${longSummary}`,
        minutes: 180,
        providerId: "albany_city__greenway__contact",
        providerName: "Emery Sloane",
      },
      {
        id: "albany:service:resupply",
        action: "resupply" as const,
        title: "Draw the one-time relief issue",
        summary: "Fill the field pack from Albany's reserved relief stock.",
        minutes: 15,
      },
    ];
    const fullClone = cloneOverworldView({ ...view, serviceOffers: sourceOffers });
    const compact = compactOverworldView({ ...view, serviceOffers: sourceOffers });

    expect(compact.service_offers).toEqual([
      [
        sourceOffers[0]!.id,
        "rest",
        sourceOffers[0]!.title,
        expect.stringMatching(/\.\.\.\(\+\d+ chars\)$/),
        180,
      ],
      [sourceOffers[1]!.id, "resupply", sourceOffers[1]!.title, sourceOffers[1]!.summary, 15],
    ]);
    expect(compact.service_offers?.[0]?.[3]).toHaveLength(
      OVERWORLD_COMPACT_SERVICE_SUMMARY_CHAR_LIMIT,
    );

    sourceOffers[0]!.title = "mutated source";
    expect(Object.keys(fullClone.serviceOffers[0]!).sort()).toEqual([
      "action",
      "id",
      "minutes",
      "providerId",
      "providerName",
      "summary",
      "title",
    ]);
    expect(fullClone.serviceOffers[0]?.title).toBe("Rest under Rowan's relief seal");
    expect(fullClone.serviceOffers[0]?.providerName).toBe("Emery Sloane");
    expect(compact.service_offers?.[0]?.[2]).toBe("Rest under Rowan's relief seal");
    expect(compact.service_offers?.[0]?.[3]).toContain("Emery Sloane");

    fullClone.serviceOffers[0]!.summary = "mutated full clone";
    expect(sourceOffers[0]!.summary).toBe(`Emery Sloane opens the shelter. ${longSummary}`);
    (fullClone.serviceActions[0] as { suppliesAfter: number }).suppliesAfter = 99;
    expect(view.serviceActions[0]?.suppliesAfter).toBe(view.maxSupplies);

    const cloned = cloneOverworldCompactView(compact);
    if (!cloned.service_offers) throw new Error("expected cloned service offers");
    if (!cloned.service_actions) throw new Error("expected cloned service actions");
    (cloned.service_offers[0] as unknown as string[])[2] = "mutated clone";
    (cloned.service_actions[0]![6] as unknown as number[])[1] = 99;
    expect(compact.service_offers?.[0]?.[2]).toBe("Rest under Rowan's relief seal");
    expect(compact.service_actions?.[0]?.[6][1]).toBe(view.maxSupplies);
  });

  it("caps compact context progress lists while marking truncated renown and completed arcs", () => {
    const session = new OverworldSession(world);
    const view = session.view();
    const denseCount =
      Math.max(OVERWORLD_COMPACT_RENOWN_LIMIT, OVERWORLD_COMPACT_COMPLETED_ARC_LIMIT) + 3;
    const denseRenown: Record<string, number> = Object.fromEntries(
      Array.from({ length: denseCount }, (_, index) => [
        `Dense Region ${String(index).padStart(2, "0")}`,
        index,
      ]),
    );
    const denseCompletedArcs = Array.from(
      { length: denseCount },
      (_, index) => `dense_arc_${String(index).padStart(2, "0")}`,
    );

    const compact = compactOverworldView({
      ...view,
      regionRenown: denseRenown,
      completedRegionalArcIds: denseCompletedArcs,
    });
    if (!compact.renown || !compact.completed_arcs) {
      throw new Error("expected compact progress lists");
    }
    expect(compact.renown).toHaveLength(OVERWORLD_COMPACT_RENOWN_LIMIT);
    expect(compact.completed_arcs).toHaveLength(OVERWORLD_COMPACT_COMPLETED_ARC_LIMIT);
    expect(compact.renown_truncated).toBe(true);
    expect(compact.completed_arcs_truncated).toBe(true);
    expect(compact.renown[0]).toEqual(["Dense Region 00", 0]);
    expect(compact.completed_arcs).toEqual(
      denseCompletedArcs.slice(0, OVERWORLD_COMPACT_COMPLETED_ARC_LIMIT),
    );

    const built = buildOverworldSessionCompactView({
      character: view.character,
      worldName: view.world,
      worldTownCount: view.totalTowns,
      current: view.current,
      currentArea: view.currentArea,
      minutes: 0,
      supplies: view.supplies,
      fatigue: view.fatigue,
      serviceOffers: view.serviceOffers,
      serviceActions: view.serviceActions,
      roads: view.exits,
      areaExits: view.areaExits,
      routeOptions: view.routeOptions,
      areas: view.areas,
      poi: view.pois,
      contacts: view.characters,
      events: view.events,
      jobs: view.jobs,
      rememberedJobs: view.rememberedJobs,
      jobLeads: view.jobLeads,
      sites: view.sites,
      quests: view.quests,
      questStarts: view.questStarts,
      hiddenAreaCount: view.hiddenAreaCount,
      hiddenJobCount: view.hiddenJobCount,
      hiddenSiteCount: view.hiddenSiteCount,
      hiddenQuestCount: view.hiddenQuestCount,
      journalEntries: view.journal,
      travelLog: view.log,
      visitedCount: view.visitedCount,
      regionRenown: new Map(Object.entries(denseRenown)),
      completedRegionalArcIds: new Set(denseCompletedArcs),
      pendingRoadEncounter: view.pendingRoadEncounter,
      ids: {
        discoveredIds: new Set(view.discovered.map((town) => town.id)),
        nodes: new Map(world.nodes.map((town) => [town.id, town])),
        discoveredAreaIds: new Set(view.discoveredAreaIds),
        visitedAreaIds: new Set(view.visitedAreaIds),
        discoveredJobIds: new Set(view.discoveredJobIds),
        completedJobIds: new Set(view.completedJobIds),
        discoveredSiteIds: new Set(view.discoveredSiteIds),
        exploredSiteIds: new Set(view.exploredSiteIds),
        discoveredQuestIds: new Set(view.discoveredQuestIds),
        startedQuestIds: new Set(view.startedQuestIds),
        completedQuestIds: new Set(view.completedQuestIds),
        resolvedEventIds: new Set(view.resolvedEventIds),
      },
    });
    expect(built.renown).toEqual(compact.renown);
    expect(built.completed_arcs).toEqual(compact.completed_arcs);
    expect(built.renown_truncated).toBe(true);
    expect(built.completed_arcs_truncated).toBe(true);

    const cloned = cloneOverworldCompactView(compact);
    if (!cloned.renown || !cloned.completed_arcs) {
      throw new Error("expected cloned compact progress lists");
    }
    expect(cloned.renown_truncated).toBe(true);
    expect(cloned.completed_arcs_truncated).toBe(true);
    cloned.renown.push(["mutated_by_test", 1]);
    cloned.completed_arcs.push("mutated_by_test");
    expect(compact.renown).toHaveLength(OVERWORLD_COMPACT_RENOWN_LIMIT);
    expect(compact.completed_arcs).toHaveLength(OVERWORLD_COMPACT_COMPLETED_ARC_LIMIT);
  });

  it("caps compact context movement lists while marking truncated roads and area routes", () => {
    const session = new OverworldSession(world);
    const view = session.view();
    expect(view.exits[0]).toBeDefined();
    expect(view.areas[0]).toBeDefined();

    const denseCount = OVERWORLD_COMPACT_MOVEMENT_LIMIT + 4;
    const denseRoads = Array.from({ length: denseCount }, (_, index) => ({
      ...view.exits[0]!,
      id: `dense_road_${index}`,
      destination: {
        ...view.exits[0]!.destination,
        id: `dense_town_${index}`,
      },
    }));
    const denseAreaRoutes = Array.from({ length: denseCount }, (_, index) => ({
      id: `dense_area_route_${index}`,
      home: view.current.id,
      from_area: view.currentArea?.id ?? view.areas[0]!.id,
      to_area: `dense_area_${index}`,
      route: `Dense lane ${index}`,
      travel_minutes: index + 1,
      destination: {
        ...view.areas[0]!,
        id: `dense_area_${index}`,
      },
    }));

    const compact = compactOverworldView({
      ...view,
      exits: denseRoads,
      areaExits: denseAreaRoutes,
    });
    expect(compact.roads).toHaveLength(OVERWORLD_COMPACT_MOVEMENT_LIMIT);
    expect(compact.area_routes).toHaveLength(OVERWORLD_COMPACT_MOVEMENT_LIMIT);
    expect(compact.roads_truncated).toBe(true);
    expect(compact.area_routes_truncated).toBe(true);

    const built = buildOverworldSessionCompactView({
      character: view.character,
      worldName: view.world,
      worldTownCount: view.totalTowns,
      current: view.current,
      currentArea: view.currentArea,
      minutes: 0,
      supplies: view.supplies,
      fatigue: view.fatigue,
      serviceOffers: view.serviceOffers,
      serviceActions: view.serviceActions,
      roads: denseRoads,
      areaExits: denseAreaRoutes,
      routeOptions: view.routeOptions,
      areas: view.areas,
      poi: view.pois,
      contacts: view.characters,
      events: view.events,
      jobs: view.jobs,
      rememberedJobs: view.rememberedJobs,
      jobLeads: view.jobLeads,
      sites: view.sites,
      quests: view.quests,
      questStarts: view.questStarts,
      hiddenAreaCount: view.hiddenAreaCount,
      hiddenJobCount: view.hiddenJobCount,
      hiddenSiteCount: view.hiddenSiteCount,
      hiddenQuestCount: view.hiddenQuestCount,
      journalEntries: view.journal,
      travelLog: view.log,
      visitedCount: view.visitedCount,
      regionRenown: new Map(Object.entries(view.regionRenown)),
      completedRegionalArcIds: new Set(view.completedRegionalArcIds),
      pendingRoadEncounter: view.pendingRoadEncounter,
      ids: {
        discoveredIds: new Set(view.discovered.map((town) => town.id)),
        nodes: new Map(world.nodes.map((town) => [town.id, town])),
        discoveredAreaIds: new Set(view.discoveredAreaIds),
        visitedAreaIds: new Set(view.visitedAreaIds),
        discoveredJobIds: new Set(view.discoveredJobIds),
        completedJobIds: new Set(view.completedJobIds),
        discoveredSiteIds: new Set(view.discoveredSiteIds),
        exploredSiteIds: new Set(view.exploredSiteIds),
        discoveredQuestIds: new Set(view.discoveredQuestIds),
        startedQuestIds: new Set(view.startedQuestIds),
        completedQuestIds: new Set(view.completedQuestIds),
        resolvedEventIds: new Set(view.resolvedEventIds),
      },
    });
    expect(built.roads).toHaveLength(OVERWORLD_COMPACT_MOVEMENT_LIMIT);
    expect(built.area_routes).toHaveLength(OVERWORLD_COMPACT_MOVEMENT_LIMIT);
    expect(built.roads_truncated).toBe(true);
    expect(built.area_routes_truncated).toBe(true);

    const cloned = cloneOverworldCompactView(compact);
    expect(cloned.roads_truncated).toBe(true);
    expect(cloned.area_routes_truncated).toBe(true);
    cloned.roads.push(["mutated_by_test", 1, 0, 0]);
    cloned.area_routes?.push(["mutated_by_test", "mutated", 1]);
    expect(compact.roads).toHaveLength(OVERWORLD_COMPACT_MOVEMENT_LIMIT);
    expect(compact.area_routes).toHaveLength(OVERWORLD_COMPACT_MOVEMENT_LIMIT);
  });

  it("caps compact context route path summaries while preserving explicit compact plans", () => {
    const session = new OverworldSession(world);
    const view = session.view();
    const plan = session.planRoute("colonie_town");
    expect(plan.steps[0]).toBeDefined();

    const denseStepCount = OVERWORLD_COMPACT_ROUTE_STEP_LIMIT + 4;
    const densePlan: typeof plan = {
      ...plan,
      steps: Array.from({ length: denseStepCount }, (_, index) => ({
        ...plan.steps[0]!,
        edge: {
          ...plan.steps[0]!.edge,
          id: `dense_road_${index}`,
        },
      })),
    };

    const explicit = compactRouteOption(densePlan);
    expect(explicit[4]).toHaveLength(denseStepCount);

    const compact = compactOverworldView({
      ...view,
      routeOptions: [densePlan],
    });
    expect(compact.route_options[0]?.[4]).toHaveLength(OVERWORLD_COMPACT_ROUTE_STEP_LIMIT);
    expect(compact.route_paths_truncated).toBe(true);

    const built = buildOverworldSessionCompactView({
      character: view.character,
      worldName: view.world,
      worldTownCount: view.totalTowns,
      current: view.current,
      currentArea: view.currentArea,
      minutes: 0,
      supplies: view.supplies,
      fatigue: view.fatigue,
      serviceOffers: view.serviceOffers,
      serviceActions: view.serviceActions,
      roads: view.exits,
      areaExits: view.areaExits,
      routeOptions: [densePlan],
      areas: view.areas,
      poi: view.pois,
      contacts: view.characters,
      events: view.events,
      jobs: view.jobs,
      rememberedJobs: view.rememberedJobs,
      jobLeads: view.jobLeads,
      sites: view.sites,
      quests: view.quests,
      questStarts: view.questStarts,
      hiddenAreaCount: view.hiddenAreaCount,
      hiddenJobCount: view.hiddenJobCount,
      hiddenSiteCount: view.hiddenSiteCount,
      hiddenQuestCount: view.hiddenQuestCount,
      journalEntries: view.journal,
      travelLog: view.log,
      visitedCount: view.visitedCount,
      regionRenown: new Map(Object.entries(view.regionRenown)),
      completedRegionalArcIds: new Set(view.completedRegionalArcIds),
      pendingRoadEncounter: view.pendingRoadEncounter,
      ids: {
        discoveredIds: new Set(view.discovered.map((town) => town.id)),
        nodes: new Map(world.nodes.map((town) => [town.id, town])),
        discoveredAreaIds: new Set(view.discoveredAreaIds),
        visitedAreaIds: new Set(view.visitedAreaIds),
        discoveredJobIds: new Set(view.discoveredJobIds),
        completedJobIds: new Set(view.completedJobIds),
        discoveredSiteIds: new Set(view.discoveredSiteIds),
        exploredSiteIds: new Set(view.exploredSiteIds),
        discoveredQuestIds: new Set(view.discoveredQuestIds),
        startedQuestIds: new Set(view.startedQuestIds),
        completedQuestIds: new Set(view.completedQuestIds),
        resolvedEventIds: new Set(view.resolvedEventIds),
      },
    });
    expect(built.route_options[0]?.[4]).toHaveLength(OVERWORLD_COMPACT_ROUTE_STEP_LIMIT);
    expect(built.route_paths_truncated).toBe(true);

    const cloned = cloneOverworldCompactView(compact);
    expect(cloned.route_paths_truncated).toBe(true);
    (cloned.route_options[0]?.[4] as string[] | undefined)?.push("mutated_by_test");
    expect(compact.route_options[0]?.[4]).toHaveLength(OVERWORLD_COMPACT_ROUTE_STEP_LIMIT);
  });

  it("caps compact context local refs while marking truncated buckets", () => {
    const session = new OverworldSession(world);
    const view = session.view();
    expect(view.areas[0]).toBeDefined();
    expect(view.pois[0]).toBeDefined();
    expect(view.characters[0]).toBeDefined();
    expect(view.events[0]).toBeDefined();

    const denseCount = OVERWORLD_COMPACT_LOCAL_REF_LIMIT + 3;
    const denseNames = Array.from({ length: denseCount }, (_, index) => ({
      id: `dense_name_${index}`,
      name: `Dense Name ${index}`,
    }));
    const denseTitles = Array.from({ length: denseCount }, (_, index) => ({
      id: `dense_title_${index}`,
      title: `Dense Title ${index}`,
    }));
    const denseRememberedJobs = denseTitles.map((value, index) => ({
      ...world.local_jobs[0]!,
      ...value,
      area: `dense_area_${index}`,
    }));
    const compact = compactOverworldView({
      ...view,
      areas: denseNames.map((value) => ({ ...view.areas[0]!, ...value })),
      pois: denseTitles.map((value) => ({ ...view.pois[0]!, ...value })),
      characters: denseNames.map((value) => ({ ...view.characters[0]!, ...value })),
      events: denseTitles.map((value) => ({ ...view.events[0]!, ...value })),
      jobs: denseTitles as typeof view.jobs,
      rememberedJobs: denseRememberedJobs,
      sites: denseTitles as typeof view.sites,
      quests: denseTitles as typeof view.quests,
      questStarts: view.questStarts,
    });

    expect(compact.areas).toHaveLength(OVERWORLD_COMPACT_LOCAL_REF_LIMIT);
    expect(compact.poi).toHaveLength(OVERWORLD_COMPACT_LOCAL_REF_LIMIT);
    expect(compact.contacts).toHaveLength(OVERWORLD_COMPACT_LOCAL_REF_LIMIT);
    expect(compact.events).toHaveLength(OVERWORLD_COMPACT_LOCAL_REF_LIMIT);
    expect(compact.jobs).toHaveLength(OVERWORLD_COMPACT_LOCAL_REF_LIMIT);
    expect(compact.remembered_jobs).toHaveLength(OVERWORLD_COMPACT_LOCAL_REF_LIMIT);
    expect(compact.sites).toHaveLength(OVERWORLD_COMPACT_LOCAL_REF_LIMIT);
    expect(compact.quests).toHaveLength(OVERWORLD_COMPACT_LOCAL_REF_LIMIT);
    expect(compact.local_refs_truncated).toEqual([
      "areas",
      "poi",
      "contacts",
      "events",
      "jobs",
      "remembered_jobs",
      "sites",
      "quests",
    ]);

    const built = buildOverworldSessionCompactView({
      character: view.character,
      worldName: view.world,
      worldTownCount: view.totalTowns,
      current: view.current,
      currentArea: view.currentArea,
      minutes: 0,
      supplies: view.supplies,
      fatigue: view.fatigue,
      serviceOffers: view.serviceOffers,
      serviceActions: view.serviceActions,
      roads: view.exits,
      areaExits: view.areaExits,
      routeOptions: view.routeOptions,
      areas: denseNames.map((value) => ({ ...view.areas[0]!, ...value })),
      poi: denseTitles.map((value) => ({ ...view.pois[0]!, ...value })),
      contacts: denseNames.map((value) => ({ ...view.characters[0]!, ...value })),
      events: denseTitles.map((value) => ({ ...view.events[0]!, ...value })),
      jobs: denseTitles as typeof view.jobs,
      rememberedJobs: denseRememberedJobs,
      jobLeads: view.jobLeads,
      sites: denseTitles as typeof view.sites,
      quests: denseTitles as typeof view.quests,
      questStarts: view.questStarts,
      hiddenAreaCount: view.hiddenAreaCount,
      hiddenJobCount: view.hiddenJobCount,
      hiddenSiteCount: view.hiddenSiteCount,
      hiddenQuestCount: view.hiddenQuestCount,
      journalEntries: view.journal,
      travelLog: view.log,
      visitedCount: view.visitedCount,
      regionRenown: new Map(Object.entries(view.regionRenown)),
      completedRegionalArcIds: new Set(view.completedRegionalArcIds),
      pendingRoadEncounter: view.pendingRoadEncounter,
      ids: {
        discoveredIds: new Set(view.discovered.map((town) => town.id)),
        nodes: new Map(world.nodes.map((town) => [town.id, town])),
        discoveredAreaIds: new Set(view.discoveredAreaIds),
        visitedAreaIds: new Set(view.visitedAreaIds),
        discoveredJobIds: new Set(view.discoveredJobIds),
        completedJobIds: new Set(view.completedJobIds),
        discoveredSiteIds: new Set(view.discoveredSiteIds),
        exploredSiteIds: new Set(view.exploredSiteIds),
        discoveredQuestIds: new Set(view.discoveredQuestIds),
        startedQuestIds: new Set(view.startedQuestIds),
        completedQuestIds: new Set(view.completedQuestIds),
        resolvedEventIds: new Set(view.resolvedEventIds),
      },
    });
    expect(built.local_refs_truncated).toEqual(compact.local_refs_truncated);
    expect(built.areas).toHaveLength(OVERWORLD_COMPACT_LOCAL_REF_LIMIT);
    expect(built.jobs).toHaveLength(OVERWORLD_COMPACT_LOCAL_REF_LIMIT);
    expect(built.remembered_jobs).toHaveLength(OVERWORLD_COMPACT_LOCAL_REF_LIMIT);

    const cloned = cloneOverworldCompactView(compact);
    expect(cloned.local_refs_truncated).toEqual(compact.local_refs_truncated);
    expect(cloned.remembered_jobs).toEqual(compact.remembered_jobs);
    cloned.remembered_jobs?.push(["mutated_job", "Mutated job", "mutated_area"]);
    expect(compact.remembered_jobs).toHaveLength(OVERWORLD_COMPACT_LOCAL_REF_LIMIT);
    cloned.local_refs_truncated?.push("areas");
    expect(compact.local_refs_truncated).toEqual([
      "areas",
      "poi",
      "contacts",
      "events",
      "jobs",
      "remembered_jobs",
      "sites",
      "quests",
    ]);
  });

  it("caps compact context labels, titles, road scenes, and risk text", () => {
    const session = new OverworldSession(world);
    const localView = session.view();
    const road = localView.exits.find((exit) => exit.destination.id === "colonie_town");
    expect(road).toBeDefined();
    session.travel(road!.id);

    const view = session.view();
    expect(view.pendingRoadEncounter).toBeDefined();
    expect(localView.currentArea).toBeDefined();
    expect(localView.areas[0]).toBeDefined();
    expect(localView.pois[0]).toBeDefined();
    expect(localView.characters[0]).toBeDefined();
    expect(localView.events[0]).toBeDefined();
    const longLabel = "label ".repeat(40);
    const longTitle = "title ".repeat(60);
    const longRisk = "risk ".repeat(70);
    const longSummary = "summary ".repeat(80);

    const pendingRoadEncounter = view.pendingRoadEncounter!;
    const compact = compactOverworldView({
      ...localView,
      world: longLabel,
      current: { ...localView.current, name: longLabel, region: longLabel },
      currentArea: localView.currentArea ? { ...localView.currentArea, name: longLabel } : null,
      areas: localView.areas.map((area, index) =>
        index === 0 ? { ...area, name: longLabel } : area,
      ),
      pois: localView.pois.map((poi, index) => (index === 0 ? { ...poi, title: longTitle } : poi)),
      characters: localView.characters.map((character, index) =>
        index === 0 ? { ...character, name: longLabel } : character,
      ),
      events: localView.events.map((event, index) =>
        index === 0 ? { ...event, title: longTitle } : event,
      ),
      journal: [
        {
          id: "synthetic_long_title",
          kind: "event",
          town: localView.current.id,
          title: longTitle,
          text: "Synthetic compact-title boundary row.",
          recordedAt: localView.timeLabel,
        },
        ...localView.journal,
      ],
      pendingRoadEncounter: {
        ...pendingRoadEncounter,
        from: longLabel,
        to: longLabel,
        route: longLabel,
        event: {
          ...pendingRoadEncounter.event,
          title: longTitle,
          summary: longSummary,
          risk: longRisk as typeof pendingRoadEncounter.event.risk,
        },
        options: pendingRoadEncounter.options.map((option) => ({
          ...option,
          label: longTitle,
        })),
      },
      regionRenown: { [longLabel]: 7 },
    });

    expect(compact.world).toHaveLength(OVERWORLD_COMPACT_LABEL_CHAR_LIMIT);
    expect(compact.here[1]).toHaveLength(OVERWORLD_COMPACT_LABEL_CHAR_LIMIT);
    expect(compact.here[2]).toHaveLength(OVERWORLD_COMPACT_LABEL_CHAR_LIMIT);
    expect(compact.here[4]).toHaveLength(OVERWORLD_COMPACT_LABEL_CHAR_LIMIT);
    expect(compact.areas[0]?.[1]).toHaveLength(OVERWORLD_COMPACT_LABEL_CHAR_LIMIT);
    expect(compact.contacts[0]?.[1]).toHaveLength(OVERWORLD_COMPACT_LABEL_CHAR_LIMIT);
    expect(compact.poi[0]?.[1]).toHaveLength(OVERWORLD_COMPACT_TITLE_CHAR_LIMIT);
    expect(compact.events[0]?.[1]).toHaveLength(OVERWORLD_COMPACT_TITLE_CHAR_LIMIT);
    expect(compact.journal?.[0]?.[1]).toHaveLength(OVERWORLD_COMPACT_TITLE_CHAR_LIMIT);
    expect(compact.pending_road?.route).toHaveLength(OVERWORLD_COMPACT_LABEL_CHAR_LIMIT);
    expect(compact.pending_road?.event[1]).toHaveLength(OVERWORLD_COMPACT_RISK_CHAR_LIMIT);
    expect(compact.pending_road?.event[2]).toHaveLength(OVERWORLD_COMPACT_TITLE_CHAR_LIMIT);
    expect(compact.pending_road?.event[3]).toHaveLength(
      OVERWORLD_COMPACT_ROAD_EVENT_SUMMARY_CHAR_LIMIT,
    );
    expect(compact.pending_road?.options[0]?.[1]).toHaveLength(OVERWORLD_COMPACT_TITLE_CHAR_LIMIT);
    expect(compact.pending_road?.where[0]).toHaveLength(OVERWORLD_COMPACT_LABEL_CHAR_LIMIT);
    expect(compact.pending_road?.where[1]).toHaveLength(OVERWORLD_COMPACT_LABEL_CHAR_LIMIT);
    expect(compact.renown?.[0]?.[0]).toHaveLength(OVERWORLD_COMPACT_LABEL_CHAR_LIMIT);
    expect(compact.world).toMatch(/\.\.\.\(\+\d+ chars\)$/);
  });

  it("adds deterministic travel delay when fatigue or supply shortage catches up", () => {
    const session = new OverworldSession(world);
    travelTo(session, "buffalo_city");
    const worn = session.view();
    expect(worn.fatigue).toBeGreaterThanOrEqual(25);

    const nextRoad = worn.exits[0]!;
    const planned = session.planRoute(nextRoad.destination.id);
    expect(planned.estimate.delayMinutes).toBeGreaterThan(0);
    expect(planned.estimate.elapsedMinutes).toBe(
      planned.estimate.baseMinutes + planned.estimate.delayMinutes,
    );
    expect(planned.estimate.travelConditionAfter).not.toBe("ready");

    const entry = session.travel(nextRoad.id);
    expect(entry.baseMinutes).toBe(nextRoad.travel_minutes);
    expect(entry.delayMinutes).toBeGreaterThan(0);
    expect(entry.minutes).toBe(entry.baseMinutes + entry.delayMinutes);
    expect(entry.arrivedAt).toBeGreaterThan(worn.log[0]!.arrivedAt);
  });

  it("uses town services to resupply and rest after travel", () => {
    const session = new OverworldSession(world);
    const road = session.view().exits.find((exit) => exit.destination.id === "colonie_town");
    expect(road).toBeDefined();
    session.travel(road!.id);
    expect(() => session.resupplyAtTown()).toThrow(/pending road encounter/i);
    session.resolveRoadEncounter("press_on");

    const worn = session.view();
    expect(worn.supplies).toBeLessThan(worn.maxSupplies);
    expect(worn.fatigue).toBeGreaterThan(0);
    const resupplyPreview = worn.serviceActions.find((action) => action.action === "resupply");
    expect(resupplyPreview).toMatchObject({
      available: true,
      changed: true,
      minutes: 45,
      suppliesBefore: worn.supplies,
      suppliesAfter: worn.maxSupplies,
      fatigueBefore: worn.fatigue,
      fatigueAfter: worn.fatigue,
    });

    const resupplied = session.resupplyAtTown();
    expect(resupplied).toMatchObject({
      action: "resupply",
      changed: true,
      minutes: 45,
      suppliesBefore: worn.supplies,
      suppliesAfter: worn.maxSupplies,
      fatigueBefore: worn.fatigue,
      fatigueAfter: worn.fatigue,
    });
    expect(resupplied).toMatchObject({
      action: resupplyPreview!.action,
      changed: resupplyPreview!.changed,
      minutes: resupplyPreview!.minutes,
      suppliesBefore: resupplyPreview!.suppliesBefore,
      suppliesAfter: resupplyPreview!.suppliesAfter,
      fatigueBefore: resupplyPreview!.fatigueBefore,
      fatigueAfter: resupplyPreview!.fatigueAfter,
      message: resupplyPreview!.message,
    });
    expect(resupplied.entry?.kind).toBe("service");
    expect(session.view().supplies).toBe(worn.maxSupplies);
    expect(session.view().journal[0]?.title).toContain("Resupplied");

    const restPreview = session.view().serviceActions.find((action) => action.action === "rest");
    const rested = session.restAtTown();
    expect(rested.action).toBe("rest");
    expect(rested.changed).toBe(true);
    expect(rested.minutes).toBeGreaterThan(0);
    expect(rested.fatigueBefore).toBe(worn.fatigue);
    expect(rested.fatigueAfter).toBe(0);
    expect(rested.entry?.kind).toBe("service");
    expect(rested).toMatchObject({
      action: restPreview!.action,
      changed: restPreview!.changed,
      minutes: restPreview!.minutes,
      suppliesBefore: restPreview!.suppliesBefore,
      suppliesAfter: restPreview!.suppliesAfter,
      fatigueBefore: restPreview!.fatigueBefore,
      fatigueAfter: restPreview!.fatigueAfter,
      message: restPreview!.message,
    });

    const ready = session.view();
    expect(ready.fatigue).toBe(0);
    expect(ready.supplies).toBe(ready.maxSupplies);
    expect(ready.travelCondition).toBe("ready");
    expect(ready.journal[0]?.title).toContain("Rested");
    expect(ready.serviceActions).toMatchObject([
      { action: "resupply", available: true, changed: false, minutes: 0 },
      { action: "rest", available: true, changed: false, minutes: 0 },
    ]);
    expect(session.compactView()).toEqual(compactOverworldView(ready));

    expect(session.restAtTown()).toMatchObject({
      changed: false,
      message: "You are already rested.",
    });
    expect(session.resupplyAtTown()).toMatchObject({
      changed: false,
      message: "Your supplies are already full.",
    });
  });

  it("plans routes only through the discovered road graph", () => {
    const session = new OverworldSession(world);
    const start = session.view();
    const colonieRoute = session.planRoute("colonie_town");
    const colonieRoad = start.exits.find((exit) => exit.destination.id === "colonie_town");

    expect(colonieRoad).toBeDefined();
    expect(colonieRoute.destination.id).toBe("colonie_town");
    expect(colonieRoute.steps[0]?.edge.id).toBe(colonieRoad!.id);
    expect(colonieRoute.totalMinutes).toBe(colonieRoad!.travel_minutes);
    expect(colonieRoute.estimate).toMatchObject({
      baseMinutes: colonieRoute.totalMinutes,
      delayMinutes: 0,
      elapsedMinutes: colonieRoute.totalMinutes,
      supplyDeficit: 0,
      travelConditionAfter: "ready",
    });
    expect(colonieRoute.estimate.suppliesAfter).toBe(
      start.supplies - colonieRoute.estimate.suppliesUsed,
    );
    expect(colonieRoute.estimate.fatigueAfter).toBe(colonieRoute.estimate.fatigueGained);
    expect(() => session.planRoute("buffalo_city")).toThrow(/not discovered/i);
  });

  it("turns local contacts, POIs, and events into timed journal leads", () => {
    const session = new OverworldSession(world);
    const before = session.view();
    const poi = before.pois[0]!;
    const contact = before.characters[0]!;
    const event = before.events[0]!;
    const localQuests = world.quests
      .filter((quest) => quest.home === before.current.id)
      .sort((a, b) => a.title.localeCompare(b.title));
    expect(localQuests.length).toBeGreaterThan(0);

    const scouted = session.scoutPoi(poi.id);
    expect(scouted.minutes).toBe(20);
    expect(scouted.entry.kind).toBe("poi");
    expect(scouted.discoveredSites).toHaveLength(1);
    expect(scouted.discoveredQuests).toEqual([]);
    expect(session.view().journal[0]?.title).toContain(poi.title);
    expect(session.view().sites.map((site) => site.id)).toEqual(
      scouted.discoveredSites?.map((site) => site.id),
    );
    expect(session.view().quests).toEqual([]);
    expect(session.view().discoveredQuestIds).toEqual([]);
    expect(session.view().hiddenQuestCount).toBe(localQuests.length);

    const repeated = session.scoutPoi(poi.id);
    expect(repeated.alreadyKnown).toBe(true);
    expect(repeated.minutes).toBe(0);
    expect(repeated.discoveredSites).toEqual([]);
    expect(repeated.discoveredQuests).toEqual([]);

    const talked = session.talkToCharacter(contact.id);
    settleOpeningRegistration(session);
    expect(talked.minutes).toBe(15);
    expect(talked.entry.text).toContain(contact.agenda);
    expect(talked.discoveredQuests).toEqual([]);
    expect(talked.discoveredQuests?.every((quest) => !("pack" in quest))).toBe(true);
    expect(session.view().quests.map((quest) => quest.id)).toEqual(
      localQuests.slice(0, 1).map((quest) => quest.id),
    );
    expect(session.view().quests.every((quest) => !("pack" in quest))).toBe(true);

    moveToArea(session, event.area);
    const investigated = session.investigateEvent(event.id);
    expect(investigated.minutes).toBe(20 + event.intensity * 5);
    expect(investigated.entry.text).toContain(event.pressure);
    expect(investigated.discoveredQuests).toEqual([]);

    const after = session.view();
    expect(after.timeLabel).not.toBe(before.timeLabel);
    expect(after.journal).toHaveLength(13);
  });

  it("requires reaching a quest's local area before starting it", () => {
    const session = new OverworldSession(world);
    const initial = session.view();
    const firstLocalQuest = world.quests
      .filter((quest) => quest.home === initial.current.id)
      .sort((a, b) => a.title.localeCompare(b.title))[0]!;

    expect(firstLocalQuest.area).not.toBe(initial.currentArea?.id);
    expect(initial.discoveredQuestIds).not.toContain(firstLocalQuest.id);

    const scouted = session.scoutPoi(initial.pois[0]!.id);
    expect(scouted.discoveredQuests).toEqual([]);
    session.talkToCharacter(initial.characters[0]!.id);
    settleOpeningRegistration(session);
    const discoveredQuests = session.view().quests;
    expect(discoveredQuests).toHaveLength(1);
    const discoveredQuest = discoveredQuests[0]!;
    expect(discoveredQuest.id).toBe(firstLocalQuest.id);
    expect("pack" in discoveredQuest).toBe(false);
    expect(session.view().currentArea?.id).toBe(discoveredQuest.area);
    const routeAwayFromQuest = session
      .view()
      .areaExits.find((exit) => exit.destination.id === "albany_city__market");
    expect(routeAwayFromQuest).toBeDefined();
    session.moveArea(routeAwayFromQuest!.id);
    expect(session.view().currentArea?.id).not.toBe(discoveredQuest.area);
    expect(() => session.startQuest(discoveredQuest.id)).toThrow(/Move to/i);
    expect(() =>
      session.completeQuest(discoveredQuest.id, {
        endingId: "ending_victory",
        endingTitle: "Victory",
        death: false,
      }),
    ).toThrow(/Start that local quest/i);

    const routeToQuestArea = session
      .view()
      .areaExits.find((exit) => exit.destination.id === discoveredQuest.area);
    expect(routeToQuestArea).toBeDefined();

    const moved = session.moveArea(routeToQuestArea!.id);
    expect(moved.to.id).toBe(discoveredQuest.area);
    const startedQuest = startVisibleQuest(session, discoveredQuest);
    expect(startedQuest).toMatchObject({
      id: discoveredQuest.id,
      area: discoveredQuest.area,
    });
    expect("pack" in startedQuest).toBe(false);
    expect(session.view().startedQuestIds).toEqual([discoveredQuest.id]);
    expect(session.view().journal[0]).toMatchObject({
      id: `quest:${discoveredQuest.id}`,
      kind: "quest",
    });
    expect(() => session.startQuest(discoveredQuest.id)).toThrow(/already active/i);
    expect(() =>
      session.completeQuest(discoveredQuest.id, {
        endingId: "ending_fallen",
        endingTitle: "Fallen",
        death: true,
      }),
    ).toThrow(/death ending/i);

    const beforeCompletionMinutes = session.snapshot().minutes;
    const completedQuest = session.completeQuest(discoveredQuest.id, {
      endingId: "ending_held",
      endingTitle: "The Byre Held",
      death: false,
    });
    const questSource = world.quests.find((quest) => quest.id === discoveredQuest.id);
    if (!questSource) throw new Error("expected quest source");
    const expectedMinutes = questCompletionMinutes(
      questSource,
      new Map(world.areas.map((area) => [area.id, area])),
    );
    expect(completedQuest).toMatchObject({
      alreadyKnown: false,
      minutes: expectedMinutes,
      endingId: "ending_held",
      quest: { id: discoveredQuest.id },
    });
    expect(completedQuest.entry.recordedAt).toBe(session.view().timeLabel);
    expect(completedQuest.entry.text).toContain(`${expectedMinutes} minutes`);
    expect(completedQuest.entry).toMatchObject({
      id: `quest_done:${discoveredQuest.id}`,
      kind: "quest_done",
    });
    expect(session.snapshot().minutes).toBe(beforeCompletionMinutes + expectedMinutes);
    expect(session.view().completedQuestIds).toEqual([discoveredQuest.id]);
    expect(session.view().quests.map((quest) => quest.id)).not.toContain(discoveredQuest.id);
    expect(session.view().journal[0]).toMatchObject({
      id: `quest_done:${discoveredQuest.id}`,
      kind: "quest_done",
    });
    const compactAfter = session.compactView();
    expect(compactAfter.quests?.map(([id]) => id) ?? []).not.toContain(discoveredQuest.id);
    expect(compactAfter.ids.completed_quests ?? []).toContain(discoveredQuest.id);
    expect(compactAfter.journal?.[0]?.[0]).toBe("quest_done");

    const repeatedCompletion = session.completeQuest(discoveredQuest.id, {
      endingId: "ending_held",
      endingTitle: "The Byre Held",
      death: false,
    });
    expect(repeatedCompletion.alreadyKnown).toBe(true);
    expect(repeatedCompletion.minutes).toBe(0);
    expect(session.view().completedQuestIds).toEqual([discoveredQuest.id]);
  });

  it("keeps a pre-quest save relaunchable while a committed save rejects duplicate starts", () => {
    const session = new OverworldSession(world);
    const opening = session.view();
    session.scoutPoi(opening.pois[0]!.id);
    session.talkToCharacter(opening.characters[0]!.id);
    settleOpeningRegistration(session);
    const quest = session.view().quests.find((candidate) => candidate.id === "wolf_winter");
    expect(quest).toBeDefined();
    moveToArea(session, quest!.area);
    settleReliefAllocation(session);
    const approach = quest!.launch?.options.find(
      (candidate) => candidate.projection?.available === true,
    );
    expect(approach).toBeDefined();

    const plan = session.prepareQuestStart(quest!.id, approach!.id);
    const preQuestSave = session.snapshot();
    session.commitQuestStart(plan);
    const committedSave = session.snapshot();

    const rollback = OverworldSession.restore(world, preQuestSave);
    expect(rollback.view().startedQuestIds).not.toContain(quest!.id);
    expect(rollback.view().questStarts).toContainEqual([quest!.id, approach!.id]);
    expect(() => rollback.prepareQuestStart(quest!.id, approach!.id)).not.toThrow();

    const committed = OverworldSession.restore(world, committedSave);
    expect(committed.view().startedQuestIds).toContain(quest!.id);
    expect(() => committed.prepareQuestStart(quest!.id, approach!.id)).toThrow(/already active/i);
  });

  it("names an off-anchor quest start area without presenting it as a legal launch", () => {
    const session = new OverworldSession(world);
    const opening = session.view();
    session.scoutPoi(opening.pois[0]!.id);
    session.talkToCharacter(opening.characters[0]!.id);
    session.chooseJourneyStory("albany:ledger_advocate");
    revealCurrentJourneyStoryOptions(session, world.opening_relief_oath!.id);
    session.chooseJourneyStory("albany:oath_limited_aid_only");
    session.chooseJourneyStory("albany:source_rowan_civic_docket");

    expect(session.view().currentArea?.id).toBe("albany_city__civic_core");
    const civic = session.compactView();
    expect(civic.quest_start_locations).toEqual([["wolf_winter", "Albany Station Quarter"]]);
    expect(civic.quest_starts).toBeUndefined();
    expect(
      civic.area_routes?.some(
        ([, destinationId]) => destinationId === "albany_city__transport_hub",
      ),
    ).toBe(true);
    expect(compactOverworldView(session.view())).toEqual(civic);

    const detachedLocation = civic.quest_start_locations?.[0] as [string, string] | undefined;
    if (!detachedLocation) throw new Error("expected detached quest-start location");
    detachedLocation[1] = "Tampered Quarter";
    expect(session.compactView().quest_start_locations).toEqual([
      ["wolf_winter", "Albany Station Quarter"],
    ]);

    moveToOpeningPreparation(session);
    const stationed = session.compactView();
    expect(stationed.quest_start_locations).toBeUndefined();
    expect(stationed.quest_starts).toEqual([
      ["wolf_winter", "albany:wolf_approach_exposed_ridge"],
      ["wolf_winter", "albany:wolf_approach_sheltered_stockway"],
    ]);
    expect(compactOverworldView(session.view())).toEqual(stationed);

    const quest = session.view().quests.find((candidate) => candidate.id === "wolf_winter");
    if (!quest) throw new Error("expected visible Wolf-Winter quest");
    const started = startVisibleQuest(session, quest);
    expect(started.id).toBe(quest.id);
    const startedCompact = session.compactView();
    expect(startedCompact.quest_start_locations).toBeUndefined();
    expect(startedCompact.quests?.find(([questId]) => questId === quest.id)).toEqual([
      quest.id,
      quest.title,
      quest.area,
    ]);
    expect(compactOverworldView(session.view())).toEqual(startedCompact);

    session.completeQuest(quest.id, {
      endingId: "ending_held",
      endingTitle: "The Byre Held",
      death: false,
    });
    expect(session.compactView().quest_start_locations).toBeUndefined();
  });

  it("treats one approach button as the one quest-start decision and rejects blocked starts", () => {
    const readyWolf = (manifest: OverworldManifest) => {
      const session = new OverworldSession(manifest);
      const opening = session.view();
      session.scoutPoi(opening.pois[0]!.id);
      session.talkToCharacter(opening.characters[0]!.id);
      settleOpeningRegistration(session);
      const quest = session.view().quests.find((candidate) => candidate.id === "wolf_winter");
      if (!quest) throw new Error("expected Wolf-Winter launch fixture");
      expect(session.compactView().quest_starts).toEqual(
        (() => {
          const starts = quest.launch?.options
            .filter((option) => option.projection?.available === true)
            .map((option) => [quest.id, option.id] as const) ?? [[quest.id, null] as const];
          return starts.length > 0 ? starts : undefined;
        })(),
      );
      if (session.view().currentArea?.id !== quest.area) {
        const route = session
          .view()
          .areaExits.find((candidate) => candidate.destination.id === quest.area);
        if (!route) throw new Error("expected route to Wolf-Winter launch area");
        session.moveArea(route.id);
      }
      expect(session.journey().storyChoice?.kind).not.toBe("relief_allocation");
      expect(session.compactView().quest_starts).toEqual(
        (() => {
          const starts = quest.launch?.options
            .filter((option) => option.projection?.available === true)
            .map((option) => [quest.id, option.id] as const) ?? [[quest.id, null] as const];
          return starts.length > 0 ? starts : undefined;
        })(),
      );
      settleReliefAllocation(session);
      const readyQuest = session.view().quests.find((candidate) => candidate.id === quest.id)!;
      const legalStarts = readyQuest.launch?.options
        .filter((option) => option.projection?.available === true)
        .map((option) => [readyQuest.id, option.id] as const) ?? [[readyQuest.id, null] as const];
      expect(session.compactView().quest_starts).toEqual(
        legalStarts.length > 0 ? legalStarts : undefined,
      );
      expect(compactOverworldView(session.view()).quest_starts).toEqual(
        session.compactView().quest_starts,
      );
      return {
        session,
        quest: session.view().quests.find((candidate) => candidate.id === quest.id)!,
      };
    };

    const missing = readyWolf(world);
    expect(missing.session.compactView().quest_starts).toEqual([
      ["wolf_winter", "albany:wolf_approach_exposed_ridge"],
      ["wolf_winter", "albany:wolf_approach_sheltered_stockway"],
    ]);
    const beforeMissing = missing.session.snapshot();
    expect(() => missing.session.prepareQuestStart(missing.quest.id)).toThrow(
      /Choose an approach_id before starting .+: albany:wolf_approach_exposed_ridge, albany:wolf_approach_sheltered_stockway.$/,
    );
    expect(missing.session.snapshot()).toEqual(beforeMissing);

    const playable = readyWolf(world);
    const approach = playable.quest.launch?.options.find(
      (option) => option.projection?.available === true,
    );
    if (!approach) throw new Error("expected an available Wolf-Winter approach");
    const decisionsBefore = playable.session.journey().acceptedDecisions;
    const started = playable.session.startQuest(playable.quest.id, approach.id);
    expect(playable.session.journey().acceptedDecisions).toBe(decisionsBefore + 1);
    expect(playable.session.journey().decisionProof.last).toMatchObject({
      number: decisionsBefore + 1,
      actionId: `quest_start:${playable.quest.id}:${approach.id}`,
    });
    expect(started.launch?.selected?.optionId).toBe(approach.id);
    expect(playable.session.compactView().quest_starts).toBeUndefined();
    expect(playable.session.view().questStarts).toEqual([]);
    expect(() => playable.session.prepareQuestStart(playable.quest.id, approach.id)).toThrow(
      /already active/i,
    );

    const blockedManifest = structuredClone(world);
    const blockedSource = blockedManifest.quests.find((quest) => quest.id === "wolf_winter");
    if (!blockedSource?.launch) throw new Error("expected authored Wolf-Winter launch");
    blockedSource.launch.options[0]!.terms.supplies = 8;
    const blocked = readyWolf(blockedManifest);
    const blockedApproach = blocked.quest.launch?.options[0];
    expect(blockedApproach?.projection).toMatchObject({
      available: false,
      blockedReason: "Requires 8 supplies. You have 6 supplies.",
    });
    const beforeBlocked = blocked.session.snapshot();
    expect(() => blocked.session.startQuest(blocked.quest.id, blockedApproach!.id)).toThrow(
      "Requires 8 supplies. You have 6 supplies.",
    );
    expect(blocked.session.compactView().quest_starts).toEqual([
      ["wolf_winter", "albany:wolf_approach_sheltered_stockway"],
    ]);
    expect(blocked.session.snapshot()).toEqual(beforeBlocked);

    const unavailableManifest = structuredClone(world);
    const unavailableSource = unavailableManifest.quests.find(
      (quest) => quest.id === "wolf_winter",
    );
    if (!unavailableSource?.launch) throw new Error("expected authored Wolf-Winter launch");
    for (const option of unavailableSource.launch.options) option.terms.supplies = 8;
    expect(readyWolf(unavailableManifest).session.compactView().quest_starts).toBeUndefined();
  });

  it("does not advertise a custom non-target quest before opening registration", () => {
    const manifest = structuredClone(world);
    const probe = manifest.quests.find((quest) => quest.id === "advocates_case");
    if (!probe) throw new Error("expected a non-opening quest fixture");
    probe.home = "albany_city";
    probe.area = "albany_city__civic_core";
    probe.discovery = "A separate Albany brief is pinned beside the registration desk.";

    const session = new OverworldSession(manifest);
    const opening = session.view();
    session.scoutPoi(opening.pois[0]!.id);
    expect(session.view().quests.map((quest) => quest.id)).toContain(probe.id);
    expect(session.journey().storyChoice).toBeNull();
    expect(() => session.prepareQuestStart(probe.id)).toThrow(/before starting the first quest/i);
    expect(session.view().questStarts).toEqual([]);
    expect(session.compactView().quest_starts).toBeUndefined();
  });

  it("reveals exploration leads from the current local area", () => {
    const session = new OverworldSession(world);
    travelTo(session, "new_york_city");
    const start = session.view();
    const sites = world.exploration_sites.filter(
      (candidate) => candidate.area === start.currentArea?.id,
    );
    expect(sites).toHaveLength(1);
    expect(start.sites).toEqual([]);
    expect(start.hiddenSiteCount).toBe(sites.length);

    const scouted = session.scoutPoi(start.pois[0]!.id);
    expect(scouted.discoveredSites).toHaveLength(1);
    expect(scouted.discoveredSites?.[0]?.area).toBe(start.currentArea?.id);
    expect(session.view().sites).toHaveLength(1);
    expect(session.view().hiddenSiteCount).toBe(sites.length - 1);

    const talked = session.talkToCharacter(start.characters[0]!.id);
    expect(talked.discoveredSites).toEqual([]);
    expect(session.view().sites).toHaveLength(1);
    expect(session.view().hiddenSiteCount).toBe(0);

    const investigated = session.investigateEvent(start.events[0]!.id);
    expect(investigated.discoveredSites).toEqual([]);
    expect(session.view().sites).toHaveLength(1);
    expect(session.view().hiddenSiteCount).toBe(0);

    const nextAreaRoute = session.view().areaExits[0];
    expect(nextAreaRoute).toBeDefined();
    session.moveArea(nextAreaRoute!.id);
    expect(session.view().sites).toEqual([]);
    expect(session.view().hiddenSiteCount).toBe(1);
    const movedScout = session.scoutPoi(session.view().pois[0]!.id);
    expect(movedScout.discoveredSites?.[0]?.area).toBe(nextAreaRoute!.destination.id);
  });

  it("reveals and explores regional sites through local scouting", () => {
    const session = new OverworldSession(world);
    const start = session.view();
    const poi = start.pois[0]!;
    const site = world.exploration_sites.find(
      (candidate) => candidate.area === start.currentArea?.id,
    );
    expect(site).toBeDefined();

    expect(() => session.exploreSite(site!.id)).toThrow(/Take a fresh local action in this area/i);
    const scouted = session.scoutPoi(poi.id);
    expect(scouted.discoveredSites?.map((candidate) => candidate.id)).toContain(site!.id);
    expect(session.view().discoveredSiteIds).toContain(site!.id);

    const explored = session.exploreSite(site!.id);
    expect(explored.minutes).toBe(45 + site!.danger * 15);
    expect(explored.entry).toMatchObject({
      kind: "site",
      title: `Explored ${site!.title}`,
    });

    const after = session.view();
    expect(after.exploredSiteIds).toContain(site!.id);
    expect(after.regionRenown[start.current.region]).toBe(site!.danger);
    expect(after.journal[0]?.kind).toBe("site");

    const repeated = session.exploreSite(site!.id);
    expect(repeated.alreadyKnown).toBe(true);
    expect(repeated.minutes).toBe(0);
    expect(repeated.discoveredAreas).toEqual([]);
    expect(repeated.discoveredJobs).toEqual([]);
    expect(repeated.discoveredSites).toEqual([]);
    expect(repeated.discoveredQuests).toEqual([]);
    expect(session.view().regionRenown[start.current.region]).toBe(site!.danger);
  });

  it("requires local prep before resolving an event and awards regional renown", () => {
    const session = new OverworldSession(world);
    const start = session.view();
    const poi = start.pois[0]!;
    const contact = start.characters[0]!;
    const event = start.events[0]!;
    const optionId = event.authored_scene?.options[0]?.id;

    expect(() => session.resolveEvent(event.id)).toThrow(/To resolve this event, first scout/i);
    session.scoutPoi(poi.id);
    session.talkToCharacter(contact.id);
    settleOpeningRegistration(session);
    moveToArea(session, event.area);
    session.investigateEvent(event.id);

    const resolved = session.resolveEvent(event.id, optionId);
    expect(resolved.minutes).toBe(
      event.authored_scene?.options[0]?.terms.minutes ?? 30 + event.intensity * 10,
    );
    expect(resolved.entry.kind).toBe("resolution");
    expect(resolved.entry.text).toContain(start.current.region);

    const after = session.view();
    expect(after.resolvedEventIds).toContain(event.id);
    expect(after.events.map((candidate) => candidate.id)).not.toContain(event.id);
    expect(after.regionRenown[start.current.region]).toBe(
      event.authored_scene?.options[0]?.terms.renown ?? event.intensity,
    );
    expect(after.journal).toHaveLength(14);

    const compactAfter = session.compactView();
    expect(compactAfter.events.map(([id]) => id)).not.toContain(event.id);
    expect(compactAfter.ids.resolved_events ?? []).toContain(event.id);
    expect(compactAfter.journal?.[0]?.[0]).toBe("resolution");

    const repeated = session.resolveEvent(event.id, optionId);
    expect(repeated.alreadyKnown).toBe(true);
    expect(repeated.minutes).toBe(0);
    expect(repeated.discoveredAreas).toEqual([]);
    expect(repeated.discoveredJobs).toEqual([]);
    expect(repeated.discoveredSites).toEqual([]);
    expect(repeated.discoveredQuests).toEqual([]);
    expect(session.view().regionRenown[start.current.region]).toBe(
      event.authored_scene?.options[0]?.terms.renown ?? event.intensity,
    );
  });

  it("completes a regional arc after enough anchor-town event resolutions", () => {
    const session = new OverworldSession(world);
    const arc = world.regional_arcs.find((candidate) => candidate.region === "Capital / Mohawk");
    expect(arc).toBeDefined();
    expect(session.view().regionalArcs.find((candidate) => candidate.id === arc!.id)).toMatchObject(
      {
        completed: false,
        resolvedInRegion: 0,
      },
    );

    const nonAnchor = world.nodes.find(
      (candidate) =>
        candidate.region === arc!.region &&
        !arc!.anchor_towns.includes(candidate.id) &&
        world.local_events.some((event) => event.home === candidate.id),
    );
    expect(nonAnchor).toBeDefined();
    travelTo(session, nonAnchor!.id);
    resolveCurrentTownEvent(session);
    expect(session.view().regionalArcs.find((candidate) => candidate.id === arc!.id)).toMatchObject(
      {
        completed: false,
        resolvedInRegion: 0,
      },
    );

    for (const townId of arc!.anchor_towns.slice(0, arc!.required_resolutions)) {
      travelTo(session, townId);
      resolveCurrentTownEvent(session);
    }

    const after = session.view();
    const progress = after.regionalArcs.find((candidate) => candidate.id === arc!.id);
    expect(progress).toMatchObject({
      completed: true,
      resolvedInRegion: arc!.required_resolutions,
    });
    expect(after.completedRegionalArcIds).toContain(arc!.id);
    expect(after.journal[0]).toMatchObject({
      kind: "regional_arc",
      title: `Completed ${arc!.title}`,
    });
  });

  it("rejects town actions for non-local content", () => {
    const session = new OverworldSession(world);
    const start = session.view();
    const nonCurrentPoi = world.points_of_interest.find(
      (poi) => poi.home === world.start && poi.area !== start.currentArea?.id,
    );
    const nonCurrentContact = world.characters.find(
      (character) => character.home === world.start && character.area !== start.currentArea?.id,
    );
    const nonCurrentEvent = world.local_events.find(
      (event) => event.home === world.start && event.area !== start.currentArea?.id,
    );
    const nonLocalPoi = world.points_of_interest.find((poi) => poi.home !== world.start);
    const nonLocalContact = world.characters.find((character) => character.home !== world.start);
    const nonLocalEvent = world.local_events.find((event) => event.home !== world.start);
    expect(nonCurrentPoi).toBeDefined();
    expect(nonCurrentContact).toBeDefined();
    expect(nonCurrentEvent).toBeDefined();
    expect(nonLocalPoi).toBeDefined();
    expect(nonLocalContact).toBeDefined();
    expect(nonLocalEvent).toBeDefined();

    expect(() => session.scoutPoi(nonCurrentPoi!.id)).toThrow(/Move to that local area/i);
    expect(() => session.talkToCharacter(nonCurrentContact!.id)).toThrow(
      /Move to that local area/i,
    );
    expect(() => session.investigateEvent(nonCurrentEvent!.id)).toThrow(/Move to that local area/i);
    expect(() => session.scoutPoi(nonLocalPoi!.id)).toThrow(/not in this town/i);
    expect(() => session.talkToCharacter(nonLocalContact!.id)).toThrow(/not in this town/i);
    expect(() => session.investigateEvent(nonLocalEvent!.id)).toThrow(/not active/i);
  });

  it("rejects travel along roads that are not adjacent to the current town", () => {
    const session = new OverworldSession(world);
    const farRoad = world.edges.find(
      (edge) => edge.from === "buffalo_city" || edge.to === "buffalo_city",
    );
    expect(farRoad).toBeDefined();
    expect(() => session.travel(farRoad!.id)).toThrow(/not reachable/i);
  });
});
