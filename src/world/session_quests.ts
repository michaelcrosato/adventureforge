import {
  overworldQuestCampaignEffectsForCharacter,
  overworldQuestCampaignExportForEnding,
  type OverworldArea,
  type OverworldNode,
  type OverworldQuest,
  type OverworldQuestCampaignExport,
} from "./overworld.js";
import {
  applyCampaignConsequences,
  deriveCampaignWorldFactIds,
  type CampaignConsequenceApplication,
  type CampaignConsequenceEffect,
} from "./campaign_consequences.js";
import {
  cloneCampaignCharacterState,
  type CampaignCharacterState,
} from "./campaign_character_state.js";
import {
  questReferenceView,
  questView,
  type OverworldQuestView,
} from "./session_local_discovery.js";
import type { OverworldJournalEntry } from "./session_snapshot.js";
import {
  applyOverworldQuestLaunchOption,
  overworldQuestStartPreconditionFingerprint,
  projectOverworldQuestLaunchOption,
  type OverworldQuestLaunch,
  type OverworldQuestLaunchResources,
} from "./quest_launch.js";
import type { OpeningLeadSource } from "./opening_lead_source.js";
import type { OpeningAlly } from "./opening_ally.js";
import type { OpeningPreparation } from "./opening_preparation.js";
import type { OpeningRegistration } from "./opening_registration.js";
import type { OpeningReliefAllocation } from "./opening_relief_allocation.js";
import type { OpeningReliefOath } from "./opening_relief_oath.js";
import {
  deriveBrokenPromiseFoldbackReceipt,
  deriveRegistrationPromiseFoldbackReceipt,
} from "./registration_promise_receipt.js";
import { deriveQuestDispatchWindow, type QuestDispatchWindow } from "./quest_dispatch_window.js";

export type OverworldQuestCompletionOutcome = {
  endingId: string;
  endingTitle: string;
  death: boolean;
};

export type OverworldQuestStartState = {
  questId: string;
  questsById: ReadonlyMap<string, OverworldQuest>;
  areasById: ReadonlyMap<string, OverworldArea>;
  currentTownId: string;
  currentTownName: string;
  currentAreaId: string | null;
  discoveredQuestIds: ReadonlySet<string>;
  startedQuestIds: ReadonlySet<string>;
};

export type OverworldQuestPrepareState = OverworldQuestStartState & {
  approachId?: string;
  sessionFingerprint?: string;
  minutes: number;
  supplies: number;
  fatigue: number;
  character: CampaignCharacterState;
  journalEntries?: readonly OverworldJournalEntry[];
  openingRegistration?: OpeningRegistration | null;
  openingReliefOath?: OpeningReliefOath | null;
  openingLeadSource?: OpeningLeadSource | null;
  openingPreparation?: OpeningPreparation | null;
  openingReliefAllocation?: OpeningReliefAllocation | null;
  openingAlly?: OpeningAlly | null;
};

export type OverworldQuestCompletionState = {
  questId: string;
  outcome: OverworldQuestCompletionOutcome;
  character: CampaignCharacterState;
  questsById: ReadonlyMap<string, OverworldQuest>;
  areasById: ReadonlyMap<string, OverworldArea>;
  nodesById: ReadonlyMap<string, OverworldNode>;
  questOutcomeIds: ReadonlyMap<string, string>;
  startedQuestIds: ReadonlySet<string>;
  journalEntries?: readonly OverworldJournalEntry[];
  journalEntriesById?: ReadonlyMap<string, OverworldJournalEntry>;
  openingRegistration?: OpeningRegistration | null;
  openingReliefOath?: OpeningReliefOath | null;
  openingLeadSource?: OpeningLeadSource | null;
};

export type OverworldQuestStartPlan = {
  minutes: number;
  quest: OverworldQuestView;
  entryDraft: Omit<OverworldJournalEntry, "recordedAt">;
};

export type OverworldQuestStartPreparation = OverworldQuestStartPlan & {
  approachId: string | null;
  preconditionFingerprint: string;
  journeyActionId: string;
  minutes: number;
  minutesAfter: number;
  suppliesBefore: number;
  suppliesAfter: number;
  fatigueBefore: number;
  fatigueAfter: number;
  characterAfter: CampaignCharacterState;
  dispatchWindow: QuestDispatchWindow;
};

export type OverworldQuestCompletionPlan = {
  minutes: number;
  quest: OverworldQuestView;
  endingId: string;
  endingTitle: string;
  characterAfter: CampaignCharacterState;
  worldFactIds: readonly string[];
  renownRegion: string;
  renown: number;
  entryDraft: Omit<OverworldJournalEntry, "recordedAt">;
};

export type OverworldQuestStartApplicationState = {
  startedQuestIds: Set<string>;
};

export type OverworldQuestCompletionApplicationState = {
  completedQuestIds: Set<string>;
  regionRenown: Map<string, number>;
};

export type OverworldAppliedQuestLifecycle = {
  questId: string;
};

export type OverworldAppliedQuestCompletion = OverworldAppliedQuestLifecycle & {
  renownRegion: string;
  renownGained: number;
  renownAfter: number;
};

export type OverworldQuestCompletionResult = {
  minutes: number;
  alreadyKnown: boolean;
  quest: OverworldQuestView;
  endingId: string;
  endingTitle: string;
  renownRegion: string;
  renownGained: number;
  renownAfter: number;
  entry: OverworldJournalEntry;
};

// Completing a quest is the marquee accomplishment of a region's opening
// experience: local jobs award their difficulty (1–5), exploration sites their
// danger (1–5), road assists 2 — so a completed quest must visibly TOP any
// single errand or the reward hierarchy reads inverted (S1 from the 2026-07-07
// overworld blind run: a 50/60 quest ending awarded nothing while a ledger run
// paid 3).
export const QUEST_COMPLETION_RENOWN = 8;

// The on-site work a quest represents, on top of the local approach travel. This
// used to be spelled `QUEST_COMPLETION_RENOWN * 15`, which silently tied every
// quest's elapsed time to the reward-economy constant above: rebalancing renown
// 8 → 10 would have re-timed the whole game by +30 minutes each and invalidated
// journal text that quotes elapsed minutes. Two unrelated numbers, two constants.
export const QUEST_COMPLETION_LOCAL_WORK_MINUTES = 120;

export function questCompletionMinutes(
  quest: OverworldQuest,
  areasById: ReadonlyMap<string, OverworldArea>,
): number {
  const localApproachMinutes = areasById.get(quest.area)?.travel_minutes ?? 30;
  return localApproachMinutes + QUEST_COMPLETION_LOCAL_WORK_MINUTES;
}

/**
 * A non-empty catalog is an opt-in strict boundary. Legacy quests without one
 * keep their existing ending behavior until their exports are authored.
 */
export function questCampaignExportForEnding(
  quest: OverworldQuest,
  endingId: string,
): OverworldQuestCampaignExport | null {
  const campaignExport = overworldQuestCampaignExportForEnding(quest, endingId);
  if (quest.campaign_exports !== undefined && campaignExport === null) {
    throw new Error(
      `Overworld quest "${quest.id}" has no declared campaign export for ending "${endingId}".`,
    );
  }
  return campaignExport;
}

export function questCampaignEffectGroupsForOutcomes(
  questsById: ReadonlyMap<string, OverworldQuest>,
  questOutcomeIds: ReadonlyMap<string, string>,
): readonly (readonly CampaignConsequenceEffect[])[] {
  return [...questOutcomeIds]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([questId, endingId]) => {
      const quest = questsById.get(questId);
      if (!quest) throw new Error(`Unknown overworld quest "${questId}".`);
      const campaignExport = questCampaignExportForEnding(quest, endingId);
      return campaignExport ? [campaignExport.effects] : [];
    });
}

/** Replay trusted exports in completion order so party removal and promise resolution stay causal. */
export function replayQuestCampaignConsequences(args: {
  character: CampaignCharacterState;
  questsById: ReadonlyMap<string, OverworldQuest>;
  questOutcomeIds: ReadonlyMap<string, string>;
  questOutcomeOrder?: readonly string[];
}): CampaignConsequenceApplication {
  const order = args.questOutcomeOrder ?? [...args.questOutcomeIds.keys()].sort();
  if (
    new Set(order).size !== order.length ||
    order.length !== args.questOutcomeIds.size ||
    order.some((questId) => !args.questOutcomeIds.has(questId))
  ) {
    throw new Error("Quest consequence replay order must name every completed quest exactly once.");
  }
  const effectGroups: CampaignConsequenceEffect[][] = [];
  let characterAfter = cloneCampaignCharacterState(args.character);
  for (const questId of order) {
    const quest = args.questsById.get(questId);
    if (!quest) throw new Error(`Unknown overworld quest "${questId}".`);
    const endingId = args.questOutcomeIds.get(questId)!;
    const campaignExport = questCampaignExportForEnding(quest, endingId);
    if (!campaignExport) continue;
    const effects = [...overworldQuestCampaignEffectsForCharacter(campaignExport, characterAfter)];
    effectGroups.push(effects);
    characterAfter = applyCampaignConsequences({
      character: characterAfter,
      effects,
    }).characterAfter;
  }
  return {
    characterAfter,
    worldFactIds: deriveCampaignWorldFactIds(effectGroups),
  };
}

export function questCompletionJournalEntryDraft(args: {
  quest: OverworldQuest;
  endingId: string;
  endingTitle: string;
  minutes: number;
  townName: string;
  returnSummary?: string;
  registrationReceipt?: string;
  brokenPromiseReceipt?: string;
}): Omit<OverworldJournalEntry, "recordedAt"> {
  const baseText =
    `The quest closed at ${args.endingTitle} after ` +
    `${String(args.minutes)} minutes of local work.`;
  const text = [baseText, args.returnSummary, args.registrationReceipt, args.brokenPromiseReceipt]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" ");
  return {
    id: `quest_done:${args.quest.id}`,
    kind: "quest_done",
    town: args.townName,
    title: `Completed ${args.quest.title}`,
    text,
    questCompletionEndingId: args.endingId,
  };
}

function questLaunchReturnSummary(
  state: OverworldQuestCompletionState,
  quest: OverworldQuest,
): string | undefined {
  const proof = state.journalEntriesById?.get(`quest:${quest.id}`)?.questStartProof;
  if (proof?.kind !== "approach") return undefined;
  const option = quest.launch?.options.find((candidate) => candidate.id === proof.approachId);
  if (!option) {
    throw new Error(
      `Overworld quest "${quest.id}" start proof names unknown launch approach "${proof.approachId}".`,
    );
  }
  return option.return_summary;
}

function questAreaName(
  quest: OverworldQuest,
  areasById: ReadonlyMap<string, OverworldArea>,
): string {
  return areasById.get(quest.area)?.name ?? quest.area;
}

function questForOverworldQuestStart(state: OverworldQuestStartState): OverworldQuest {
  const quest = state.questsById.get(state.questId);
  if (!quest || quest.home !== state.currentTownId) {
    throw new Error("That quest lead is not in this town.");
  }
  if (!state.discoveredQuestIds.has(quest.id)) {
    throw new Error("Discover that local quest lead before starting it.");
  }
  if (state.startedQuestIds.has(quest.id)) {
    throw new Error(`${quest.title} is already active.`);
  }
  if (state.currentAreaId !== quest.area) {
    throw new Error(
      `Move to ${questAreaName(quest, state.areasById)} before starting ${quest.title}.`,
    );
  }
  return quest;
}

function questStartPreconditionFingerprint(
  state: OverworldQuestPrepareState,
  quest: OverworldQuest,
  approachId: string | null,
): string {
  return overworldQuestStartPreconditionFingerprint({
    ...(state.sessionFingerprint !== undefined
      ? { sessionFingerprint: state.sessionFingerprint }
      : {}),
    questId: quest.id,
    approachId,
    launch: quest.launch ?? null,
    currentTownId: state.currentTownId,
    currentAreaId: state.currentAreaId,
    minutes: state.minutes,
    supplies: state.supplies,
    fatigue: state.fatigue,
    character: state.character,
    discovered: state.discoveredQuestIds.has(quest.id),
    started: state.startedQuestIds.has(quest.id),
  });
}

function questDispatchWindowForPreparation(
  state: OverworldQuestPrepareState,
  questId: string,
): QuestDispatchWindow {
  return deriveQuestDispatchWindow({
    questId,
    ...(state.journalEntries !== undefined ? { journalEntries: state.journalEntries } : {}),
    ...(state.openingRegistration !== undefined
      ? { openingRegistration: state.openingRegistration }
      : {}),
    ...(state.openingReliefOath !== undefined
      ? { openingReliefOath: state.openingReliefOath }
      : {}),
    ...(state.openingLeadSource !== undefined
      ? { openingLeadSource: state.openingLeadSource }
      : {}),
    ...(state.openingPreparation !== undefined
      ? { openingPreparation: state.openingPreparation }
      : {}),
    ...(state.openingReliefAllocation !== undefined
      ? { openingReliefAllocation: state.openingReliefAllocation }
      : {}),
    ...(state.openingAlly !== undefined ? { openingAlly: state.openingAlly } : {}),
  });
}

export function previewOverworldQuestStart(state: OverworldQuestPrepareState): OverworldQuestView {
  const quest = questForOverworldQuestStart(state);
  const dispatchWindow = questDispatchWindowForPreparation(state, quest.id);
  return questView(
    quest,
    {
      minutes: state.minutes,
      supplies: state.supplies,
      fatigue: state.fatigue,
    },
    undefined,
    state.character.knowledge,
    dispatchWindow,
  );
}

export function planOverworldQuestStart(state: OverworldQuestStartState): OverworldQuestStartPlan {
  const quest = questForOverworldQuestStart(state);
  return {
    minutes: 0,
    quest: questView(quest),
    entryDraft: {
      id: `quest:${quest.id}`,
      kind: "quest",
      town: state.currentTownName,
      title: `Started ${quest.title}`,
      text: `Lead: ${quest.discovery}`,
    },
  };
}

/**
 * The rejection for a launch-gated quest started without an approach. Like the
 * job/event option rejections (bug_0620/bug_0621), it names the parameter and every
 * approach id that would be accepted right now — the same affordability projection
 * applyOverworldQuestLaunchOption enforces — so a caller can retry without a separate
 * lookup (bug_0646). When none is affordable, each id is named with its blocked reason.
 */
function missingQuestApproachError(
  title: string,
  launch: OverworldQuestLaunch,
  resources: OverworldQuestLaunchResources,
): Error {
  const projected = launch.options.map((option) => ({
    id: option.id,
    projection: projectOverworldQuestLaunchOption(option, resources),
  }));
  const availableIds = projected
    .filter((entry) => entry.projection.available)
    .map((entry) => entry.id);
  if (availableIds.length > 0) {
    return new Error(`Choose an approach_id before starting ${title}: ${availableIds.join(", ")}.`);
  }
  const blocked = projected
    .map((entry) => `${entry.id} (${entry.projection.blockedReason ?? "unavailable"})`)
    .join(", ");
  return new Error(
    `Choose an approach_id before starting ${title}, but no approach is available yet: ${blocked}.`,
  );
}

export function prepareOverworldQuestStart(
  state: OverworldQuestPrepareState,
): OverworldQuestStartPreparation {
  const quest = questForOverworldQuestStart(state);
  if (!quest.launch && state.approachId !== undefined) {
    throw new Error(`Quest "${quest.id}" does not offer a launch approach.`);
  }
  const resources = {
    minutes: state.minutes,
    supplies: state.supplies,
    fatigue: state.fatigue,
  };
  if (quest.launch && state.approachId === undefined) {
    throw missingQuestApproachError(quest.title, quest.launch, resources);
  }
  const launchApplication =
    quest.launch && state.approachId
      ? applyOverworldQuestLaunchOption({
          launch: quest.launch,
          approachId: state.approachId,
          character: state.character,
          resources,
        })
      : null;
  const approachId = launchApplication?.option.id ?? null;
  const minutes = launchApplication?.option.terms.minutes ?? 0;
  const suppliesAfter = launchApplication?.projection.suppliesAfter ?? state.supplies;
  const fatigueAfter = launchApplication?.projection.fatigueAfter ?? state.fatigue;
  const characterAfter =
    launchApplication?.characterAfter ?? cloneCampaignCharacterState(state.character);
  const dispatchWindow = questDispatchWindowForPreparation(state, quest.id);
  const questPresentation = questView(
    quest,
    resources,
    launchApplication?.option.id,
    state.character.knowledge,
    dispatchWindow,
  );
  return {
    approachId,
    preconditionFingerprint: questStartPreconditionFingerprint(state, quest, approachId),
    journeyActionId:
      approachId === null ? `quest_start:${quest.id}` : `quest_start:${quest.id}:${approachId}`,
    minutes,
    minutesAfter: state.minutes + minutes,
    suppliesBefore: state.supplies,
    suppliesAfter,
    fatigueBefore: state.fatigue,
    fatigueAfter,
    characterAfter,
    dispatchWindow,
    quest: questPresentation,
    entryDraft: {
      id: `quest:${quest.id}`,
      kind: "quest",
      town: state.currentTownName,
      title: `Started ${quest.title}`,
      text: launchApplication
        ? `Lead: ${quest.discovery} Approach: ${launchApplication.option.title}. ${launchApplication.option.consequence}`
        : `Lead: ${quest.discovery}`,
    },
  };
}

export function planOverworldQuestCompletion(
  state: OverworldQuestCompletionState,
): OverworldQuestCompletionPlan {
  const quest = state.questsById.get(state.questId);
  if (!quest) throw new Error(`Unknown overworld quest "${state.questId}".`);
  if (!state.startedQuestIds.has(quest.id)) {
    throw new Error("Start that local quest lead before completing it.");
  }
  if (state.outcome.death) {
    throw new Error("A death ending does not complete the overworld quest.");
  }
  const campaignExport = questCampaignExportForEnding(quest, state.outcome.endingId);
  if (campaignExport !== null && campaignExport.ending_title !== state.outcome.endingTitle) {
    throw new Error(
      `Overworld quest "${quest.id}" ending "${state.outcome.endingId}" has title ` +
        `"${state.outcome.endingTitle}", expected canonical title ` +
        `"${campaignExport.ending_title}".`,
    );
  }
  const recordedEndingId = state.questOutcomeIds.get(quest.id);
  if (recordedEndingId !== undefined && recordedEndingId !== state.outcome.endingId) {
    throw new Error(
      `Overworld quest "${quest.id}" already completed with ending "${recordedEndingId}"; ` +
        `cannot replace it with "${state.outcome.endingId}".`,
    );
  }
  const home = state.nodesById.get(quest.home);
  const minutes = questCompletionMinutes(quest, state.areasById);
  const endingTitle = campaignExport?.ending_title ?? state.outcome.endingTitle;
  const consequence = applyCampaignConsequences({
    character: state.character,
    effects: campaignExport
      ? overworldQuestCampaignEffectsForCharacter(campaignExport, state.character)
      : [],
  });
  const returnSummary = questLaunchReturnSummary(state, quest);
  const registrationReceipt = campaignExport
    ? deriveRegistrationPromiseFoldbackReceipt({
        quest,
        campaignExport,
        characterBefore: state.character,
        characterAfter: consequence.characterAfter,
        worldFactIds: consequence.worldFactIds,
        journalEntries: state.journalEntries ?? [],
        openingRegistration: state.openingRegistration,
        openingReliefOath: state.openingReliefOath,
        openingLeadSource: state.openingLeadSource,
      })
    : undefined;
  const brokenPromiseReceipt = campaignExport
    ? deriveBrokenPromiseFoldbackReceipt(campaignExport, state.character)
    : undefined;
  return {
    minutes,
    // A completed quest returns its achieved ending and journal consequence.
    // Re-attaching the pre-launch option catalog here can only be stale:
    // its forecasts no longer describe an actionable future and completion
    // state does not carry every dispatch modifier used to present them.
    quest: questReferenceView(quest),
    endingId: state.outcome.endingId,
    endingTitle,
    characterAfter: consequence.characterAfter,
    worldFactIds: consequence.worldFactIds,
    renownRegion: home?.region ?? quest.home,
    renown: QUEST_COMPLETION_RENOWN,
    entryDraft: questCompletionJournalEntryDraft({
      quest,
      endingId: state.outcome.endingId,
      endingTitle,
      minutes,
      townName: state.nodesById.get(quest.home)?.name ?? quest.home,
      ...(returnSummary ? { returnSummary } : {}),
      ...(registrationReceipt ? { registrationReceipt } : {}),
      ...(brokenPromiseReceipt ? { brokenPromiseReceipt } : {}),
    }),
  };
}

export function applyOverworldQuestStart(
  state: OverworldQuestStartApplicationState,
  plan: OverworldQuestStartPlan,
): OverworldAppliedQuestLifecycle {
  state.startedQuestIds.add(plan.quest.id);
  return { questId: plan.quest.id };
}

export function applyOverworldQuestCompletion(
  state: OverworldQuestCompletionApplicationState,
  plan: OverworldQuestCompletionPlan,
): OverworldAppliedQuestCompletion {
  state.completedQuestIds.add(plan.quest.id);
  state.regionRenown.set(
    plan.renownRegion,
    (state.regionRenown.get(plan.renownRegion) ?? 0) + plan.renown,
  );
  return {
    questId: plan.quest.id,
    renownRegion: plan.renownRegion,
    renownGained: plan.renown,
    renownAfter: state.regionRenown.get(plan.renownRegion) ?? 0,
  };
}
