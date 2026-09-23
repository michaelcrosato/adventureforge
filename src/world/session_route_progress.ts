import type { OverworldNode, OverworldRegionalArc, OverworldRoutePlan } from "./overworld.js";
import type { OverworldSessionCaches } from "./session_cache.js";
import {
  applyOverworldRegionalArcCompletions,
  buildOverworldRegionalArcProgress,
  regionalArcCompletionsForRegion,
  type OverworldRegionalArcProgress,
} from "./session_regional_arcs.js";
import {
  buildOverworldDiscoveredRouteOptions,
  withOverworldRouteEstimate,
  type OverworldRoutePlannerIndex,
  type OverworldRouteResourceState,
  type OverworldRouteRoadEventState,
  type OverworldSessionRoutePlan,
} from "./session_routes.js";
import type { OverworldJournalEntry } from "./session_snapshot.js";

type OverworldSessionRouteOptionCacheState = {
  caches: OverworldSessionCaches;
  routePlannerIndex: OverworldRoutePlannerIndex;
  current: OverworldNode;
  currentId: string;
  discoveredIds: ReadonlySet<string>;
  resources: OverworldRouteResourceState;
  roadEventState?: OverworldRouteRoadEventState;
};

type OverworldSessionRegionalArcProgressCacheState = {
  caches: OverworldSessionCaches;
  regionalArcs: readonly OverworldRegionalArc[];
  currentRegion: string;
  regionalArcAnchorTownsById: ReadonlyMap<string, readonly OverworldNode[]>;
  resolvedEventHomeIds: ReadonlySet<string>;
  completedRegionalArcIds: ReadonlySet<string>;
};

type MutableOverworldSessionRegionalArcCompletionState = {
  regionalArcsByRegion: ReadonlyMap<string, readonly OverworldRegionalArc[]>;
  resolvedEventHomeIds: ReadonlySet<string>;
  completedRegionalArcIds: Set<string>;
  minutes: number;
  journalEntries: OverworldJournalEntry[];
  journalEntriesById: Map<string, OverworldJournalEntry>;
};

export function withOverworldSessionRouteEstimate(
  plan: OverworldRoutePlan,
  resources: OverworldRouteResourceState,
): OverworldSessionRoutePlan {
  return withOverworldRouteEstimate(plan, resources);
}

export function cachedOverworldSessionDiscoveredRouteOptions(
  state: OverworldSessionRouteOptionCacheState,
): OverworldSessionRoutePlan[] {
  if (state.caches.routeOptions) return state.caches.routeOptions;
  state.caches.routeOptions = buildOverworldDiscoveredRouteOptions({
    routePlannerIndex: state.routePlannerIndex,
    current: state.current,
    currentId: state.currentId,
    discoveredIds: state.discoveredIds,
    resources: state.resources,
    ...(state.roadEventState ? { roadEventState: state.roadEventState } : {}),
  });
  return state.caches.routeOptions;
}

export function cachedOverworldSessionRegionalArcProgress(
  state: OverworldSessionRegionalArcProgressCacheState,
): OverworldRegionalArcProgress[] {
  if (state.caches.regionalArcProgress) return state.caches.regionalArcProgress;
  state.caches.regionalArcProgress = buildOverworldRegionalArcProgress(
    state.regionalArcs,
    state.currentRegion,
    state.regionalArcAnchorTownsById,
    state.resolvedEventHomeIds,
    state.completedRegionalArcIds,
  );
  return state.caches.regionalArcProgress;
}

export function applyOverworldSessionRegionalArcCompletionsForRegion(
  state: MutableOverworldSessionRegionalArcCompletionState,
  region: string,
): boolean {
  const completions = regionalArcCompletionsForRegion(
    region,
    state.regionalArcsByRegion,
    state.resolvedEventHomeIds,
    state.completedRegionalArcIds,
    state.minutes,
  );
  if (completions.length === 0) return false;
  return applyOverworldRegionalArcCompletions(
    {
      completedRegionalArcIds: state.completedRegionalArcIds,
      journalEntries: state.journalEntries,
      journalEntriesById: state.journalEntriesById,
    },
    completions,
  );
}
