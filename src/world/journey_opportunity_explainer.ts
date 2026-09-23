import type {
  JourneyOpportunityKind,
  JourneyOpportunityLeadPresentation,
  JourneyOpportunityPresentation,
} from "./journey_contract.js";
import type { OverworldLocalEvent, OverworldLocalJob } from "./overworld.js";

export const OPPORTUNITY_TRAVEL_TOOL = "travel_overworld_session" as const;
export const OPPORTUNITY_MOVE_AREA_TOOL = "move_overworld_session_area" as const;
export const OPPORTUNITY_EXPLORE_AREA_TOOL = "explore_overworld_session_area" as const;
export const OPPORTUNITY_EXPLORE_SITE_TOOL = "explore_overworld_session_site" as const;
export const OPPORTUNITY_SCOUT_POI_TOOL = "scout_overworld_session_poi" as const;
export const OPPORTUNITY_TALK_CONTACT_TOOL = "talk_overworld_session_contact" as const;
export const OPPORTUNITY_INVESTIGATE_EVENT_TOOL = "investigate_overworld_session_event" as const;
export const OPPORTUNITY_RESOLVE_EVENT_TOOL = "resolve_overworld_session_event" as const;
export const OPPORTUNITY_WORK_JOB_TOOL = "work_overworld_session_job" as const;

export type JourneyOpportunityIdentity = Readonly<{
  kind: JourneyOpportunityKind;
  id: string;
}>;

export type JourneyOpportunityNextAction =
  | Readonly<{
      tool: typeof OPPORTUNITY_TRAVEL_TOOL;
      arguments: Readonly<{ road_id: string }>;
      command: string;
      label: string;
    }>
  | Readonly<{
      tool: typeof OPPORTUNITY_MOVE_AREA_TOOL;
      arguments: Readonly<{ area_route_id: string }>;
      command: string;
      label: string;
    }>
  | Readonly<{
      tool: typeof OPPORTUNITY_EXPLORE_AREA_TOOL;
      arguments: Readonly<{ area_id: string }>;
      command: string;
      label: string;
    }>
  | Readonly<{
      tool: typeof OPPORTUNITY_EXPLORE_SITE_TOOL;
      arguments: Readonly<{ site_id: string }>;
      command: string;
      label: string;
    }>
  | Readonly<{
      tool: typeof OPPORTUNITY_SCOUT_POI_TOOL;
      arguments: Readonly<{ poi_id: string }>;
      command: string;
      label: string;
    }>
  | Readonly<{
      tool: typeof OPPORTUNITY_TALK_CONTACT_TOOL;
      arguments: Readonly<{ character_id: string }>;
      command: string;
      label: string;
    }>
  | Readonly<{
      tool: typeof OPPORTUNITY_INVESTIGATE_EVENT_TOOL;
      arguments: Readonly<{ event_id: string }>;
      command: string;
      label: string;
    }>
  | Readonly<{
      tool: typeof OPPORTUNITY_RESOLVE_EVENT_TOOL;
      arguments: Readonly<{ event_id: string; option_id: string }>;
      command: string;
      label: string;
    }>
  | Readonly<{
      tool: typeof OPPORTUNITY_WORK_JOB_TOOL;
      arguments: Readonly<{ job_id: string; option_id: string }>;
      command: string;
      label: string;
    }>;

export type JourneyOpportunityExplanation = Readonly<{
  lead: JourneyOpportunityLeadPresentation;
  nextAction: JourneyOpportunityNextAction;
}>;

export type JourneyOpportunityRoadStep = Readonly<{
  roadId: string;
  destinationId: string;
  destinationName: string;
}>;

type JourneyOpportunityAreaStep = Readonly<{
  routeId: string;
  destinationAreaId: string;
  destinationName: string;
}>;

type JourneyOpportunityEventDefinition = Pick<
  OverworldLocalEvent,
  "id" | "home" | "area" | "title" | "authored_scene"
>;
type JourneyOpportunityJobDefinition = Pick<
  OverworldLocalJob,
  "id" | "home" | "area" | "title" | "authored_scene"
>;

export type JourneyOpportunityExplanationState = Readonly<{
  opportunities: JourneyOpportunityPresentation | null;
  currentTownId: string;
  currentAreaId: string | null;
  areasById: ReadonlyMap<string, Readonly<{ id: string; name: string }>>;
  areaExitsByArea: ReadonlyMap<
    string,
    readonly Readonly<{
      id: string;
      destination: Readonly<{ id: string; name: string }>;
    }>[]
  >;
  discoveredAreaIds: ReadonlySet<string>;
  visitedAreaIds: ReadonlySet<string>;
  eventsById: ReadonlyMap<string, JourneyOpportunityEventDefinition>;
  jobsById: ReadonlyMap<string, JourneyOpportunityJobDefinition>;
  journalEntryIds: ReadonlySet<string>;
  eventChoices: readonly (readonly [eventId: string, optionId: string])[];
  jobChoices: readonly (readonly [jobId: string, optionId: string])[];
  nextRoadToward: (townId: string) => JourneyOpportunityRoadStep | null;
  currentAreaDiscoveryAction: () => JourneyOpportunityNextAction | null;
}>;

function freezeAction<Action extends JourneyOpportunityNextAction>(action: Action): Action {
  return Object.freeze({
    ...action,
    arguments: Object.freeze({ ...action.arguments }),
  }) as Action;
}

function hasTalkedTo(journalEntryIds: ReadonlySet<string>, characterId: string): boolean {
  const base = `talk:${characterId}`;
  for (const entryId of journalEntryIds) {
    if (entryId === base || entryId.startsWith(`${base}@`)) return true;
  }
  return false;
}

function requireProjectedLead(
  opportunities: JourneyOpportunityPresentation | null,
  identity: JourneyOpportunityIdentity,
): JourneyOpportunityLeadPresentation {
  const lead = opportunities?.leads.find(
    (candidate) => candidate.kind === identity.kind && candidate.id === identity.id,
  );
  if (!lead) {
    throw new Error(
      `Opportunity lead "${identity.kind}:${identity.id}" is not currently projected.`,
    );
  }
  return lead;
}

function roadAction(
  state: JourneyOpportunityExplanationState,
  homeId: string,
): JourneyOpportunityNextAction {
  const step = state.nextRoadToward(homeId);
  if (!step) throw new Error("This opportunity has no legal road step from here.");
  return freezeAction({
    tool: OPPORTUNITY_TRAVEL_TOOL,
    arguments: { road_id: step.roadId },
    command: `go ${step.destinationId}`,
    label: `Take one road toward ${step.destinationName}.`,
  });
}

function firstDiscoveredRouteStep(
  state: JourneyOpportunityExplanationState,
  destinationMatches: (areaId: string) => boolean,
): JourneyOpportunityAreaStep | null {
  const start = state.currentAreaId;
  if (!start) return null;
  const queue = [start];
  const firstStepByArea = new Map<
    string,
    Readonly<{ id: string; destination: Readonly<{ id: string; name: string }> }>
  >();
  const seen = new Set(queue);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const exit of state.areaExitsByArea.get(current) ?? []) {
      const destinationId = exit.destination.id;
      if (!state.discoveredAreaIds.has(destinationId) || seen.has(destinationId)) continue;
      seen.add(destinationId);
      firstStepByArea.set(destinationId, firstStepByArea.get(current) ?? exit);
      if (destinationMatches(destinationId)) {
        const first = firstStepByArea.get(destinationId)!;
        return {
          routeId: first.id,
          destinationAreaId: first.destination.id,
          destinationName: first.destination.name,
        };
      }
      queue.push(destinationId);
    }
  }
  return null;
}

function areaRouteAction(step: JourneyOpportunityAreaStep): JourneyOpportunityNextAction {
  return freezeAction({
    tool: OPPORTUNITY_MOVE_AREA_TOOL,
    arguments: { area_route_id: step.routeId },
    command: `enter ${step.destinationAreaId}`,
    label: `Take one local route toward ${step.destinationName}.`,
  });
}

function nextJourneyOpportunityAreaProgress(
  state: JourneyOpportunityExplanationState,
  targetAreaId: string,
): JourneyOpportunityNextAction {
  const targetStep = firstDiscoveredRouteStep(state, (areaId) => areaId === targetAreaId);
  if (targetStep) return areaRouteAction(targetStep);
  const discoveryAction = state.currentAreaDiscoveryAction();
  if (discoveryAction) return freezeAction(discoveryAction);
  const frontierStep = firstDiscoveredRouteStep(
    state,
    (areaId) => !state.visitedAreaIds.has(areaId),
  );
  if (frontierStep) return areaRouteAction(frontierStep);
  throw new Error("No available local action can reveal the route to this lead.");
}

function localAreaAction(
  state: JourneyOpportunityExplanationState,
  areaId: string,
): JourneyOpportunityNextAction {
  if (!state.currentAreaId || !state.areasById.has(state.currentAreaId)) {
    throw new Error("This opportunity has no current local area.");
  }
  return nextJourneyOpportunityAreaProgress(state, areaId);
}

function eventAction(
  state: JourneyOpportunityExplanationState,
  event: JourneyOpportunityEventDefinition,
): JourneyOpportunityNextAction {
  const scene = event.authored_scene;
  if (!scene) throw new Error("This event has no available follow-up.");
  if (!state.journalEntryIds.has(`scout:${scene.required_poi_id}`)) {
    return freezeAction({
      tool: OPPORTUNITY_SCOUT_POI_TOOL,
      arguments: { poi_id: scene.required_poi_id },
      command: `scout ${scene.required_poi_id}`,
      label: "Scout the required point of interest.",
    });
  }
  if (!hasTalkedTo(state.journalEntryIds, scene.required_contact_id)) {
    return freezeAction({
      tool: OPPORTUNITY_TALK_CONTACT_TOOL,
      arguments: { character_id: scene.required_contact_id },
      command: `talk ${scene.required_contact_id}`,
      label: "Talk to the required contact.",
    });
  }
  if (!state.journalEntryIds.has(`investigate:${event.id}`)) {
    return freezeAction({
      tool: OPPORTUNITY_INVESTIGATE_EVENT_TOOL,
      arguments: { event_id: event.id },
      command: `investigate ${event.id}`,
      label: `Investigate ${event.title}.`,
    });
  }
  const choice = state.eventChoices.find(([eventId]) => eventId === event.id);
  const option = choice ? scene.options.find((candidate) => candidate.id === choice[1]) : undefined;
  if (!choice || !option) {
    throw new Error("This event has no legal action right now.");
  }
  return freezeAction({
    tool: OPPORTUNITY_RESOLVE_EVENT_TOOL,
    arguments: { event_id: event.id, option_id: option.id },
    command: `resolve ${event.id} ${option.id}`,
    label: `Choose “${option.title}” for this event.`,
  });
}

function jobAction(
  state: JourneyOpportunityExplanationState,
  job: JourneyOpportunityJobDefinition,
): JourneyOpportunityNextAction {
  const scene = job.authored_scene;
  if (!scene) throw new Error("This job has no available follow-up.");
  if (!state.journalEntryIds.has(`scout:${scene.required_poi_id}`)) {
    return freezeAction({
      tool: OPPORTUNITY_SCOUT_POI_TOOL,
      arguments: { poi_id: scene.required_poi_id },
      command: `scout ${scene.required_poi_id}`,
      label: "Scout the required point of interest.",
    });
  }
  if (!hasTalkedTo(state.journalEntryIds, scene.required_contact_id)) {
    return freezeAction({
      tool: OPPORTUNITY_TALK_CONTACT_TOOL,
      arguments: { character_id: scene.required_contact_id },
      command: `talk ${scene.required_contact_id}`,
      label: "Talk to the required contact.",
    });
  }
  const choice = state.jobChoices.find(([jobId]) => jobId === job.id);
  const option = choice ? scene.options.find((candidate) => candidate.id === choice[1]) : undefined;
  if (!choice || !option) {
    throw new Error("This job has no legal action right now.");
  }
  return freezeAction({
    tool: OPPORTUNITY_WORK_JOB_TOOL,
    arguments: { job_id: job.id, option_id: option.id },
    command: `work ${job.id} ${option.id}`,
    label: `Choose “${option.title}” for this job.`,
  });
}

export function explainJourneyOpportunity(
  state: JourneyOpportunityExplanationState,
  identity: JourneyOpportunityIdentity,
): JourneyOpportunityExplanation {
  const lead = requireProjectedLead(state.opportunities, identity);
  const definition =
    identity.kind === "event" ? state.eventsById.get(identity.id) : state.jobsById.get(identity.id);
  if (!definition) {
    throw new Error(
      `Opportunity lead "${identity.kind}:${identity.id}" is not currently projected.`,
    );
  }
  let nextAction: JourneyOpportunityNextAction;
  if (state.currentTownId !== definition.home) {
    nextAction = roadAction(state, definition.home);
  } else if (lead.access === "mapped" || lead.access === "route_unmapped") {
    nextAction = localAreaAction(state, definition.area);
  } else if (definition.area !== state.currentAreaId) {
    throw new Error("This opportunity is not in the current area.");
  } else {
    nextAction =
      identity.kind === "event"
        ? eventAction(state, definition as JourneyOpportunityEventDefinition)
        : jobAction(state, definition as JourneyOpportunityJobDefinition);
  }
  return Object.freeze({
    lead: Object.freeze({ ...lead }),
    nextAction,
  });
}
