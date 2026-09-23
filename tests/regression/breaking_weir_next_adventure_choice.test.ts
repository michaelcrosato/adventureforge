/**
 * Regression for bug_0517: completing The Breaking Weir used to advance directly to
 * The Advocate's Case. The game now keeps the honest Continue/End retention decision,
 * then lets players who continue choose whether the Oswego or Greece packet goes first.
 */
import { describe, expect, it } from "vitest";

import { JOURNEY_STORY_CHOICE_STAGED_CONSEQUENCE } from "../../src/mcp/journey_projection.js";
import { createToolApi } from "../../src/mcp/tools.js";
import {
  BREAKING_WEIR_CAMPAIGN_OUTCOMES,
  ROME_POST_WEIR_DISPATCH_CHOICE_IDS,
  ROME_POST_WEIR_DISPATCH_GOALS,
  ROME_POST_WEIR_DISPATCH_ID,
  ROME_POST_WEIR_DISPATCH_TEASER,
  TANNERS_FEVER_ACCOUNTABILITY_GOALS,
  journeyCampaignGoalDefinition,
  type RomePostWeirDispatchChoiceId,
} from "../../src/world/journey_campaign.js";
import { planOverworldRoute } from "./support/overworld_queries.js";
import { OverworldSession } from "../../src/world/session.js";
import { loadOverworldManifest } from "../../src/world/source.js";
import { revealCurrentJourneyStoryOptions } from "./support/journey_story.js";

const WORLD = loadOverworldManifest(process.cwd());

const FIRST_PACKET_ROUTES = Object.freeze({
  take_oswego_charter_packet: Object.freeze({
    townId: "oswego_city",
    civicAreaId: "oswego_city__civic_core",
    marketAreaId: "oswego_city__market",
    questId: "advocates_case",
    endingId: "ending_exempted",
    endingTitle: "The Charter Upheld",
    deferredGoalId: "greece_cold_forge",
  }),
  take_greece_forge_packet: Object.freeze({
    townId: "greece_town",
    civicAreaId: "greece_town__civic_core",
    marketAreaId: "greece_town__market",
    questId: "cold_forge",
    endingId: "ending_victory",
    endingTitle: "Keeper of the Ember",
    deferredGoalId: "oswego_advocates_case",
  }),
} as const satisfies Record<
  RomePostWeirDispatchChoiceId,
  Readonly<{
    townId: string;
    civicAreaId: string;
    marketAreaId: string;
    questId: string;
    endingId: string;
    endingTitle: string;
    deferredGoalId: string;
  }>
>);

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

function reachBreakingWeirGoalCompletion(): OverworldSession {
  const session = new OverworldSession(WORLD);

  session.scoutPoi("albany_city__civic_core__poi");
  session.talkToCharacter("albany_city__civic_core__contact");
  session.chooseJourneyStory("albany:ledger_advocate");
  revealCurrentJourneyStoryOptions(session, WORLD.opening_relief_oath!.id);
  session.chooseJourneyStory("albany:oath_limited_aid_only");
  session.chooseJourneyStory("albany:source_rowan_civic_docket");
  moveToArea(session, WORLD.opening_preparation!.area);
  expect(session.journey().storyChoice).toBeNull();
  expect(session.view().departureInteractions.map(({ id, kind }) => [id, kind])).toEqual([
    ["albany:wolf_preparation", "preparation"],
    ["albany:wolf_relief_allocation", "relief_allocation"],
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

  travelToTown(session, "queensbury_town");
  session.exploreArea("queensbury_town__civic_core");
  continueAtFixedCheckpoint(session);
  moveToArea(session, "queensbury_town__market");
  session.startQuest("gallowmere");
  session.completeQuest("gallowmere", {
    endingId: "ending_hunt_won",
    endingTitle: "The Gallowmere Hunt Won",
    death: false,
  });
  session.chooseJourney("continue");

  travelToTown(session, "oneonta_city");
  session.exploreArea("oneonta_city__civic_core");
  continueAtFixedCheckpoint(session);
  moveToArea(session, "oneonta_city__market");
  session.startQuest("tanners_fever");
  session.completeQuest("tanners_fever", {
    endingId: "ending_recovered",
    endingTitle: "The Meadowsweet",
    death: false,
  });
  session.chooseJourney("continue");
  session.chooseJourneyStory("keep_household_correction");

  travelToTown(session, "rome_city");
  session.exploreArea("rome_city__civic_core");
  continueAtFixedCheckpoint(session);
  moveToArea(session, "rome_city__market");
  session.startQuest("breaking_weir");
  session.completeQuest("breaking_weir", {
    endingId: "ending_fields_held_race_spent",
    endingTitle: "The Fields Held, the Old Race Spent",
    death: false,
  });

  expect(session.journey()).toMatchObject({
    status: "awaiting_choice",
    goal: {
      id: TANNERS_FEVER_ACCOUNTABILITY_GOALS.keep_household_correction.id,
      status: "completed",
    },
    pendingChoice: { reasons: expect.arrayContaining(["goal_completed"]) },
    storyChoice: null,
  });
  return session;
}

function finishSelectedFirstPacket(
  session: OverworldSession,
  choiceId: RomePostWeirDispatchChoiceId,
): void {
  const route = FIRST_PACKET_ROUTES[choiceId];
  continueAtFixedCheckpoint(session);
  travelToTown(session, route.townId);
  session.exploreArea(route.civicAreaId);
  continueAtFixedCheckpoint(session);
  moveToArea(session, route.marketAreaId);
  session.startQuest(route.questId);
  session.completeQuest(route.questId, {
    endingId: route.endingId,
    endingTitle: route.endingTitle,
    death: false,
  });
  expect(session.journey()).toMatchObject({
    status: "awaiting_choice",
    goal: { id: ROME_POST_WEIR_DISPATCH_GOALS[choiceId].id, status: "completed" },
    pendingChoice: { reasons: expect.arrayContaining(["goal_completed"]) },
  });
  session.chooseJourney("continue");
  expect(session.journey()).toMatchObject({
    status: "active",
    goal: { id: route.deferredGoalId, status: "active" },
    storyChoice: null,
  });
}

const FOLLOWUP_ENDINGS = Object.freeze({
  advocates_case: Object.freeze({
    endingId: "ending_exempted",
    endingTitle: "The Charter Upheld",
  }),
  cold_forge: Object.freeze({
    endingId: "ending_victory",
    endingTitle: "Keeper of the Ember",
  }),
  dawn_beacon: Object.freeze({
    endingId: "ending_lit",
    endingTitle: "The Beacon Lit",
  }),
  factors_mark: Object.freeze({
    endingId: "ending_cleared",
    endingTitle: "The Mark Cleared",
  }),
  falconers_ransom: Object.freeze({
    endingId: "ending_cleared",
    endingTitle: "The Ransom Cleared",
  }),
} as const);

function finishActiveFollowupQuest(session: OverworldSession): void {
  const definition = journeyCampaignGoalDefinition(session.journey().goal);
  if (!definition) throw new Error("Expected an active canonical campaign goal.");
  const ending = FOLLOWUP_ENDINGS[definition.targetQuestId as keyof typeof FOLLOWUP_ENDINGS];
  if (!ending) {
    throw new Error(`No test ending is configured for ${definition.targetQuestId}.`);
  }
  travelToTown(session, definition.targetTownId);
  moveToArea(session, definition.targetAreaId);
  session.startQuest(definition.targetQuestId);
  continueAtFixedCheckpoint(session);
  session.completeQuest(definition.targetQuestId, {
    ...ending,
    death: false,
  });
  expect(session.journey().pendingChoice?.reasons).toContain("goal_completed");
  session.chooseJourney("continue");
}

describe("Breaking Weir next-adventure dispatch", () => {
  it("offers a genuine Continue/End choice and records an honest exit without selecting a packet", () => {
    const session = reachBreakingWeirGoalCompletion();
    const pending = session.journey().pendingChoice;
    expect(pending?.message).toContain(
      BREAKING_WEIR_CAMPAIGN_OUTCOMES.ending_fields_held_race_spent.romeDispatchContext,
    );
    expect(pending?.message).toContain(ROME_POST_WEIR_DISPATCH_TEASER);
    expect(pending?.options.map((option) => option.id)).toEqual(["continue", "end"]);
    expect(pending?.options.find((option) => option.id === "continue")?.consequence).toContain(
      "choose which live packet you carry first",
    );

    const exited = OverworldSession.restore(WORLD, session.snapshot());
    const result = exited.chooseJourney("end");
    expect(result.retentionEvent).toMatchObject({
      choice: "end",
      reasons: expect.arrayContaining(["goal_completed"]),
    });
    expect(result.exitReceipt).toMatchObject({
      exitReason: "player_ended_at_choice",
      goalId: TANNERS_FEVER_ACCOUNTABILITY_GOALS.keep_household_correction.id,
      goalStatus: "completed",
      exitReasons: expect.arrayContaining(["goal_completed"]),
    });
    expect(exited.journey()).toMatchObject({ status: "ended", storyChoice: null });
    expect(JSON.stringify(exited.snapshot().journalEntries)).not.toMatch(
      /take_oswego_charter_packet|take_greece_forge_packet|oswego_advocates_case_first|greece_cold_forge_first/i,
    );
  });

  it("presents the story only after Continue and preserves either selected-first branch", () => {
    const continued = reachBreakingWeirGoalCompletion();
    const completionSnapshot = continued.snapshot();
    const acceptedAtCompletion = continued.journey().acceptedDecisions;
    const currentGoalAtCompletion = continued.journey().goal;
    const continuation = continued.chooseJourney("continue");

    expect(continuation.retentionEvent).toMatchObject({
      choice: "continue",
      reasons: expect.arrayContaining(["goal_completed"]),
    });
    expect(continued.journey().acceptedDecisions).toBe(acceptedAtCompletion);
    expect(continued.journey().goal).toEqual(currentGoalAtCompletion);
    expect(continued.snapshot().journalEntries).toEqual(completionSnapshot.journalEntries);

    const visible = continued.journey().storyChoice;
    expect(visible).toMatchObject({ id: ROME_POST_WEIR_DISPATCH_ID });
    expect(visible?.options.map((option) => option.id)).toEqual(ROME_POST_WEIR_DISPATCH_CHOICE_IDS);
    expect(Object.keys(visible!).sort()).toEqual(["id", "message", "options"]);
    for (const option of visible!.options) {
      expect(Object.keys(option).sort()).toEqual(["consequence", "id", "label"]);
    }
    expect(JSON.stringify(visible)).not.toMatch(
      /targetQuestId|targetTownId|targetAreaId|questOutcomeIds|endingId|content\/rpg|win_conditions|solution|maneuver_/i,
    );

    const blockedHash = continued.snapshotHash();
    expect(() => continued.restAtTown()).toThrow(/choose the open story option/i);
    expect(continued.snapshotHash()).toBe(blockedHash);

    const choiceSnapshot = continued.snapshot();
    for (const choiceId of ROME_POST_WEIR_DISPATCH_CHOICE_IDS) {
      const branch = OverworldSession.restore(WORLD, choiceSnapshot);
      expect(branch.journey().storyChoice).toEqual(visible);
      const before = branch.snapshot();
      const selected = branch.chooseJourneyStory(choiceId);
      const after = branch.snapshot();
      const expectedGoal = ROME_POST_WEIR_DISPATCH_GOALS[choiceId];
      const expectedOption = visible!.options.find((option) => option.id === choiceId)!;

      expect(selected).toMatchObject({
        storyChoiceId: ROME_POST_WEIR_DISPATCH_ID,
        choiceId,
        consequence: expectedOption.consequence,
        goal: { id: expectedGoal.id, text: expectedGoal.text, status: "active" },
        journeyDecision: { countsTowardJourney: true, reason: "situation_changed" },
      });
      expect(after.journey.acceptedDecisions).toBe(before.journey.acceptedDecisions + 1);
      expect({
        minutes: after.minutes,
        supplies: after.supplies,
        fatigue: after.fatigue,
        regionRenown: after.regionRenown,
      }).toEqual({
        minutes: before.minutes,
        supplies: before.supplies,
        fatigue: before.fatigue,
        regionRenown: before.regionRenown,
      });
      expect(selected.entry).toMatchObject({
        kind: "campaign",
        title: expectedOption.label,
        text: expectedOption.consequence,
      });
      expect(after.journalEntries).toContainEqual(selected.entry);
      expect(branch.journey().storyChoice).toBeNull();
      expect(OverworldSession.restore(WORLD, after).snapshot()).toEqual(after);

      finishSelectedFirstPacket(branch, choiceId);
    }
  });

  it("stages the private choice in compact MCP and reveals only one inspected branch", () => {
    const session = reachBreakingWeirGoalCompletion();
    session.chooseJourney("continue");
    const humanJourney = session.journey();
    const api = createToolApi({ root: process.cwd() });
    const restored = api.restore_overworld_session({
      snapshot: session.snapshot(),
      compact_context: false,
      compact_result: false,
    });

    expect(restored.journey).toEqual(humanJourney);
    const compactJourney = api.get_overworld_session_context({
      session_id: restored.session_id,
      compact_context: true,
    }).journey;
    const { storyChoice: humanStory, ...humanWithoutStory } = humanJourney;
    const { storyChoice: compactStory, ...compactWithoutStory } = compactJourney;
    expect(compactWithoutStory).toEqual(humanWithoutStory);
    expect(compactStory).toMatchObject({
      id: ROME_POST_WEIR_DISPATCH_ID,
      message: humanStory!.message,
    });
    expect(compactStory!.options).toEqual(
      humanStory!.options.map((option) => ({
        ...option,
        consequence: JOURNEY_STORY_CHOICE_STAGED_CONSEQUENCE,
      })),
    );

    const selectedOption = humanStory!.options[0]!;
    const siblingOption = humanStory!.options[1]!;
    const beforeInspection = api.export_overworld_session({
      session_id: restored.session_id,
    });
    const inspection = api.inspect_overworld_session_story({
      session_id: restored.session_id,
      story_choice_id: humanStory!.id,
      option_id: selectedOption.id,
    });
    expect(inspection.story.inspectedOption).toEqual(selectedOption);
    expect(inspection.story).not.toHaveProperty("message");
    expect(inspection.story).not.toHaveProperty("options");
    expect(JSON.stringify(inspection.story)).not.toContain(siblingOption.consequence);
    expect(api.export_overworld_session({ session_id: restored.session_id })).toEqual(
      beforeInspection,
    );

    expect(() => api.rest_overworld_session({ session_id: restored.session_id })).toThrow(
      /choose the open story option/i,
    );
    expect(JSON.stringify(restored.journey.storyChoice)).not.toMatch(
      /targetQuestId|targetTownId|targetAreaId|questOutcomeIds|endingId|content\/rpg|win_conditions|solution|maneuver_/i,
    );
  });

  it("replays a canonical action from the remote New York Waterfront anchor", () => {
    const session = reachBreakingWeirGoalCompletion();
    session.chooseJourney("continue");
    session.chooseJourneyStory("take_oswego_charter_packet");
    finishSelectedFirstPacket(session, "take_oswego_charter_packet");
    finishActiveFollowupQuest(session); // Cold Forge
    finishActiveFollowupQuest(session); // Dawn Beacon
    finishActiveFollowupQuest(session); // Factor's Mark
    finishActiveFollowupQuest(session); // Falconer's Ransom

    expect(session.journey().goal).toMatchObject({
      id: "new_york_tide_mill",
      status: "active",
    });
    travelToTown(session, "new_york_city");
    expect(
      session
        .view()
        .areas.map((area) => area.id)
        .filter((areaId) => areaId.startsWith("new_york_city__")),
    ).toEqual(["new_york_city__civic_core", "new_york_city__waterfront"]);

    moveToArea(session, "new_york_city__waterfront");
    const scouted = session.scoutPoi("new_york_city__waterfront__poi");
    expect(scouted.discoveredAreas?.map((area) => area.id)).toEqual(["new_york_city__market"]);
    expect(session.snapshot().startedQuestIds).not.toContain("tide_mill");

    const snapshot = session.snapshot();
    expect(OverworldSession.restore(WORLD, snapshot).snapshot()).toEqual(snapshot);
  });
});
