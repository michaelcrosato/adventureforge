import type {
  OverworldArea,
  OverworldExplorationSite,
  OverworldLocalJob,
  OverworldQuest,
} from "./overworld.js";
import {
  presentOverworldQuestLaunch,
  projectOverworldQuestLaunchOption,
  type OverworldQuestLaunchResources,
  type OverworldQuestLaunchView,
} from "./quest_launch.js";
import type { QuestDispatchPresentationWindow } from "./quest_dispatch_window.js";
import { wolfHillRoutePresentation } from "./wolf_hill_route_presentation.js";

export type OverworldQuestView = {
  id: string;
  title: string;
  home: string;
  area: string;
  discovery: string;
  visibility: OverworldQuest["visibility"];
  launch?: OverworldQuestLaunchView;
};

export type OverworldLocalDiscoveryResult = {
  discoveredAreas: OverworldArea[];
  discoveredJobs: OverworldLocalJob[];
  discoveredSites: OverworldExplorationSite[];
  discoveredQuests: OverworldQuestView[];
};

type OverworldLocalDiscoveryState = {
  townId: string;
  currentTownId: string;
  areasByTown: ReadonlyMap<string, readonly OverworldArea[]>;
  jobsByTown: ReadonlyMap<string, readonly OverworldLocalJob[]>;
  currentAreaSites: readonly OverworldExplorationSite[];
  questsByTown: ReadonlyMap<string, readonly OverworldQuest[]>;
  discoveredAreaIds: ReadonlySet<string>;
  discoveredJobIds: ReadonlySet<string>;
  discoveredSiteIds: ReadonlySet<string>;
  discoveredQuestIds: ReadonlySet<string>;
  excludedQuestIds?: ReadonlySet<string>;
};

type MutableOverworldLocalDiscoveryIds = {
  discoveredAreaIds: Set<string>;
  discoveredJobIds: Set<string>;
  discoveredSiteIds: Set<string>;
  discoveredQuestIds: Set<string>;
};

export function questReferenceView(quest: OverworldQuest): OverworldQuestView {
  return {
    id: quest.id,
    title: quest.title,
    home: quest.home,
    area: quest.area,
    discovery: quest.discovery,
    visibility: quest.visibility,
  };
}

/**
 * Reveal a quest lead together with the local district named by that lead.
 *
 * Normal notice-board discovery already has the district in its local
 * discovery prefix. Campaign scenes may certify a lead before that prefix has
 * advanced, though. In that case the named anchor is part of the lead's
 * actionable information: without it the player can read the quest but cannot
 * take its legal local route. Keep this rule data-driven from `quest.area` so
 * every direct quest revelation observes the same contract.
 */
export function revealOverworldQuestAnchor(
  state: Pick<MutableOverworldLocalDiscoveryIds, "discoveredAreaIds" | "discoveredQuestIds">,
  questsById: ReadonlyMap<string, OverworldQuest>,
  questId: string,
): boolean {
  const quest = questsById.get(questId);
  if (!quest) throw new Error(`Cannot reveal unknown overworld quest "${questId}".`);

  const questChanged = !state.discoveredQuestIds.has(quest.id);
  state.discoveredQuestIds.add(quest.id);
  const areaChanged = !state.discoveredAreaIds.has(quest.area);
  state.discoveredAreaIds.add(quest.area);
  return questChanged || areaChanged;
}

export function questView(
  quest: OverworldQuest,
  resources?: OverworldQuestLaunchResources,
  selectedApproachId?: string,
  knowledgeIds?: readonly string[],
  dispatchWindow?: QuestDispatchPresentationWindow,
): OverworldQuestView {
  return {
    ...questReferenceView(quest),
    ...(quest.launch
      ? {
          launch: presentOverworldQuestLaunch(
            quest.launch,
            resources,
            selectedApproachId,
            knowledgeIds,
            dispatchWindow,
          ),
        }
      : {}),
  };
}

export function projectOverworldQuestView(
  quest: OverworldQuestView,
  resources: OverworldQuestLaunchResources,
  knowledgeIds?: readonly string[],
  dispatchWindow?: QuestDispatchPresentationWindow,
): OverworldQuestView {
  const launch = quest.launch;
  if (!launch) return { ...quest };
  return {
    ...quest,
    launch: {
      id: launch.id,
      prompt: launch.prompt,
      options: launch.options.map((option) => {
        const routePresentation = wolfHillRoutePresentation({
          launchId: launch.id,
          optionId: option.id,
          ...(knowledgeIds ? { knowledgeIds } : {}),
          ...(dispatchWindow ? { dispatchWindow } : {}),
        });
        return {
          id: option.id,
          title: option.title,
          summary: option.summary,
          preview: option.preview,
          consequence: option.consequence,
          ...(routePresentation ? { tradeoffSummary: routePresentation.tradeoffSummary } : {}),
          terms: { ...option.terms },
          projection: projectOverworldQuestLaunchOption(option, resources),
        };
      }),
      ...(launch.selected ? { selected: { ...launch.selected } } : {}),
    },
  };
}

export function emptyOverworldLocalDiscovery(): OverworldLocalDiscoveryResult {
  return {
    discoveredAreas: [],
    discoveredJobs: [],
    discoveredSites: [],
    discoveredQuests: [],
  };
}

export function planOverworldLocalDiscovery(
  state: OverworldLocalDiscoveryState,
): OverworldLocalDiscoveryResult {
  const discovery = emptyOverworldLocalDiscovery();

  const area = (state.areasByTown.get(state.townId) ?? []).find(
    (candidate) => !state.discoveredAreaIds.has(candidate.id),
  );
  if (area) discovery.discoveredAreas.push(area);

  const discoveredAreaIds = new Set(state.discoveredAreaIds);
  for (const discoveredArea of discovery.discoveredAreas) discoveredAreaIds.add(discoveredArea.id);

  const job = (state.jobsByTown.get(state.townId) ?? []).find(
    (candidate) =>
      discoveredAreaIds.has(candidate.area) && !state.discoveredJobIds.has(candidate.id),
  );
  if (job) discovery.discoveredJobs.push(job);

  if (state.townId === state.currentTownId) {
    const site = state.currentAreaSites.find(
      (candidate) => !state.discoveredSiteIds.has(candidate.id),
    );
    if (site) discovery.discoveredSites.push(site);
  }

  const quest = (state.questsByTown.get(state.townId) ?? []).find(
    (candidate) =>
      discoveredAreaIds.has(candidate.area) &&
      !state.discoveredQuestIds.has(candidate.id) &&
      !state.excludedQuestIds?.has(candidate.id),
  );
  if (quest) discovery.discoveredQuests.push(questView(quest));

  return discovery;
}

function addDiscoveredIds<T extends { id: string }>(
  target: Set<string>,
  values: readonly T[],
): boolean {
  let changed = false;
  for (const value of values) {
    if (target.has(value.id)) continue;
    target.add(value.id);
    changed = true;
  }
  return changed;
}

export function applyOverworldLocalDiscovery(
  state: MutableOverworldLocalDiscoveryIds,
  discovery: OverworldLocalDiscoveryResult,
): boolean {
  const areasChanged = addDiscoveredIds(state.discoveredAreaIds, discovery.discoveredAreas);
  const jobsChanged = addDiscoveredIds(state.discoveredJobIds, discovery.discoveredJobs);
  const sitesChanged = addDiscoveredIds(state.discoveredSiteIds, discovery.discoveredSites);
  const questsChanged = addDiscoveredIds(state.discoveredQuestIds, discovery.discoveredQuests);
  return areasChanged || jobsChanged || sitesChanged || questsChanged;
}
