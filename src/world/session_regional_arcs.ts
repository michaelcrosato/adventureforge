import type { OverworldNode, OverworldRegionalArc } from "./overworld.js";
import { cloneOverworldNode } from "./overworld_clone.js";
import { timeLabel } from "./session_journal_codec.js";
import { addOverworldJournalEntry } from "./session_journal_store.js";
import type { OverworldJournalEntry } from "./session_snapshot.js";
import { pushIndexed } from "./session_collections.js";
import { compareCaseFoldedCodeUnits } from "./string_order.js";

export type OverworldRegionalArcProgress = {
  id: string;
  region: string;
  title: string;
  summary: string;
  requiredResolutions: number;
  resolvedInRegion: number;
  anchorTowns: OverworldNode[];
  resolvedAnchorTowns: OverworldNode[];
  completed: boolean;
  reward: string;
};

type OverworldRegionalArcCompletion = {
  arc: OverworldRegionalArc;
  entry: OverworldJournalEntry;
};

type MutableOverworldRegionalArcCompletionState = {
  completedRegionalArcIds: Set<string>;
  journalEntries: OverworldJournalEntry[];
  journalEntriesById: Map<string, OverworldJournalEntry>;
};

export function indexOverworldRegionalArcsByRegion(
  arcs: readonly OverworldRegionalArc[],
): Map<string, OverworldRegionalArc[]> {
  const index = new Map<string, OverworldRegionalArc[]>();
  for (const arc of arcs) pushIndexed(index, arc.region, arc);
  return index;
}

export function indexOverworldRegionalArcAnchorTowns(
  arcs: readonly OverworldRegionalArc[],
  nodes: ReadonlyMap<string, OverworldNode>,
): Map<string, OverworldNode[]> {
  const index = new Map<string, OverworldNode[]>();
  for (const arc of arcs) {
    index.set(
      arc.id,
      arc.anchor_towns
        .map((id) => nodes.get(id))
        .filter((node): node is OverworldNode => node !== undefined),
    );
  }
  return index;
}

export function resolvedOverworldRegionalArcAnchorTownIds(
  arc: OverworldRegionalArc,
  resolvedEventHomeIds: ReadonlySet<string>,
): Set<string> {
  const resolved = new Set<string>();
  for (const townId of arc.anchor_towns) {
    if (resolvedEventHomeIds.has(townId)) resolved.add(townId);
  }
  return resolved;
}

export function buildOverworldRegionalArcProgress(
  arcs: readonly OverworldRegionalArc[],
  currentRegion: string,
  anchorTownsByArcId: ReadonlyMap<string, readonly OverworldNode[]>,
  resolvedEventHomeIds: ReadonlySet<string>,
  completedRegionalArcIds: ReadonlySet<string>,
): OverworldRegionalArcProgress[] {
  const progress: OverworldRegionalArcProgress[] = [];
  for (const arc of arcs) {
    const resolvedAnchorIds = resolvedOverworldRegionalArcAnchorTownIds(arc, resolvedEventHomeIds);
    const anchorTowns = anchorTownsByArcId.get(arc.id) ?? [];
    const resolvedAnchorTowns: OverworldNode[] = [];
    for (const town of anchorTowns) {
      if (resolvedAnchorIds.has(town.id)) resolvedAnchorTowns.push(town);
    }
    progress.push({
      id: arc.id,
      region: arc.region,
      title: arc.title,
      summary: arc.summary,
      requiredResolutions: arc.required_resolutions,
      resolvedInRegion: resolvedAnchorIds.size,
      anchorTowns: [...anchorTowns],
      resolvedAnchorTowns,
      completed: completedRegionalArcIds.has(arc.id),
      reward: arc.reward,
    });
  }
  progress.sort(
    (a, b) =>
      Number(b.region === currentRegion) - Number(a.region === currentRegion) ||
      Number(a.completed) - Number(b.completed) ||
      compareCaseFoldedCodeUnits(a.region, b.region),
  );
  return progress;
}

export function cloneOverworldRegionalArcProgress(
  arc: OverworldRegionalArcProgress,
): OverworldRegionalArcProgress {
  return {
    ...arc,
    anchorTowns: arc.anchorTowns.map(cloneOverworldNode),
    resolvedAnchorTowns: arc.resolvedAnchorTowns.map(cloneOverworldNode),
  };
}

export function regionalArcCompletionsForRegion(
  region: string,
  regionalArcsByRegion: ReadonlyMap<string, readonly OverworldRegionalArc[]>,
  resolvedEventHomeIds: ReadonlySet<string>,
  completedRegionalArcIds: ReadonlySet<string>,
  minutes: number,
): OverworldRegionalArcCompletion[] {
  const recordedAt = timeLabel(minutes);
  const completions: OverworldRegionalArcCompletion[] = [];
  for (const arc of regionalArcsByRegion.get(region) ?? []) {
    if (completedRegionalArcIds.has(arc.id)) continue;
    const resolvedAnchorIds = resolvedOverworldRegionalArcAnchorTownIds(arc, resolvedEventHomeIds);
    if (resolvedAnchorIds.size < arc.required_resolutions) continue;
    completions.push({
      arc,
      entry: {
        id: `arc:${arc.id}`,
        kind: "regional_arc",
        town: region,
        title: `Completed ${arc.title}`,
        text: arc.reward,
        recordedAt,
      },
    });
  }
  return completions;
}

export function applyOverworldRegionalArcCompletions(
  state: MutableOverworldRegionalArcCompletionState,
  completions: readonly OverworldRegionalArcCompletion[],
): boolean {
  let changed = false;
  for (const completion of completions) {
    if (state.completedRegionalArcIds.has(completion.arc.id)) continue;
    state.completedRegionalArcIds.add(completion.arc.id);
    if (!state.journalEntriesById.has(completion.entry.id)) {
      addOverworldJournalEntry(state.journalEntries, state.journalEntriesById, completion.entry);
    }
    changed = true;
  }
  return changed;
}
