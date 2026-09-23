import type {
  OverworldCharacter,
  OverworldLocalEvent,
  OverworldPoi,
  OverworldRegionalArc,
} from "./overworld.js";
import {
  recordOverworldSessionAction,
  type OverworldSessionActionApplication,
} from "./session_action_application.js";
import type { OverworldActionJournalState } from "./session_action_recording.js";
import {
  applyOverworldEventResolution,
  planOverworldEventResolution,
  type OverworldEventResolutionPlan,
} from "./session_event_resolution.js";
import { applyOverworldSessionRegionalArcCompletionsForRegion } from "./session_route_progress.js";
import type { OverworldJournalEntry } from "./session_snapshot.js";

type OverworldSessionEventResolutionPlanState = {
  eventId: string;
  optionId?: string | undefined;
  eventsById: ReadonlyMap<string, OverworldLocalEvent>;
  currentTownId: string;
  currentTownName: string;
  currentRegion: string;
  currentAreaId: string | null;
  completedQuestIds: ReadonlySet<string>;
  completedJobIds?: ReadonlySet<string> | undefined;
  campaignWorldFactIds?: ReadonlySet<string> | undefined;
  resolvedEventIds: ReadonlySet<string>;
  journalEntries: ReadonlyMap<string, OverworldJournalEntry>;
  poisByArea: ReadonlyMap<string, readonly Pick<OverworldPoi, "id">[]>;
  charactersByArea: ReadonlyMap<string, readonly OverworldCharacter[]>;
};

type MutableOverworldSessionEventResolutionState = OverworldActionJournalState & {
  resolvedEventIds: Set<string>;
  resolvedEventHomeIds: Set<string>;
  regionRenown: Map<string, number>;
  regionalArcsByRegion: ReadonlyMap<string, readonly OverworldRegionalArc[]>;
  completedRegionalArcIds: Set<string>;
};

type OverworldSessionEventResolutionState = Omit<
  OverworldSessionEventResolutionPlanState,
  "journalEntries"
> &
  MutableOverworldSessionEventResolutionState;

export function planOverworldSessionEventResolution(
  state: OverworldSessionEventResolutionPlanState,
): OverworldEventResolutionPlan {
  return planOverworldEventResolution(state);
}

function applyOverworldSessionEventResolution(
  state: MutableOverworldSessionEventResolutionState,
  plan: OverworldEventResolutionPlan,
): OverworldSessionActionApplication {
  if (plan.alreadyKnown) {
    return {
      result: {
        minutes: 0,
        alreadyKnown: true,
        entry: plan.entry,
      },
      minutesAfter: state.minutes,
      stateChanged: false,
    };
  }

  const applied = recordOverworldSessionAction(state, plan.entryDraft, plan.minutes);
  if (!applied.result.alreadyKnown) {
    applyOverworldEventResolution(
      {
        resolvedEventIds: state.resolvedEventIds,
        resolvedEventHomeIds: state.resolvedEventHomeIds,
        regionRenown: state.regionRenown,
      },
      plan,
    );
    applyOverworldSessionRegionalArcCompletionsForRegion(
      {
        regionalArcsByRegion: state.regionalArcsByRegion,
        resolvedEventHomeIds: state.resolvedEventHomeIds,
        completedRegionalArcIds: state.completedRegionalArcIds,
        minutes: applied.minutesAfter,
        journalEntries: state.journalEntries,
        journalEntriesById: state.journalEntriesById,
      },
      plan.region,
    );
  }
  return applied;
}

export function applyOverworldSessionEventResolutionFromState(
  state: OverworldSessionEventResolutionState,
): OverworldSessionActionApplication {
  return applyOverworldSessionEventResolution(
    state,
    planOverworldSessionEventResolution({
      ...state,
      journalEntries: state.journalEntriesById,
    }),
  );
}
