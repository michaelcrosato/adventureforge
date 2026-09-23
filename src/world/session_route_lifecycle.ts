import type {
  OverworldRouteResourceState,
  OverworldRouteRoadEventState,
} from "./session_routes.js";
import {
  indexedOverworldRoute,
  withOverworldSessionRoadEvents,
  type OverworldRoutePlannerIndex,
  type OverworldSessionRoutePlan,
} from "./session_routes.js";
import { withOverworldSessionRouteEstimate } from "./session_route_progress.js";

type OverworldSessionRoadRoutePlanState = {
  destinationId: string;
  routePlannerIndex: OverworldRoutePlannerIndex;
  currentId: string;
  discoveredIds: ReadonlySet<string>;
  resources: OverworldRouteResourceState;
  roadEventState?: OverworldRouteRoadEventState;
};

export function planOverworldSessionRoadRoute(
  state: OverworldSessionRoadRoutePlanState,
): OverworldSessionRoutePlan {
  if (state.destinationId === state.currentId) throw new Error("You are already there.");
  if (!state.discoveredIds.has(state.destinationId)) {
    throw new Error(
      "That destination is not discovered. Visit nearby towns or reveal more roads first.",
    );
  }
  const plan = indexedOverworldRoute(
    state.routePlannerIndex,
    state.currentId,
    state.destinationId,
    state.discoveredIds,
  );
  if (!plan) throw new Error("No discovered roads reach that destination.");
  return withOverworldSessionRouteEstimate(
    state.roadEventState ? withOverworldSessionRoadEvents(plan, state.roadEventState) : plan,
    state.resources,
  );
}
