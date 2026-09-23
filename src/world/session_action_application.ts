import type { OverworldLocalActionDescriptor, OverworldLocalActionKind } from "./local_actions.js";
import type { OverworldArea, OverworldExplorationSite, OverworldLocalJob } from "./overworld.js";
import {
  recordOverworldAction,
  recordOverworldLocalAction,
  type OverworldActionJournalState,
  type OverworldRecordedActionResult,
} from "./session_action_recording.js";
import {
  emptyOverworldLocalDiscovery,
  type OverworldLocalDiscoveryResult,
  type OverworldQuestView,
} from "./session_local_discovery.js";
import {
  applyOverworldServicePlan,
  type OverworldAppliedServicePlan,
  type OverworldServicePlan,
  type OverworldServiceResult,
} from "./session_services.js";
import type { OverworldJournalEntry } from "./session_snapshot.js";
import type { CampaignCharacterState } from "./campaign_character_state.js";

export type OverworldActionResult = {
  minutes: number;
  alreadyKnown: boolean;
  entry: OverworldJournalEntry;
  discoveredAreas?: OverworldArea[];
  discoveredJobs?: OverworldLocalJob[];
  discoveredSites?: OverworldExplorationSite[];
  discoveredQuests?: OverworldQuestView[];
};

type OverworldSessionLocalAction = OverworldLocalActionDescriptor<OverworldLocalActionKind>;

export type OverworldSessionActionApplication = {
  result: OverworldActionResult;
  minutesAfter: number;
  stateChanged: boolean;
};

export type OverworldSessionServiceApplication = {
  result: OverworldServiceResult;
  minutesAfter: number;
  suppliesAfter: number;
  fatigueAfter: number;
  characterAfter?: CampaignCharacterState;
  stateChanged: boolean;
};

function applyOverworldSessionRecordedAction(
  recorded: OverworldRecordedActionResult,
): OverworldSessionActionApplication {
  return {
    result: {
      minutes: recorded.minutes,
      alreadyKnown: recorded.alreadyKnown,
      entry: recorded.entry,
    },
    minutesAfter: recorded.minutesAfter,
    stateChanged: recorded.stateChanged,
  };
}

export function recordOverworldSessionAction(
  state: OverworldActionJournalState,
  entry: Omit<OverworldJournalEntry, "recordedAt">,
  minutes: number,
): OverworldSessionActionApplication {
  return applyOverworldSessionRecordedAction(recordOverworldAction(state, entry, minutes));
}

export function recordOverworldSessionLocalAction(
  state: OverworldActionJournalState,
  action: OverworldSessionLocalAction,
  town: string,
): OverworldSessionActionApplication {
  return applyOverworldSessionRecordedAction(recordOverworldLocalAction(state, action, town));
}

export function withOverworldSessionLocalDiscovery(
  result: OverworldActionResult,
  discovery: OverworldLocalDiscoveryResult | null,
): OverworldActionResult {
  return {
    ...result,
    ...(result.alreadyKnown || !discovery ? emptyOverworldLocalDiscovery() : discovery),
  };
}

export function applyOverworldSessionServicePlan(
  state: OverworldActionJournalState,
  plan: OverworldServicePlan,
): OverworldSessionServiceApplication {
  const applied: OverworldAppliedServicePlan = applyOverworldServicePlan(state, plan);
  return {
    result: {
      action: applied.action,
      minutes: applied.minutes,
      changed: applied.changed,
      suppliesBefore: applied.suppliesBefore,
      suppliesAfter: applied.suppliesAfter,
      fatigueBefore: applied.fatigueBefore,
      fatigueAfter: applied.fatigueAfter,
      message: applied.message,
      entry: applied.entry,
    },
    minutesAfter: applied.minutesAfter,
    suppliesAfter: applied.suppliesAfter,
    fatigueAfter: applied.fatigueAfter,
    ...(applied.characterAfter ? { characterAfter: applied.characterAfter } : {}),
    stateChanged: applied.stateChanged,
  };
}
