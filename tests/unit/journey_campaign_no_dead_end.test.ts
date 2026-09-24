/**
 * Exhaustive no-dead-end proof for campaign progression. Quests are not gated by the
 * active journey goal, so ANY subset of campaign quests can be complete when a goal's
 * continue is chosen. For every one of the 2^12 completion subsets this pins the
 * three-way total split the session relies on (session.ts chooseJourney + the
 * journeyCampaignPresentationContext fallback):
 *
 *   - campaign not started (wolf_winter incomplete): no next goal, no story step —
 *     the initial journey goal itself is the pending work;
 *   - campaign exhausted (every ordered post-Weir target complete): both null;
 *   - otherwise EXACTLY ONE of nextJourneyCampaignGoal (auto-activation) or
 *     journeyCampaignPendingStoryStep (a story choice must present) is available.
 *
 * If a future goal/quest edit breaks this split, the campaign can silently dead-end
 * at a continue again (the out-of-order campaign recovery bug).
 */
import { describe, expect, it } from "vitest";

import {
  JOURNEY_CAMPAIGN_INITIAL_QUEST_ID,
  JOURNEY_CAMPAIGN_QUEST_ORDER,
  journeyCampaignPendingStoryStep,
  journeyCampaignStoryChoiceSelection,
  nextJourneyCampaignGoal,
  romePostWeirDispatchStoryChoice,
  tannersFeverAccountabilityStoryChoice,
} from "../../src/world/journey_campaign.js";

const QUESTS = [...JOURNEY_CAMPAIGN_QUEST_ORDER];

function subsetAt(mask: number): ReadonlySet<string> {
  const set = new Set<string>();
  for (let bit = 0; bit < QUESTS.length; bit += 1) {
    if (mask & (1 << bit)) set.add(QUESTS[bit]!);
  }
  return set;
}

describe("journey campaign never dead-ends", () => {
  it("every completion subset yields exactly one of: next goal, story step, or a terminal state", () => {
    expect(QUESTS.length).toBe(12);
    let autoActivations = 0;
    let storySteps = 0;
    let terminals = 0;
    for (let mask = 0; mask < 1 << QUESTS.length; mask += 1) {
      const completed = subsetAt(mask);
      const next = nextJourneyCampaignGoal({ completedQuestIds: completed });
      const step = journeyCampaignPendingStoryStep(completed);

      if (!completed.has(JOURNEY_CAMPAIGN_INITIAL_QUEST_ID)) {
        // The initial journey goal is still the live objective; progression is idle.
        expect(next).toBeNull();
        expect(step).toBeNull();
        continue;
      }
      // The campaign is exhausted only when every campaign quest is complete; any
      // missing quest still owes the player either an auto goal or a story step.
      const exhausted = QUESTS.every((quest) => completed.has(quest));
      if (exhausted) {
        terminals += 1;
        expect(next).toBeNull();
        expect(step).toBeNull();
        continue;
      }
      // Not terminal: exactly one progression path must exist — a null/null pair here
      // is the silent dead-end class, and a both-non-null pair would double-present.
      expect(next === null).not.toBe(step === null);
      if (next) autoActivations += 1;
      if (step) storySteps += 1;
    }
    // Anti-vacuity: all three regimes were actually exercised.
    expect(autoActivations).toBeGreaterThan(0);
    expect(storySteps).toBeGreaterThan(0);
    expect(terminals).toBeGreaterThan(0);
  });

  it("every presentable story step resolves each of its options to a real campaign goal", () => {
    for (const storyChoice of [
      tannersFeverAccountabilityStoryChoice(),
      romePostWeirDispatchStoryChoice(),
    ]) {
      for (const option of storyChoice.options) {
        const selection = journeyCampaignStoryChoiceSelection(storyChoice.id, option.id);
        expect(selection.goal.id.length).toBeGreaterThan(0);
        expect(selection.goal.targetQuestId.length).toBeGreaterThan(0);
      }
    }
  });
});
