import type { OverworldJournalEntry } from "./session_snapshot.js";

export type OverworldProgressJournalSourceIndex = {
  completedJobIds: ReadonlySet<string>;
  completedQuestIds: ReadonlySet<string>;
  completedRegionalArcIds: ReadonlySet<string>;
  exploredSiteIds: ReadonlySet<string>;
  resolvedEventIds: ReadonlySet<string>;
  startedQuestIds: ReadonlySet<string>;
  visitedAreaIds: ReadonlySet<string>;
};

type MutableOverworldProgressJournalSourceIndex = {
  completedJobIds: Set<string>;
  completedQuestIds: Set<string>;
  completedRegionalArcIds: Set<string>;
  exploredSiteIds: Set<string>;
  resolvedEventIds: Set<string>;
  startedQuestIds: Set<string>;
  visitedAreaIds: Set<string>;
};

export function emptyProgressJournalSourceIndex(): MutableOverworldProgressJournalSourceIndex {
  return {
    completedJobIds: new Set<string>(),
    completedQuestIds: new Set<string>(),
    completedRegionalArcIds: new Set<string>(),
    exploredSiteIds: new Set<string>(),
    resolvedEventIds: new Set<string>(),
    startedQuestIds: new Set<string>(),
    visitedAreaIds: new Set<string>(),
  };
}

export function recordProgressJournalSource(
  sources: MutableOverworldProgressJournalSourceIndex,
  entry: OverworldJournalEntry,
): void {
  switch (entry.kind) {
    case "area":
      sources.visitedAreaIds.add(entry.id.slice("area:".length));
      return;
    case "job":
      sources.completedJobIds.add(entry.id.slice("job:".length));
      return;
    case "quest":
      sources.startedQuestIds.add(entry.id.slice("quest:".length));
      return;
    case "quest_done":
      sources.completedQuestIds.add(entry.id.slice("quest_done:".length));
      return;
    case "regional_arc":
      sources.completedRegionalArcIds.add(entry.id.slice("arc:".length));
      return;
    case "resolution":
      sources.resolvedEventIds.add(entry.id.slice("resolve:".length));
      return;
    case "site":
      sources.exploredSiteIds.add(entry.id.slice("site:".length));
      return;
    default:
      return;
  }
}

export function assertStringSetSubset(
  label: string,
  values: Iterable<string>,
  parentLabel: string,
  parent: ReadonlySet<string>,
): void {
  for (const value of values) {
    if (!parent.has(value)) {
      throw new Error(`Overworld session snapshot ${label} "${value}" is not in ${parentLabel}.`);
    }
  }
}

function assertJournalStateBinding(
  stateLabel: string,
  stateIds: ReadonlySet<string>,
  journalLabel: string,
  journalIds: ReadonlySet<string>,
): void {
  for (const id of stateIds) {
    if (!journalIds.has(id)) {
      throw new Error(
        `Overworld session snapshot ${stateLabel} "${id}" has no matching journal entry.`,
      );
    }
  }
  for (const id of journalIds) {
    if (!stateIds.has(id)) {
      throw new Error(
        `Overworld session snapshot journal ${journalLabel} "${id}" is missing from saved state.`,
      );
    }
  }
}

export function assertSnapshotProgressJournalBindings(
  stateIds: OverworldProgressJournalSourceIndex,
  journalSources: OverworldProgressJournalSourceIndex,
): void {
  assertJournalStateBinding(
    "visited area id",
    stateIds.visitedAreaIds,
    "visited area id",
    journalSources.visitedAreaIds,
  );
  assertJournalStateBinding(
    "completed job id",
    stateIds.completedJobIds,
    "completed job id",
    journalSources.completedJobIds,
  );
  assertJournalStateBinding(
    "started quest id",
    stateIds.startedQuestIds,
    "started quest id",
    journalSources.startedQuestIds,
  );
  assertJournalStateBinding(
    "completed quest id",
    stateIds.completedQuestIds,
    "completed quest id",
    journalSources.completedQuestIds,
  );
  assertJournalStateBinding(
    "explored site id",
    stateIds.exploredSiteIds,
    "explored site id",
    journalSources.exploredSiteIds,
  );
  assertJournalStateBinding(
    "resolved event id",
    stateIds.resolvedEventIds,
    "resolved event id",
    journalSources.resolvedEventIds,
  );
  assertJournalStateBinding(
    "completed regional arc id",
    stateIds.completedRegionalArcIds,
    "completed regional arc id",
    journalSources.completedRegionalArcIds,
  );
}
