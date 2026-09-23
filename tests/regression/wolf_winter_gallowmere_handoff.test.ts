import { describe, expect, it } from "vitest";

import { hashState } from "../../src/core/hash.js";
import { createToolApi } from "../../src/mcp/tools.js";
import { planOverworldRoute } from "./support/overworld_queries.js";
import { OverworldSession } from "../../src/world/session.js";
import { loadOverworldManifest } from "../../src/world/source.js";
import { revealCurrentJourneyStoryOptions } from "./support/journey_story.js";

const world = loadOverworldManifest(process.cwd());

const ALBANY_TO_SARATOGA = "road_albany_city__saratoga_springs_city";
const SARATOGA_TO_QUEENSBURY = "road_saratoga_springs_city__queensbury_town";
const QUEENSBURY_MARKET_ROUTE = "queensbury_town__area_route__civic_core__market__1";
const HAYDEN_ID = "albany_city__transport_hub__contact";

function haydenCard(session: OverworldSession) {
  const hayden = session.view().characters.find((character) => character.id === HAYDEN_ID);
  if (!hayden) throw new Error("Expected Hayden Hale in Albany Station Quarter.");
  return hayden;
}

function contactCopy(contact: { summary: string; agenda: string }): string {
  return `${contact.summary} ${contact.agenda}`;
}

function moveToArea(session: OverworldSession, destinationAreaId: string): void {
  const route = session
    .view()
    .areaExits.find((candidate) => candidate.destination.id === destinationAreaId);
  if (!route) throw new Error(`Expected a discovered area route to ${destinationAreaId}.`);
  session.moveArea(route.id);
}

function continueFixedCheckpoint(session: OverworldSession): void {
  const pending = session.journey().pendingChoice;
  if (
    pending?.reasons.includes("checkpoint") === true &&
    !pending.reasons.includes("goal_completed")
  ) {
    session.chooseJourney("continue");
  }
}

function travelSessionToTown(session: OverworldSession, destinationTownId: string): void {
  const route = planOverworldRoute(world, session.view().current.id, destinationTownId);
  if (!route) throw new Error(`Expected a route to ${destinationTownId}.`);
  for (const step of route.steps) {
    session.travel(step.edge.id);
    continueFixedCheckpoint(session);
    if (session.view().pendingRoadEncounter) {
      session.resolveRoadEncounter("press_on");
      continueFixedCheckpoint(session);
    }
  }
}

function startAlbanyWolf(session: OverworldSession): void {
  if (session.view().currentArea?.id !== "albany_city__civic_core") {
    moveToArea(session, "albany_city__civic_core");
  }
  session.scoutPoi("albany_city__civic_core__poi");
  if (session.campaignCharacterState().background === null) {
    session.talkToCharacter("albany_city__civic_core__contact");
    session.chooseJourneyStory("albany:ledger_advocate");
  }
  if (session.journey().storyChoice?.kind === "relief_oath") {
    revealCurrentJourneyStoryOptions(session, world.opening_relief_oath!.id);
    session.chooseJourneyStory("albany:oath_limited_aid_only");
  }
  if (session.journey().storyChoice?.kind === "lead_source") {
    session.chooseJourneyStory("albany:source_rowan_civic_docket");
  }
  moveToArea(session, world.opening_preparation!.area);
  if (session.view().departureInteractions[0]?.kind === "preparation") {
    session.chooseJourneyStory("albany:prep_works_fortification");
  }
  if (session.view().departureInteractions[0]?.kind === "relief_allocation") {
    session.chooseJourneyStory("albany:relief_resident_shelter");
  }
  moveToArea(session, "albany_city__market");
  session.scoutPoi("albany_city__market__poi");
  moveToArea(session, "albany_city__transport_hub");
  expect(session.view().quests.map((quest) => quest.id)).toContain("wolf_winter");
  session.startQuest("wolf_winter", "albany:wolf_approach_sheltered_stockway");
}

function revealAlbanyWolfAtStation(session: OverworldSession): void {
  if (session.view().currentArea?.id !== "albany_city__civic_core") {
    moveToArea(session, "albany_city__civic_core");
  }
  session.scoutPoi("albany_city__civic_core__poi");
  if (session.campaignCharacterState().background === null) {
    session.talkToCharacter("albany_city__civic_core__contact");
    session.chooseJourneyStory("albany:ledger_advocate");
  }
  if (session.journey().storyChoice?.kind === "relief_oath") {
    revealCurrentJourneyStoryOptions(session, world.opening_relief_oath!.id);
    session.chooseJourneyStory("albany:oath_limited_aid_only");
  }
  if (session.journey().storyChoice?.kind === "lead_source") {
    session.chooseJourneyStory("albany:source_rowan_civic_docket");
  }
  moveToArea(session, world.opening_preparation!.area);
  if (session.view().departureInteractions[0]?.kind === "preparation") {
    session.chooseJourneyStory("albany:prep_works_fortification");
  }
  if (session.view().departureInteractions[0]?.kind === "relief_allocation") {
    session.chooseJourneyStory("albany:relief_resident_shelter");
  }
  moveToArea(session, "albany_city__market");
  session.scoutPoi("albany_city__market__poi");
  moveToArea(session, "albany_city__transport_hub");
  expect(session.view().quests.map((quest) => quest.id)).toContain("wolf_winter");
}

function completeWolfWithBaseHaydenAtDecision22(session: OverworldSession): string {
  revealAlbanyWolfAtStation(session);
  const baseCard = haydenCard(session);
  const baseCopy = contactCopy(baseCard);
  expect(baseCard).not.toHaveProperty("variants");
  expect(baseCopy).toContain("dispatches road wardens and relief crews");
  expect(baseCopy).toContain("route reports, winter dispatches, and field returns");
  expect(baseCopy).not.toMatch(/current journey goal|return board|crossed both/i);

  const beforeTalk = session.journey().acceptedDecisions;
  const talked = session.talkToCharacter(HAYDEN_ID);
  expect(talked).toMatchObject({
    minutes: 15,
    alreadyKnown: false,
    journeyDecision: { countsTowardJourney: true, reason: "substantive_dialogue" },
  });
  expect(talked.entry.text).toBe(baseCopy);
  expect(session.journey().acceptedDecisions).toBe(beforeTalk + 1);

  session.startQuest("wolf_winter", "albany:wolf_approach_sheltered_stockway");
  while (session.journey().acceptedDecisions < 22) {
    const next = session.journey().acceptedDecisions + 1;
    session.recordQuestDecision(
      `wolf_winter:hayden_lifecycle:${String(next)}`,
      {
        countsTowardJourney: true,
        reason: "preparation",
      },
      true,
    );
  }
  session.completeQuest("wolf_winter", {
    endingId: "ending_held_timber_saved",
    endingTitle: "The Byre Held, Paling Timber Saved",
    death: false,
  });
  expect(session.journey()).toMatchObject({
    acceptedDecisions: 22,
    goal: { status: "completed", completedAtDecision: 22 },
    pendingChoice: { reasons: ["goal_completed"] },
  });
  return baseCopy;
}

function travelToQueensburyMarket(session: OverworldSession): void {
  session.travel(ALBANY_TO_SARATOGA);
  if (session.view().pendingRoadEncounter) session.resolveRoadEncounter("press_on");
  session.travel(SARATOGA_TO_QUEENSBURY);
  if (session.view().pendingRoadEncounter) session.resolveRoadEncounter("press_on");
  moveToArea(session, "queensbury_town__market");
}

function returnToAlbanyStation(session: OverworldSession): void {
  session.travel(SARATOGA_TO_QUEENSBURY);
  if (session.view().pendingRoadEncounter) session.resolveRoadEncounter("press_on");
  session.travel(ALBANY_TO_SARATOGA);
  if (session.view().pendingRoadEncounter) session.resolveRoadEncounter("press_on");
  expect(session.view()).toMatchObject({
    current: { id: "albany_city" },
    currentArea: { id: "albany_city__transport_hub" },
  });
}

function completeWolfAtDecision22(session: OverworldSession): void {
  startAlbanyWolf(session);
  while (session.journey().acceptedDecisions < 22) {
    const next = session.journey().acceptedDecisions + 1;
    session.recordQuestDecision(
      `wolf_winter:regression_setup:${String(next)}`,
      {
        countsTowardJourney: true,
        reason: "preparation",
      },
      true,
    );
  }
  session.completeQuest("wolf_winter", {
    endingId: "ending_held_timber_saved",
    endingTitle: "The Byre Held, Paling Timber Saved",
    death: false,
  });
  expect(session.journey()).toMatchObject({
    acceptedDecisions: 22,
    goal: { status: "completed", completedAtDecision: 22 },
    pendingChoice: { reasons: ["goal_completed"] },
  });
}

function startGallowmereAfterWolf(
  choice: "send_wagon_to_cade" | "send_wardens_north",
): OverworldSession {
  const session = new OverworldSession(world);
  completeWolfAtDecision22(session);

  session.chooseJourney("continue");
  expect(session.journey().storyChoice?.options.map((option) => option.id)).toEqual([
    "send_wagon_to_cade",
    "send_wardens_north",
  ]);
  const beforeDispatch = session.snapshot();
  session.chooseJourneyStory(choice);
  expect(session.journey().acceptedDecisions).toBe(23);
  const afterDispatch = session.snapshot();
  expect(
    afterDispatch.discoveredAreaIds.filter(
      (areaId) => !beforeDispatch.discoveredAreaIds.includes(areaId),
    ),
  ).toEqual(["queensbury_town__market"]);
  expect(
    afterDispatch.discoveredQuestIds.filter(
      (questId) => !beforeDispatch.discoveredQuestIds.includes(questId),
    ),
  ).toEqual(["gallowmere"]);
  expect(OverworldSession.restore(world, afterDispatch).snapshot()).toEqual(afterDispatch);
  expect(session.journey().goalGuidance).toBe(
    "Next road: Saratoga Springs city. Queensbury town is 2 roads away, about 60 travel minutes.",
  );

  session.travel(ALBANY_TO_SARATOGA);
  expect(session.journey().goalGuidance).toBe(
    "Next road: Queensbury town. Queensbury town is 1 road away, about 26 travel minutes.",
  );
  session.resolveRoadEncounter("press_on");
  session.travel(SARATOGA_TO_QUEENSBURY);
  expect(session.view().pendingRoadEncounter).toBeNull();
  expect(session.journey().acceptedDecisions).toBe(26);

  expect(session.journey().goalGuidance).toBe(
    "You reached the goal town. Move toward Queensbury Market Streets to find the lead.",
  );
  expect(session.view().areaExits.map((route) => route.id)).toContain(QUEENSBURY_MARKET_ROUTE);
  expect(session.view().quests.map((quest) => quest.id)).toContain("gallowmere");
  session.moveArea(QUEENSBURY_MARKET_ROUTE);
  const started = session.startQuest("gallowmere");

  expect(started.id).toBe("gallowmere");
  expect(session.journey().acceptedDecisions).toBe(28);
  expect(session.journey().acceptedDecisions - 22).toBe(6);
  expect(session.view()).toMatchObject({
    current: { id: "queensbury_town" },
    currentArea: { id: "queensbury_town__market" },
    completedJobIds: [],
    startedQuestIds: ["gallowmere", "wolf_winter"],
  });
  expect(session.journey().goalGuidance).toBe(
    "You reached the goal location: Queensbury Market Streets. Use the visible lead here.",
  );
  return session;
}

describe("Wolf-Winter to Gallowmere authored handoff", () => {
  it("pins the two-road Albany-to-Queensbury corridor and its authored story copy", () => {
    const route = planOverworldRoute(world, "albany_city", "queensbury_town");
    expect(route).not.toBeNull();
    expect(route?.steps.map((step) => step.edge.id)).toEqual([
      ALBANY_TO_SARATOGA,
      SARATOGA_TO_QUEENSBURY,
    ]);
    expect(route?.steps.map((step) => step.roadEvent?.id)).toEqual([
      `road_event_${ALBANY_TO_SARATOGA.slice("road_".length)}`,
      `road_event_${SARATOGA_TO_QUEENSBURY.slice("road_".length)}`,
    ]);
    expect(route?.totalMinutes).toBe(60);
    expect(route?.totalDistanceMi).toBeCloseTo(57.6, 8);

    expect(route?.steps[0]?.roadEvent).toMatchObject({
      title: "Queensbury Shepherd Warning",
      summary:
        "Wardens on the Albany–Saratoga road report that a shepherd was killed near Queensbury. His son is waiting with the tracking record.",
    });
    expect(route?.steps[1]?.roadEvent).toMatchObject({
      title: "Gallowmere tracks on the Queensbury road",
      summary:
        "Before Queensbury, shepherds point out churned verges and one broad, deep track turning toward the Gallowmere hills.",
    });
    expect(route?.steps.map((step) => step.roadEvent?.title)).not.toContain(
      "I-87 / New York State Thruway road report",
    );

    const civic = world.areas.find((area) => area.id === "queensbury_town__civic_core");
    const market = world.areas.find((area) => area.id === "queensbury_town__market");
    expect(civic).toMatchObject({
      summary: "This area holds the notice board, official counters, and local records.",
    });
    expect(market).toMatchObject({
      summary: "This area has shops, food, supplies, and local rumors.",
      discovery: "Explore it to find quest leads, supplies, and unposted work.",
    });

    expect(
      world.characters.find((character) => character.id === "queensbury_town__market__contact"),
    ).toMatchObject({
      name: "Hedrick Cradoc",
      role: "shepherd's son",
      faction: "Queensbury Shepherds",
      summary: "Hedrick Cradoc is the shepherd's son for Queensbury Market Streets.",
      agenda: "Hedrick Cradoc wants help with local problems before they spread to nearby roads.",
    });
    expect(world.quests.find((quest) => quest.id === "gallowmere")).toMatchObject({
      home: "queensbury_town",
      area: "queensbury_town__market",
      discovery:
        "Find Hedrick in Queensbury Market Streets. His father was killed this morning, and his tracking log leads to the Gallowmere sow.",
    });
    expect(world.area_edges.find((edge) => edge.id === QUEENSBURY_MARKET_ROUTE)).toMatchObject({
      route: "Go from Queensbury Civic Center to Queensbury Market Streets",
    });
  });

  it.each(["send_wagon_to_cade", "send_wardens_north"] as const)(
    "starts Gallowmere at decision 28 through %s without a scout detour or generic job dependency",
    (choice) => {
      const session = startGallowmereAfterWolf(choice);
      expect(session.view().log.map((entry) => entry.edgeId)).toEqual([
        SARATOGA_TO_QUEENSBURY,
        ALBANY_TO_SARATOGA,
      ]);
      expect(session.journey().goal).toMatchObject({
        version: 2,
        status: "active",
      });
      session.completeQuest("gallowmere", {
        endingId: "ending_victory",
        endingTitle: "The Gallowmere Broken",
        death: false,
      });
      session.chooseJourney("continue");
      expect(session.journey()).toMatchObject({
        goal: { version: 3, id: "oneonta_tanners_fever", status: "active" },
        goalGuidance:
          "Next road: Saratoga Springs city. Oneonta city is 6 roads away, about 153 travel minutes.",
      });
    },
  );

  it("migrates only the authenticated campaign anchor and replays the first Queensbury action across UI and MCP restore", () => {
    const session = new OverworldSession(world);
    completeWolfAtDecision22(session);
    session.chooseJourney("continue");
    session.chooseJourneyStory("send_wagon_to_cade");

    const current = session.snapshot();
    expect(current.discoveredQuestIds).toContain("gallowmere");
    expect(current.discoveredAreaIds).toContain("queensbury_town__market");

    const preAnchor = structuredClone(current);
    preAnchor.discoveredQuestIds = preAnchor.discoveredQuestIds.filter(
      (questId) => questId !== "gallowmere",
    );
    preAnchor.discoveredAreaIds = preAnchor.discoveredAreaIds.filter(
      (areaId) => areaId !== "queensbury_town__market",
    );
    const migrated = OverworldSession.restore(world, preAnchor);
    expect(migrated.snapshot().discoveredQuestIds).toContain("gallowmere");
    expect(migrated.snapshot().discoveredAreaIds).toContain("queensbury_town__market");
    expect(OverworldSession.restore(world, migrated.snapshot()).snapshot()).toEqual(
      migrated.snapshot(),
    );

    const authenticatedCampaignEntry = current.journalEntries.find(
      (entry) => entry.kind === "campaign",
    );
    if (!authenticatedCampaignEntry) {
      throw new Error("Expected the authenticated current campaign goal journal.");
    }
    const forgedCampaignCopy = structuredClone(current);
    const campaignEntry = forgedCampaignCopy.journalEntries.find(
      (entry) => entry.kind === "campaign",
    );
    if (!campaignEntry) throw new Error("Expected the authenticated campaign goal journal.");
    campaignEntry.text += " Forged route.";
    expect(() => OverworldSession.restore(world, forgedCampaignCopy)).toThrow(
      /campaign journal entry.*forged/i,
    );

    const predecessorCampaignCopy = structuredClone(current);
    const predecessorEntry = predecessorCampaignCopy.journalEntries.find(
      (entry) => entry.kind === "campaign",
    );
    if (!predecessorEntry) throw new Error("Expected the predecessor campaign goal journal.");
    predecessorEntry.title = "Send the wagon back to Cade";
    predecessorEntry.text =
      "The wagon and the saved timber close Cade's breach before the next night. You take Hedrick's packet north alone.";
    expect(() => OverworldSession.restore(world, predecessorCampaignCopy)).toThrow(
      /campaign journal entry.*forged/i,
    );

    predecessorCampaignCopy.worldHash = "0".repeat(64);
    const predecessorRestored = OverworldSession.restore(world, predecessorCampaignCopy);
    const normalizedEntry = predecessorRestored
      .snapshot()
      .journalEntries.find((entry) => entry.kind === "campaign");
    expect(normalizedEntry).toMatchObject({
      title: authenticatedCampaignEntry.title,
      text: authenticatedCampaignEntry.text,
    });

    const nearPredecessorCampaignCopy = structuredClone(predecessorCampaignCopy);
    const nearPredecessorEntry = nearPredecessorCampaignCopy.journalEntries.find(
      (entry) => entry.kind === "campaign",
    );
    if (!nearPredecessorEntry) throw new Error("Expected the near-predecessor campaign journal.");
    nearPredecessorEntry.text += " Altered.";
    expect(() => OverworldSession.restore(world, nearPredecessorCampaignCopy)).toThrow(
      /campaign journal entry.*forged/i,
    );

    const crossOutcomePredecessorCopy = structuredClone(predecessorCampaignCopy);
    const crossOutcomeEntry = crossOutcomePredecessorCopy.journalEntries.find(
      (entry) => entry.kind === "campaign",
    );
    if (!crossOutcomeEntry) throw new Error("Expected the cross-outcome campaign journal.");
    crossOutcomeEntry.text =
      "The wagon replaces the broken outer paling while Cade keeps the whole herd in; the diverted pack remains alive in the high wood. You take Hedrick's packet north alone.";
    expect(() => OverworldSession.restore(world, crossOutcomePredecessorCopy)).toThrow(
      /campaign journal entry.*forged/i,
    );

    const unrelatedQuest = world.quests.find(
      (quest) => quest.home === "oneonta_city" && quest.id !== "gallowmere",
    );
    if (!unrelatedQuest) throw new Error("Expected an unrelated remote quest fixture.");
    const forgedRemoteDiscovery = structuredClone(current);
    forgedRemoteDiscovery.discoveredQuestIds.push(unrelatedQuest.id);
    forgedRemoteDiscovery.discoveredAreaIds.push(unrelatedQuest.area);
    expect(() => OverworldSession.restore(world, forgedRemoteDiscovery)).toThrow(
      /belongs to unvisited town/i,
    );

    session.followGoalPassage();
    session.resolveRoadEncounter("press_on");
    session.followGoalPassage();
    session.moveArea(QUEENSBURY_MARKET_ROUTE);
    const scouted = session.scoutPoi("queensbury_town__market__poi");
    expect(scouted.discoveredAreas?.map((area) => area.id)).toEqual([
      "queensbury_town__transport_hub",
    ]);
    const afterFirstAction = session.snapshot();
    expect(
      afterFirstAction.discoveredAreaIds.filter((areaId) => areaId.startsWith("queensbury_town__")),
    ).toEqual([
      "queensbury_town__civic_core",
      "queensbury_town__market",
      "queensbury_town__transport_hub",
    ]);
    expect(OverworldSession.restore(world, afterFirstAction).snapshot()).toEqual(afterFirstAction);
    const mcp = createToolApi({ root: process.cwd() }).restore_overworld_session({
      snapshot: afterFirstAction,
      compact_context: false,
      compact_result: false,
    });
    expect(mcp.observation.areas.map((area) => area.id)).toEqual([
      "queensbury_town__civic_core",
      "queensbury_town__market",
      "queensbury_town__transport_hub",
    ]);

    const actionBeforeActivation = structuredClone(afterFirstAction);
    const trail = actionBeforeActivation.openingLeadSourceDecisionTrail;
    if (!trail) throw new Error("Expected the replayable campaign decision trail.");
    const activation = trail.decisions.find(
      (decision) => decision.actionId === "campaign_story:albany_dawn_dispatch:send_wagon_to_cade",
    );
    const marketAction = trail.decisions.find(
      (decision) => decision.actionId === "scout:queensbury_town__market__poi",
    );
    if (!activation || !marketAction) {
      throw new Error("Expected activation and anchored-market action decisions.");
    }
    const activationAction = {
      surface: activation.surface,
      actionId: activation.actionId,
      reason: activation.reason,
    };
    activation.surface = marketAction.surface;
    activation.actionId = marketAction.actionId;
    activation.reason = marketAction.reason;
    marketAction.surface = activationAction.surface;
    marketAction.actionId = activationAction.actionId;
    marketAction.reason = activationAction.reason;
    let decisionProofHash = trail.baseDecisionProofHash;
    for (const decision of trail.decisions) {
      decisionProofHash = hashState({ previous: decisionProofHash, ...decision });
    }
    actionBeforeActivation.journey.decisionProof = {
      hash: decisionProofHash,
      last: { ...trail.decisions.at(-1)! },
    };
    expect(() => OverworldSession.restore(world, actionBeforeActivation)).toThrow(
      /before discovering area "queensbury_town__market"/i,
    );
  });

  it("accepts a Oneonta market event before the anchored quest and restores it exactly", () => {
    const session = startGallowmereAfterWolf("send_wagon_to_cade");
    session.completeQuest("gallowmere", {
      endingId: "ending_hunt_won",
      endingTitle: "The Gallowmere Hunt Won",
      death: false,
    });
    session.chooseJourney("continue");
    expect(session.journey().goal.id).toBe("oneonta_tanners_fever");

    travelSessionToTown(session, "oneonta_city");
    expect(
      session
        .view()
        .areas.map((area) => area.id)
        .filter((areaId) => areaId.startsWith("oneonta_city__")),
    ).toEqual(["oneonta_city__civic_core", "oneonta_city__market"]);
    moveToArea(session, "oneonta_city__market");
    const investigated = session.investigateEvent("oneonta_city__market__event");
    expect(investigated.entry.id).toBe("investigate:oneonta_city__market__event");
    expect(session.snapshot().startedQuestIds).not.toContain("tanners_fever");

    const snapshot = session.snapshot();
    expect(OverworldSession.restore(world, snapshot).snapshot()).toEqual(snapshot);
  });

  it.each([
    [
      "area",
      (session: OverworldSession) => {
        session.exploreArea("queensbury_town__market");
      },
    ],
    [
      "contact",
      (session: OverworldSession) => {
        session.talkToCharacter("queensbury_town__market__contact");
      },
    ],
    [
      "event",
      (session: OverworldSession) => {
        session.investigateEvent("queensbury_town__market__event");
      },
    ],
    [
      "point of interest",
      (session: OverworldSession) => {
        session.scoutPoi("queensbury_town__market__poi");
      },
    ],
    [
      "site",
      (session: OverworldSession) => {
        session.scoutPoi("queensbury_town__market__poi");
        session.exploreSite("queensbury_town__market__site");
      },
    ],
    [
      "job",
      (session: OverworldSession) => {
        session.scoutPoi("queensbury_town__market__poi");
        session.talkToCharacter("queensbury_town__market__contact");
        session.workLocalJob("queensbury_town__market__job");
      },
    ],
    [
      "resolution",
      (session: OverworldSession) => {
        session.scoutPoi("queensbury_town__market__poi");
        session.talkToCharacter("queensbury_town__market__contact");
        session.investigateEvent("queensbury_town__market__event");
        session.resolveEvent("queensbury_town__market__event");
      },
    ],
  ] as const)("restores a campaign-anchored Queensbury %s action", (_label, act) => {
    const prepared = new OverworldSession(world);
    completeWolfAtDecision22(prepared);
    prepared.chooseJourney("continue");
    prepared.chooseJourneyStory("send_wagon_to_cade");
    prepared.followGoalPassage();
    prepared.resolveRoadEncounter("press_on");
    prepared.followGoalPassage();
    prepared.moveArea(QUEENSBURY_MARKET_ROUTE);

    const session = OverworldSession.restore(world, prepared.snapshot());
    act(session);
    const snapshot = session.snapshot();
    expect(OverworldSession.restore(world, snapshot).snapshot()).toEqual(snapshot);
  });

  it("evolves Hayden's contact card and one-time talk across both dispatch branches and restore", () => {
    const baseCopies: string[] = [];
    const wolfClosedCopies: string[] = [];
    const bothClosedCopies: string[] = [];

    for (const choice of ["send_wagon_to_cade", "send_wardens_north"] as const) {
      const session = new OverworldSession(world);
      baseCopies.push(completeWolfWithBaseHaydenAtDecision22(session));

      session.chooseJourney("continue");
      session.chooseJourneyStory(choice);
      const wolfClosedCard = haydenCard(session);
      const wolfClosedCopy = contactCopy(wolfClosedCard);
      wolfClosedCopies.push(wolfClosedCopy);
      expect(wolfClosedCard).not.toHaveProperty("variants");
      expect(wolfClosedCopy).toMatch(/Cade/i);
      expect(wolfClosedCopy).toMatch(/surviving|closed|return board/i);
      expect(wolfClosedCopy).toMatch(/current journey goal|journey ledger/i);
      expect(wolfClosedCopy).not.toMatch(/controlling source certification|settled packets/i);

      const beforeWolfClosedTalk = session.journey().acceptedDecisions;
      const wolfClosedTalk = session.talkToCharacter(HAYDEN_ID);
      expect(wolfClosedTalk).toMatchObject({
        minutes: 15,
        alreadyKnown: false,
        entry: { id: `talk:${HAYDEN_ID}@wolf_winter_closed`, text: wolfClosedCopy },
        journeyDecision: { countsTowardJourney: true, reason: "substantive_dialogue" },
      });
      expect(session.journey().acceptedDecisions).toBe(beforeWolfClosedTalk + 1);

      travelToQueensburyMarket(session);
      session.startQuest("gallowmere");
      session.completeQuest("gallowmere", {
        endingId: "ending_victory",
        endingTitle: "The Gallowmere Broken",
        death: false,
      });
      session.chooseJourney("continue");
      returnToAlbanyStation(session);
      expect(
        session
          .view()
          .log.slice(0, 2)
          .map((entry) => entry.edgeId),
      ).toEqual([ALBANY_TO_SARATOGA, SARATOGA_TO_QUEENSBURY]);

      const snapshotBeforeTalk = session.snapshot();
      const hashBeforeTalk = session.snapshotHash();
      const restoredBeforeTalk = OverworldSession.restore(world, snapshotBeforeTalk);
      expect(restoredBeforeTalk.snapshotHash()).toBe(hashBeforeTalk);
      const bothClosedCard = haydenCard(restoredBeforeTalk);
      const bothClosedCopy = contactCopy(bothClosedCard);
      bothClosedCopies.push(bothClosedCopy);
      expect(bothClosedCard).not.toHaveProperty("variants");
      expect(bothClosedCopy).toMatch(/Wolf-Winter/i);
      expect(bothClosedCopy).toMatch(/Hedrick|Gallowmere/i);
      expect(bothClosedCopy).toMatch(/crossed|closed|settled|filed/i);
      expect(bothClosedCopy).toMatch(/current journey goal|journey ledger/i);
      expect(bothClosedCopy).not.toBe(wolfClosedCopy);
      expect(bothClosedCopy).not.toMatch(/controlling source certification|settled packets/i);

      const decisionsBeforeTalk = restoredBeforeTalk.journey().acceptedDecisions;
      const firstTalk = restoredBeforeTalk.talkToCharacter(HAYDEN_ID);
      expect(firstTalk).toMatchObject({
        minutes: 15,
        alreadyKnown: false,
        entry: {
          id: `talk:${HAYDEN_ID}@wolf_winter_and_gallowmere_closed`,
          text: bothClosedCopy,
        },
        journeyDecision: { countsTowardJourney: true, reason: "substantive_dialogue" },
      });
      expect(restoredBeforeTalk.journey().acceptedDecisions).toBe(decisionsBeforeTalk + 1);
      expect(restoredBeforeTalk.snapshotHash()).not.toBe(hashBeforeTalk);

      const snapshotAfterTalk = restoredBeforeTalk.snapshot();
      const hashAfterTalk = restoredBeforeTalk.snapshotHash();
      const restoredAfterTalk = OverworldSession.restore(world, snapshotAfterTalk);
      expect(restoredAfterTalk.snapshotHash()).toBe(hashAfterTalk);
      const projectionBeforeRepeat = restoredAfterTalk.view();
      const repeat = restoredAfterTalk.talkToCharacter(HAYDEN_ID);
      expect(repeat).toMatchObject({
        minutes: 0,
        alreadyKnown: true,
        entry: { text: bothClosedCopy },
        journeyDecision: { countsTowardJourney: false, reason: "repeated_context" },
      });
      expect(restoredAfterTalk.journey().acceptedDecisions).toBe(decisionsBeforeTalk + 1);
      expect(restoredAfterTalk.snapshotHash()).toBe(hashAfterTalk);
      expect(restoredAfterTalk.view()).toEqual(projectionBeforeRepeat);
    }

    expect([...new Set(baseCopies)]).toHaveLength(1);
    expect([...new Set(wolfClosedCopies)]).toHaveLength(1);
    expect([...new Set(bothClosedCopies)]).toHaveLength(1);
  });

  it("restores an authored job between its older setup talk and a newer reactive talk", () => {
    const stationJob = world.local_jobs.find((job) => job.id === "albany_city__transport_hub__job");
    const option = stationJob?.authored_scene?.options[0];
    if (!stationJob?.authored_scene || !option) {
      throw new Error("Expected the authored Albany station job.");
    }

    const session = new OverworldSession(world);
    completeWolfWithBaseHaydenAtDecision22(session);
    session.chooseJourney("continue");
    session.chooseJourneyStory("send_wardens_north");
    session.scoutPoi("albany_city__transport_hub__poi");
    expect(session.talkToCharacter(HAYDEN_ID).entry.id).toBe(
      `talk:${HAYDEN_ID}@wolf_winter_closed`,
    );
    session.workLocalJob(stationJob.id, option.id);

    travelToQueensburyMarket(session);
    session.startQuest("gallowmere");
    session.completeQuest("gallowmere", {
      endingId: "ending_victory",
      endingTitle: "The Gallowmere Broken",
      death: false,
    });
    session.chooseJourney("continue");
    returnToAlbanyStation(session);
    expect(session.talkToCharacter(HAYDEN_ID).entry.id).toBe(
      `talk:${HAYDEN_ID}@wolf_winter_and_gallowmere_closed`,
    );

    const snapshot = session.snapshot();
    const jobIndex = snapshot.journalEntries.findIndex(
      (entry) => entry.id === `job:${stationJob.id}`,
    );
    const newerTalkIndex = snapshot.journalEntries.findIndex(
      (entry) => entry.id === `talk:${HAYDEN_ID}@wolf_winter_and_gallowmere_closed`,
    );
    const olderTalkIndex = snapshot.journalEntries.findIndex(
      (entry) => entry.id === `talk:${HAYDEN_ID}@wolf_winter_closed`,
    );
    expect(newerTalkIndex).toBeLessThan(jobIndex);
    expect(olderTalkIndex).toBeGreaterThan(jobIndex);
    expect(OverworldSession.restore(world, snapshot).snapshot()).toEqual(snapshot);
  });

  it("folds an already-completed Gallowmere goal honestly and advances to the next live lead", () => {
    const session = new OverworldSession(world);
    session.scoutPoi("albany_city__civic_core__poi");
    session.talkToCharacter("albany_city__civic_core__contact");
    session.chooseJourneyStory("albany:ledger_advocate");
    revealCurrentJourneyStoryOptions(session, world.opening_relief_oath!.id);
    session.chooseJourneyStory("albany:oath_limited_aid_only");
    session.chooseJourneyStory("albany:source_rowan_civic_docket");
    moveToArea(session, world.opening_preparation!.area);
    expect(session.view().departureInteractions[0]?.kind).toBe("preparation");
    session.chooseJourneyStory("albany:prep_works_fortification");
    expect(session.view().departureInteractions[0]?.kind).toBe("relief_allocation");
    session.chooseJourneyStory("albany:relief_resident_shelter");
    session.travel(ALBANY_TO_SARATOGA);
    if (session.view().pendingRoadEncounter) session.resolveRoadEncounter("press_on");
    session.travel(SARATOGA_TO_QUEENSBURY);
    if (session.view().pendingRoadEncounter) session.resolveRoadEncounter("press_on");
    session.exploreArea("queensbury_town__civic_core");
    session.moveArea(QUEENSBURY_MARKET_ROUTE);
    session.startQuest("gallowmere");
    session.completeQuest("gallowmere", {
      endingId: "ending_victory",
      endingTitle: "The Gallowmere Broken",
      death: false,
    });

    session.travel(SARATOGA_TO_QUEENSBURY);
    if (session.view().pendingRoadEncounter) session.resolveRoadEncounter("press_on");
    session.travel(ALBANY_TO_SARATOGA);
    if (session.view().pendingRoadEncounter) session.resolveRoadEncounter("press_on");
    completeWolfAtDecision22(session);
    session.chooseJourney("continue");
    const beforeDispatch = session.snapshot();
    session.chooseJourneyStory("send_wagon_to_cade");
    const afterDispatch = session.snapshot();
    expect(
      afterDispatch.discoveredAreaIds.filter(
        (areaId) => !beforeDispatch.discoveredAreaIds.includes(areaId),
      ),
    ).toEqual([]);

    expect(session.journey()).toMatchObject({
      acceptedDecisions: 23,
      goal: {
        version: 2,
        id: "carry_hedricks_packet_north",
        status: "completed",
        completedAtDecision: 23,
      },
      pendingChoice: {
        reasons: ["goal_completed"],
        goalVersion: 2,
        goalId: "carry_hedricks_packet_north",
      },
    });

    session.chooseJourney("continue");
    expect(session.journey().goal).toMatchObject({
      version: 3,
      id: "oneonta_tanners_fever",
      status: "active",
    });

    travelSessionToTown(session, "queensbury_town");
    expect(session.view().currentArea?.id).toBe("queensbury_town__market");
    const next = session.scoutPoi("queensbury_town__market__poi");
    expect(next.discoveredAreas?.map((area) => area.id)).toEqual([
      "queensbury_town__transport_hub",
    ]);
    const replayed = session.snapshot();
    expect(OverworldSession.restore(world, replayed).snapshot()).toEqual(replayed);
  });
});
