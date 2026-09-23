import type { OverworldArea, OverworldNode, OverworldQuest } from "./overworld.js";
import type { CampaignCharacterState } from "./campaign_character_state.js";
import type { OpeningLeadSource } from "./opening_lead_source.js";
import type { OpeningAlly } from "./opening_ally.js";
import type { OpeningPreparation } from "./opening_preparation.js";
import type { OpeningRegistration } from "./opening_registration.js";
import type { OpeningReliefAllocation } from "./opening_relief_allocation.js";
import type { OpeningReliefOath } from "./opening_relief_oath.js";
import {
  recordOverworldSessionAction,
  type OverworldSessionActionApplication,
} from "./session_action_application.js";
import type { OverworldActionJournalState } from "./session_action_recording.js";
import type { OverworldQuestView } from "./session_local_discovery.js";
import type { OverworldJournalEntry } from "./session_snapshot.js";
import {
  applyOverworldQuestCompletion,
  applyOverworldQuestStart,
  planOverworldQuestCompletion,
  prepareOverworldQuestStart,
  previewOverworldQuestStart,
  type OverworldQuestCompletionOutcome,
  type OverworldQuestCompletionPlan,
  type OverworldQuestCompletionResult,
  type OverworldQuestStartPreparation,
} from "./session_quests.js";

export type OverworldSessionQuestStartPlanState = {
  questId: string;
  approachId?: string;
  sessionFingerprint?: string;
  minutes: number;
  supplies: number;
  fatigue: number;
  character: CampaignCharacterState;
  journalEntries?: readonly OverworldJournalEntry[];
  openingRegistration?: OpeningRegistration | null;
  openingReliefOath?: OpeningReliefOath | null;
  openingLeadSource?: OpeningLeadSource | null;
  openingPreparation?: OpeningPreparation | null;
  openingReliefAllocation?: OpeningReliefAllocation | null;
  openingAlly?: OpeningAlly | null;
  questsById: ReadonlyMap<string, OverworldQuest>;
  areasById: ReadonlyMap<string, OverworldArea>;
  currentTownId: string;
  currentTownName: string;
  currentAreaId: string | null;
  discoveredQuestIds: ReadonlySet<string>;
  startedQuestIds: ReadonlySet<string>;
};

type OverworldSessionQuestCompletionPlanState = {
  questId: string;
  outcome: OverworldQuestCompletionOutcome;
  character: CampaignCharacterState;
  questsById: ReadonlyMap<string, OverworldQuest>;
  areasById: ReadonlyMap<string, OverworldArea>;
  nodesById: ReadonlyMap<string, OverworldNode>;
  questOutcomeIds: ReadonlyMap<string, string>;
  startedQuestIds: ReadonlySet<string>;
  journalEntries?: readonly OverworldJournalEntry[];
  journalEntriesById?: ReadonlyMap<string, OverworldJournalEntry>;
  openingRegistration?: OpeningRegistration | null;
  openingReliefOath?: OpeningReliefOath | null;
  openingLeadSource?: OpeningLeadSource | null;
};

export type MutableOverworldSessionQuestStartState = OverworldActionJournalState & {
  startedQuestIds: Set<string>;
};

type MutableOverworldSessionQuestCompletionState = OverworldActionJournalState & {
  completedQuestIds: Set<string>;
  regionRenown: Map<string, number>;
};

export type OverworldSessionQuestStartState = OverworldSessionQuestStartPlanState &
  MutableOverworldSessionQuestStartState;

type OverworldAppliedSessionQuestStart = OverworldSessionActionApplication & {
  quest: OverworldQuestView;
  characterAfter: CampaignCharacterState;
  suppliesAfter: number;
  fatigueAfter: number;
};

type OverworldAppliedSessionQuestCompletion = {
  result: OverworldQuestCompletionResult;
  characterAfter: CampaignCharacterState;
  worldFactIds: readonly string[];
  minutesAfter: number;
  stateChanged: boolean;
};

export function planOverworldSessionQuestStart(
  state: OverworldSessionQuestStartPlanState,
): OverworldQuestStartPreparation {
  return prepareOverworldQuestStart(state);
}

export function planOverworldSessionQuestCompletion(
  state: OverworldSessionQuestCompletionPlanState,
): OverworldQuestCompletionPlan {
  return planOverworldQuestCompletion(state);
}

export function previewOverworldSessionQuestStart(
  state: OverworldSessionQuestStartPlanState,
): OverworldQuestView {
  return previewOverworldQuestStart(state);
}

export function applyOverworldSessionQuestStart(
  state: MutableOverworldSessionQuestStartState,
  plan: OverworldQuestStartPreparation,
): OverworldAppliedSessionQuestStart {
  const applied = recordOverworldSessionAction(state, plan.entryDraft, plan.minutes);
  if (!applied.result.alreadyKnown) {
    applyOverworldQuestStart({ startedQuestIds: state.startedQuestIds }, plan);
  }
  return {
    ...applied,
    quest: plan.quest,
    characterAfter: plan.characterAfter,
    suppliesAfter: plan.suppliesAfter,
    fatigueAfter: plan.fatigueAfter,
  };
}

export function applyOverworldSessionQuestCompletion(
  state: MutableOverworldSessionQuestCompletionState,
  plan: OverworldQuestCompletionPlan,
): OverworldAppliedSessionQuestCompletion {
  const applied = recordOverworldSessionAction(state, plan.entryDraft, plan.minutes);
  // Renown is awarded exactly once: a repeat completion (alreadyKnown) reports
  // zero gained and the standing total, never a double award.
  const award = applied.result.alreadyKnown
    ? {
        renownRegion: plan.renownRegion,
        renownGained: 0,
        renownAfter: state.regionRenown.get(plan.renownRegion) ?? 0,
      }
    : applyOverworldQuestCompletion(
        { completedQuestIds: state.completedQuestIds, regionRenown: state.regionRenown },
        plan,
      );
  return {
    result: {
      minutes: applied.result.minutes,
      alreadyKnown: applied.result.alreadyKnown,
      quest: plan.quest,
      endingId: plan.endingId,
      endingTitle: plan.endingTitle,
      renownRegion: award.renownRegion,
      renownGained: award.renownGained,
      renownAfter: award.renownAfter,
      entry: applied.result.entry,
    },
    characterAfter: plan.characterAfter,
    worldFactIds: plan.worldFactIds,
    minutesAfter: applied.minutesAfter,
    stateChanged: applied.stateChanged,
  };
}
