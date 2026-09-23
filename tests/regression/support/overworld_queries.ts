/**
 * World-manifest queries the tests use to set up and check scenarios. Production reads
 * the world through OverworldSession (route planning lives in src/world/session_routes.ts),
 * so these live with the tests rather than in the engine.
 */
import {
  overworldEdgesFrom,
  overworldRoadEventFor,
  type OverworldCharacter,
  type OverworldEdge,
  type OverworldExplorationSite,
  type OverworldLocalJob,
  type OverworldManifest,
  type OverworldRoutePlan,
  type OverworldRouteStep,
} from "../../../src/world/overworld.js";
import { compareCaseFoldedCodeUnits } from "../../../src/world/string_order.js";

export function overworldCharactersAt(
  world: OverworldManifest,
  nodeId: string,
): OverworldCharacter[] {
  return world.characters
    .filter((character) => character.home === nodeId)
    .sort((a, b) => compareCaseFoldedCodeUnits(a.name, b.name));
}

export function overworldJobsAt(world: OverworldManifest, nodeId: string): OverworldLocalJob[] {
  return world.local_jobs
    .filter((job) => job.home === nodeId)
    .sort(
      (a, b) =>
        a.difficulty - b.difficulty ||
        a.minutes - b.minutes ||
        compareCaseFoldedCodeUnits(a.title, b.title),
    );
}

export function overworldExplorationSitesNear(
  world: OverworldManifest,
  nodeId: string,
): OverworldExplorationSite[] {
  return world.exploration_sites
    .filter((site) => site.nearest_town === nodeId)
    .sort((a, b) => b.danger - a.danger || compareCaseFoldedCodeUnits(a.title, b.title));
}

export function overworldExplorationSitesInArea(
  world: OverworldManifest,
  areaId: string,
): OverworldExplorationSite[] {
  return world.exploration_sites
    .filter((site) => site.area === areaId)
    .sort((a, b) => b.danger - a.danger || compareCaseFoldedCodeUnits(a.title, b.title));
}

export function planOverworldRoute(
  world: OverworldManifest,
  fromId: string,
  destinationId: string,
  allowedNodeIds?: ReadonlySet<string>,
): OverworldRoutePlan | null {
  const nodes = new Map(world.nodes.map((node) => [node.id, node]));
  const from = nodes.get(fromId);
  if (!from) throw new Error(`Unknown overworld route start "${fromId}".`);
  const destination = nodes.get(destinationId);
  if (!destination) throw new Error(`Unknown overworld route destination "${destinationId}".`);
  if (allowedNodeIds && (!allowedNodeIds.has(fromId) || !allowedNodeIds.has(destinationId))) {
    return null;
  }
  if (fromId === destinationId) {
    return { from, destination, steps: [], totalDistanceMi: 0, totalMinutes: 0 };
  }

  const distance = new Map<string, number>([[fromId, 0]]);
  const previous = new Map<string, { from: string; edge: OverworldEdge }>();
  const unsettled = new Set<string>(allowedNodeIds ? [...allowedNodeIds] : [...nodes.keys()]);

  while (unsettled.size > 0) {
    let current: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of unsettled) {
      const candidateDistance = distance.get(candidate) ?? Number.POSITIVE_INFINITY;
      if (candidateDistance < best) {
        current = candidate;
        best = candidateDistance;
      }
    }
    if (current === null || best === Number.POSITIVE_INFINITY) break;
    unsettled.delete(current);
    if (current === destinationId) break;

    for (const edge of overworldEdgesFrom(world, current)) {
      const next = edge.destination.id;
      if (!unsettled.has(next)) continue;
      const nextDistance = best + edge.travel_minutes;
      if (nextDistance >= (distance.get(next) ?? Number.POSITIVE_INFINITY)) continue;
      distance.set(next, nextDistance);
      previous.set(next, { from: current, edge });
    }
  }

  if (!previous.has(destinationId)) return null;
  const steps: OverworldRouteStep[] = [];
  for (let cursor = destinationId; cursor !== fromId; ) {
    const prev = previous.get(cursor);
    if (!prev) return null;
    const stepFrom = nodes.get(prev.from);
    const stepTo = nodes.get(cursor);
    if (!stepFrom || !stepTo) return null;
    steps.unshift({
      from: stepFrom,
      to: stepTo,
      edge: prev.edge,
      roadEvent: overworldRoadEventFor(world, prev.edge.id),
    });
    cursor = prev.from;
  }

  return {
    from,
    destination,
    steps,
    totalDistanceMi: steps.reduce((sum, step) => sum + step.edge.distance_mi, 0),
    totalMinutes: steps.reduce((sum, step) => sum + step.edge.travel_minutes, 0),
  };
}
