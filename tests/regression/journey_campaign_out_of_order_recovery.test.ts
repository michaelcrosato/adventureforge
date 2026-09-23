/**
 * Regression for the out-of-order campaign dead-end: nothing gates quest access by the
 * active journey goal, so a player can complete a later campaign quest (tanners_fever,
 * breaking_weir) while an earlier goal is still active. Continuing past the earlier
 * goal's completion then found no next goal — nextJourneyCampaignGoal needed a story
 * choice that only presented when the CURRENT goal's identity matched — and the
 * campaign silently dead-ended forever, surviving save/restore. The presentation now
 * falls back to the campaign step derived from completed quests, so the required story
 * choice presents at whichever goal the player actually continues from.
 */
import { describe, expect, it } from "vitest";

import {
  ROME_POST_WEIR_DISPATCH_ID,
  TANNERS_FEVER_ACCOUNTABILITY_CHOICE_IDS,
  TANNERS_FEVER_ACCOUNTABILITY_CONTEXT,
  TANNERS_FEVER_ACCOUNTABILITY_GOALS,
  TANNERS_FEVER_ACCOUNTABILITY_ID,
  TANNERS_FEVER_ACCOUNTABILITY_TEASER,
} from "../../src/world/journey_campaign.js";
import { planOverworldRoute } from "./support/overworld_queries.js";
import { OverworldSession } from "../../src/world/session.js";
import { loadOverworldManifest } from "../../src/world/source.js";
import { revealCurrentJourneyStoryOptions } from "./support/journey_story.js";

const WORLD = loadOverworldManifest(process.cwd());

function continueAtFixedCheckpoint(session: OverworldSession): void {
  const pending = session.journey().pendingChoice;
  if (!pending) return;
  expect(pending.reasons).toContain("checkpoint");
  expect(pending.reasons).not.toContain("goal_completed");
  session.chooseJourney("continue");
}

function moveToArea(session: OverworldSession, destinationAreaId: string): void {
  const route = session
    .view()
    .areaExits.find((candidate) => candidate.destination.id === destinationAreaId);
  if (!route) throw new Error(`Expected a visible area route to ${destinationAreaId}.`);
  session.moveArea(route.id);
  continueAtFixedCheckpoint(session);
}

function travelToTown(session: OverworldSession, destinationTownId: string): void {
  const route = planOverworldRoute(WORLD, session.view().current.id, destinationTownId);
  if (!route) throw new Error(`Expected a road route to ${destinationTownId}.`);
  for (const step of route.steps) {
    session.travel(step.edge.id);
    continueAtFixedCheckpoint(session);
    if (session.view().pendingRoadEncounter) {
      session.resolveRoadEncounter("press_on");
      continueAtFixedCheckpoint(session);
    }
  }
}

function completeQuestAt(
  session: OverworldSession,
  townId: string,
  questId: string,
  endingId: string,
  endingTitle: string,
): void {
  travelToTown(session, townId);
  session.exploreArea(`${townId}__civic_core`);
  continueAtFixedCheckpoint(session);
  moveToArea(session, `${townId}__market`);
  session.startQuest(questId);
  session.completeQuest(questId, { endingId, endingTitle, death: false });
}

function startCampaignThroughDispatch(): OverworldSession {
  const session = new OverworldSession(WORLD);
  session.scoutPoi("albany_city__civic_core__poi");
  session.talkToCharacter("albany_city__civic_core__contact");
  session.chooseJourneyStory("albany:ledger_advocate");
  revealCurrentJourneyStoryOptions(session, WORLD.opening_relief_oath!.id);
  session.chooseJourneyStory("albany:oath_limited_aid_only");
  session.chooseJourneyStory("albany:source_rowan_civic_docket");
  moveToArea(session, WORLD.opening_preparation!.area);
  expect(session.journey().storyChoice).toBeNull();
  expect(session.view().departureInteractions.map((interaction) => interaction.id)).toEqual([
    "albany:wolf_preparation",
    "albany:wolf_relief_allocation",
  ]);
  session.chooseJourneyStory("albany:prep_works_fortification");
  expect(session.journey().storyChoice).toBeNull();
  expect(session.view().departureInteractions.map((interaction) => interaction.id)).toEqual([
    "albany:wolf_relief_allocation",
  ]);
  session.chooseJourneyStory("albany:relief_resident_shelter");
  moveToArea(session, "albany_city__market");
  session.scoutPoi("albany_city__market__poi");
  moveToArea(session, "albany_city__transport_hub");
  session.startQuest("wolf_winter", "albany:wolf_approach_sheltered_stockway");
  session.completeQuest("wolf_winter", {
    endingId: "ending_held_timber_saved",
    endingTitle: "The Byre Held, Paling Timber Saved",
    death: false,
  });
  session.chooseJourney("continue");
  session.chooseJourneyStory("send_wagon_to_cade");
  return session;
}

describe("journey campaign out-of-order recovery", () => {
  it("presents the accountability choice when tanners_fever completed before the gallowmere goal", () => {
    const session = startCampaignThroughDispatch();

    completeQuestAt(
      session,
      "oneonta_city",
      "tanners_fever",
      "ending_recovered",
      "The Meadowsweet",
    );
    expect(session.journey().goal.status).toBe("active");

    completeQuestAt(
      session,
      "queensbury_town",
      "gallowmere",
      "ending_hunt_won",
      "The Gallowmere Hunt Won",
    );
    const pending = session.journey().pendingChoice;
    expect(pending?.reasons).toContain("goal_completed");
    expect(pending?.message).toContain(TANNERS_FEVER_ACCOUNTABILITY_CONTEXT);
    expect(pending?.message).toContain(TANNERS_FEVER_ACCOUNTABILITY_TEASER);

    session.chooseJourney("continue");
    const storyChoice = session.journey().storyChoice;
    expect(storyChoice?.id).toBe(TANNERS_FEVER_ACCOUNTABILITY_ID);
    expect(storyChoice?.options.map((option) => option.id)).toEqual([
      ...TANNERS_FEVER_ACCOUNTABILITY_CHOICE_IDS,
    ]);

    const restored = OverworldSession.restore(WORLD, session.snapshot());
    expect(restored.journey().storyChoice?.id).toBe(TANNERS_FEVER_ACCOUNTABILITY_ID);

    const choiceId = TANNERS_FEVER_ACCOUNTABILITY_CHOICE_IDS[0];
    const result = session.chooseJourneyStory(choiceId);
    expect(result.storyChoiceId).toBe(TANNERS_FEVER_ACCOUNTABILITY_ID);
    expect(session.journey().goal).toMatchObject({
      id: TANNERS_FEVER_ACCOUNTABILITY_GOALS[choiceId].id,
      status: "active",
    });
    expect(session.journey().storyChoice).toBeNull();
  });

  it("self-recovers when gallowmere is completed before wolf_winter (dispatch goal re-completes)", () => {
    const session = new OverworldSession(WORLD);
    // Discover the Albany leads first, then finish gallowmere before ever starting
    // wolf_winter — nothing gates quest access by the active journey goal.
    session.scoutPoi("albany_city__civic_core__poi");
    session.talkToCharacter("albany_city__civic_core__contact");
    session.chooseJourneyStory("albany:ledger_advocate");
    revealCurrentJourneyStoryOptions(session, WORLD.opening_relief_oath!.id);
    session.chooseJourneyStory("albany:oath_limited_aid_only");
    session.chooseJourneyStory("albany:source_rowan_civic_docket");
    moveToArea(session, WORLD.opening_preparation!.area);
    expect(session.journey().storyChoice).toBeNull();
    expect(session.view().departureInteractions.map((interaction) => interaction.id)).toEqual([
      "albany:wolf_preparation",
      "albany:wolf_relief_allocation",
    ]);
    session.chooseJourneyStory("albany:prep_works_fortification");
    expect(session.journey().storyChoice).toBeNull();
    expect(session.view().departureInteractions.map((interaction) => interaction.id)).toEqual([
      "albany:wolf_relief_allocation",
    ]);
    session.chooseJourneyStory("albany:relief_resident_shelter");
    moveToArea(session, "albany_city__market");
    session.scoutPoi("albany_city__market__poi");
    completeQuestAt(
      session,
      "queensbury_town",
      "gallowmere",
      "ending_hunt_won",
      "The Gallowmere Hunt Won",
    );
    expect(session.journey().goal.status).toBe("active");

    travelToTown(session, "albany_city");
    moveToArea(session, "albany_city__transport_hub");
    session.startQuest("wolf_winter", "albany:wolf_approach_sheltered_stockway");
    session.completeQuest("wolf_winter", {
      endingId: "ending_held_timber_saved",
      endingTitle: "The Byre Held, Paling Timber Saved",
      death: false,
    });
    expect(session.journey().pendingChoice?.reasons).toContain("goal_completed");

    // The dispatch story must still present: its decision is a campaign beat even
    // though its goal's target quest is already complete.
    session.chooseJourney("continue");
    const storyChoice = session.journey().storyChoice;
    expect(storyChoice).not.toBeNull();

    // Choosing it activates an already-complete goal, which immediately re-completes
    // and re-prompts; continuing then auto-activates the Tanner's Fever goal.
    session.chooseJourneyStory("send_wagon_to_cade");
    expect(session.journey().pendingChoice?.reasons).toContain("goal_completed");
    session.chooseJourney("continue");
    expect(session.journey().goal).toMatchObject({
      id: "oneonta_tanners_fever",
      status: "active",
    });
    expect(session.journey().storyChoice).toBeNull();
  });

  it("presents the Rome dispatch choice when breaking_weir also completed before the gallowmere goal", () => {
    const session = startCampaignThroughDispatch();

    completeQuestAt(
      session,
      "oneonta_city",
      "tanners_fever",
      "ending_recovered",
      "The Meadowsweet",
    );
    completeQuestAt(
      session,
      "rome_city",
      "breaking_weir",
      "ending_fields_held_race_spent",
      "The Fields Held, the Race Spent",
    );
    expect(session.journey().goal.status).toBe("active");

    completeQuestAt(
      session,
      "queensbury_town",
      "gallowmere",
      "ending_hunt_won",
      "The Gallowmere Hunt Won",
    );
    expect(session.journey().pendingChoice?.reasons).toContain("goal_completed");

    session.chooseJourney("continue");
    const storyChoice = session.journey().storyChoice;
    expect(storyChoice?.id).toBe(ROME_POST_WEIR_DISPATCH_ID);

    session.chooseJourneyStory("take_oswego_charter_packet");
    expect(session.journey().goal.status).toBe("active");
    expect(session.journey().storyChoice).toBeNull();
  });
});
