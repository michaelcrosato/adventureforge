import { describe, expect, expectTypeOf, it } from "vitest";

import { createToolApi } from "../../src/mcp/tools.js";
import { EMBEDDED_QUEST_COMPACT_SCOPE_NOTE } from "../../src/rpg/embedded_quest_character_continuity.js";
import {
  compactJourneyStoryChoiceComparison,
  compactJourneyPresentation,
  compactJourneyStoryChoicePrompt,
  JOURNEY_STORY_CHOICE_COMPARISON_VERSION,
  JOURNEY_STORY_CHOICE_REVIEW_INSTRUCTION,
  JOURNEY_STORY_CHOICE_STAGED_CONSEQUENCE,
  type JourneyStoryChoiceDetail,
  type JourneyStoryChoiceRevealAffordance,
  type JourneyStoryChoiceSummaryComparison,
  type EmbeddedJourneyFocus,
} from "../../src/mcp/journey_projection.js";
import {
  OPENING_RELIEF_OATH_CUSTOMIZE_DESCRIPTION,
  OPENING_RELIEF_OATH_CUSTOMIZE_LABEL,
  OPENING_RELIEF_OATH_FIELD_OUTCOME_COMPASS,
} from "../../src/world/opening_relief_oath_presentation.js";
import {
  INITIAL_JOURNEY_GOAL,
  INITIAL_JOURNEY_GOAL_GUIDANCE,
  JOURNEY_CONTRACT_VERSION,
  type JourneyChoiceResult,
  type JourneyPresentation,
  type JourneyStoryChoicePrompt,
} from "../../src/world/journey_contract.js";
import {
  OPENING_SELECTION_RECEIPT_WORD_LIMIT,
  openingSelectionReceiptWordCount,
} from "../../src/world/opening_choice_receipt.js";
import { compactOpeningDepartureRecapTerms } from "../../src/world/opening_departure_recap.js";
import {
  compactStationDispatchBoard,
  compactStationDispatchBoardSupport,
  STATION_DISPATCH_SUPPORT_REVEAL_ID,
} from "../../src/world/station_dispatch_board.js";
import {
  TANNERS_FEVER_ACCOUNTABILITY_CHOICE_IDS,
  TANNERS_FEVER_ACCOUNTABILITY_ID,
} from "../../src/world/journey_campaign.js";
import { planOverworldRoute } from "../regression/support/overworld_queries.js";
import {
  INSPECT_OVERWORLD_SESSION_STORY_TOOL,
  OVERWORLD_DEPARTURE_CHOICE_VALUES_FROM,
} from "../../src/world/session_departure_interactions.js";
import { loadOverworldManifest } from "../../src/world/source.js";
import { OverworldSession } from "../../ui/src/overworld.js";
import { revealCurrentJourneyStoryOptions } from "../regression/support/journey_story.js";

const api = () => createToolApi({ root: process.cwd() });
const FULL_OVERWORLD = { compact_context: false, compact_result: false } as const;
const WORLD = loadOverworldManifest(process.cwd());
const HAYDEN_ID = "albany_city__transport_hub__contact";
const LIMITED_RELIEF_OATH_ID = "albany:oath_limited_aid_only";
const SHELTERED_APPROACH_ID = "albany:wolf_approach_sheltered_stockway";
const RESIDENT_SHELTER_ALLOCATION_ID = "albany:relief_resident_shelter";
const PREPARATION_STORY_ID = "albany:wolf_preparation";
const RELIEF_ALLOCATION_STORY_ID = "albany:wolf_relief_allocation";
const ALBANY_TO_SARATOGA = "road_albany_city__saratoga_springs_city";
const SARATOGA_TO_QUEENSBURY = "road_saratoga_springs_city__queensbury_town";

function moveUiSessionToArea(session: OverworldSession, destinationAreaId: string): void {
  const route = session
    .view()
    .areaExits.find((candidate) => candidate.destination.id === destinationAreaId);
  if (!route) throw new Error(`expected a route to ${destinationAreaId}`);
  session.moveArea(route.id);
}

function uiSessionAtPostGallowmereHayden(): OverworldSession {
  const session = new OverworldSession(WORLD);
  session.scoutPoi("albany_city__civic_core__poi");
  session.talkToCharacter("albany_city__civic_core__contact");
  session.chooseJourneyStory("albany:ledger_advocate");
  revealCurrentJourneyStoryOptions(session, WORLD.opening_relief_oath!.id);
  session.chooseJourneyStory(LIMITED_RELIEF_OATH_ID);
  session.chooseJourneyStory("albany:source_rowan_civic_docket");
  moveUiSessionToArea(session, "albany_city__transport_hub");
  expect(session.view().departureInteractions[0]?.kind).toBe("preparation");
  session.chooseJourneyStory("albany:prep_works_fortification");
  session.chooseJourneyStory(RESIDENT_SHELTER_ALLOCATION_ID);
  moveUiSessionToArea(session, "albany_city__market");
  session.scoutPoi("albany_city__market__poi");
  moveUiSessionToArea(session, "albany_city__transport_hub");
  session.startQuest("wolf_winter", SHELTERED_APPROACH_ID);
  session.completeQuest("wolf_winter", {
    endingId: "ending_held_timber_saved",
    endingTitle: "The Byre Held, Paling Timber Saved",
    death: false,
  });
  session.chooseJourney("continue");
  session.chooseJourneyStory("send_wagon_to_cade");

  session.travel(ALBANY_TO_SARATOGA);
  if (session.view().pendingRoadEncounter) session.resolveRoadEncounter("press_on");
  session.travel(SARATOGA_TO_QUEENSBURY);
  if (session.view().pendingRoadEncounter) session.resolveRoadEncounter("press_on");
  session.exploreArea("queensbury_town__civic_core");
  moveUiSessionToArea(session, "queensbury_town__market");
  session.startQuest("gallowmere");
  session.completeQuest("gallowmere", {
    endingId: "ending_victory",
    endingTitle: "The Gallowmere Broken",
    death: false,
  });
  session.chooseJourney("continue");

  session.travel(SARATOGA_TO_QUEENSBURY);
  if (session.view().pendingRoadEncounter) session.resolveRoadEncounter("press_on");
  session.travel(ALBANY_TO_SARATOGA);
  if (session.view().pendingRoadEncounter) session.resolveRoadEncounter("press_on");
  expect(session.view()).toMatchObject({
    current: { id: "albany_city" },
    currentArea: { id: "albany_city__transport_hub" },
  });
  return session;
}

function uiSessionAtAlbanyGoalPause(): OverworldSession {
  const session = new OverworldSession(WORLD);
  const opening = session.view();
  session.scoutPoi(opening.pois[0]!.id);
  const talked = session.talkToCharacter(opening.characters[0]!.id);
  expect(talked.discoveredQuests?.map((candidate) => candidate.id)).not.toContain("wolf_winter");
  if (session.journey().storyChoice?.kind === "registration") {
    session.chooseJourneyStory("albany:ledger_advocate");
  }
  expect(session.journey().storyChoice?.kind).toBe("relief_oath");
  revealCurrentJourneyStoryOptions(session, WORLD.opening_relief_oath!.id);
  session.chooseJourneyStory(LIMITED_RELIEF_OATH_ID);
  expect(session.journey().storyChoice?.kind).toBe("lead_source");
  session.chooseJourneyStory("albany:source_rowan_civic_docket");
  moveUiSessionToArea(session, "albany_city__transport_hub");
  expect(session.view().departureInteractions[0]?.kind).toBe("preparation");
  expect(session.view().quests.map((candidate) => candidate.id)).toContain("wolf_winter");
  session.chooseJourneyStory("albany:prep_works_fortification");
  session.chooseJourneyStory(RESIDENT_SHELTER_ALLOCATION_ID);
  const quest = session.view().quests.find((candidate) => candidate.id === "wolf_winter");
  if (!quest) throw new Error("expected the Albany Wolf-Winter lead");
  session.startQuest(quest.id, SHELTERED_APPROACH_ID);
  session.completeQuest(quest.id, {
    endingId: "ending_held",
    endingTitle: "The Byre Held",
    death: false,
  });
  return session;
}

function uiSessionAtAlbanyStoryChoice(): OverworldSession {
  const session = uiSessionAtAlbanyGoalPause();
  session.chooseJourney("continue");
  if (!session.journey().storyChoice) throw new Error("expected Albany's dawn dispatch");
  return session;
}

function continueFixedCheckpoint(session: OverworldSession): void {
  const pending = session.journey().pendingChoice;
  if (!pending) return;
  expect(pending.reasons).toContain("checkpoint");
  expect(pending.reasons).not.toContain("goal_completed");
  session.chooseJourney("continue");
}

function travelUiSessionToTown(session: OverworldSession, destinationTownId: string): void {
  const route = planOverworldRoute(WORLD, session.view().current.id, destinationTownId);
  if (!route) throw new Error(`expected a route to ${destinationTownId}`);
  for (const step of route.steps) {
    session.travel(step.edge.id);
    continueFixedCheckpoint(session);
    if (session.view().pendingRoadEncounter) {
      session.resolveRoadEncounter("press_on");
      continueFixedCheckpoint(session);
    }
  }
}

function uiSessionAtTannersAccountabilityChoice(): OverworldSession {
  const session = uiSessionAtPostGallowmereHayden();
  travelUiSessionToTown(session, "oneonta_city");
  session.exploreArea("oneonta_city__civic_core");
  continueFixedCheckpoint(session);
  moveUiSessionToArea(session, "oneonta_city__market");
  continueFixedCheckpoint(session);
  session.startQuest("tanners_fever");
  continueFixedCheckpoint(session);
  session.completeQuest("tanners_fever", {
    endingId: "ending_recovered",
    endingTitle: "The Meadowsweet",
    death: false,
  });
  expect(session.journey().pendingChoice?.reasons).toContain("goal_completed");
  session.chooseJourney("continue");
  expect(session.journey().storyChoice?.id).toBe(TANNERS_FEVER_ACCOUNTABILITY_ID);
  return session;
}

function mcpWolfWinterCheckpointInsideQuest() {
  const a = api();
  const started = a.start_overworld({ compact_context: false });
  const overworldSessionId = started.session_id;

  let view = started.observation;
  a.scout_overworld_session_poi({
    ...FULL_OVERWORLD,
    session_id: overworldSessionId,
    poi_id: view.pois[0]!.id,
  });
  view = a.get_overworld_session({
    session_id: overworldSessionId,
    include_observation: true,
  }).observation;
  const rowan = view.characters[0];
  if (!rowan) throw new Error("expected Albany registration contact");
  const registrationTalk = a.talk_overworld_session_contact({
    ...FULL_OVERWORLD,
    session_id: overworldSessionId,
    character_id: rowan.id,
  });
  expect(registrationTalk.journey.storyChoice?.kind).toBe("registration");
  expect(registrationTalk.result.discoveredQuests).toEqual([]);
  const registered = a.choose_overworld_session_story({
    ...FULL_OVERWORLD,
    session_id: overworldSessionId,
    choice: "albany:ledger_advocate",
  });
  expect(registered.journey.storyChoice?.kind).toBe("relief_oath");
  expect(registered.observation.quests.map((candidate) => candidate.id)).not.toContain(
    "wolf_winter",
  );
  const oathed = a.choose_overworld_session_story({
    ...FULL_OVERWORLD,
    session_id: overworldSessionId,
    choice: LIMITED_RELIEF_OATH_ID,
  });
  expect(oathed.journey.storyChoice?.kind).toBe("lead_source");
  const sourced = a.choose_overworld_session_story({
    ...FULL_OVERWORLD,
    session_id: overworldSessionId,
    choice: "albany:source_rowan_civic_docket",
  });
  expect(sourced.journey.storyChoice).toBeNull();
  expect(sourced.observation.quests.map((candidate) => candidate.id)).toContain("wolf_winter");
  const stationRoute = sourced.observation.areaExits.find(
    (route) => route.destination.id === "albany_city__transport_hub",
  );
  if (!stationRoute) throw new Error("expected route to the preparation board");
  const stationed = a.move_overworld_session_area({
    ...FULL_OVERWORLD,
    session_id: overworldSessionId,
    area_route_id: stationRoute.id,
  });
  expect(stationed.observation.departureInteractions[0]?.kind).toBe("preparation");
  a.choose_overworld_session_story({
    ...FULL_OVERWORLD,
    session_id: overworldSessionId,
    story_choice_id: PREPARATION_STORY_ID,
    choice: "albany:prep_works_fortification",
  });
  const allocationChosen = a.choose_overworld_session_story({
    ...FULL_OVERWORLD,
    session_id: overworldSessionId,
    story_choice_id: RELIEF_ALLOCATION_STORY_ID,
    choice: RESIDENT_SHELTER_ALLOCATION_ID,
  });
  view = allocationChosen.observation;

  const marketRoute = view.areaExits.find(
    (route) => route.destination.id === "albany_city__market",
  );
  if (!marketRoute) throw new Error("expected Albany market route");
  a.move_overworld_session_area({
    ...FULL_OVERWORLD,
    session_id: overworldSessionId,
    area_route_id: marketRoute.id,
  });
  view = a.get_overworld_session({
    session_id: overworldSessionId,
    include_observation: true,
  }).observation;

  const revealed = a.scout_overworld_session_poi({
    ...FULL_OVERWORLD,
    session_id: overworldSessionId,
    poi_id: view.pois[0]!.id,
  });
  const quest = allocationChosen.observation.quests.find(
    (candidate) => candidate.id === "wolf_winter",
  );
  if (!quest) throw new Error("expected Albany quest lead");
  const questRoute = revealed.observation.areaExits.find(
    (route) => route.destination.id === quest.area,
  );
  if (!questRoute) throw new Error("expected route to quest area");
  a.move_overworld_session_area({
    ...FULL_OVERWORLD,
    session_id: overworldSessionId,
    area_route_id: questRoute.id,
  });
  view = a.get_overworld_session({
    session_id: overworldSessionId,
    include_observation: true,
  }).observation;

  const questAreaPoi = view.pois[0];
  if (!questAreaPoi) throw new Error("expected quest-area point of interest");
  const questAreaScouted = a.scout_overworld_session_poi({
    ...FULL_OVERWORLD,
    session_id: overworldSessionId,
    poi_id: questAreaPoi.id,
  });
  let journey = questAreaScouted.journey;
  expect(journey.acceptedDecisions).toBe(12);
  const questAreaSite = questAreaScouted.observation.sites[0];
  if (!questAreaSite) throw new Error("expected a quest-area exploration site");
  journey = a.explore_overworld_session_site({
    ...FULL_OVERWORLD,
    session_id: overworldSessionId,
    site_id: questAreaSite.id,
  }).journey;
  expect(journey.acceptedDecisions).toBe(13);

  // Talk with Hayden and map the Station before leaving it. These are actual
  // local actions (rather than a repeated scout), and retain an even movement
  // count so the helper returns to the quest departure area. The authored
  // filing-standard event is intentionally post-Wolf and absent here.
  journey = a.talk_overworld_session_contact({
    ...FULL_OVERWORLD,
    session_id: overworldSessionId,
    character_id: HAYDEN_ID,
  }).journey;
  expect(journey.acceptedDecisions).toBe(14);
  journey = a.explore_overworld_session_area({
    ...FULL_OVERWORLD,
    session_id: overworldSessionId,
    area_id: quest.area,
  }).journey;
  expect(journey.acceptedDecisions).toBe(15);

  // Reach decision 37 through real local work and reversible movement,
  // so quest start and two accepted quest moves put the checkpoint inside the
  // RPG at decision 40 while ending back in the quest's area.
  while (journey.acceptedDecisions < 37) {
    const current = a.get_overworld_session({
      session_id: overworldSessionId,
      include_observation: true,
    }).observation;
    const route =
      current.currentArea?.id === quest.area
        ? current.areaExits[0]
        : current.areaExits.find((candidate) => candidate.destination.id === quest.area);
    if (!route) throw new Error("expected a reversible Albany area route");
    journey = a.move_overworld_session_area({
      ...FULL_OVERWORLD,
      session_id: overworldSessionId,
      area_route_id: route.id,
    }).journey;
  }
  const finalArea = a.get_overworld_session({
    session_id: overworldSessionId,
    include_observation: true,
  }).observation;
  if (finalArea.currentArea?.id !== quest.area) {
    const route = finalArea.areaExits.find((candidate) => candidate.destination.id === quest.area);
    if (!route) throw new Error("expected a final route back to the Albany quest area");
    a.move_overworld_session_area({
      ...FULL_OVERWORLD,
      session_id: overworldSessionId,
      area_route_id: route.id,
    });
  }
  expect(
    a.get_overworld_session({ session_id: overworldSessionId, include_observation: true })
      .observation.currentArea?.id,
  ).toBe(quest.area);

  const launched = a.start_overworld_session_quest({
    ...FULL_OVERWORLD,
    compact_observation: false,
    session_id: overworldSessionId,
    quest_id: quest.id,
    approach_id: SHELTERED_APPROACH_ID,
  });
  expect(launched.journey).toMatchObject({
    status: "active",
    acceptedDecisions: 38,
    nextCheckpoint: 40,
    pendingChoice: null,
  });

  const enteredYard = a.step_action({
    session_id: launched.rpg_session_id,
    action_id: "use_sheltered_stockway_last_mile",
    expected_state_hash: launched.rpg_session.state_hash,
    compact_observation: false,
    compact_events: false,
  });
  if (enteredYard.ok !== true) throw new Error("expected the first quest move to succeed");
  expect(enteredYard).toMatchObject({
    ok: true,
    journey: { status: "active", acceptedDecisions: 39 },
    observation: { room: "byre_yard" },
  });
  const staleActionIds = enteredYard.observation.available_actions.map((action) => action.id);
  expect(staleActionIds).toEqual(
    expect.arrayContaining(["go_north", "go_west", "read_day_book", "talk_houndsman"]),
  );

  const unsafeAtThreshold = a.step_action({
    session_id: launched.rpg_session_id,
    action_id: "go_north",
    expected_state_hash: enteredYard.state_hash,
    compact_observation: false,
    compact_events: false,
  });
  if (unsafeAtThreshold.ok !== true) {
    throw new Error("expected the threshold-crossing quest move to succeed");
  }
  expect(unsafeAtThreshold).toMatchObject({
    ok: true,
    journey: {
      status: "active",
      acceptedDecisions: 40,
      nextCheckpoint: 40,
      pendingChoice: null,
      decisionProof: {
        last: { number: 40, surface: "quest", actionId: "go_north", reason: "movement" },
      },
    },
    observation: { room: "paling_gap" },
  });
  expect(unsafeAtThreshold.observation.available_actions.map((action) => action.id)).toContain(
    "maneuver_yearling_wolf_set_spear",
  );

  // Decision 40 enters a live fight, so it is not a safe checkpoint boundary.
  // Both returned combat beats remain playable; the overdue fixed checkpoint
  // materializes only when the second beat defeats the yearling.
  const setSpear = a.step_action({
    session_id: launched.rpg_session_id,
    action_id: "maneuver_yearling_wolf_set_spear",
    expected_state_hash: unsafeAtThreshold.state_hash,
    compact_observation: false,
    compact_events: false,
  });
  if (setSpear.ok !== true) throw new Error("expected the set-spear combat beat to succeed");
  expect(setSpear).toMatchObject({
    journey: {
      status: "active",
      acceptedDecisions: 41,
      nextCheckpoint: 40,
      pendingChoice: null,
    },
    observation: { room: "paling_gap" },
  });
  expect(setSpear.observation.available_actions.map((action) => action.id)).toContain(
    "maneuver_yearling_wolf_drive_set_spear_unarmored",
  );

  const checkpoint = a.step_action({
    session_id: launched.rpg_session_id,
    action_id: "maneuver_yearling_wolf_drive_set_spear_unarmored",
    expected_state_hash: setSpear.state_hash,
    compact_observation: false,
    compact_events: false,
  });
  if (checkpoint.ok !== true) throw new Error("expected the drive-spear combat beat to succeed");
  const checkpointJourney = checkpoint.journey;
  if (!checkpointJourney) throw new Error("expected the embedded parent journey");
  expect(checkpoint).toMatchObject({
    ok: true,
    journey: {
      status: "awaiting_choice",
      nextCheckpoint: 40,
    },
    observation: { room: "paling_gap", available_actions: [] },
  });
  expect(checkpointJourney.acceptedDecisions).toBeGreaterThan(40);
  expect(checkpointJourney.pendingChoice).toMatchObject({
    atDecision: checkpointJourney.acceptedDecisions,
    checkpoint: 40,
    reasons: ["checkpoint"],
  });
  expect(checkpointJourney.decisionProof.last).toMatchObject({
    number: checkpointJourney.acceptedDecisions,
    surface: "quest",
  });
  expect(checkpointJourney.pendingChoice?.options.map((option) => option.id)).toEqual([
    "continue",
    "end",
  ]);
  expect(checkpoint.overworld_snapshot_hash).not.toBe(launched.snapshot_hash);
  expect(a.sessions.get(launched.rpg_session_id).state.current).toBe("paling_gap");
  const fullRpgStateHash = a.sessions.get(launched.rpg_session_id).stateHash;

  return {
    a,
    overworldSessionId,
    rpgSessionId: launched.rpg_session_id,
    checkpoint,
    checkpointJourney,
    fullRpgStateHash,
    staleActionIds,
  };
}

describe("MCP journey surface", () => {
  it("keeps the completed Wolf dispatch preview identical in full and compact MCP until Continue", () => {
    const source = uiSessionAtAlbanyGoalPause();
    const snapshot = source.snapshot();
    const a = api();
    const full = a.restore_overworld_session({ ...FULL_OVERWORLD, snapshot });
    const compact = a.restore_overworld_session({
      snapshot,
      compact_context: true,
      compact_result: true,
    });
    const fullPreview = full.journey.pendingChoice?.continuationPreview;
    if (!fullPreview) throw new Error("Expected a completed Wolf dawn dispatch preview.");

    expect(full.journey.pendingChoice?.options.map((option) => option.id)).toEqual([
      "continue",
      "end",
    ]);
    expect(fullPreview.options).toHaveLength(2);
    expect(compact.journey.pendingChoice?.continuationPreview).toEqual(fullPreview);
    expect(compact.journey.pendingChoice?.options).toEqual(full.journey.pendingChoice?.options);

    for (const [restored, responseOptions] of [
      [full, FULL_OVERWORLD],
      [compact, { compact_context: true, compact_result: true }],
    ] as const) {
      const beforeHash = restored.snapshot_hash;
      const beforeDecisions = restored.journey.acceptedDecisions;
      expect(() =>
        a.choose_overworld_session_story({
          ...responseOptions,
          session_id: restored.session_id,
          story_choice_id: fullPreview.id,
          choice: fullPreview.options[0].id,
        }),
      ).toThrow(/choose whether to continue or end/i);

      const after = a.get_overworld_session({
        ...responseOptions,
        session_id: restored.session_id,
        include_observation: true,
      });
      expect(after.snapshot_hash).toBe(beforeHash);
      expect(after.journey.acceptedDecisions).toBe(beforeDecisions);
      expect(after.journey.pendingChoice?.continuationPreview).toEqual(fullPreview);
    }
  });

  it("keeps the human contact line in the default compact action result", () => {
    const a = api();
    const compactStart = a.start_overworld();
    const fullStart = a.start_overworld({ compact_context: false });
    const compactContact = compactStart.context.contacts[0];
    const fullContact = fullStart.observation.characters.find(
      (candidate) => candidate.id === compactContact?.[0],
    );
    if (!compactContact || !fullContact) throw new Error("expected the Albany contact");

    const compact = a.talk_overworld_session_contact({
      session_id: compactStart.session_id,
      character_id: compactContact[0],
    });
    const full = a.talk_overworld_session_contact({
      ...FULL_OVERWORLD,
      session_id: fullStart.session_id,
      character_id: fullContact.id,
    });

    expect(compact.result.text).toBe(full.result.entry.text);
    expect(compact.result.text).toContain("Rowan Quill");
    expect(compact.result.text).toContain("registration, emergency authority, public records");
    expect("observation" in compact).toBe(false);
    expect(JSON.stringify(compact.result)).not.toContain(full.result.entry.id);
  });

  it("shares only Hayden's active post-Gallowmere copy across UI, full MCP, and compact MCP", () => {
    const source = uiSessionAtPostGallowmereHayden();
    const snapshot = source.snapshot();
    const sourceHash = source.snapshotHash();
    const ui = OverworldSession.restore(WORLD, snapshot);
    const uiCard = ui.view().characters.find((character) => character.id === HAYDEN_ID);
    if (!uiCard) throw new Error("expected Hayden's UI contact card");

    const a = api();
    const full = a.restore_overworld_session({
      ...FULL_OVERWORLD,
      snapshot,
    });
    const compact = a.restore_overworld_session({
      snapshot,
      compact_context: true,
      compact_result: true,
    });
    expect(compact.snapshot_hash).toBe(full.snapshot_hash);
    expect(sourceHash.startsWith(full.snapshot_hash)).toBe(true);

    const fullCard = full.observation.characters.find((character) => character.id === HAYDEN_ID);
    const compactCard = compact.context.contacts.find(([characterId]) => characterId === HAYDEN_ID);
    expect(fullCard).toEqual(uiCard);
    expect(compactCard).toEqual([HAYDEN_ID, "Hayden Hale"]);
    expect(uiCard).not.toHaveProperty("variants");

    const observationPayload = JSON.stringify({
      ui: ui.view(),
      full: full.observation,
      compact: compact.context,
    });
    expect(observationPayload).not.toMatch(
      /"variants"|"after_quests"|wolf_winter_closed|wolf_winter_and_gallowmere_closed/i,
    );
    expect(observationPayload).not.toMatch(
      /controlling source certification|settled packets|return board|other live report in that chain/i,
    );

    const uiTalk = ui.talkToCharacter(HAYDEN_ID);
    const fullTalk = a.talk_overworld_session_contact({
      ...FULL_OVERWORLD,
      session_id: full.session_id,
      character_id: HAYDEN_ID,
    });
    const compactTalk = a.talk_overworld_session_contact({
      session_id: compact.session_id,
      character_id: HAYDEN_ID,
      compact_context: true,
      compact_result: true,
    });
    expect(fullTalk.result.entry.text).toBe(uiTalk.entry.text);
    expect(compactTalk.result.text).toBe(uiTalk.entry.text);
    expect(uiTalk.entry.text).toBe(`${uiCard.summary} ${uiCard.agenda}`);
    expect(uiTalk.entry.text).toMatch(/Wolf-Winter/i);
    expect(uiTalk.entry.text).toMatch(/Hedrick|Gallowmere/i);
    expect(uiTalk.entry.text).toMatch(/current journey goal|journey ledger/i);
    expect(uiTalk.entry.text).not.toMatch(/controlling source certification|settled packets/i);
    expect(fullTalk.journey).toEqual(ui.journey());
    expect(compactTalk.journey).toEqual(ui.journey());
    expect(compactTalk.snapshot_hash).toBe(fullTalk.snapshot_hash);
    expect(ui.snapshotHash().startsWith(fullTalk.snapshot_hash)).toBe(true);
  });

  it("keeps the canonical journey at the response root across compact and full play", () => {
    const a = api();
    const compact = a.start_overworld();
    const full = a.start_overworld({ compact_context: false });

    expect(compact.journey).toMatchObject({
      contractVersion: JOURNEY_CONTRACT_VERSION,
      status: "active",
      goal: { ...INITIAL_JOURNEY_GOAL, status: "active", completedAtDecision: null },
      acceptedDecisions: 0,
      baselineDecisions: 40,
      nextCheckpoint: 40,
      goalGuidance: INITIAL_JOURNEY_GOAL_GUIDANCE,
      pendingChoice: null,
    });
    expect(full.journey).toEqual(compact.journey);

    const reread = a.get_overworld_session_context({ session_id: compact.session_id });
    expect(reread.journey).toEqual(compact.journey);
    const unchanged = a.get_overworld_session_context({
      session_id: compact.session_id,
      if_snapshot_hash: compact.snapshot_hash,
    });
    expect(unchanged).toMatchObject({ unchanged: true, journey: compact.journey });

    const poi = full.observation.pois[0]!;
    const acted = a.scout_overworld_session_poi({
      ...FULL_OVERWORLD,
      session_id: full.session_id,
      poi_id: poi.id,
    });
    expect(acted.journeyDecision).toEqual({
      countsTowardJourney: true,
      reason: "stateful_clue",
    });
    const compactObservation = a.get_overworld_session({
      session_id: compact.session_id,
      include_observation: true,
    }).observation;
    const compactActed = a.scout_overworld_session_poi({
      session_id: compact.session_id,
      poi_id: compactObservation.pois[0]!.id,
      compact_context: true,
      compact_result: true,
    });
    expect(compactActed.journeyDecision).toEqual(acted.journeyDecision);
    expect(compactActed.journey.acceptedDecisions).toBe(1);
    expect(compactActed.journey.decisionProof).toEqual(acted.journey.decisionProof);
    expect(acted.journey.acceptedDecisions).toBe(1);
    expect(acted.snapshot_hash).not.toBe(full.snapshot_hash);
    expect(acted.journey).toEqual(
      a.get_overworld_session({
        session_id: full.session_id,
        include_observation: true,
      }).journey,
    );
  });

  it("shares the exact Wolf-Winter continuation card across full and compact MCP", () => {
    const source = uiSessionAtAlbanyGoalPause();
    const expectedOptions = [
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
    ] as const;
    const sourceJourney = source.journey();
    expect(sourceJourney).toMatchObject({
      status: "awaiting_choice",
      nextCheckpoint: 40,
      pendingChoice: {
        atDecision: sourceJourney.acceptedDecisions,
        checkpoint: null,
        reasons: ["goal_completed"],
        options: expectedOptions,
      },
    });

    const a = api();
    const full = a.restore_overworld_session({
      snapshot: source.snapshot(),
      ...FULL_OVERWORLD,
    });
    const compact = a.restore_overworld_session({
      snapshot: source.snapshot(),
      compact_context: true,
      compact_result: true,
    });

    expect(full.journey.pendingChoice?.options).toEqual(expectedOptions);
    expect(compact.journey.pendingChoice?.options).toEqual(expectedOptions);
  });

  it("projects setup cards on compact restore, read, unchanged, rejection, and action responses", () => {
    const source = new OverworldSession(WORLD);
    const registrationContact = WORLD.opening_registration?.contact;
    if (!registrationContact) throw new Error("expected Albany registration contact");
    const poi = source.view().pois[0];
    if (!poi) throw new Error("expected Albany Civic POI");
    source.scoutPoi(poi.id);
    source.talkToCharacter(registrationContact);
    const authoredJourney = source.journey();
    const compactJourney = compactJourneyPresentation(authoredJourney);
    expect(compactJourney).not.toEqual(authoredJourney);

    const a = api();
    const compactRestore = a.restore_overworld_session({
      snapshot: source.snapshot(),
      compact_context: true,
      compact_result: true,
    });
    const fullRestore = a.restore_overworld_session({
      snapshot: source.snapshot(),
      ...FULL_OVERWORLD,
    });
    expect(compactRestore.journey).toEqual(compactJourney);
    expect(fullRestore.journey).toEqual(authoredJourney);

    expect(
      a.get_overworld_session_context({ session_id: compactRestore.session_id }).journey,
    ).toEqual(compactJourney);
    expect(
      a.get_overworld_session({
        session_id: compactRestore.session_id,
        include_observation: true,
      }).journey,
    ).toEqual(authoredJourney);

    const compactUnchanged = a.get_overworld_session_context({
      session_id: compactRestore.session_id,
      if_snapshot_hash: compactRestore.snapshot_hash,
    });
    expect(compactUnchanged).toMatchObject({ unchanged: true, journey: compactJourney });
    const fullUnchanged = a.get_overworld_session({
      session_id: compactRestore.session_id,
      include_observation: true,
      if_snapshot_hash: compactRestore.snapshot_hash,
    });
    expect(fullUnchanged).toMatchObject({ unchanged: true, journey: authoredJourney });

    const compactRejected = a.choose_overworld_session_story({
      session_id: compactRestore.session_id,
      choice: "albany:ledger_advocate",
      expected_snapshot_hash: "stale",
      compact_context: true,
      compact_result: true,
    });
    expect(compactRejected).toMatchObject({ ok: false, journey: compactJourney });
    const fullRejected = a.choose_overworld_session_story({
      session_id: fullRestore.session_id,
      choice: "albany:ledger_advocate",
      expected_snapshot_hash: "stale",
      ...FULL_OVERWORLD,
    });
    expect(fullRejected).toMatchObject({ ok: false, journey: authoredJourney });

    const compactAction = a.choose_overworld_session_story({
      session_id: compactRestore.session_id,
      choice: "albany:ledger_advocate",
      compact_context: true,
      compact_result: true,
    });
    const fullAction = a.choose_overworld_session_story({
      session_id: fullRestore.session_id,
      choice: "albany:ledger_advocate",
      ...FULL_OVERWORLD,
    });
    expect(compactAction.ok).toBe(true);
    expect(fullAction.ok).toBe(true);
    if (compactAction.ok !== true || fullAction.ok !== true) {
      throw new Error("expected accepted story choices");
    }
    const ledgerProfile = WORLD.opening_registration?.profiles.find(
      (profile) => profile.id === "albany:ledger_advocate",
    );
    if (!ledgerProfile) throw new Error("expected the Ledger Advocate profile");
    const ledgerJournalText = `${ledgerProfile.summary} ${ledgerProfile.preview} ${ledgerProfile.consequence}`;
    expect(fullAction.result.entry.text).toBe(ledgerJournalText);
    expect(fullAction.result.consequence).toBe(
      `${ledgerProfile.preview} Best for: ${ledgerProfile.trigger_category} ${ledgerProfile.consequence}`,
    );
    expect(compactAction.result).toMatchObject({
      storyChoiceId: fullAction.result.storyChoiceId,
      choiceId: fullAction.result.choiceId,
      consequence: fullAction.result.consequence,
      goal: fullAction.result.goal,
      entry: [
        fullAction.result.entry.kind,
        fullAction.result.entry.title,
        fullAction.result.entry.recordedAt,
      ],
      entry_text: ledgerJournalText,
      journeyDecision: fullAction.result.journeyDecision,
    });
    const compactResultJson = JSON.stringify(compactAction.result);
    expect(compactResultJson.match(/"consequence":/gu)).toHaveLength(1);
    expect(compactAction.snapshot_hash).toBe(fullAction.snapshot_hash);
    expect(compactAction.journey).toEqual(compactJourneyPresentation(fullAction.journey));
    expect(compactAction.journey).not.toEqual(fullAction.journey);
  });

  it("preserves Albany setup semantics while de-duplicating only compact story cards", () => {
    const a = api();
    const compact = a.start_overworld();
    const full = a.start_overworld({ compact_context: false });
    const registrationContact = WORLD.opening_registration?.contact;
    if (!registrationContact) throw new Error("expected Albany registration contact");

    const responseOptions = (compactResult: boolean) =>
      compactResult ? { compact_context: true, compact_result: true } : FULL_OVERWORLD;
    const expectStoryChoiceParity = (
      compactJourney: typeof compact.journey | typeof full.journey,
      fullJourney: typeof compact.journey | typeof full.journey,
      kind: string,
    ) => {
      if (!fullJourney.storyChoice) throw new Error(`expected full ${kind} story choice`);
      const fullStoryChoice = fullJourney.storyChoice as JourneyStoryChoicePrompt;
      expect(compactJourney.storyChoice).toEqual(compactJourneyStoryChoicePrompt(fullStoryChoice));
      expect(compactJourney.storyChoice).not.toEqual(fullStoryChoice);
      expect(compactJourney.storyChoice).toMatchObject({ kind });
      expect(compactJourney.storyChoice?.message).toBe(
        `${fullStoryChoice.message} ${JOURNEY_STORY_CHOICE_REVIEW_INSTRUCTION}`,
      );
      for (const compactOption of compactJourney.storyChoice!.options) {
        const fullOption = fullStoryChoice.options.find((option) => option.id === compactOption.id);
        if (!fullOption?.summary) throw new Error(`expected summary for ${compactOption.id}`);
        expect(compactOption).toMatchObject({
          id: fullOption.id,
          label: fullOption.label,
          summary: fullOption.summary,
        });
        expect(compactOption.consequence).toBe("");
        if (kind === "registration") {
          expect(Object.keys(fullOption.summary).sort()).toEqual([
            "commitment",
            "highlights",
            "immediateCost",
            "tradeoff",
          ]);
          expect(fullOption.summary).toMatchObject({
            commitment: expect.stringMatching(/^Permanent background — /u),
            highlights: [expect.objectContaining({ label: "Starts with" })],
            immediateCost: expect.stringMatching(/^no fee or delay; start with \$\d+$/u),
          });
          expect(JSON.stringify(fullOption.summary)).not.toMatch(
            /\b(?:DEF|DC|import|fieldTrigger)\b/i,
          );
        } else {
          expect(Object.keys(fullOption.summary).sort()).toEqual([
            "commitment",
            "immediateCost",
            "tradeoff",
          ]);
          expect(fullOption.consequence).toMatch(/^Benefit: .+ Cost: .+\. Tradeoff: .+$/);
          expect(fullOption.consequence).toContain(`Cost: ${fullOption.summary.immediateCost}.`);
          const isReadyMadeDispatch =
            WORLD.opening_registration?.doctrines?.some(
              (doctrine) => doctrine.id === fullOption.id,
            ) === true;
          expect(fullOption.consequence).toContain(
            `Tradeoff: ${isReadyMadeDispatch ? "Other duty/evidence pairs close." : fullOption.summary.tradeoff}`,
          );
          expect(openingSelectionReceiptWordCount(fullOption.consequence)).toBeLessThanOrEqual(
            OPENING_SELECTION_RECEIPT_WORD_LIMIT,
          );
        }
        expect(JSON.stringify(compactJourney.storyChoice)).not.toContain(fullOption.consequence);
      }
      expect(JSON.stringify(compactJourney.storyChoice)).not.toContain(
        JOURNEY_STORY_CHOICE_STAGED_CONSEQUENCE,
      );
    };
    const reachRegistration = (sessionId: string, compactResult: boolean) => {
      const observation = a.get_overworld_session({
        session_id: sessionId,
        include_observation: true,
      }).observation;
      const poi = observation.pois[0];
      if (!poi) throw new Error("expected Albany Civic POI");
      a.scout_overworld_session_poi({
        ...responseOptions(compactResult),
        session_id: sessionId,
        poi_id: poi.id,
      });
      return a.talk_overworld_session_contact({
        ...responseOptions(compactResult),
        session_id: sessionId,
        character_id: registrationContact,
      });
    };
    const choose = (sessionId: string, choice: string, compactResult: boolean) =>
      a.choose_overworld_session_story({
        ...responseOptions(compactResult),
        session_id: sessionId,
        choice,
      });
    const moveToAllocation = (sessionId: string, compactResult: boolean) => {
      const observation = a.get_overworld_session({
        session_id: sessionId,
        include_observation: true,
      }).observation;
      const route = observation.areaExits.find(
        (candidate) => candidate.destination.id === "albany_city__transport_hub",
      );
      if (!route) throw new Error("expected a route to Albany's relief allocation board");
      return a.move_overworld_session_area({
        ...responseOptions(compactResult),
        session_id: sessionId,
        area_route_id: route.id,
      });
    };

    const compactRegistration = reachRegistration(compact.session_id, true);
    const fullRegistration = reachRegistration(full.session_id, false);
    expectStoryChoiceParity(compactRegistration.journey, fullRegistration.journey, "registration");
    expect("observation" in compactRegistration).toBe(false);

    const compactOath = choose(compact.session_id, "albany:ledger_advocate", true);
    const fullOath = choose(full.session_id, "albany:ledger_advocate", false);
    expectStoryChoiceParity(compactOath.journey, fullOath.journey, "relief_oath");

    const compactLead = choose(compact.session_id, LIMITED_RELIEF_OATH_ID, true);
    const fullLead = choose(full.session_id, LIMITED_RELIEF_OATH_ID, false);
    expectStoryChoiceParity(compactLead.journey, fullLead.journey, "lead_source");

    choose(compact.session_id, "albany:source_rowan_civic_docket", true);
    choose(full.session_id, "albany:source_rowan_civic_docket", false);
    const compactPreparation = moveToAllocation(compact.session_id, true);
    const fullPreparation = moveToAllocation(full.session_id, false);
    expect(compactPreparation.journey.storyChoice).toBeNull();
    expect(fullPreparation.journey.storyChoice).toBeNull();
    const compactPreparationStory = a.inspect_overworld_session_story({
      session_id: compact.session_id,
      story_choice_id: PREPARATION_STORY_ID,
      compact_context: true,
      compact_result: true,
    }).story;
    const fullPreparationStory = a.inspect_overworld_session_story({
      session_id: full.session_id,
      story_choice_id: PREPARATION_STORY_ID,
      ...FULL_OVERWORLD,
    }).story;
    const compactContextFullStory = a.inspect_overworld_session_story({
      session_id: compact.session_id,
      story_choice_id: PREPARATION_STORY_ID,
      compact_context: true,
      compact_result: false,
    }).story;
    const fullContextCompactStory = a.inspect_overworld_session_story({
      session_id: full.session_id,
      story_choice_id: PREPARATION_STORY_ID,
      compact_context: false,
      compact_result: true,
    }).story;
    expect(compactPreparationStory).toEqual(
      compactJourneyStoryChoiceComparison(fullPreparationStory),
    );
    expect(compactPreparationStory).not.toEqual(fullPreparationStory);
    expect(compactContextFullStory).toEqual(fullPreparationStory);
    expect(fullContextCompactStory).toEqual(compactPreparationStory);
    expect(compactPreparationStory).toMatchObject({
      comparisonVersion: JOURNEY_STORY_CHOICE_COMPARISON_VERSION,
      kind: "preparation",
      inspectedOption: null,
    });
    expect(
      compactPreparationStory.options.every(
        (option) =>
          JSON.stringify(Object.keys(option.summary ?? {}).sort()) ===
          JSON.stringify(["commitment", "highlights", "immediateCost", "tradeoff"]),
      ),
    ).toBe(true);
    expect(
      fullPreparationStory.options.every(
        (option) =>
          JSON.stringify(Object.keys(option.summary ?? {}).sort()) ===
          JSON.stringify(["checkFit", "commitment", "immediateCost", "tradeoff"]),
      ),
    ).toBe(true);
    expect(compactPreparationStory.options.map((option) => option.summary?.highlights)).toEqual(
      fullPreparationStory.options.map((option) => [
        { label: "Check skill", value: option.summary?.checkFit },
      ]),
    );
    expect(
      fullPreparationStory.options.every((option) => option.summary?.highlights === undefined),
    ).toBe(true);

    a.choose_overworld_session_story({
      session_id: compact.session_id,
      story_choice_id: PREPARATION_STORY_ID,
      choice: "albany:prep_works_fortification",
      compact_context: true,
      compact_result: true,
    });
    a.choose_overworld_session_story({
      session_id: full.session_id,
      story_choice_id: PREPARATION_STORY_ID,
      choice: "albany:prep_works_fortification",
      ...FULL_OVERWORLD,
    });
    const compactAllocation = a.inspect_overworld_session_story({
      session_id: compact.session_id,
      story_choice_id: RELIEF_ALLOCATION_STORY_ID,
      compact_context: true,
      compact_result: true,
    }).story;
    const fullAllocation = a.inspect_overworld_session_story({
      session_id: full.session_id,
      story_choice_id: RELIEF_ALLOCATION_STORY_ID,
      ...FULL_OVERWORLD,
    }).story;
    expect(compactAllocation).toEqual(compactJourneyStoryChoiceComparison(fullAllocation));
    expect(compactAllocation).not.toEqual(fullAllocation);
    expect(compactAllocation).toMatchObject({
      comparisonVersion: JOURNEY_STORY_CHOICE_COMPARISON_VERSION,
      kind: "relief_allocation",
      inspectedOption: null,
    });
  });

  it("keeps the authenticated Albany recall beside preparation, allocation, and ally MCP choices", () => {
    const a = api();
    const source = new OverworldSession(WORLD);
    source.scoutPoi("albany_city__civic_core__poi");
    source.talkToCharacter("albany_city__civic_core__contact");
    source.chooseJourneyStory("albany:ledger_advocate");
    revealCurrentJourneyStoryOptions(source, WORLD.opening_relief_oath!.id);
    source.chooseJourneyStory(LIMITED_RELIEF_OATH_ID);
    source.chooseJourneyStory("albany:source_rowan_civic_docket");
    moveUiSessionToArea(source, "albany_city__transport_hub");

    const assertMcpRecall = (storyChoiceId: string, kind: string): void => {
      const expectedFull = source.view().departureRecap;
      const expectedCompact = source.compactView();
      const expectedBoard = expectedCompact.station_dispatch_board;
      const expectedRecap = expectedCompact.departure_recap;
      if (!expectedFull || (!expectedBoard && !expectedRecap)) {
        throw new Error(`expected authenticated recap before ${kind}`);
      }
      const expectCompactRecall = (payload: Record<string, unknown>): void => {
        if (expectedBoard) {
          expect(payload.station_dispatch_board).toEqual(expectedBoard);
          expect(payload).not.toHaveProperty("departure_recap");
        } else {
          expect(payload.departure_recap).toEqual(expectedRecap);
          expect(payload).not.toHaveProperty("station_dispatch_board");
        }
      };
      const expectInspectionRecall = (
        payload: Record<string, unknown>,
        exactTerms = false,
      ): void => {
        expect(payload).not.toHaveProperty("station_dispatch_board");
        if (expectedBoard || exactTerms) {
          expect(payload).not.toHaveProperty("departure_recap");
        } else {
          expect(payload.departure_recap).toEqual(expectedRecap);
        }
      };
      const snapshot = source.snapshot();
      const full = a.restore_overworld_session({ ...FULL_OVERWORLD, snapshot });
      const compact = a.restore_overworld_session({ compact_context: true, snapshot });
      expect(full.observation.departureRecap).toEqual(expectedFull);
      expectCompactRecall(compact.context);
      expect(compact.context).not.toHaveProperty("departure_recap_terms");
      expect(full.snapshot_hash).toBe(compact.snapshot_hash);
      if (expectedBoard) {
        const sourceBoard = source.view().stationDispatchBoard;
        if (!sourceBoard) throw new Error("expected full Station dispatch board");
        const compactBoard = compact.context.station_dispatch_board;
        if (!compactBoard) throw new Error("expected compact Station dispatch board");
        expect(compactBoard[0]).toBe(6);
        expect(compactBoard[3]?.[3]).toBe(
          sourceBoard.support.filter((entry) => entry.status === "open_optional").length,
        );
        expect(compactBoard[4].every((row) => row[3] === null && row[4] === null)).toBe(true);
        expect(compactBoard[4].map(([slot]) => slot)).not.toEqual(
          expect.arrayContaining(
            sourceBoard.support
              .filter((entry) => entry.status === "open_optional")
              .map((entry) => entry.slot),
          ),
        );
        const openSupportKey = sourceBoard.support
          .filter((entry) => entry.status === "open_optional")
          .map((entry) => entry.slot)
          .join("|");
        const expectedOverviewByOpenSupport: Readonly<Record<string, string>> = {
          "preparation|relief_allocation|field_team":
            "Optional: a field kit using Repair, Streetwise, or Mediation; plus Albany's last relief wagon or June as a cattle-safety rider. Review only what interests you.",
          "relief_allocation|field_team":
            "Optional: Albany's last relief wagon or June as a cattle-safety rider. Review only what interests you.",
          field_team: "Optional: June as a cattle-safety rider. Review only what interests you.",
        };
        expect(compactBoard[5]).toEqual([
          STATION_DISPATCH_SUPPORT_REVEAL_ID,
          expectedOverviewByOpenSupport[openSupportKey],
        ]);
        // An explicitly requested verbose observation remains the complete data
        // surface; progressive disclosure applies to compact/pure presentation.
        expect(full.observation.stationDispatchBoard).toEqual(sourceBoard);
        expect(full.observation.stationDispatchBoard?.support).toEqual(sourceBoard.support);
        expect(compact.context).not.toHaveProperty("station_dispatch_support");
        const supportReview = a.get_overworld_session_context({
          session_id: compact.session_id,
          if_snapshot_hash: compact.snapshot_hash,
          include_station_dispatch_support: true,
        });
        expect(supportReview).not.toHaveProperty("unchanged");
        if (!("context" in supportReview)) {
          throw new Error(`expected explicit Station support before ${kind}`);
        }
        expectCompactRecall(supportReview.context);
        expect(supportReview.context.station_dispatch_support).toEqual(
          compactStationDispatchBoardSupport(sourceBoard),
        );
        expect(supportReview.legend_delta).toHaveProperty("station_dispatch_support");
        expect(supportReview.snapshot_hash).toBe(compact.snapshot_hash);
        const afterLegacyReview = a.export_overworld_session({
          session_id: compact.session_id,
        });
        expect(afterLegacyReview.ok).toBe(true);
        if (!afterLegacyReview.ok) throw new Error(`expected export after ${kind} support review`);
        expect(afterLegacyReview.snapshot).toEqual(snapshot);
        expect(afterLegacyReview.snapshot_hash).toBe(compact.snapshot_hash);

        const revealProbe = a.restore_overworld_session({ compact_context: true, snapshot });
        const beforeReveal = a.export_overworld_session({ session_id: revealProbe.session_id });
        if (!beforeReveal.ok) throw new Error(`expected export before ${kind} Station reveal`);
        const revealed = a.get_overworld_session_context({
          session_id: revealProbe.session_id,
          if_snapshot_hash: revealProbe.snapshot_hash,
          reveal_station_dispatch_support: STATION_DISPATCH_SUPPORT_REVEAL_ID,
        });
        expect(revealed).not.toHaveProperty("unchanged");
        if (!("context" in revealed)) {
          throw new Error(`expected revealed Station support before ${kind}`);
        }
        const revealedBoard = revealed.context.station_dispatch_board;
        if (!revealedBoard) throw new Error("expected revealed compact Station board");
        expect(revealed.snapshot_hash).not.toBe(revealProbe.snapshot_hash);
        expect(revealed.journey).toEqual(revealProbe.journey);
        expect(revealedBoard[3]?.[3]).toBe(compactBoard[3]?.[3]);
        expect(revealedBoard[4]).toHaveLength(sourceBoard.plan.length);
        expect(revealedBoard[5]).toBeNull();
        expect(revealedBoard[4]).toEqual(compactStationDispatchBoard(sourceBoard, true)[4]);
        const afterReveal = a.export_overworld_session({ session_id: revealProbe.session_id });
        if (!afterReveal.ok) throw new Error(`expected export after ${kind} Station reveal`);
        expect(afterReveal.snapshot.stationDispatchSupportReveals).toEqual([
          [sourceBoard.questId, STATION_DISPATCH_SUPPORT_REVEAL_ID],
        ]);
        const { stationDispatchSupportReveals: _revealedReceipt, ...revealedGameplaySnapshot } =
          afterReveal.snapshot;
        expect(revealedGameplaySnapshot).toEqual(beforeReveal.snapshot);

        const repeatedReveal = a.get_overworld_session_context({
          session_id: revealProbe.session_id,
          if_snapshot_hash: revealed.snapshot_hash,
          reveal_station_dispatch_support: STATION_DISPATCH_SUPPORT_REVEAL_ID,
        });
        expect(repeatedReveal).not.toHaveProperty("unchanged");
        if (!("context" in repeatedReveal)) {
          throw new Error(`expected repeated Station support before ${kind}`);
        }
        expect(repeatedReveal.snapshot_hash).toBe(revealed.snapshot_hash);
        expect(repeatedReveal.context.station_dispatch_board).toEqual(revealedBoard);
        expect(a.export_overworld_session({ session_id: revealProbe.session_id })).toEqual(
          afterReveal,
        );

        const refreshedReveal = a.get_overworld_session_context({
          session_id: revealProbe.session_id,
        });
        if (!("context" in refreshedReveal)) {
          throw new Error(`expected refreshed Station support before ${kind}`);
        }
        expect(refreshedReveal.snapshot_hash).toBe(revealed.snapshot_hash);
        expect(refreshedReveal.context.station_dispatch_board).toEqual(revealedBoard);
        const restoredReveal = a.restore_overworld_session({
          compact_context: true,
          snapshot: afterReveal.snapshot,
        });
        expect(restoredReveal.snapshot_hash).toBe(revealed.snapshot_hash);
        expect(restoredReveal.context.station_dispatch_board).toEqual(revealedBoard);

        const forgedProbe = a.restore_overworld_session({ compact_context: true, snapshot });
        const beforeForgery = a.export_overworld_session({ session_id: forgedProbe.session_id });
        expect(() =>
          a.get_overworld_session_context({
            session_id: forgedProbe.session_id,
            reveal_station_dispatch_support: "forged:station-support",
          }),
        ).toThrow(/Unknown Station optional-support reveal/i);
        expect(a.export_overworld_session({ session_id: forgedProbe.session_id })).toEqual(
          beforeForgery,
        );
      }
      const inspection = a.restore_overworld_session({ compact_context: true, snapshot });
      const reviewed = a.get_overworld_session_context({
        session_id: compact.session_id,
        if_snapshot_hash: compact.snapshot_hash,
        include_departure_recap_terms: true,
      });
      expect(reviewed).not.toHaveProperty("unchanged");
      if (!("context" in reviewed)) {
        throw new Error(`expected explicit departure terms before ${kind}`);
      }
      expectCompactRecall(reviewed.context);
      expect(reviewed.context.departure_recap_terms).toEqual(
        compactOpeningDepartureRecapTerms(expectedFull),
      );
      expect(reviewed.legend_delta).toHaveProperty("departure_recap_terms");
      expect(reviewed.snapshot_hash).toBe(compact.snapshot_hash);
      expect(reviewed.journey).toEqual(compact.journey);
      const repeatedReview = a.get_overworld_session_context({
        session_id: compact.session_id,
        include_departure_recap_terms: true,
      });
      expect(repeatedReview).not.toHaveProperty("legend_delta");
      const afterReview = a.export_overworld_session({ session_id: compact.session_id });
      expect(afterReview.ok).toBe(true);
      if (!afterReview.ok) throw new Error(`expected export after ${kind} recap review`);
      expect(afterReview.snapshot).toEqual(snapshot);
      expect(afterReview.snapshot_hash).toBe(compact.snapshot_hash);
      const fullInspection = a.inspect_overworld_session_story({
        session_id: full.session_id,
        story_choice_id: storyChoiceId,
        ...FULL_OVERWORLD,
      });
      expect(fullInspection.story.kind).toBe(kind);
      expect(fullInspection.observation.departureRecap).toEqual(expectedFull);
      const compactInspection = a.inspect_overworld_session_story({
        session_id: inspection.session_id,
        story_choice_id: storyChoiceId,
        compact_context: true,
        compact_result: true,
      });
      expect(compactInspection.story.kind).toBe(kind);
      expect(compactInspection.unchanged).toBe(true);
      expectInspectionRecall(compactInspection);
      expect(compactInspection).not.toHaveProperty("departure_recap_terms");
      expect(compactInspection.story.reviewOption).toMatchObject({
        tool: INSPECT_OVERWORLD_SESSION_STORY_TOOL,
        storyChoiceId,
        arguments: {
          story_choice_id: storyChoiceId,
        },
        argument: "option_id",
        readOnly: true,
      });
      for (const option of compactInspection.story.options) {
        expect(option).not.toHaveProperty("situationalBoundary");
      }
      expect(JSON.stringify(compactInspection.story)).not.toContain("may not trigger");
      const exactCandidateId =
        kind === "preparation"
          ? "albany:prep_relief_protocol"
          : kind === "ally"
            ? "albany:ally_june_cattle_first"
            : compactInspection.story.options[0]!.id;
      const optionInspection = a.inspect_overworld_session_story({
        session_id: inspection.session_id,
        ...compactInspection.story.reviewOption.arguments,
        option_id: exactCandidateId,
        compact_context: true,
        compact_result: true,
      });
      expectInspectionRecall(optionInspection, true);
      const canonicalOption = fullInspection.story.options.find(
        (option) => option.id === exactCandidateId,
      );
      if (!canonicalOption) throw new Error(`expected canonical ${kind} option`);
      expect(optionInspection.story.inspectedOption?.consequence).toBe(canonicalOption.consequence);
      if (kind === "preparation") {
        expect(optionInspection.story.inspectedOption?.situationalBoundary).toBe(
          "This bonus may not trigger. In LURE, it applies only if you foul the first feed cast, fail the public wedge, use the split-rail guard to redirect the yearling alive, and return to Cade before the loft cast. A clean cast, braced rail, or different recovery gives no bonus.",
        );
      } else if (kind === "ally") {
        expect(optionInspection.story.inspectedOption?.situationalBoundary).toBe(
          "June's help may not trigger. She lowers cattle alarm after recovered LURE if the herd presses. She prevents 2 HP after failed-signal DRIVE Overrun or an unstabilized first FORTIFY failure at pressure 3+. No help for clean DRIVE, lower/stabilized FORTIFY, or combat. Her help ends when a wolf dies.",
        );
      } else {
        expect(optionInspection.story.inspectedOption).not.toHaveProperty("situationalBoundary");
      }
      expect(optionInspection.departure_recap_terms).toEqual(
        compactOpeningDepartureRecapTerms(expectedFull),
      );
      expect(optionInspection).not.toHaveProperty("departure_recap");
      expect(optionInspection.legend_delta).toHaveProperty("departure_recap_terms");
      expect(JSON.stringify(optionInspection).length).toBeLessThanOrEqual(2_048);
      expect(optionInspection.snapshot_hash).toBe(compactInspection.snapshot_hash);
      const repeatedOptionInspection = a.inspect_overworld_session_story({
        session_id: inspection.session_id,
        ...compactInspection.story.reviewOption.arguments,
        option_id: exactCandidateId,
        compact_context: true,
        compact_result: true,
      });
      expect(repeatedOptionInspection.departure_recap_terms).toEqual(
        compactOpeningDepartureRecapTerms(expectedFull),
      );
      expect(repeatedOptionInspection).not.toHaveProperty("departure_recap");
      expect(repeatedOptionInspection).not.toHaveProperty("legend_delta");
      const afterInspection = a.export_overworld_session({ session_id: inspection.session_id });
      expect(afterInspection.ok).toBe(true);
      if (!afterInspection.ok) throw new Error(`expected export after ${kind} option review`);
      expect(afterInspection.snapshot).toEqual(snapshot);
      expect(afterInspection.snapshot_hash).toBe(compactInspection.snapshot_hash);
      const recapText = JSON.stringify(full.observation.departureRecap);
      const selectedTitles = new Set(
        expectedFull.entries.flatMap((entry) => (entry.title ? [entry.title] : [])),
      );
      for (const alternative of [
        ...WORLD.opening_preparation!.profiles,
        ...WORLD.opening_relief_allocation!.options,
        ...WORLD.opening_ally!.options,
      ]) {
        if (!selectedTitles.has(alternative.title)) {
          expect(recapText).not.toContain(alternative.title);
        }
      }
    };

    assertMcpRecall(PREPARATION_STORY_ID, "preparation");
    source.chooseJourneyStory("albany:prep_works_fortification", PREPARATION_STORY_ID);
    assertMcpRecall(RELIEF_ALLOCATION_STORY_ID, "relief_allocation");
    source.chooseJourneyStory(RESIDENT_SHELTER_ALLOCATION_ID, RELIEF_ALLOCATION_STORY_ID);
    const directTalkSession = a.restore_overworld_session({
      compact_context: true,
      snapshot: source.snapshot(),
    });
    const directTalkReview = a.get_overworld_session_context({
      session_id: directTalkSession.session_id,
      reveal_station_dispatch_support: STATION_DISPATCH_SUPPORT_REVEAL_ID,
    });
    if (!("context" in directTalkReview)) {
      throw new Error("expected revealed Station support for the field-team action");
    }
    const directTalkAction = directTalkReview.context.station_dispatch_board?.[4].find(
      ([slot]) => slot === "field_team",
    )?.[4];
    if (directTalkAction?.[0] !== "talk") {
      throw new Error("expected an authenticated revealed field-team action");
    }
    const directTalk = a.talk_overworld_session_contact({
      session_id: directTalkSession.session_id,
      character_id: directTalkAction[1],
      compact_context: true,
      compact_result: true,
    });
    expect(directTalk.journey.storyChoice).toMatchObject({
      id: WORLD.opening_ally!.id,
      kind: "ally",
    });
    expect(directTalk.context).not.toHaveProperty("station_dispatch_support");
    source.talkToCharacter(WORLD.opening_ally!.contact);
    expect(source.journey().storyChoice?.kind).toBe("ally");
    assertMcpRecall(WORLD.opening_ally!.id, "ally");
  });

  it("inspects one active option without mutation or sibling-term leakage", () => {
    const a = api();
    const started = a.start_overworld();
    const registration = WORLD.opening_registration;
    if (!registration) throw new Error("expected Albany's opening registration");
    a.scout_overworld_session_poi({
      session_id: started.session_id,
      poi_id: "albany_city__civic_core__poi",
    });
    const compactPresented = a.talk_overworld_session_contact({
      session_id: started.session_id,
      character_id: registration.contact,
    }).journey.storyChoice;
    if (!compactPresented) throw new Error("expected a currently presented registration");
    expect(compactPresented).toMatchObject({ id: registration.id, kind: "registration" });
    expect(compactPresented.options.every((option) => option.consequence === "")).toBe(true);
    expect(compactPresented.message).toContain(JOURNEY_STORY_CHOICE_REVIEW_INSTRUCTION);
    const canonical = a.get_overworld_session({
      session_id: started.session_id,
      include_observation: true,
    }).journey.storyChoice;
    if (!canonical) throw new Error("expected canonical registration terms");
    const selected = canonical.options[1]!;

    const before = a.export_overworld_session({ session_id: started.session_id });
    if (!before.ok) throw new Error("expected an exportable presented-choice session");
    const comparison = a.inspect_overworld_session_story({
      session_id: started.session_id,
      story_choice_id: registration.id,
    });
    expect(comparison).toEqual({
      ok: true,
      session_id: started.session_id,
      snapshot_hash: before.snapshot_hash,
      unchanged: true,
      story: compactJourneyStoryChoiceComparison(canonical),
    });
    const detail = a.inspect_overworld_session_story({
      session_id: started.session_id,
      story_choice_id: registration.id,
      option_id: selected.id,
    });
    expect(detail).toEqual({
      ok: true,
      session_id: started.session_id,
      snapshot_hash: before.snapshot_hash,
      unchanged: true,
      story: compactJourneyStoryChoiceComparison(canonical, selected.id),
    });
    expect(detail.story).not.toHaveProperty("message");
    expect(detail.story).not.toHaveProperty("options");
    expect(detail.story.inspectedOption).not.toHaveProperty("summary");
    const optionalArgs: {
      session_id: string;
      story_choice_id: string;
      option_id?: string;
    } = {
      session_id: started.session_id,
      story_choice_id: registration.id,
      option_id: selected.id,
    };
    const optionalDetail = a.inspect_overworld_session_story(optionalArgs);
    expectTypeOf(optionalDetail.story).toEqualTypeOf<
      JourneyStoryChoiceSummaryComparison | JourneyStoryChoiceDetail
    >();
    expect(optionalDetail.story).not.toHaveProperty("message");
    expect(optionalDetail.story).not.toHaveProperty("options");
    const detailJson = JSON.stringify(detail.story);
    for (const sibling of canonical.options.filter((option) => option.id !== selected.id)) {
      expect(detailJson).not.toContain(sibling.consequence);
    }
    const full = a.inspect_overworld_session_story({
      session_id: started.session_id,
      story_choice_id: registration.id,
      ...FULL_OVERWORLD,
    });
    expect(full.story).toEqual(canonical);

    expect(() =>
      a.inspect_overworld_session_story({
        session_id: started.session_id,
        story_choice_id: "albany:not_the_presented_story",
      }),
    ).toThrow(/finish the presented story choice/i);
    expect(() =>
      a.inspect_overworld_session_story({
        session_id: started.session_id,
        story_choice_id: registration.id,
        option_id: "albany:not_an_option",
      }),
    ).toThrow(/does not offer option/i);
    expect(a.export_overworld_session({ session_id: started.session_id })).toEqual(before);

    const directBranch = a.restore_overworld_session({
      snapshot: before.snapshot,
      compact_context: true,
    });
    const inspectedBranch = a.restore_overworld_session({
      snapshot: before.snapshot,
      compact_context: true,
    });
    a.inspect_overworld_session_story({
      session_id: inspectedBranch.session_id,
      story_choice_id: registration.id,
      option_id: selected.id,
    });
    const directChoice = a.choose_overworld_session_story({
      session_id: directBranch.session_id,
      choice: selected.id,
    });
    const inspectedChoice = a.choose_overworld_session_story({
      session_id: inspectedBranch.session_id,
      choice: selected.id,
    });
    expect(inspectedChoice.snapshot_hash).toBe(directChoice.snapshot_hash);
    expect(inspectedChoice.result).toEqual(directChoice.result);
    expect(directChoice.result).toMatchObject({
      displaySummary: expect.stringContaining(`Background chosen — ${selected.label}.`),
      consequence: selected.consequence,
    });
    expect(directChoice.result.displaySummary).not.toContain(selected.consequence);
    const compactResultJson = JSON.stringify(directChoice.result);
    expect(compactResultJson.indexOf('"displaySummary"')).toBeLessThan(
      compactResultJson.indexOf('"consequence"'),
    );
  });

  it("offers the ready-made dispatch immediately and expands custom promises read-only without leaking oath cards", () => {
    const a = api();
    const registration = WORLD.opening_registration;
    const oath = WORLD.opening_relief_oath;
    const doctrine = registration?.doctrines?.[0];
    if (!registration || !oath || !doctrine) {
      throw new Error("expected Albany's registration, oath, and standard packet");
    }
    const started = a.start_overworld();
    a.scout_overworld_session_poi({
      session_id: started.session_id,
      poi_id: "albany_city__civic_core__poi",
    });
    a.talk_overworld_session_contact({
      session_id: started.session_id,
      character_id: registration.contact,
    });
    const compactOath = a.choose_overworld_session_story({
      session_id: started.session_id,
      choice: doctrine.profile_id,
    }).journey.storyChoice;
    if (!compactOath) throw new Error("expected a compact oath comparison");
    expectTypeOf(compactOath.progressiveDisclosure).toEqualTypeOf<undefined>();
    expectTypeOf(compactOath.revealOption).toEqualTypeOf<
      JourneyStoryChoiceRevealAffordance | undefined
    >();
    expect(compactOath.revealOption).toMatchObject({
      id: "customize_duty_and_evidence",
      label: OPENING_RELIEF_OATH_CUSTOMIZE_LABEL,
      description: OPENING_RELIEF_OATH_CUSTOMIZE_DESCRIPTION,
    });
    expect(JSON.stringify(compactOath)).not.toContain(OPENING_RELIEF_OATH_FIELD_OUTCOME_COMPASS);
    const canonical = a.inspect_overworld_session_story({
      session_id: started.session_id,
      story_choice_id: oath.id,
      ...FULL_OVERWORLD,
    }).story;
    expectTypeOf(canonical.progressiveDisclosure).not.toEqualTypeOf<undefined>();
    const disclosure = canonical.progressiveDisclosure;
    if (!disclosure) throw new Error("expected staged custom oath disclosure");
    expect(disclosure.reveal).toMatchObject({
      label: OPENING_RELIEF_OATH_CUSTOMIZE_LABEL,
      description: OPENING_RELIEF_OATH_CUSTOMIZE_DESCRIPTION,
    });
    expect(JSON.stringify(canonical)).not.toContain(OPENING_RELIEF_OATH_FIELD_OUTCOME_COMPASS);
    const shortcutId = doctrine.id;
    const hiddenId = oath.options[0]!.id;

    expect(compactOath.options.map((option) => option.id)).toEqual(disclosure.initialOptionIds);
    expect(disclosure.initialOptionIds).toEqual([shortcutId]);
    expect(disclosure.reveal.optionIds).toEqual(oath.options.map((option) => option.id));
    expect(() =>
      a.choose_overworld_session_story({
        session_id: started.session_id,
        story_choice_id: oath.id,
        choice: hiddenId,
      }),
    ).toThrow(new RegExp(`hidden[^]*reveal_id "${disclosure.reveal.id}"[^]*this session`, "i"));
    expect(() =>
      a.inspect_overworld_session_story({
        session_id: started.session_id,
        story_choice_id: oath.id,
        option_id: hiddenId,
      }),
    ).toThrow(/hidden[^]*reveal_id[^]*this session/i);
    expect(compactOath).not.toHaveProperty("progressiveDisclosure");
    const initialJourneyJson = JSON.stringify(compactOath);
    expect(initialJourneyJson.indexOf('"revealOption"')).toBeLessThan(
      initialJourneyJson.indexOf('"options"'),
    );
    for (const hiddenIdOrLabel of disclosure.reveal.optionIds) {
      const hidden = canonical.options.find((option) => option.id === hiddenIdOrLabel)!;
      expect(initialJourneyJson).not.toContain(hidden.id);
      expect(initialJourneyJson).not.toContain(hidden.summary?.tradeoff);
      expect(initialJourneyJson).not.toContain(hidden.consequence);
    }

    const before = a.export_overworld_session({ session_id: started.session_id });
    if (!before.ok) throw new Error("expected an exportable oath comparison");
    const beforeRevealJourney = a.get_overworld_session_context({
      session_id: started.session_id,
    }).journey;
    const initial = a.inspect_overworld_session_story({
      session_id: started.session_id,
      story_choice_id: oath.id,
    });
    expect(initial).toMatchObject({
      snapshot_hash: before.snapshot_hash,
      unchanged: true,
      story: compactJourneyStoryChoiceComparison(canonical),
    });
    expect(initial.story.options.map((option) => option.id)).toEqual(disclosure.initialOptionIds);
    expect(initial.story.options).toHaveLength(1);
    expect(initial.story.options[0]).toMatchObject({
      id: shortcutId,
      label: expect.stringContaining("Ready-made setup"),
    });
    const initialJson = JSON.stringify(initial.story);
    expect(initialJson.indexOf('"revealOption"')).toBeLessThan(initialJson.indexOf('"options"'));
    for (const hiddenIdOrLabel of disclosure.reveal.optionIds) {
      const hidden = canonical.options.find((option) => option.id === hiddenIdOrLabel)!;
      expect(initialJson).not.toContain(hidden.id);
      expect(initialJson).not.toContain(hidden.summary?.tradeoff);
      expect(initialJson).not.toContain(hidden.consequence);
    }

    const expanded = a.inspect_overworld_session_story({
      session_id: started.session_id,
      story_choice_id: oath.id,
      reveal_id: disclosure.reveal.id,
    });
    // Opening the compass is now RECORDED. The gate that gives duty selection its
    // legality reads this, and legality in this engine is a function of state — so the
    // receipt lives in the snapshot and moves the hash, rather than in a WeakMap that a
    // restore silently empties. Only that authenticated boundary adds the full compass.
    const revealedHash = expanded.snapshot_hash;
    expect(revealedHash).not.toBe(before.snapshot_hash);
    expect(expanded.story.options.map((option) => option.id)).toEqual([
      ...disclosure.initialOptionIds,
      ...disclosure.reveal.optionIds,
    ]);
    expect(expanded.story).not.toHaveProperty("revealOption");
    expect(expanded.story.message).toContain(OPENING_RELIEF_OATH_FIELD_OUTCOME_COMPASS);
    const fullReveal = a.inspect_overworld_session_story({
      session_id: started.session_id,
      story_choice_id: oath.id,
      reveal_id: disclosure.reveal.id,
      ...FULL_OVERWORLD,
    });
    const { progressiveDisclosure: _progressiveDisclosure, ...canonicalWithoutDisclosure } =
      canonical;
    expect(fullReveal.story).toEqual({
      ...canonicalWithoutDisclosure,
      message: `${canonical.message} ${OPENING_RELIEF_OATH_FIELD_OUTCOME_COMPASS}`,
    });
    expect(fullReveal.story).not.toHaveProperty("progressiveDisclosure");
    expect(expanded.story).toEqual(compactJourneyStoryChoiceComparison(fullReveal.story));
    // Re-opening the same reveal is genuinely idempotent — the receipt is a set.
    expect(fullReveal.snapshot_hash).toBe(revealedHash);

    const refreshedReveal = a.get_overworld_session_context({
      session_id: started.session_id,
    });
    const refreshedStory = refreshedReveal.journey.storyChoice;
    if (!refreshedStory) throw new Error("expected the revealed oath after compact refresh");
    expect(refreshedReveal.snapshot_hash).toBe(revealedHash);
    expect(refreshedReveal.journey.acceptedDecisions).toBe(beforeRevealJourney.acceptedDecisions);
    expect(refreshedReveal.journey.goal).toEqual(beforeRevealJourney.goal);
    expect(refreshedStory.options.map((option) => option.id)).toEqual(
      expanded.story.options.map((option) => option.id),
    );
    expect(refreshedStory.options.every((option) => option.consequence === "")).toBe(true);
    expect(refreshedStory).not.toHaveProperty("revealOption");
    expect(JSON.stringify(refreshedStory).match(/HUNT — Fight the wolves/gu)).toHaveLength(1);

    const detail = a.inspect_overworld_session_story({
      session_id: started.session_id,
      story_choice_id: oath.id,
      option_id: hiddenId,
    });
    expect(detail.story).toEqual(compactJourneyStoryChoiceComparison(canonical, hiddenId));
    // Reading one option's detail reveals nothing new, so it moves nothing.
    expect(detail.snapshot_hash).toBe(revealedHash);
    expect(() =>
      a.inspect_overworld_session_story({
        session_id: started.session_id,
        story_choice_id: oath.id,
        reveal_id: "albany:unknown_custom_duty_disclosure",
      }),
    ).toThrow(/no progressive disclosure/i);
    expect(() =>
      a.inspect_overworld_session_story({
        session_id: started.session_id,
        story_choice_id: oath.id,
        option_id: hiddenId,
        reveal_id: disclosure.reveal.id,
      }),
    ).toThrow(/option_id or reveal_id/i);
    const afterReveal = a.export_overworld_session({ session_id: started.session_id });
    expect(afterReveal).not.toEqual(before);
    expect(afterReveal.snapshot.inspectedStoryReveals).toEqual([[oath.id, [disclosure.reveal.id]]]);

    const detachedRevealSnapshot = a.export_overworld_session({ session_id: started.session_id });
    if (!detachedRevealSnapshot.ok) throw new Error("expected a detached reveal snapshot");
    const detachedRevealIds = detachedRevealSnapshot.snapshot.inspectedStoryReveals?.[0]?.[1];
    if (!detachedRevealIds) throw new Error("expected the detached reveal receipt");
    detachedRevealIds.push("mutated_outside_the_session");
    const intactRevealSnapshot = a.export_overworld_session({ session_id: started.session_id });
    if (!intactRevealSnapshot.ok) throw new Error("expected the intact reveal snapshot");
    // Returned snapshots must not alias the cached nested receipt arrays. Otherwise
    // callers can rewrite session state while the cached hash keeps authenticating
    // the old bytes.
    expect(intactRevealSnapshot.snapshot_hash).toBe(detachedRevealSnapshot.snapshot_hash);
    expect(intactRevealSnapshot.snapshot.inspectedStoryReveals).toEqual([
      [oath.id, [disclosure.reveal.id]],
    ]);

    // THE POINT OF PERSISTING IT: a session exported after the reveal restores WITH the
    // gate satisfied. Previously the receipt was excluded from the snapshot, so a player
    // who opened the compass, exported, and restored could no longer take the choice they
    // had unlocked — an exported session was not fully resumable.
    const resumedRevealed = a.restore_overworld_session({ snapshot: afterReveal.snapshot });
    expect(resumedRevealed.snapshot_hash).toBe(afterReveal.snapshot_hash);
    expect(resumedRevealed.journey.storyChoice?.options.map((option) => option.id)).toEqual(
      expanded.story.options.map((option) => option.id),
    );
    expect(resumedRevealed.journey.storyChoice).not.toHaveProperty("revealOption");
    expect(
      JSON.stringify(resumedRevealed.journey.storyChoice).match(/HUNT — Fight the wolves/gu),
    ).toHaveLength(1);
    const resumedRefresh = a.get_overworld_session_context({
      session_id: resumedRevealed.session_id,
    });
    expect(resumedRefresh.snapshot_hash).toBe(afterReveal.snapshot_hash);
    expect(resumedRefresh.journey).toEqual(resumedRevealed.journey);
    expect(() =>
      a.inspect_overworld_session_story({
        session_id: resumedRevealed.session_id,
        story_choice_id: oath.id,
        option_id: hiddenId,
      }),
    ).not.toThrow();

    const directBranch = a.restore_overworld_session({ snapshot: before.snapshot });
    const expandedBranch = a.restore_overworld_session({ snapshot: before.snapshot });
    const fullExpandedBranch = a.restore_overworld_session({ snapshot: before.snapshot });
    const shortcutExpandedBranch = a.restore_overworld_session({ snapshot: before.snapshot });
    expect(() =>
      a.inspect_overworld_session_story({
        session_id: directBranch.session_id,
        story_choice_id: oath.id,
        reveal_id: "albany:not_this_story_reveal",
      }),
    ).toThrow(/no progressive disclosure/i);
    expect(() =>
      a.inspect_overworld_session_story({
        session_id: directBranch.session_id,
        story_choice_id: oath.id,
        option_id: hiddenId,
      }),
    ).toThrow(/hidden[^]*reveal_id[^]*this session/i);
    expect(() =>
      a.choose_overworld_session_story({
        session_id: directBranch.session_id,
        story_choice_id: oath.id,
        choice: hiddenId,
      }),
    ).toThrow(/hidden[^]*reveal_id[^]*this session/i);
    const directShortcutChoice = a.choose_overworld_session_story({
      session_id: directBranch.session_id,
      story_choice_id: oath.id,
      choice: shortcutId,
    });
    const profile = registration.profiles.find(
      (candidate) => candidate.id === doctrine.profile_id,
    )!;
    const oathOption = oath.options.find(
      (candidate) => candidate.id === doctrine.relief_oath_option_id,
    )!;
    const sourceOption = WORLD.opening_lead_source!.options.find(
      (candidate) => candidate.id === doctrine.lead_source_option_id,
    )!;
    const exactReceipt =
      `${doctrine.preview} Cost: ${doctrine.immediate_cost}. ` +
      `${doctrine.consequence} Background: ${profile.title}. ` +
      `Promise: ${oathOption.title}. Report: ${sourceOption.title}.`;
    expect(directShortcutChoice.result.consequence).toBe(exactReceipt);
    expect(directShortcutChoice.result.displaySummary).toBe(
      `Quick setup chosen. Background: ${profile.title}. ` +
        `Wolf-Winter promise: ${oathOption.title.replace(/\bDuty\b/gu, "Promise")}. ` +
        `Report: ${sourceOption.title}. You can still choose a field kit, relief wagon, second rider, and route.`,
    );
    expect(directShortcutChoice.result.displaySummary).not.toMatch(
      /\b(role|duty|source|preparation|relief allocation|field-team)\b/iu,
    );
    const compactShortcutJson = JSON.stringify(directShortcutChoice.result);
    expect(compactShortcutJson.indexOf('"displaySummary"')).toBeLessThan(
      compactShortcutJson.indexOf('"consequence"'),
    );
    const fullShortcutBranch = a.restore_overworld_session({ snapshot: before.snapshot });
    const fullShortcutChoice = a.choose_overworld_session_story({
      session_id: fullShortcutBranch.session_id,
      story_choice_id: oath.id,
      choice: shortcutId,
      ...FULL_OVERWORLD,
    });
    expect(fullShortcutChoice.result).toMatchObject({
      consequence: exactReceipt,
      displaySummary: directShortcutChoice.result.displaySummary,
      entry: {
        title: `Quick setup confirmed: ${doctrine.title}`,
        text: exactReceipt,
      },
    });
    const fullShortcutJson = JSON.stringify(fullShortcutChoice.result);
    expect(fullShortcutJson.indexOf('"displaySummary"')).toBeLessThan(
      fullShortcutJson.indexOf('"consequence"'),
    );
    expect(fullShortcutChoice.snapshot_hash).toBe(directShortcutChoice.snapshot_hash);
    a.inspect_overworld_session_story({
      session_id: expandedBranch.session_id,
      story_choice_id: oath.id,
      reveal_id: disclosure.reveal.id,
    });
    const fullExpandedInspection = a.inspect_overworld_session_story({
      session_id: fullExpandedBranch.session_id,
      story_choice_id: oath.id,
      reveal_id: disclosure.reveal.id,
      ...FULL_OVERWORLD,
    });
    expect(fullExpandedInspection.snapshot_hash).not.toBe(before.snapshot_hash);
    expect(fullExpandedInspection.snapshot_hash).toBe(revealedHash);
    const fullExpandedExport = a.export_overworld_session({
      session_id: fullExpandedBranch.session_id,
    });
    if (!fullExpandedExport.ok) throw new Error("expected an exportable full reveal");
    // Full and compact inspection both return the snapshot that already contains
    // the reveal receipt; neither may hand back the pre-reveal hash.
    expect(fullExpandedExport.snapshot_hash).toBe(fullExpandedInspection.snapshot_hash);
    expect(fullExpandedExport.snapshot.inspectedStoryReveals).toEqual([
      [oath.id, [disclosure.reveal.id]],
    ]);
    a.inspect_overworld_session_story({
      session_id: shortcutExpandedBranch.session_id,
      story_choice_id: oath.id,
      reveal_id: disclosure.reveal.id,
    });
    const expandedChoice = a.choose_overworld_session_story({
      session_id: expandedBranch.session_id,
      story_choice_id: oath.id,
      choice: hiddenId,
    });
    const fullExpandedChoice = a.choose_overworld_session_story({
      session_id: fullExpandedBranch.session_id,
      story_choice_id: oath.id,
      choice: hiddenId,
    });
    expect(expandedChoice.snapshot_hash).toBe(fullExpandedChoice.snapshot_hash);
    expect(expandedChoice.result).toEqual(fullExpandedChoice.result);
    const expandedShortcutChoice = a.choose_overworld_session_story({
      session_id: shortcutExpandedBranch.session_id,
      story_choice_id: oath.id,
      choice: shortcutId,
    });
    expect(directShortcutChoice.snapshot_hash).toBe(expandedShortcutChoice.snapshot_hash);
    expect(directShortcutChoice.result).toEqual(expandedShortcutChoice.result);

    // A snapshot taken AFTER the reveal restores with the gate satisfied: the player
    // opened the compass, so the duty they unlocked is still theirs to take. A snapshot
    // taken BEFORE it (the `directBranch` above) still gates, because in that session
    // they had not opened it. Both follow from legality being a function of state.
    const restoredAfterReveal = a.restore_overworld_session({
      snapshot: afterReveal.snapshot,
    });
    expect(() =>
      a.choose_overworld_session_story({
        session_id: restoredAfterReveal.session_id,
        story_choice_id: oath.id,
        choice: hiddenId,
      }),
    ).not.toThrow();
  });

  it("stages compact departure terms without mutating zero-, one-, or multi-inspection play", () => {
    const a = api();
    const registrationContact = WORLD.opening_registration?.contact;
    const preparation = WORLD.opening_preparation;
    if (!registrationContact || !preparation) {
      throw new Error("expected Albany's registration and preparation");
    }

    const reachPreparation = (): string => {
      const started = a.start_overworld();
      a.scout_overworld_session_poi({
        session_id: started.session_id,
        poi_id: "albany_city__civic_core__poi",
      });
      a.talk_overworld_session_contact({
        session_id: started.session_id,
        character_id: registrationContact,
      });
      a.choose_overworld_session_story({
        session_id: started.session_id,
        choice: "albany:ledger_advocate",
      });
      a.choose_overworld_session_story({
        session_id: started.session_id,
        choice: LIMITED_RELIEF_OATH_ID,
      });
      a.choose_overworld_session_story({
        session_id: started.session_id,
        choice: "albany:source_rowan_civic_docket",
      });
      const beforeMove = a.get_overworld_session({
        session_id: started.session_id,
        include_observation: true,
      });
      const route = beforeMove.observation.areaExits.find(
        (candidate) => candidate.destination.id === preparation.area,
      );
      if (!route) throw new Error("expected a route to the preparation board");
      a.move_overworld_session_area({
        session_id: started.session_id,
        area_route_id: route.id,
      });
      return started.session_id;
    };

    const [zeroInspectionId, oneInspectionId, multipleInspectionId] = [
      reachPreparation(),
      reachPreparation(),
      reachPreparation(),
    ];
    const optionId = preparation.profiles[0]!.id;
    const otherOptionId = preparation.profiles[1]!.id;

    const beforeOne = a.export_overworld_session({ session_id: oneInspectionId });
    if (!beforeOne.ok) throw new Error("expected an exportable comparison session");
    const comparisonResponse = a.inspect_overworld_session_story({
      session_id: oneInspectionId,
      story_choice_id: preparation.id,
    });
    const afterOne = a.export_overworld_session({ session_id: oneInspectionId });
    expect(afterOne).toEqual(beforeOne);
    expect(comparisonResponse).toMatchObject({
      ok: true,
      session_id: oneInspectionId,
      snapshot_hash: beforeOne.snapshot_hash,
      unchanged: true,
      story: {
        comparisonVersion: JOURNEY_STORY_CHOICE_COMPARISON_VERSION,
        id: preparation.id,
        kind: "preparation",
        reviewOption: {
          tool: INSPECT_OVERWORLD_SESSION_STORY_TOOL,
          storyChoiceId: preparation.id,
          arguments: { story_choice_id: preparation.id },
          argument: "option_id",
          valuesFrom: OVERWORLD_DEPARTURE_CHOICE_VALUES_FROM,
          readOnly: true,
        },
        inspectedOption: null,
      },
    });
    expect(Object.keys(comparisonResponse).sort()).toEqual(
      ["ok", "session_id", "snapshot_hash", "story", "unchanged"].sort(),
    );
    expect(comparisonResponse).not.toHaveProperty("departure_recap_terms");
    expect(comparisonResponse.story.options).toHaveLength(preparation.profiles.length);
    for (const option of comparisonResponse.story.options) {
      expect(option).not.toHaveProperty("consequence");
    }
    const comparisonJson = JSON.stringify(comparisonResponse.story);
    for (const profile of preparation.profiles) {
      expect(comparisonJson).not.toContain(profile.preview);
      expect(comparisonJson).not.toContain(profile.consequence);
    }

    const affordanceSessionId = reachPreparation();
    const beforeAffordance = a.export_overworld_session({ session_id: affordanceSessionId });
    if (!beforeAffordance.ok) throw new Error("expected an exportable affordance session");
    const affordanceComparison = a.inspect_overworld_session_story({
      session_id: affordanceSessionId,
      story_choice_id: preparation.id,
    });
    const reviewOption = affordanceComparison.story.reviewOption;
    const reviewedOptionId = affordanceComparison.story.options[0]!.id;
    expect(reviewOption.tool).toBe(INSPECT_OVERWORLD_SESSION_STORY_TOOL);
    const reviewedFromAffordance = a.inspect_overworld_session_story({
      session_id: affordanceSessionId,
      ...reviewOption.arguments,
      [reviewOption.argument]: reviewedOptionId,
    });
    expect(reviewedFromAffordance.story.inspectedOption?.id).toBe(reviewedOptionId);
    expect(reviewedFromAffordance.snapshot_hash).toBe(beforeAffordance.snapshot_hash);
    expect(a.export_overworld_session({ session_id: affordanceSessionId })).toEqual(
      beforeAffordance,
    );

    const beforeMultiple = a.export_overworld_session({ session_id: multipleInspectionId });
    if (!beforeMultiple.ok) throw new Error("expected an exportable detail session");
    const expectedMultipleRecap = OverworldSession.restore(WORLD, beforeMultiple.snapshot).view()
      .departureRecap;
    if (!expectedMultipleRecap) throw new Error("expected authenticated preparation terms");
    const firstDetail = a.inspect_overworld_session_story({
      session_id: multipleInspectionId,
      story_choice_id: preparation.id,
      option_id: optionId,
    });
    const secondDetail = a.inspect_overworld_session_story({
      session_id: multipleInspectionId,
      story_choice_id: preparation.id,
      option_id: otherOptionId,
    });
    const afterMultiple = a.export_overworld_session({ session_id: multipleInspectionId });
    expect(afterMultiple).toEqual(beforeMultiple);
    const firstProfile = preparation.profiles[0]!;
    const secondProfile = preparation.profiles[1]!;
    const firstSummary = comparisonResponse.story.options.find(
      (option) => option.id === optionId,
    )!.summary!;
    const secondSummary = comparisonResponse.story.options.find(
      (option) => option.id === otherOptionId,
    )!.summary!;
    expect(firstSummary).not.toHaveProperty("checkFit");
    expect(secondSummary).not.toHaveProperty("checkFit");
    expect(firstSummary.highlights).toEqual([
      { label: "Check skill", value: "Repair +0 vs DC 12" },
    ]);
    expect(secondSummary.highlights).toEqual([
      { label: "Check skill", value: "Streetwise +0 vs DC 12" },
    ]);
    const firstReceipt =
      `Benefit: ${firstProfile.trigger_category ?? firstProfile.title} ` +
      `Cost: ${firstSummary.immediateCost}. Tradeoff: ${firstProfile.tradeoff}`;
    const secondReceipt =
      `Benefit: ${secondProfile.trigger_category ?? secondProfile.title} ` +
      `Cost: ${secondSummary.immediateCost}. Tradeoff: ${secondProfile.tradeoff}`;
    expect(firstDetail.story.inspectedOption).toMatchObject({
      id: optionId,
      checkFit: "Repair +0 vs DC 12",
      dispatchForecast: { proofHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      consequence: firstReceipt,
    });
    expect(openingSelectionReceiptWordCount(firstReceipt)).toBeLessThanOrEqual(
      OPENING_SELECTION_RECEIPT_WORD_LIMIT,
    );
    expect(Object.keys(firstDetail).sort()).toEqual(
      [
        "departure_recap_terms",
        "legend_delta",
        "ok",
        "session_id",
        "snapshot_hash",
        "story",
        "unchanged",
      ].sort(),
    );
    expect(firstDetail).not.toHaveProperty("departure_recap");
    expect(firstDetail.departure_recap_terms).toEqual(
      compactOpeningDepartureRecapTerms(expectedMultipleRecap),
    );
    expect(firstDetail.legend_delta).toHaveProperty("departure_recap_terms");
    expect(Object.keys(firstDetail.story).sort()).toEqual(
      ["comparisonVersion", "id", "inspectedOption", "kind"].sort(),
    );
    expect(Object.keys(firstDetail.story.inspectedOption).sort()).toEqual(
      ["checkFit", "consequence", "dispatchForecast", "id", "label"].sort(),
    );
    expect(secondDetail.story.inspectedOption).toMatchObject({
      id: otherOptionId,
      checkFit: "Streetwise +0 vs DC 12",
      dispatchForecast: { proofHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      consequence: secondReceipt,
    });
    expect(secondDetail.departure_recap_terms).toEqual(firstDetail.departure_recap_terms);
    expect(secondDetail).not.toHaveProperty("legend_delta");
    expect(openingSelectionReceiptWordCount(secondReceipt)).toBeLessThanOrEqual(
      OPENING_SELECTION_RECEIPT_WORD_LIMIT,
    );
    const firstDetailJson = JSON.stringify(firstDetail.story);
    expect(firstDetailJson).not.toContain(firstProfile.preview);
    expect(firstDetailJson).not.toContain(firstProfile.consequence);
    for (const profile of preparation.profiles.slice(1)) {
      expect(firstDetailJson).not.toContain(profile.preview);
      expect(firstDetailJson).not.toContain(profile.consequence);
    }

    expect(() =>
      a.inspect_overworld_session_story({
        session_id: multipleInspectionId,
        story_choice_id: preparation.id,
        option_id: "albany:not_a_preparation",
      }),
    ).toThrow(`Story choice "${preparation.id}" does not offer option "albany:not_a_preparation".`);
    expect(a.export_overworld_session({ session_id: multipleInspectionId })).toEqual(
      beforeMultiple,
    );
    expect(afterMultiple.snapshot.minutes).toBe(beforeMultiple.snapshot.minutes);
    expect(afterMultiple.snapshot.character.money).toBe(beforeMultiple.snapshot.character.money);
    expect(afterMultiple.journey.acceptedDecisions).toBe(beforeMultiple.journey.acceptedDecisions);

    const choose = (sessionId: string) =>
      a.choose_overworld_session_story({
        session_id: sessionId,
        story_choice_id: preparation.id,
        choice: optionId,
      });
    const zeroChoice = choose(zeroInspectionId);
    const oneChoice = choose(oneInspectionId);
    const multipleChoice = choose(multipleInspectionId);
    expect(oneChoice.result).toEqual(zeroChoice.result);
    expect(multipleChoice.result).toEqual(zeroChoice.result);
    expect(oneChoice.snapshot_hash).toBe(zeroChoice.snapshot_hash);
    expect(multipleChoice.snapshot_hash).toBe(zeroChoice.snapshot_hash);

    const allocation = WORLD.opening_relief_allocation;
    if (!allocation) throw new Error("expected Albany's Relief Allocation");
    const allocationOptionId = allocation.options[0]!.id;
    const beforeAllocation = a.export_overworld_session({ session_id: oneInspectionId });
    if (!beforeAllocation.ok) throw new Error("expected an exportable allocation session");
    const allocationComparison = a.inspect_overworld_session_story({
      session_id: oneInspectionId,
      story_choice_id: allocation.id,
    });
    expect(a.export_overworld_session({ session_id: oneInspectionId })).toEqual(beforeAllocation);
    expect(allocationComparison).toMatchObject({
      ok: true,
      session_id: oneInspectionId,
      snapshot_hash: beforeAllocation.snapshot_hash,
      unchanged: true,
      story: {
        comparisonVersion: JOURNEY_STORY_CHOICE_COMPARISON_VERSION,
        id: allocation.id,
        kind: "relief_allocation",
        reviewOption: {
          tool: INSPECT_OVERWORLD_SESSION_STORY_TOOL,
          storyChoiceId: allocation.id,
          arguments: { story_choice_id: allocation.id },
          argument: "option_id",
          valuesFrom: OVERWORLD_DEPARTURE_CHOICE_VALUES_FROM,
          readOnly: true,
        },
        inspectedOption: null,
      },
    });
    const allocationComparisonJson = JSON.stringify(allocationComparison.story);
    for (const allocationOption of allocation.options) {
      expect(allocationComparisonJson).not.toContain(allocationOption.preview);
      expect(allocationComparisonJson).not.toContain(allocationOption.consequence);
      const presented = allocationComparison.story.options.find(
        (option) => option.id === allocationOption.id,
      )!;
      expect(presented.summary).toEqual({
        commitment: allocationOption.summary,
        immediateCost: presented.summary!.immediateCost,
        tradeoff: `Leaves exposed: ${allocationOption.leaves_exposed}`,
      });
      expect(Object.keys(presented.summary!).sort()).toEqual([
        "commitment",
        "immediateCost",
        "tradeoff",
      ]);
    }

    const allocationDetail = a.inspect_overworld_session_story({
      session_id: oneInspectionId,
      story_choice_id: allocation.id,
      option_id: allocationOptionId,
    });
    expect(a.export_overworld_session({ session_id: oneInspectionId })).toEqual(beforeAllocation);
    const selectedAllocation = allocation.options[0]!;
    const selectedAllocationSummary = allocationComparison.story.options.find(
      (option) => option.id === allocationOptionId,
    )!.summary!;
    const allocationReceipt =
      `Benefit: ${selectedAllocation.trigger_category ?? selectedAllocation.protects} ` +
      `Cost: ${selectedAllocationSummary.immediateCost}. ` +
      `Tradeoff: Leaves exposed: ${selectedAllocation.leaves_exposed}`;
    expect(allocationDetail.story.inspectedOption).toMatchObject({
      id: allocationOptionId,
      consequence: allocationReceipt,
    });
    expect(openingSelectionReceiptWordCount(allocationReceipt)).toBeLessThanOrEqual(
      OPENING_SELECTION_RECEIPT_WORD_LIMIT,
    );
    const allocationDetailJson = JSON.stringify(allocationDetail.story);
    expect(allocationDetailJson).not.toContain(selectedAllocation.preview);
    expect(allocationDetailJson).not.toContain(selectedAllocation.consequence);
    for (const otherOption of allocation.options.slice(1)) {
      expect(allocationDetailJson).not.toContain(otherOption.preview);
      expect(allocationDetailJson).not.toContain(otherOption.consequence);
    }

    const fullSessionId = reachPreparation();
    const fullStory = a.inspect_overworld_session_story({
      session_id: fullSessionId,
      story_choice_id: preparation.id,
      ...FULL_OVERWORLD,
    });
    const fullStoryWithOption = a.inspect_overworld_session_story({
      session_id: fullSessionId,
      story_choice_id: preparation.id,
      option_id: optionId,
      ...FULL_OVERWORLD,
    });
    expect(fullStoryWithOption).toEqual(fullStory);
    expect(fullStory.story.options.every((option) => "consequence" in option)).toBe(true);

    a.choose_overworld_session_story({
      session_id: fullSessionId,
      story_choice_id: preparation.id,
      choice: optionId,
      ...FULL_OVERWORLD,
    });
    const fullAllocation = a.inspect_overworld_session_story({
      session_id: fullSessionId,
      story_choice_id: allocation.id,
      ...FULL_OVERWORLD,
    });
    const fullAllocationWithOption = a.inspect_overworld_session_story({
      session_id: fullSessionId,
      story_choice_id: allocation.id,
      option_id: allocationOptionId,
      ...FULL_OVERWORLD,
    });
    expect(fullAllocationWithOption).toEqual(fullAllocation);
    expect(fullAllocation.story.options).toHaveLength(allocation.options.length);
    for (const allocationOption of allocation.options) {
      const presented = fullAllocation.story.options.find(
        (option) => option.id === allocationOption.id,
      )!;
      const receipt =
        `Benefit: ${allocationOption.trigger_category ?? allocationOption.protects} ` +
        `Cost: ${presented.summary!.immediateCost}. ` +
        `Tradeoff: Leaves exposed: ${allocationOption.leaves_exposed}`;
      expect(presented.consequence).toBe(receipt);
      expect(openingSelectionReceiptWordCount(receipt)).toBeLessThanOrEqual(
        OPENING_SELECTION_RECEIPT_WORD_LIMIT,
      );
    }
  });

  it("bounds the exhaustive-audit worst-case exact June inspection", () => {
    const registration = WORLD.opening_registration;
    const oath = WORLD.opening_relief_oath;
    const source = WORLD.opening_lead_source;
    const preparation = WORLD.opening_preparation;
    const allocation = WORLD.opening_relief_allocation;
    const ally = WORLD.opening_ally;
    if (!registration || !oath || !source || !preparation || !allocation || !ally) {
      throw new Error("expected the complete Albany Station setup");
    }
    const session = new OverworldSession(WORLD);
    session.scoutPoi(session.view().pois[0]!.id);
    session.talkToCharacter(registration.contact);
    session.chooseJourneyStory("albany:unaffiliated_courier", registration.id);
    revealCurrentJourneyStoryOptions(session, oath.id);
    session.chooseJourneyStory("albany:oath_limited_aid_only", oath.id);
    session.chooseJourneyStory("albany:source_hayden_frost_report", source.id);
    moveUiSessionToArea(session, preparation.area);
    session.chooseJourneyStory("albany:prep_relief_protocol", preparation.id);
    session.chooseJourneyStory("albany:relief_cade_fodder", allocation.id);
    session.talkToCharacter(ally.contact);

    const a = api();
    const restored = a.restore_overworld_session({
      compact_context: true,
      snapshot: session.snapshot(),
    });
    const inspected = a.inspect_overworld_session_story({
      session_id: restored.session_id,
      story_choice_id: ally.id,
      option_id: "albany:ally_june_cattle_first",
      compact_context: true,
      compact_result: true,
    });

    expect(inspected).not.toHaveProperty("departure_recap");
    expect(inspected.departure_recap_terms).toBeDefined();
    expect(inspected.story.inspectedOption?.situationalBoundary).toContain(
      "June's help may not trigger.",
    );
    // An exhaustive audit covered all 4*3*3*3*3 = 324 legal Station setups;
    // this setup was the largest exact June response.
    expect(JSON.stringify(inspected).length).toBe(1_834);
    expect(JSON.stringify(inspected).length).toBeLessThanOrEqual(2_048);
  });

  it("makes a pending parent choice the only legal move inside an embedded quest", () => {
    const { a, overworldSessionId, rpgSessionId, checkpoint, checkpointJourney, fullRpgStateHash } =
      mcpWolfWinterCheckpointInsideQuest();
    const checkpointProof = checkpointJourney.decisionProof;
    const checkpointDecision = checkpointJourney.acceptedDecisions;
    const resumedCheckpoint = (Math.floor(checkpointDecision / 40) + 1) * 40;
    const checkpointRpgHash = checkpoint.state_hash;

    const observed = a.get_observation({
      session_id: rpgSessionId,
      compact_observation: false,
    });
    expect(observed.journey).toEqual(checkpointJourney);
    expect(observed.overworld_snapshot_hash).toBe(checkpoint.overworld_snapshot_hash);
    expect(observed.observation.available_actions).toEqual([]);
    expect(
      a.list_legal_actions({ session_id: rpgSessionId, compact_actions: true }).actions,
    ).toEqual([]);

    const blocked = a.step_action({
      session_id: rpgSessionId,
      action_id: "not_a_legal_action",
      compact_observation: false,
      compact_events: false,
    });
    expect(blocked).toMatchObject({
      ok: false,
      journey: { status: "awaiting_choice", acceptedDecisions: checkpointDecision },
      overworld_snapshot_hash: checkpoint.overworld_snapshot_hash,
    });
    expect(blocked.observation.available_actions).toEqual([]);

    const compactPending = a.get_observation({
      session_id: rpgSessionId,
      compact_observation: true,
      include_actions: true,
    });
    expect(compactPending.journey).toEqual({
      status: checkpointJourney.status,
      goal: checkpointJourney.goal,
      acceptedDecisions: checkpointJourney.acceptedDecisions,
      nextCheckpoint: checkpointJourney.nextCheckpoint,
      pendingChoice: checkpointJourney.pendingChoice,
    });
    expect(compactPending.journey).not.toHaveProperty("decisionProof");
    expect(compactPending.context).not.toHaveProperty("actions");

    const continued = a.choose_overworld_session_journey({
      ...FULL_OVERWORLD,
      compact_observation: false,
      session_id: overworldSessionId,
      choice: "continue",
    });
    expect(continued.result.exitReceipt).toBeNull();
    expect(continued.journey).toMatchObject({
      status: "active",
      acceptedDecisions: checkpointDecision,
      nextCheckpoint: resumedCheckpoint,
      pendingChoice: null,
    });
    expect(continued.journey.decisionProof).toEqual(checkpointProof);
    expect(continued.result.retentionEvent).toMatchObject({
      atDecision: checkpointDecision,
      checkpoint: 40,
      choice: "continue",
      decisionProofHash: checkpointProof.hash,
    });
    expect(continued.snapshot_hash).not.toBe(checkpoint.overworld_snapshot_hash);
    expect(continued.rpg_session_id).toBe(rpgSessionId);
    const resumed = continued.rpg_session;
    if (!resumed) throw new Error("expected Continue to resume the embedded quest");
    expectTypeOf(resumed.journey).toEqualTypeOf<JourneyPresentation>();
    expect(resumed).toMatchObject({
      session_id: rpgSessionId,
      state_hash: checkpointRpgHash,
      world_quest_id: "wolf_winter",
      journey: continued.journey,
      overworld_snapshot_hash: continued.snapshot_hash,
    });
    expect(resumed.character_continuity).toMatchObject({
      continuity: "same_campaign_character",
      quest_local_profile: { hp: a.sessions.get(rpgSessionId).state.vars.hp },
    });
    expect(checkpoint).not.toHaveProperty("character_continuity");

    const resumedIds = resumed.observation.available_actions.map((action) => action.id);
    const listed = a.list_legal_actions({ session_id: rpgSessionId, compact_actions: true });
    expect(resumedIds).toEqual(listed.actions);
    expect(resumedIds).toEqual(expect.arrayContaining(["go_north", "go_south"]));
    expect(resumedIds.some((id) => id.includes("yearling_wolf"))).toBe(false);
    for (const staleId of ["go_west", "examine_day_book", "read_day_book", "talk_houndsman"]) {
      expect(resumedIds).not.toContain(staleId);
    }

    const reread = a.get_observation({
      session_id: rpgSessionId,
      compact_observation: false,
    });
    expect(resumed.observation).toEqual(reread.observation);
    expect(resumed.state_hash).toBe(reread.state_hash);
    expect(a.sessions.get(rpgSessionId).stateHash).toBe(fullRpgStateHash);

    // The action returned directly by Continue is executable without guessing or
    // fetching a replacement menu.
    const stepped = a.step_action({
      session_id: rpgSessionId,
      action_id: resumedIds[0]!,
      expected_state_hash: resumed.state_hash,
      compact_observation: true,
      compact_events: true,
    });
    expect(stepped.ok).toBe(true);
    expect(stepped.journey).toMatchObject({
      status: "active",
      acceptedDecisions: checkpointDecision + 1,
    });
    expect(stepped.overworld_snapshot_hash).not.toBe(continued.snapshot_hash);
  });

  it.each([
    { choice: "continue", compact_context: true },
    { choice: "end", compact_context: true },
    { choice: "continue", compact_context: false },
    { choice: "end", compact_context: false },
  ] as const)(
    "journey result projection keeps $choice evidence without a second journey (compact context $compact_context)",
    ({ choice, compact_context }) => {
      const run = mcpWolfWinterCheckpointInsideQuest();
      const before = run.a.get_overworld_session({
        session_id: run.overworldSessionId,
        include_observation: true,
      });
      const response = run.a.choose_overworld_session_journey({
        session_id: run.overworldSessionId,
        choice,
        compact_context,
      });
      const current = run.a.get_overworld_session({
        session_id: run.overworldSessionId,
        include_observation: true,
      });
      expect(response.result).not.toHaveProperty("journey");
      expect(Object.keys(response.result).sort()).toEqual(["exitReceipt", "retentionEvent"]);
      expect(response.journey).toEqual(
        compact_context ? compactJourneyPresentation(current.journey) : current.journey,
      );
      expect(response.snapshot_hash).toBe(current.snapshot_hash);
      expect(response.result.retentionEvent).toEqual(current.journey.retentionHistory.at(-1));
      expect(response.result.retentionEvent).toMatchObject({
        choice,
        atDecision: before.journey.acceptedDecisions,
        decisionProofHash: before.journey.decisionProof.hash,
      });
      expect(current.journey.decisionProof).toEqual(before.journey.decisionProof);
      if (choice === "end") {
        expect(response.result.exitReceipt).toMatchObject({
          acceptedDecisions: before.journey.acceptedDecisions,
          decisionProofHash: before.journey.decisionProof.hash,
          retentionHistory: current.journey.retentionHistory,
        });
        expect(response).not.toHaveProperty("rpg_session");
      } else {
        expect(response.result.exitReceipt).toBeNull();
        expect(response.rpg_session_id).toBe(run.rpgSessionId);
        expect(response.rpg_session?.state_hash).toBe(run.checkpoint.state_hash);
      }
    },
  );

  it.each([true, false] as const)(
    "journey result projection preserves explicit full results (compact context %s)",
    (compact_context) => {
      const run = mcpWolfWinterCheckpointInsideQuest();
      const response = run.a.choose_overworld_session_journey({
        session_id: run.overworldSessionId,
        choice: "continue",
        compact_context,
        compact_result: false,
      });
      const current = run.a.get_overworld_session({
        session_id: run.overworldSessionId,
        include_observation: true,
      });
      expectTypeOf(response.result).toEqualTypeOf<JourneyChoiceResult>();
      expect(response.result.journey).toEqual(current.journey);
      expect(response.result.retentionEvent).toEqual(current.journey.retentionHistory.at(-1));
      expect(response.result.exitReceipt).toBeNull();
      expect(response.rpg_session_id).toBe(run.rpgSessionId);
    },
  );

  it("resumes compact quest context after Continue and never exposes it after End", () => {
    const continuedRun = mcpWolfWinterCheckpointInsideQuest();
    const continued = continuedRun.a.choose_overworld_session_journey({
      session_id: continuedRun.overworldSessionId,
      choice: "continue",
    });
    expect(continued.rpg_session_id).toBe(continuedRun.rpgSessionId);
    const resumed = continued.rpg_session;
    if (!resumed) throw new Error("expected compact Continue to resume the embedded quest");
    expectTypeOf(resumed.journey).toEqualTypeOf<EmbeddedJourneyFocus>();
    expect(resumed.state_hash).toBe(continuedRun.checkpoint.state_hash);
    const fullReread = continuedRun.a.get_observation({
      session_id: continuedRun.rpgSessionId,
      compact_observation: false,
    });
    expect(resumed.context.actions).toEqual(
      fullReread.observation.available_actions.map((action) => action.id),
    );
    const compactReread = continuedRun.a.get_observation({
      session_id: continuedRun.rpgSessionId,
      compact_observation: true,
      include_actions: true,
    });
    expect(resumed.context).toEqual(compactReread.context);
    expect(resumed.journey).toEqual(compactReread.journey);
    expect(compactReread).not.toHaveProperty("character_continuity");
    expect(resumed.journey).toMatchObject({
      status: "active",
      goal: continued.journey.goal,
      acceptedDecisions: continued.journey.acceptedDecisions,
      nextCheckpoint: continued.journey.nextCheckpoint,
    });
    expect(resumed.journey).not.toHaveProperty("decisionProof");
    expect(resumed.journey.pendingChoice).toBeNull();
    expect(continued.journey).toHaveProperty("decisionProof");
    expect(resumed.overworld_snapshot_hash).toBe(continued.snapshot_hash);
    expect(resumed.character_continuity).toMatchObject({
      continuity: "same_campaign_character",
      cross_boundary: "authored_imports_exports_only",
      persistent_record: {
        background: expect.any(String),
        health: { current: expect.any(Number), max: expect.any(Number) },
      },
      quest_local_profile: {
        hp: expect.any(Number),
        attack: expect.any(Number),
        defense: expect.any(Number),
        skills: expect.arrayContaining([
          expect.objectContaining({ id: expect.any(String), value: expect.any(Number) }),
        ]),
        inventory: expect.any(Array),
      },
      applied_campaign_import_effects: expect.any(Array),
      scope_note: EMBEDDED_QUEST_COMPACT_SCOPE_NOTE,
    });
    expect(resumed).not.toHaveProperty("character_continuity_legend");
    expect(continuedRun.checkpoint).not.toHaveProperty("character_continuity");

    const compactUnchanged = continuedRun.a.get_observation({
      session_id: continuedRun.rpgSessionId,
      compact_observation: true,
      if_state_hash: compactReread.state_hash,
    });
    expect(compactUnchanged).toMatchObject({
      unchanged: true,
      journey: { pendingChoice: null },
    });
    if (!("unchanged" in compactUnchanged)) throw new Error("expected compact unchanged read");
    expectTypeOf(compactUnchanged.journey).toEqualTypeOf<EmbeddedJourneyFocus | undefined>();

    const compactActionsUnchanged = continuedRun.a.list_legal_actions({
      session_id: continuedRun.rpgSessionId,
      compact_actions: true,
      if_state_hash: compactReread.state_hash,
    });
    expect(compactActionsUnchanged).toMatchObject({
      unchanged: true,
      journey: { pendingChoice: null },
    });
    if (!("unchanged" in compactActionsUnchanged)) {
      throw new Error("expected compact unchanged action read");
    }
    expectTypeOf(compactActionsUnchanged.journey).toEqualTypeOf<EmbeddedJourneyFocus | undefined>();

    const endedRun = mcpWolfWinterCheckpointInsideQuest();
    const ended = endedRun.a.choose_overworld_session_journey({
      session_id: endedRun.overworldSessionId,
      choice: "end",
    });
    expect(ended.journey.status).toBe("ended");
    expect(ended.result.exitReceipt).not.toBeNull();
    expect(ended).not.toHaveProperty("rpg_session_id");
    expect(ended).not.toHaveProperty("rpg_session");
    expect(endedRun.a.sessions.embeddedJourneyPause(endedRun.overworldSessionId)).toBeNull();
  });

  it("shares one story-choice presentation with the UI and rejects forged embedded authority", () => {
    const uiSession = uiSessionAtAlbanyStoryChoice();
    const uiJourney = uiSession.journey();
    const snapshot = uiSession.snapshot();
    const a = api();
    const restored = a.restore_overworld_session({
      snapshot,
      compact_context: false,
      compact_result: false,
    });

    expect(restored.journey).toEqual(uiJourney);
    expect(
      a.get_overworld_session_context({
        session_id: restored.session_id,
        compact_context: true,
      }).journey,
    ).toEqual(compactJourneyPresentation(uiJourney));
    expect(Object.keys(restored.journey.storyChoice!).sort()).toEqual(["id", "message", "options"]);
    for (const option of restored.journey.storyChoice!.options) {
      expect(Object.keys(option).sort()).toEqual(["consequence", "id", "label"]);
      expect(option.summary).toBeUndefined();
    }
    const compactStory = a.get_overworld_session_context({
      session_id: restored.session_id,
      compact_context: true,
    }).journey.storyChoice;
    expect(
      compactStory?.options.every(
        (option) => option.consequence === JOURNEY_STORY_CHOICE_STAGED_CONSEQUENCE,
      ),
    ).toBe(true);
    const playerChoicePayload = JSON.stringify({
      goal: restored.journey.goal,
      storyChoice: restored.journey.storyChoice,
    });
    expect(playerChoicePayload).not.toMatch(
      /targetQuestId|endingId|ending_held|wolf_winter|content\/rpg|win_conditions|maneuver_/i,
    );

    expect(() =>
      (a.start_world_quest as (args: Record<string, unknown>) => unknown)({
        world_quest_id: "wolf_winter",
        seed: 1,
        overworldSessionId: restored.session_id,
      }),
    ).toThrow(/does not accept embedded field "overworldSessionId"/);
    expect(() => a.rest_overworld_session({ session_id: restored.session_id })).toThrow(
      /Choose the open story option/i,
    );

    const uiBranch = OverworldSession.restore(WORLD, snapshot);
    const uiResult = uiBranch.chooseJourneyStory("send_wagon_to_cade");
    const mcpBranch = a.choose_overworld_session_story({
      session_id: restored.session_id,
      choice: "send_wagon_to_cade",
      compact_context: false,
      compact_result: false,
    });
    expect(mcpBranch.result).toEqual(uiResult);
    expect(mcpBranch.journey).toEqual(uiBranch.journey());
    expect(mcpBranch.journey.storyChoice).toBeNull();
    expect(mcpBranch.journey.goalGuidance).toBe(
      "Next road: Saratoga Springs city. Queensbury town is 2 roads away, about 60 travel minutes.",
    );
    expect(JSON.stringify(mcpBranch.journey.goalGuidance)).not.toMatch(
      /targetQuestId|endingId|wolf_winter|content\/rpg|win_conditions|maneuver_/i,
    );
  });

  it.each(TANNERS_FEVER_ACCOUNTABILITY_CHOICE_IDS)(
    "routes the visible Tanner accountability option %s through the generic handler",
    (choiceId) => {
      const uiSession = uiSessionAtTannersAccountabilityChoice();
      const uiJourney = uiSession.journey();
      const snapshot = uiSession.snapshot();
      expect(uiJourney.storyChoice?.options.map((option) => option.id)).toEqual(
        TANNERS_FEVER_ACCOUNTABILITY_CHOICE_IDS,
      );

      const a = api();
      const restored = a.restore_overworld_session({
        snapshot,
        compact_context: false,
        compact_result: false,
      });
      expect(restored.journey).toEqual(uiJourney);

      const uiBranch = OverworldSession.restore(WORLD, snapshot);
      const uiResult = uiBranch.chooseJourneyStory(choiceId);
      const mcpBranch = a.choose_overworld_session_story({
        session_id: restored.session_id,
        choice: choiceId,
        compact_context: false,
        compact_result: false,
      });

      expect(mcpBranch.result).toEqual(uiResult);
      expect(mcpBranch.result).toMatchObject({
        storyChoiceId: TANNERS_FEVER_ACCOUNTABILITY_ID,
        choiceId,
        journeyDecision: { countsTowardJourney: true, reason: "situation_changed" },
      });
      expect(mcpBranch.journey).toEqual(uiBranch.journey());
      expect(mcpBranch.journey.storyChoice).toBeNull();
      expect(JSON.stringify({ result: mcpBranch.result, journey: mcpBranch.journey })).not.toMatch(
        /targetQuestId|targetTownId|targetAreaId|questOutcomeIds|endingId|content\/rpg/i,
      );
    },
  );
});
