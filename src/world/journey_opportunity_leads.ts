import {
  JOURNEY_OPPORTUNITY_GUIDANCE,
  type JourneyOpportunityAccess,
  type JourneyOpportunityLeadPresentation,
  type JourneyOpportunityPresentation,
} from "./journey_contract.js";
import { localEventSceneRequirementsMet } from "./local_event_scene.js";
import { availableLocalJobSceneOptions } from "./local_job_scene.js";
import type { OverworldArea, OverworldLocalEvent, OverworldLocalJob } from "./overworld.js";
import type { CampaignCharacterState } from "./campaign_character_state.js";
import { compareCaseFoldedCodeUnits, compareCodeUnits } from "./string_order.js";

type JourneyOpportunityProjectionState = Readonly<{
  currentAreaId: string | null;
  areasById: ReadonlyMap<string, OverworldArea>;
  events: readonly OverworldLocalEvent[];
  jobs: readonly OverworldLocalJob[];
  visitedTownIds: ReadonlySet<string>;
  completedQuestIds: ReadonlySet<string>;
  resolvedEventIds: ReadonlySet<string>;
  discoveredAreaIds: ReadonlySet<string>;
  discoveredJobIds: ReadonlySet<string>;
  completedJobIds: ReadonlySet<string>;
  worldFactIds: ReadonlySet<string>;
  storyChoiceKeys?: ReadonlySet<string> | undefined;
  character?: CampaignCharacterState | undefined;
  eventOptionIdFor: (eventId: string) => string | null;
}>;

const ACCESS_ORDER: Readonly<Record<JourneyOpportunityAccess, number>> = Object.freeze({
  here: 0,
  mapped: 1,
  route_unmapped: 2,
});

export function deferJourneyOpportunityDetails(
  opportunities: JourneyOpportunityPresentation | null,
): JourneyOpportunityPresentation | null {
  if (!opportunities || opportunities.leads.length === 0) return opportunities;
  const deferredLeadCount = opportunities.leads.length;
  const subject = deferredLeadCount === 1 ? "lead remains" : "leads remain";
  return Object.freeze({
    guidance: `Choose the current journey option first. ${String(deferredLeadCount)} optional follow-up ${subject}. Complete any other required choice. The leads return when play resumes.`,
    leads: Object.freeze([]),
    deferredLeadCount,
  });
}

function opportunityAccess(
  areaId: string,
  currentAreaId: string | null,
  discoveredAreaIds: ReadonlySet<string>,
): JourneyOpportunityAccess {
  if (areaId === currentAreaId) return "here";
  return discoveredAreaIds.has(areaId) ? "mapped" : "route_unmapped";
}

function opportunityLead(
  value: Pick<OverworldLocalEvent | OverworldLocalJob, "id" | "area" | "home" | "title">,
  kind: JourneyOpportunityLeadPresentation["kind"],
  state: JourneyOpportunityProjectionState,
): JourneyOpportunityLeadPresentation | null {
  const area = state.areasById.get(value.area);
  if (!area || area.home !== value.home) return null;
  return Object.freeze({
    id: value.id,
    kind,
    title: value.title,
    area: area.name,
    access: opportunityAccess(value.area, state.currentAreaId, state.discoveredAreaIds),
  });
}

function compareOpportunityLeads(
  left: JourneyOpportunityLeadPresentation,
  right: JourneyOpportunityLeadPresentation,
): number {
  const access = ACCESS_ORDER[left.access] - ACCESS_ORDER[right.access];
  if (access !== 0) return access;
  const area = compareCaseFoldedCodeUnits(left.area, right.area);
  if (area !== 0) return area;
  const title = compareCaseFoldedCodeUnits(left.title, right.title);
  if (title !== 0) return title;
  const kind = compareCodeUnits(left.kind, right.kind);
  return kind !== 0 ? kind : compareCodeUnits(left.id, right.id);
}

/**
 * Project optional authored aftermath without changing discovery or persistence.
 * Authored events are the roots of their local chains and may therefore be heard
 * about before their route is mapped, but only after their town has been visited.
 * Authored jobs retain normal discovery and chronology gates wherever the player
 * travels, so a revealed return packet is not forgotten on departure.
 */
export function projectJourneyOpportunities(
  state: JourneyOpportunityProjectionState,
): JourneyOpportunityPresentation | null {
  const leads: JourneyOpportunityLeadPresentation[] = [];

  for (const event of state.events) {
    const scene = event.authored_scene;
    if (
      !state.visitedTownIds.has(event.home) ||
      !scene ||
      (scene.requires_completed_quests?.length ?? 0) === 0 ||
      state.resolvedEventIds.has(event.id) ||
      !localEventSceneRequirementsMet(scene, state)
    ) {
      continue;
    }
    const lead = opportunityLead(event, "event", state);
    if (lead) leads.push(lead);
  }

  for (const job of state.jobs) {
    const scene = job.authored_scene;
    if (
      !state.visitedTownIds.has(job.home) ||
      !scene ||
      !state.discoveredJobIds.has(job.id) ||
      state.completedJobIds.has(job.id) ||
      availableLocalJobSceneOptions(scene, state).length === 0
    ) {
      continue;
    }
    const lead = opportunityLead(job, "job", state);
    if (lead) leads.push(lead);
  }

  if (leads.length === 0) return null;
  leads.sort(compareOpportunityLeads);
  return Object.freeze({
    guidance: JOURNEY_OPPORTUNITY_GUIDANCE,
    leads: Object.freeze(leads),
  });
}
