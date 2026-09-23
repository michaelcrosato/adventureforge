import type {
  OverworldArea,
  OverworldAreaEdge,
  OverworldCampaignServiceRule,
  OverworldCharacter,
  OverworldEdge,
  OverworldExit,
  OverworldExplorationSite,
  OverworldLocalEvent,
  OverworldLocalJob,
  OverworldManifest,
  OverworldNode,
  OverworldPoi,
  OverworldQuest,
  OverworldRegionalArc,
  OverworldRoadEvent,
} from "./overworld.js";
import {
  allOverworldContactPresentations,
  type OverworldContactPresentation,
} from "./session_contact_presentation.js";
import type { OpeningRegistration } from "./opening_registration.js";
import type { OpeningAlly } from "./opening_ally.js";
import {
  openingAllyJournalId,
  openingAllyOfferJournalDraft,
  type OpeningAllyJournalDraft,
} from "./opening_ally_journal.js";
import type { OpeningLeadSource } from "./opening_lead_source.js";
import {
  openingLeadSourceJournalId,
  openingLeadSourceOfferJournalDraft,
  type OpeningLeadSourceJournalDraft,
} from "./opening_lead_source_journal.js";
import type { OpeningPreparation } from "./opening_preparation.js";
import {
  openingPreparationJournalId,
  openingPreparationOfferJournalDraft,
  type OpeningPreparationJournalDraft,
} from "./opening_preparation_journal.js";
import type { OpeningReliefAllocation } from "./opening_relief_allocation.js";
import {
  openingReliefAllocationJournalId,
  openingReliefAllocationOfferJournalDraft,
  type OpeningReliefAllocationJournalDraft,
} from "./opening_relief_allocation_journal.js";
import type { OpeningReliefOath } from "./opening_relief_oath.js";
import {
  openingReliefOathJournalId,
  openingReliefOathOfferJournalDraft,
  type OpeningReliefOathJournalDraft,
} from "./opening_relief_oath_journal.js";
import {
  allOpeningRegistrationJournalDrafts,
  openingRegistrationOfferJournalDraft,
  type OpeningRegistrationJournalDraft,
} from "./opening_registration_journal.js";

export type OverworldSnapshotManifestIndex = {
  arcIds: ReadonlySet<string>;
  arcRegionNames: ReadonlyMap<string, string>;
  areaHomes: ReadonlyMap<string, string>;
  areaEdgesById: ReadonlyMap<string, OverworldAreaEdge>;
  areaIds: ReadonlySet<string>;
  areasById: ReadonlyMap<string, OverworldArea>;
  areasByTown: ReadonlyMap<string, readonly OverworldArea[]>;
  areaTownNames: ReadonlyMap<string, string>;
  characterIds: ReadonlySet<string>;
  charactersById: ReadonlyMap<string, OverworldCharacter>;
  characterTownNames: ReadonlyMap<string, string>;
  campaignServiceRulesById: ReadonlyMap<string, OverworldCampaignServiceRule>;
  contactPresentationsByJournalId: ReadonlyMap<string, OverworldContactPresentation>;
  edgeIds: ReadonlySet<string>;
  edgesById: ReadonlyMap<string, OverworldEdge>;
  eventIds: ReadonlySet<string>;
  eventsById: ReadonlyMap<string, OverworldLocalEvent>;
  eventTownNames: ReadonlyMap<string, string>;
  jobIds: ReadonlySet<string>;
  jobsById: ReadonlyMap<string, OverworldLocalJob>;
  jobsByTown: ReadonlyMap<string, readonly OverworldLocalJob[]>;
  jobTownNames: ReadonlyMap<string, string>;
  nodeIds: ReadonlySet<string>;
  nodesById: ReadonlyMap<string, OverworldNode>;
  openingLeadSource: OpeningLeadSource | null;
  openingLeadSourceJournalIds: ReadonlySet<string>;
  openingLeadSourceOfferDraft: OpeningLeadSourceJournalDraft | null;
  openingLeadSourceTownName: string | null;
  openingAlly: OpeningAlly | null;
  openingAllyJournalIds: ReadonlySet<string>;
  openingAllyOfferDraft: OpeningAllyJournalDraft | null;
  openingAllyTownName: string | null;
  openingPreparation: OpeningPreparation | null;
  openingPreparationJournalIds: ReadonlySet<string>;
  openingPreparationOfferDraft: OpeningPreparationJournalDraft | null;
  openingPreparationTownName: string | null;
  openingReliefAllocation: OpeningReliefAllocation | null;
  openingReliefAllocationJournalIds: ReadonlySet<string>;
  openingReliefAllocationOfferDraft: OpeningReliefAllocationJournalDraft | null;
  openingReliefAllocationTownName: string | null;
  openingReliefOath: OpeningReliefOath | null;
  openingReliefOathJournalIds: ReadonlySet<string>;
  openingReliefOathOfferDraft: OpeningReliefOathJournalDraft | null;
  openingReliefOathTownName: string | null;
  openingRegistration: OpeningRegistration | null;
  openingRegistrationJournalDraftsById: ReadonlyMap<string, OpeningRegistrationJournalDraft>;
  openingRegistrationTownName: string | null;
  poiIds: ReadonlySet<string>;
  poisById: ReadonlyMap<string, OverworldPoi>;
  poiTownNames: ReadonlyMap<string, string>;
  questIds: ReadonlySet<string>;
  questsById: ReadonlyMap<string, OverworldQuest>;
  questsByTown: ReadonlyMap<string, readonly OverworldQuest[]>;
  questTownNames: ReadonlyMap<string, string>;
  regionalArcs: readonly OverworldRegionalArc[];
  regionNames: ReadonlySet<string>;
  roadEventsByEdgeId: ReadonlyMap<string, OverworldRoadEvent>;
  roadExitsByTown: ReadonlyMap<string, readonly OverworldExit[]>;
  siteIds: ReadonlySet<string>;
  sitesByArea: ReadonlyMap<string, readonly OverworldExplorationSite[]>;
  sitesById: ReadonlyMap<string, OverworldExplorationSite>;
  siteTownNames: ReadonlyMap<string, string>;
  townNameForSource: (nodeId: string) => string;
  townNames: ReadonlySet<string>;
};

type OverworldSnapshotManifestIndexSources = {
  areasById: ReadonlyMap<string, OverworldArea>;
  areasByTown: ReadonlyMap<string, readonly OverworldArea[]>;
  charactersById: ReadonlyMap<string, OverworldCharacter>;
  eventsById: ReadonlyMap<string, OverworldLocalEvent>;
  jobsById: ReadonlyMap<string, OverworldLocalJob>;
  jobsByTown: ReadonlyMap<string, readonly OverworldLocalJob[]>;
  nodesById: ReadonlyMap<string, OverworldNode>;
  poisById: ReadonlyMap<string, OverworldPoi>;
  questsById: ReadonlyMap<string, OverworldQuest>;
  questsByTown: ReadonlyMap<string, readonly OverworldQuest[]>;
  roadEventsByEdgeId: ReadonlyMap<string, OverworldRoadEvent>;
  roadExitsByTown: ReadonlyMap<string, readonly OverworldExit[]>;
  sitesByArea: ReadonlyMap<string, readonly OverworldExplorationSite[]>;
  sitesById: ReadonlyMap<string, OverworldExplorationSite>;
  world: OverworldManifest;
};

export function buildOverworldSnapshotManifestIndex(
  sources: OverworldSnapshotManifestIndexSources,
): OverworldSnapshotManifestIndex {
  const townNameById = new Map<string, string>();
  const nodeIds = new Set<string>();
  const townNames = new Set<string>();
  for (const [nodeId, node] of sources.nodesById) {
    townNameById.set(nodeId, node.name);
    nodeIds.add(nodeId);
    townNames.add(node.name);
  }
  const townNameForSource = (nodeId: string): string => townNameById.get(nodeId) ?? nodeId;

  const campaignServiceRulesById = new Map<string, OverworldCampaignServiceRule>();
  for (const rule of sources.world.campaign_service_rules ?? []) {
    if (campaignServiceRulesById.has(rule.id)) {
      throw new Error(`Duplicate campaign service rule id "${rule.id}".`);
    }
    campaignServiceRulesById.set(rule.id, rule);
  }

  const areaEdgesById = new Map<string, OverworldAreaEdge>();
  for (const edge of sources.world.area_edges) {
    if (areaEdgesById.has(edge.id)) {
      throw new Error(`Duplicate overworld area edge id "${edge.id}".`);
    }
    areaEdgesById.set(edge.id, edge);
  }

  const openingRegistration = sources.world.opening_registration ?? null;
  const openingAlly = sources.world.opening_ally ?? null;
  const openingAllyJournalIds = new Set<string>();
  const openingAllyOfferDraft = openingAlly ? openingAllyOfferJournalDraft(openingAlly) : null;
  if (openingAlly) {
    for (const option of openingAlly.options) {
      openingAllyJournalIds.add(openingAllyJournalId(openingAlly.id, option.id));
    }
  }
  const openingLeadSource = sources.world.opening_lead_source ?? null;
  const openingLeadSourceJournalIds = new Set<string>();
  const openingLeadSourceOfferDraft = openingLeadSource
    ? openingLeadSourceOfferJournalDraft(openingLeadSource)
    : null;
  if (openingLeadSource) {
    for (const option of openingLeadSource.options) {
      openingLeadSourceJournalIds.add(openingLeadSourceJournalId(openingLeadSource.id, option.id));
    }
  }
  const openingPreparation = sources.world.opening_preparation ?? null;
  const openingPreparationJournalIds = new Set<string>();
  const openingPreparationOfferDraft = openingPreparation
    ? openingPreparationOfferJournalDraft(openingPreparation)
    : null;
  if (openingPreparation) {
    for (const profile of openingPreparation.profiles) {
      openingPreparationJournalIds.add(
        openingPreparationJournalId(openingPreparation.id, profile.id),
      );
    }
  }
  const openingReliefAllocation = sources.world.opening_relief_allocation ?? null;
  const openingReliefAllocationJournalIds = new Set<string>();
  const openingReliefAllocationOfferDraft = openingReliefAllocation
    ? openingReliefAllocationOfferJournalDraft(openingReliefAllocation)
    : null;
  if (openingReliefAllocation) {
    for (const option of openingReliefAllocation.options) {
      openingReliefAllocationJournalIds.add(
        openingReliefAllocationJournalId(openingReliefAllocation.id, option.id),
      );
    }
  }
  const openingReliefOath = sources.world.opening_relief_oath ?? null;
  const openingReliefOathJournalIds = new Set<string>();
  const openingReliefOathOfferDraft = openingReliefOath
    ? openingReliefOathOfferJournalDraft(openingReliefOath)
    : null;
  if (openingReliefOath) {
    for (const option of openingReliefOath.options) {
      openingReliefOathJournalIds.add(openingReliefOathJournalId(openingReliefOath.id, option.id));
    }
  }
  const openingRegistrationJournalDraftsById = new Map<string, OpeningRegistrationJournalDraft>();
  if (openingRegistration) {
    for (const draft of [
      openingRegistrationOfferJournalDraft(openingRegistration),
      ...allOpeningRegistrationJournalDrafts(openingRegistration),
    ]) {
      openingRegistrationJournalDraftsById.set(draft.id, draft);
    }
  }

  const edgesById = new Map<string, OverworldEdge>();
  const edgeIds = new Set<string>();
  for (const edge of sources.world.edges) {
    edgesById.set(edge.id, edge);
    edgeIds.add(edge.id);
  }

  const arcIds = new Set<string>();
  const arcRegionNames = new Map<string, string>();
  for (const arc of sources.world.regional_arcs) {
    arcIds.add(arc.id);
    arcRegionNames.set(arc.id, arc.region);
  }

  const areaHomes = new Map<string, string>();
  const areaIds = new Set<string>();
  const areaTownNames = new Map<string, string>();
  for (const [areaId, area] of sources.areasById) {
    areaHomes.set(areaId, area.home);
    areaIds.add(areaId);
    areaTownNames.set(areaId, townNameForSource(area.home));
  }

  const characterIds = new Set<string>();
  const characterTownNames = new Map<string, string>();
  const contactPresentationsByJournalId = new Map<string, OverworldContactPresentation>();
  for (const [characterId, character] of sources.charactersById) {
    characterIds.add(characterId);
    characterTownNames.set(characterId, townNameForSource(character.home));
    for (const presentation of allOverworldContactPresentations(character)) {
      if (contactPresentationsByJournalId.has(presentation.journalId)) {
        throw new Error(`Duplicate overworld contact journal id "${presentation.journalId}".`);
      }
      contactPresentationsByJournalId.set(presentation.journalId, presentation);
    }
  }

  const eventIds = new Set<string>();
  const eventTownNames = new Map<string, string>();
  for (const [eventId, event] of sources.eventsById) {
    eventIds.add(eventId);
    eventTownNames.set(eventId, townNameForSource(event.home));
  }

  const jobIds = new Set<string>();
  const jobTownNames = new Map<string, string>();
  for (const [jobId, job] of sources.jobsById) {
    jobIds.add(jobId);
    jobTownNames.set(jobId, townNameForSource(job.home));
  }

  const poiIds = new Set<string>();
  const poiTownNames = new Map<string, string>();
  for (const [poiId, poi] of sources.poisById) {
    poiIds.add(poiId);
    poiTownNames.set(poiId, townNameForSource(poi.home));
  }

  const questIds = new Set<string>();
  const questTownNames = new Map<string, string>();
  for (const [questId, quest] of sources.questsById) {
    questIds.add(questId);
    questTownNames.set(questId, townNameForSource(quest.home));
  }

  const regionNames = new Set<string>();
  for (const region of sources.world.regions) regionNames.add(region.name);

  const siteIds = new Set<string>();
  const siteTownNames = new Map<string, string>();
  for (const [siteId, site] of sources.sitesById) {
    siteIds.add(siteId);
    siteTownNames.set(siteId, townNameForSource(site.nearest_town));
  }

  return {
    arcIds,
    arcRegionNames,
    areaHomes,
    areaEdgesById,
    areaIds,
    areasById: sources.areasById,
    areasByTown: sources.areasByTown,
    areaTownNames,
    characterIds,
    charactersById: sources.charactersById,
    characterTownNames,
    campaignServiceRulesById,
    contactPresentationsByJournalId,
    edgeIds,
    edgesById,
    eventIds,
    eventsById: sources.eventsById,
    eventTownNames,
    jobIds,
    jobsById: sources.jobsById,
    jobsByTown: sources.jobsByTown,
    jobTownNames,
    nodeIds,
    nodesById: sources.nodesById,
    openingLeadSource,
    openingLeadSourceJournalIds,
    openingLeadSourceOfferDraft,
    openingLeadSourceTownName: openingLeadSource ? townNameForSource(openingLeadSource.home) : null,
    openingAlly,
    openingAllyJournalIds,
    openingAllyOfferDraft,
    openingAllyTownName: openingAlly ? townNameForSource(openingAlly.home) : null,
    openingPreparation,
    openingPreparationJournalIds,
    openingPreparationOfferDraft,
    openingPreparationTownName: openingPreparation
      ? townNameForSource(openingPreparation.home)
      : null,
    openingReliefAllocation,
    openingReliefAllocationJournalIds,
    openingReliefAllocationOfferDraft,
    openingReliefAllocationTownName: openingReliefAllocation
      ? townNameForSource(openingReliefAllocation.home)
      : null,
    openingReliefOath,
    openingReliefOathJournalIds,
    openingReliefOathOfferDraft,
    openingReliefOathTownName: openingReliefOath ? townNameForSource(openingReliefOath.home) : null,
    openingRegistration,
    openingRegistrationJournalDraftsById,
    openingRegistrationTownName: openingRegistration
      ? townNameForSource(openingRegistration.home)
      : null,
    poiIds,
    poisById: sources.poisById,
    poiTownNames,
    questIds,
    questsById: sources.questsById,
    questsByTown: sources.questsByTown,
    questTownNames,
    regionalArcs: sources.world.regional_arcs,
    regionNames,
    roadEventsByEdgeId: sources.roadEventsByEdgeId,
    roadExitsByTown: sources.roadExitsByTown,
    siteIds,
    sitesByArea: sources.sitesByArea,
    sitesById: sources.sitesById,
    siteTownNames,
    townNameForSource,
    townNames,
  };
}
