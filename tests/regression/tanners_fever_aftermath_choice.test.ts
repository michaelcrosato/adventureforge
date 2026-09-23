/**
 * Regression for bug_0513: finishing Tanner's Fever previously advanced straight to an
 * unrelated Rome packet. The goal-completion retention choice now truthfully previews a
 * consequential Oneonta accountability decision; only players who continue make it.
 */
import { describe, expect, it } from "vitest";

import { JOURNEY_STORY_CHOICE_STAGED_CONSEQUENCE } from "../../src/mcp/journey_projection.js";
import { createToolApi } from "../../src/mcp/tools.js";
import {
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

function moveToArea(session: OverworldSession, destinationAreaId: string): void {
  const route = session
    .view()
    .areaExits.find((candidate) => candidate.destination.id === destinationAreaId);
  if (!route) throw new Error(`Expected a visible area route to ${destinationAreaId}.`);
  session.moveArea(route.id);
  continueAtFixedCheckpoint(session);
}

function continueAtFixedCheckpoint(session: OverworldSession): void {
  const pending = session.journey().pendingChoice;
  if (!pending) return;
  expect(pending.reasons).toContain("checkpoint");
  expect(pending.reasons).not.toContain("goal_completed");
  session.chooseJourney("continue");
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

function reachTannersGoalCompletion(): OverworldSession {
  const session = new OverworldSession(WORLD);

  session.scoutPoi("albany_city__civic_core__poi");
  session.talkToCharacter("albany_city__civic_core__contact");
  session.chooseJourneyStory("albany:ledger_advocate");
  revealCurrentJourneyStoryOptions(session, WORLD.opening_relief_oath!.id);
  session.chooseJourneyStory("albany:oath_limited_aid_only");
  session.chooseJourneyStory("albany:source_rowan_civic_docket");
  moveToArea(session, WORLD.opening_preparation!.area);
  expect(session.view().departureInteractions[0]?.kind).toBe("preparation");
  session.chooseJourneyStory("albany:prep_works_fortification");
  expect(session.view().departureInteractions[0]?.kind).toBe("relief_allocation");
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

  expect(session.journey()).toMatchObject({
    status: "awaiting_choice",
    goal: { id: "oneonta_tanners_fever", status: "completed" },
    pendingChoice: { reasons: ["goal_completed"], checkpoint: null },
    storyChoice: null,
  });
  expect(session.journey().acceptedDecisions).toBeLessThan(40);
  return session;
}

describe("Tanner's Fever accountability aftermath", () => {
  it("offers the game-native continue/end choice early and records an honest exit", () => {
    const session = reachTannersGoalCompletion();
    const pending = session.journey().pendingChoice;
    expect(pending?.message).toContain(TANNERS_FEVER_ACCOUNTABILITY_CONTEXT);
    expect(pending?.message).toContain(TANNERS_FEVER_ACCOUNTABILITY_TEASER);
    expect(pending?.options.map((option) => option.id)).toEqual(["continue", "end"]);
    expect(pending?.options.find((option) => option.id === "continue")?.consequence).toContain(
      "decide how Oneonta records the corrected dose",
    );

    const exited = OverworldSession.restore(WORLD, session.snapshot());
    const result = exited.chooseJourney("end");
    expect(result.retentionEvent).toMatchObject({
      choice: "end",
      reasons: ["goal_completed"],
    });
    expect(result.exitReceipt).toMatchObject({
      exitReason: "player_ended_at_choice",
      goalId: "oneonta_tanners_fever",
      goalStatus: "completed",
      exitReasons: ["goal_completed"],
    });
    expect(exited.journey()).toMatchObject({ status: "ended", storyChoice: null });
    expect(JSON.stringify(exited.snapshot().journalEntries)).not.toMatch(
      /household record|dosage warning/i,
    );
  });

  it("shows only the human-visible choice after continue and preserves either branch", () => {
    const continued = reachTannersGoalCompletion();
    const acceptedAtCompletion = continued.journey().acceptedDecisions;
    const continuation = continued.chooseJourney("continue");
    expect(continuation.retentionEvent).toMatchObject({
      choice: "continue",
      reasons: ["goal_completed"],
    });
    expect(continued.journey().acceptedDecisions).toBe(acceptedAtCompletion);

    const visible = continued.journey().storyChoice;
    expect(visible).toMatchObject({ id: TANNERS_FEVER_ACCOUNTABILITY_ID });
    expect(visible?.options.map((option) => option.id)).toEqual(
      TANNERS_FEVER_ACCOUNTABILITY_CHOICE_IDS,
    );
    expect(Object.keys(visible!).sort()).toEqual(["id", "message", "options"]);
    for (const option of visible!.options) {
      expect(Object.keys(option).sort()).toEqual(["consequence", "id", "label"]);
    }
    expect(JSON.stringify(visible)).not.toMatch(
      /targetQuestId|targetTownId|targetAreaId|questOutcomeIds|endingId|content\/rpg|solution/i,
    );

    const choiceSnapshot = continued.snapshot();
    const branchResults = TANNERS_FEVER_ACCOUNTABILITY_CHOICE_IDS.map((choiceId) => {
      const branch = OverworldSession.restore(WORLD, choiceSnapshot);
      const before = branch.snapshot();
      const selected = branch.chooseJourneyStory(choiceId);
      const after = branch.snapshot();
      const expectedGoal = TANNERS_FEVER_ACCOUNTABILITY_GOALS[choiceId];

      expect(selected).toMatchObject({
        storyChoiceId: TANNERS_FEVER_ACCOUNTABILITY_ID,
        choiceId,
        goal: { id: expectedGoal.id, status: "active" },
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
        title: visible!.options.find((option) => option.id === choiceId)!.label,
        text: visible!.options.find((option) => option.id === choiceId)!.consequence,
      });
      expect(branch.journey().storyChoice).toBeNull();
      expect(OverworldSession.restore(WORLD, after).snapshot()).toEqual(after);
      return { selected, after };
    });

    expect(branchResults[0]!.selected.goal.id).not.toBe(branchResults[1]!.selected.goal.id);
    expect(branchResults[0]!.selected.entry.text).not.toBe(branchResults[1]!.selected.entry.text);
  });

  it("stages the choice in compact MCP and reveals only one inspected branch", () => {
    const session = reachTannersGoalCompletion();
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
      id: TANNERS_FEVER_ACCOUNTABILITY_ID,
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
  });
});
