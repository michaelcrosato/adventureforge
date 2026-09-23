import { hashState } from "../core/hash.js";
import {
  overworldNodesById,
  type OverworldArea,
  type OverworldAreaExit,
  type OverworldCharacter,
  type OverworldExit,
  type OverworldExplorationSite,
  type OverworldLocalEvent,
  type OverworldLocalJob,
  type OverworldManifest,
  type OverworldNode,
  type OverworldPoi,
  type OverworldQuest,
  type OverworldRegionalArc,
  type OverworldRoadEvent,
} from "./overworld.js";
import {
  idIndex,
  keyedIndex,
  nestedIdIndex,
  pushIndexed,
  sortedIndex,
} from "./session_collections.js";
import { buildOverworldSnapshotManifestIndex } from "./session_manifest_index.js";
import type { OverworldSnapshotManifestIndex } from "./session_manifest_index.js";
import {
  indexOverworldRegionalArcAnchorTowns,
  indexOverworldRegionalArcsByRegion,
} from "./session_regional_arcs.js";
import type { OverworldRoutePlannerIndex } from "./session_routes.js";
import { compareCaseFoldedCodeUnits } from "./string_order.js";

export type OverworldSessionIndexes = {
  nodes: Map<string, OverworldNode>;
  roadExitsByTown: Map<string, OverworldExit[]>;
  roadExitsByTownAndId: Map<string, Map<string, OverworldExit>>;
  roadEventsByEdgeId: Map<string, OverworldRoadEvent>;
  areasById: Map<string, OverworldArea>;
  areasByTown: Map<string, OverworldArea[]>;
  areaExitsByArea: Map<string, OverworldAreaExit[]>;
  areaExitsByAreaAndId: Map<string, Map<string, OverworldAreaExit>>;
  poisById: Map<string, OverworldPoi>;
  poisByArea: Map<string, OverworldPoi[]>;
  charactersById: Map<string, OverworldCharacter>;
  charactersByArea: Map<string, OverworldCharacter[]>;
  eventsByArea: Map<string, OverworldLocalEvent[]>;
  localEventsById: Map<string, OverworldLocalEvent>;
  jobsById: Map<string, OverworldLocalJob>;
  jobsByTown: Map<string, OverworldLocalJob[]>;
  sitesById: Map<string, OverworldExplorationSite>;
  sitesByArea: Map<string, OverworldExplorationSite[]>;
  questsById: Map<string, OverworldQuest>;
  questsByTown: Map<string, OverworldQuest[]>;
  regionalArcsByRegion: Map<string, OverworldRegionalArc[]>;
  regionalArcAnchorTownsById: Map<string, OverworldNode[]>;
  routePlannerIndex: OverworldRoutePlannerIndex;
  snapshotManifestIndex: OverworldSnapshotManifestIndex;
  worldHash: string;
};

/**
 * Module-level WeakMap cache for `worldHash` computations on deep-frozen OverworldManifest objects.
 * Computing `hashState(world)` takes ~100ms per call due to canonical serialization of the large manifest,
 * and caching by object identity avoids repeating it on every new `OverworldSession` instance.
 *
 * Identity caching is only sound when NOTHING reachable from the manifest can change, and
 * `Object.isFrozen` answers for the top level alone: a manifest frozen only at the top still
 * accepts nested edits, and used to be served its stale first hash (bug_0642). So the cache
 * admits only manifests a loader registered right after deep-freezing them.
 */
const DEEP_FROZEN_WORLDS = new WeakSet<OverworldManifest>();
const DEEP_FROZEN_WORLD_HASH_CACHE = new WeakMap<OverworldManifest, string>();

/**
 * Declare `world` deep-frozen, making its `worldHash` cacheable by identity. Call it only
 * after freezing every object reachable from the manifest (`loadOverworldManifest` does).
 */
export function registerDeepFrozenOverworldManifest(world: OverworldManifest): void {
  if (!Object.isFrozen(world)) {
    throw new Error("Only a deep-frozen overworld manifest can be registered for hash caching.");
  }
  DEEP_FROZEN_WORLDS.add(world);
}

/** Verification seam: whether `world`'s hash is currently served from the identity cache. */
export function overworldWorldHashIsCached(world: OverworldManifest): boolean {
  return DEEP_FROZEN_WORLD_HASH_CACHE.has(world);
}

function getOrComputeWorldHash(world: OverworldManifest): string {
  if (!DEEP_FROZEN_WORLDS.has(world)) return hashState(world);
  let hash = DEEP_FROZEN_WORLD_HASH_CACHE.get(world);
  if (!hash) {
    hash = hashState(world);
    DEEP_FROZEN_WORLD_HASH_CACHE.set(world, hash);
  }
  return hash;
}

export function buildOverworldSessionIndexes(world: OverworldManifest): OverworldSessionIndexes {
  const nodes = overworldNodesById(world);
  const roadExitsByTown = indexRoadExits(world, nodes);
  const roadEventsByEdgeId = keyedIndex(world.road_events, (event) => event.edge);
  const areasById = idIndex(world.areas);
  const areasByTown = sortedIndex(
    world.areas,
    (area) => area.home,
    (a, b) => a.travel_minutes - b.travel_minutes || compareCaseFoldedCodeUnits(a.name, b.name),
  );
  const areaExitsByArea = indexAreaExits(world, areasById);
  const poisById = idIndex(world.points_of_interest);
  const poisByArea = sortedIndex(
    world.points_of_interest,
    (poi) => poi.area,
    (a, b) => compareCaseFoldedCodeUnits(a.title, b.title),
  );
  const charactersById = idIndex(world.characters);
  const charactersByArea = sortedIndex(
    world.characters,
    (character) => character.area,
    (a, b) => compareCaseFoldedCodeUnits(a.name, b.name),
  );
  const eventsByArea = sortedIndex(
    world.local_events,
    (event) => event.area,
    (a, b) => b.intensity - a.intensity || compareCaseFoldedCodeUnits(a.title, b.title),
  );
  const localEventsById = idIndex(world.local_events);
  const jobsById = idIndex(world.local_jobs);
  const jobsByTown = sortedIndex(
    world.local_jobs,
    (job) => job.home,
    (a, b) =>
      a.difficulty - b.difficulty ||
      a.minutes - b.minutes ||
      compareCaseFoldedCodeUnits(a.title, b.title),
  );
  const sitesById = idIndex(world.exploration_sites);
  const sitesByArea = sortedIndex(
    world.exploration_sites,
    (site) => site.area,
    (a, b) => b.danger - a.danger || compareCaseFoldedCodeUnits(a.title, b.title),
  );
  const questsById = idIndex(world.quests);
  const questsByTown = sortedIndex(
    world.quests,
    (quest) => quest.home,
    (a, b) => compareCaseFoldedCodeUnits(a.title, b.title),
  );
  const regionalArcsByRegion = indexOverworldRegionalArcsByRegion(world.regional_arcs);
  const regionalArcAnchorTownsById = indexOverworldRegionalArcAnchorTowns(
    world.regional_arcs,
    nodes,
  );
  const routePlannerIndex = {
    nodes,
    roadEventsByEdgeId,
    roadExitsByTown,
  };
  const snapshotManifestIndex = buildOverworldSnapshotManifestIndex({
    areasById,
    areasByTown,
    charactersById,
    eventsById: localEventsById,
    jobsById,
    jobsByTown,
    nodesById: nodes,
    poisById,
    questsById,
    questsByTown,
    roadEventsByEdgeId,
    roadExitsByTown,
    sitesByArea,
    sitesById,
    world,
  });

  return {
    nodes,
    roadExitsByTown,
    roadExitsByTownAndId: nestedIdIndex(roadExitsByTown),
    roadEventsByEdgeId,
    areasById,
    areasByTown,
    areaExitsByArea,
    areaExitsByAreaAndId: nestedIdIndex(areaExitsByArea),
    poisById,
    poisByArea,
    charactersById,
    charactersByArea,
    eventsByArea,
    localEventsById,
    jobsById,
    jobsByTown,
    sitesById,
    sitesByArea,
    questsById,
    questsByTown,
    regionalArcsByRegion,
    regionalArcAnchorTownsById,
    routePlannerIndex,
    snapshotManifestIndex,
    worldHash: getOrComputeWorldHash(world),
  };
}

function indexAreaExits(
  world: OverworldManifest,
  areasById: ReadonlyMap<string, OverworldArea>,
): Map<string, OverworldAreaExit[]> {
  const index = new Map<string, OverworldAreaExit[]>();
  for (const edge of world.area_edges) {
    const fromDestination = areasById.get(edge.to_area);
    const toDestination = areasById.get(edge.from_area);
    if (!fromDestination || !toDestination) {
      const missingAreaId = fromDestination ? edge.from_area : edge.to_area;
      throw new Error(`Overworld area edge references missing area "${missingAreaId}".`);
    }
    pushIndexed(index, edge.from_area, { ...edge, destination: fromDestination });
    pushIndexed(index, edge.to_area, { ...edge, destination: toDestination });
  }
  for (const exits of index.values()) {
    exits.sort(
      (a, b) =>
        a.travel_minutes - b.travel_minutes ||
        compareCaseFoldedCodeUnits(a.destination.name, b.destination.name),
    );
  }
  return index;
}

function indexRoadExits(
  world: OverworldManifest,
  nodes: ReadonlyMap<string, OverworldNode>,
): Map<string, OverworldExit[]> {
  const index = new Map<string, OverworldExit[]>();
  for (const edge of world.edges) {
    const fromDestination = nodes.get(edge.to);
    const toDestination = nodes.get(edge.from);
    if (!fromDestination || !toDestination) {
      const missingNodeId = fromDestination ? edge.from : edge.to;
      throw new Error(`Overworld edge references missing node "${missingNodeId}".`);
    }
    pushIndexed(index, edge.from, { ...edge, destination: fromDestination });
    pushIndexed(index, edge.to, { ...edge, destination: toDestination });
  }
  for (const exits of index.values()) {
    exits.sort(
      (a, b) =>
        a.travel_minutes - b.travel_minutes ||
        compareCaseFoldedCodeUnits(a.destination.name, b.destination.name),
    );
  }
  return index;
}
