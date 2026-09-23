import type { OverworldLocalActionDescriptor, OverworldLocalActionKind } from "./local_actions.js";
import { timeLabel } from "./session_journal_codec.js";
import { addOverworldJournalEntry } from "./session_journal_store.js";
import type { OverworldJournalEntry } from "./session_snapshot.js";

export type OverworldActionJournalState = {
  minutes: number;
  journalEntries: OverworldJournalEntry[];
  journalEntriesById: Map<string, OverworldJournalEntry>;
};

export type OverworldRecordedActionResult = {
  minutes: number;
  minutesAfter: number;
  alreadyKnown: boolean;
  stateChanged: boolean;
  entry: OverworldJournalEntry;
};

type OverworldRecordedRepeatableEntry = {
  minutesAfter: number;
  entry: OverworldJournalEntry;
};

export function recordOverworldAction(
  state: OverworldActionJournalState,
  entry: Omit<OverworldJournalEntry, "recordedAt">,
  minutes: number,
): OverworldRecordedActionResult {
  const existing = state.journalEntriesById.get(entry.id);
  if (existing) {
    return {
      minutes: 0,
      minutesAfter: state.minutes,
      alreadyKnown: true,
      stateChanged: false,
      entry: existing,
    };
  }

  const minutesAfter = state.minutes + minutes;
  const recorded: OverworldJournalEntry = {
    ...entry,
    recordedAt: timeLabel(minutesAfter),
  };
  addOverworldJournalEntry(state.journalEntries, state.journalEntriesById, recorded);
  return {
    minutes,
    minutesAfter,
    alreadyKnown: false,
    stateChanged: true,
    entry: recorded,
  };
}

export function recordOverworldLocalAction<Kind extends OverworldLocalActionKind>(
  state: OverworldActionJournalState,
  action: OverworldLocalActionDescriptor<Kind>,
  town: string,
): OverworldRecordedActionResult {
  return recordOverworldAction(
    state,
    {
      id: action.id,
      kind: action.kind,
      town,
      title: action.title,
      text: action.text,
    },
    action.minutes,
  );
}

export function recordOverworldRepeatableEntry(
  state: OverworldActionJournalState,
  entry: Omit<OverworldJournalEntry, "recordedAt">,
  minutes: number,
): OverworldRecordedRepeatableEntry {
  const minutesAfter = state.minutes + minutes;
  const recorded: OverworldJournalEntry = {
    ...entry,
    id: `${entry.id}:${minutesAfter}`,
    recordedAt: timeLabel(minutesAfter),
  };
  addOverworldJournalEntry(state.journalEntries, state.journalEntriesById, recorded);
  return { minutesAfter, entry: recorded };
}
