/**
 * New York overworld play view.
 *
 * The first interaction is location and travel, not content selection. Pack-based
 * quests still run through the existing deterministic engine, but they are now
 * local opportunities discovered at towns in the road graph.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { GameSession, type View } from "./engine.js";
import {
  embeddedLaunchOverlayForPlan,
  hasLiveOverworldEventChoice,
  OverworldSession,
  type OverworldActionResult,
  type OverworldAreaTravelResult,
  type OverworldRoadEncounterResult,
  type OverworldServiceResult,
  type OverworldSessionSnapshot,
  type OverworldView,
} from "./overworld.js";
import { PACKS } from "./packs.js";
import { OVERWORLD } from "./worldData.js";
import { NewJourneyTutorial } from "./NewJourneyTutorial.js";
import { JourneyChoiceScreen } from "./JourneyChoiceScreen.js";
import { JourneyStoryChoiceScreen } from "./JourneyStoryChoiceScreen.js";
import { JourneyEndedScreen } from "./JourneyEndedScreen.js";
import { QuestPlayScreen } from "./QuestPlayScreen.js";
import type { NightWatchPanel } from "./NightWatchChrome.js";
import {
  OverworldPlayScreen,
  type WorldActionCard,
  type WorldActionSection,
} from "./OverworldPlayScreen.js";
import { presentServiceSection, primaryWorldSectionIds } from "./worldActionPresentation.js";
import { formatGoalPassageLog } from "./goalPassage.js";
import { FRESH_GAME_TUTORIAL } from "../../src/world/fresh_game_tutorial.js";
import { OPENING_CHAPTER_HORIZON } from "../../src/world/journey_contract.js";
import type {
  JourneyChoice,
  JourneyOpportunityKind,
  JourneyStoryChoicePrompt,
} from "../../src/world/journey_contract.js";
import type { JourneyOpportunityExplanation } from "../../src/world/journey_opportunity_explainer.js";
import type { OverworldQuest } from "../../src/world/overworld.js";
import type { OverworldQuestView } from "../../src/world/session_local_discovery.js";

function normalizePackPath(path: string): string {
  return path.replace(/^(\.\.\/)+/, "");
}

const packsByPath = new Map(PACKS.map((pack) => [normalizePackPath(pack.path), pack]));
// The session exposes quests as OverworldQuestView (no pack source — the view
// is what a PLAYER knows); the pack path lives only on the manifest quest.
const questsById = new Map<string, OverworldQuest>(OVERWORLD.quests.map((q) => [q.id, q]));
const BROWSER_QUEST_SEED = 1;
export const LEGACY_OVERWORLD_SAVE_KEY = "adventureforge:new-york-overworld:v1";
export const JOURNEY_SAVE_KEY = "adventureforge:new-york-journey:v2";
const BROWSER_SAVE_VERSION = 2 as const;

const BrowserRoadSaveSchema = z
  .object({
    browserSaveVersion: z.literal(BROWSER_SAVE_VERSION),
    phase: z.literal("road"),
    world: z.unknown(),
  })
  .strict();
const BrowserQuestTrailEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("quest"), actionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("journey"), choice: z.enum(["continue", "end"]) }).strict(),
]);
const BrowserQuestSaveSchema = z
  .object({
    browserSaveVersion: z.literal(BROWSER_SAVE_VERSION),
    phase: z.literal("quest"),
    questId: z.string().min(1),
    approachId: z.string().min(1).nullable(),
    preQuestWorld: z.unknown(),
    trail: z.array(BrowserQuestTrailEntrySchema),
    questSave: z.string().min(1),
    worldSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const BrowserJourneySaveSchema = z.discriminatedUnion("phase", [
  BrowserRoadSaveSchema,
  BrowserQuestSaveSchema,
]);

function jobChoiceKey(jobId: string, optionId: string): string {
  return JSON.stringify([jobId, optionId]);
}

function eventChoiceKey(eventId: string, optionId: string): string {
  return JSON.stringify([eventId, optionId]);
}

type InitialWorldSession = {
  session: OverworldSession;
  origin: "new" | "resume" | "blocked";
  notice: string | null;
  questSession: GameSession | null;
  activeQuest: OverworldQuestView | null;
  activeQuestSave: ActiveQuestSaveState | null;
  recoveryError: string | null;
  storageAvailable: boolean;
};

export type ActiveQuestSaveState = {
  questId: string;
  approachId: string | null;
  preQuestWorld: OverworldSessionSnapshot;
  trail: z.infer<typeof BrowserQuestTrailEntrySchema>[];
};

type BrowserSaveStatus = "pending" | "saved" | "unavailable";

type QuestStageMemory = {
  scrollTop: number;
  restoreDecisionFocus: boolean;
};

type RestoredQuestEnding = NonNullable<ReturnType<GameSession["ending"]>>;

function normalizedGoalPhrase(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function containsGoalPhrase(goalCopy: string, candidate: string): boolean {
  return candidate.length > 0 && ` ${goalCopy} `.includes(` ${candidate} `);
}

const NORMALIZED_CHAPTER_HORIZON = normalizedGoalPhrase(OPENING_CHAPTER_HORIZON);

/**
 * The copy that describes where the CURRENT goal points.
 *
 * The journey's guidance ends with the engine's end-of-chapter horizon, which
 * names the OPTIONAL next chapter ("carry its results into the optional
 * Gallowmere chapter") purely so the player understands what Continue and End
 * mean at the coming checkpoint. That sentence is not direction: matching quest
 * titles against it labelled the route into Gallowmere's district "Next for
 * current goal" from the first turn of the opening chapter, while the actual
 * goal was Wolf-Winter in Albany. Drop the horizon — by the engine's own
 * constant, so a rewording of it cannot silently reopen the mislabel — and
 * match only the part of the copy that describes this goal.
 */
function goalDirectionCopy(goalText: string, goalGuidance: string | null | undefined): string {
  return normalizedGoalPhrase(`${goalText} ${goalGuidance ?? ""}`)
    .split(NORMALIZED_CHAPTER_HORIZON)
    .join(" ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Resolve destination ids from visible goal copy without hard-coding a quest or area. */
export function goalRelevantAreaIds(
  goalText: string,
  goalGuidance: string | null | undefined,
  quests: readonly Pick<OverworldQuest, "title" | "area">[],
): ReadonlySet<string> {
  const goalCopy = goalDirectionCopy(goalText, goalGuidance);
  return new Set(
    quests
      .filter((quest) => {
        const title = normalizedGoalPhrase(quest.title).replace(/^the\s+/, "");
        return containsGoalPhrase(goalCopy, title);
      })
      .map((quest) => quest.area),
  );
}

/** Apply the same authoritative campaign foldback used after a restored final scene. */
export function applyRestoredQuestEnding(
  session: OverworldSession,
  questId: string,
  ending: RestoredQuestEnding,
): void {
  if (ending.death) {
    session.recordQuestCharacterDeath(questId, {
      endingId: ending.id,
      death: true,
    });
    return;
  }
  session.completeQuest(questId, {
    endingId: ending.id,
    endingTitle: ending.title,
    death: false,
  });
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadInitialWorldSession(): InitialWorldSession {
  const storage = browserStorage();
  if (!storage) {
    return {
      session: new OverworldSession(OVERWORLD),
      origin: "new",
      notice: "Browser saving is unavailable. Keep this tab open to avoid losing progress.",
      questSession: null,
      activeQuest: null,
      activeQuestSave: null,
      recoveryError: null,
      storageAvailable: false,
    };
  }

  let currentRaw: string | null;
  let legacyRaw: string | null;
  try {
    currentRaw = storage.getItem(JOURNEY_SAVE_KEY);
    legacyRaw = currentRaw === null ? storage.getItem(LEGACY_OVERWORLD_SAVE_KEY) : null;
  } catch {
    return {
      session: new OverworldSession(OVERWORLD),
      origin: "new",
      notice: "Browser saving is unavailable. Keep this tab open to avoid losing progress.",
      questSession: null,
      activeQuest: null,
      activeQuestSave: null,
      recoveryError: null,
      storageAvailable: false,
    };
  }
  const raw = currentRaw ?? legacyRaw;
  if (raw === null) {
    return {
      session: new OverworldSession(OVERWORLD),
      origin: "new",
      notice: null,
      questSession: null,
      activeQuest: null,
      activeQuestSave: null,
      recoveryError: null,
      storageAvailable: true,
    };
  }

  try {
    const decoded: unknown = JSON.parse(raw);
    if (
      decoded !== null &&
      typeof decoded === "object" &&
      Object.prototype.hasOwnProperty.call(decoded, "browserSaveVersion")
    ) {
      const saved = BrowserJourneySaveSchema.parse(decoded);
      if (saved.phase === "quest") {
        const session = OverworldSession.restore(OVERWORLD, saved.preQuestWorld);
        const canonicalPreQuestWorld = session.snapshot();
        const manifestQuest = questsById.get(saved.questId);
        const source = manifestQuest ? normalizePackPath(manifestQuest.source) : undefined;
        const pack = source ? packsByPath.get(source) : undefined;
        if (!manifestQuest || !pack) {
          throw new Error(
            `Quest pack is missing for saved quest ${JSON.stringify(saved.questId)}.`,
          );
        }
        const plan = session.prepareQuestStart(
          saved.questId,
          saved.approachId === null ? undefined : saved.approachId,
        );
        const activeQuest = session.commitQuestStart(plan);
        const launchCharacter = session.questLaunchCharacterState(saved.questId);
        if (!launchCharacter) throw new Error("This quest save is missing its starting character.");
        const restored = GameSession.restoreEmbedded(
          pack.source,
          saved.questId,
          launchCharacter,
          manifestQuest.campaign_imports,
          BROWSER_QUEST_SEED,
          saved.trail.flatMap((entry) => (entry.kind === "quest" ? [entry.actionId] : [])),
          saved.questSave,
        );
        let decisionIndex = 0;
        for (const entry of saved.trail) {
          if (entry.kind === "journey") {
            session.chooseJourney(entry.choice);
            continue;
          }
          const decision = restored.decisions[decisionIndex++];
          if (!decision || decision.actionId !== entry.actionId) {
            throw new Error("The saved quest's recorded actions do not agree.");
          }
          session.recordQuestDecision(
            decision.actionId,
            decision.classification,
            decision.checkpointSafeBoundary,
          );
        }
        if (decisionIndex !== restored.decisions.length) {
          throw new Error("The saved quest has extra recorded actions.");
        }
        if (session.snapshotHash() !== saved.worldSnapshotHash) {
          throw new Error("The saved journey does not match the quest's recorded actions.");
        }
        const restoredEnding = restored.session.ending();
        if (restoredEnding) {
          applyRestoredQuestEnding(session, saved.questId, restoredEnding);
          return {
            session,
            origin: "resume",
            notice: restoredEnding.death
              ? `Recovered ${activeQuest.title}'s final scene. Your character died there.`
              : `Recovered and completed ${activeQuest.title}. Its journey results were verified.`,
            questSession: null,
            activeQuest: null,
            activeQuestSave: null,
            recoveryError: null,
            storageAvailable: true,
          };
        }
        return {
          session,
          origin: "resume",
          notice: `Resumed ${activeQuest.title} at ${restored.session.view().title}. The saved quest and journey record were verified.`,
          questSession: restored.session,
          activeQuest,
          activeQuestSave: {
            questId: saved.questId,
            approachId: saved.approachId,
            preQuestWorld: canonicalPreQuestWorld,
            trail: saved.trail.map((entry) => ({ ...entry })),
          },
          recoveryError: null,
          storageAvailable: true,
        };
      }

      const session = OverworldSession.restore(OVERWORLD, saved.world);
      const warnings = session.restoreWarnings();
      return {
        session,
        origin: "resume",
        notice: warnings.length > 0 ? `Warning: ${warnings.join(" ")}` : null,
        questSession: null,
        activeQuest: null,
        activeQuestSave: null,
        recoveryError: null,
        storageAvailable: true,
      };
    }

    // Compatibility with the original raw-overworld browser save.
    const session = OverworldSession.restore(OVERWORLD, decoded);
    const warnings = session.restoreWarnings();
    return {
      session,
      origin: "resume",
      notice: warnings.length > 0 ? `Warning: ${warnings.join(" ")}` : null,
      questSession: null,
      activeQuest: null,
      activeQuestSave: null,
      recoveryError: null,
      storageAvailable: true,
    };
  } catch (e) {
    return {
      session: new OverworldSession(OVERWORLD),
      origin: "blocked",
      notice: null,
      questSession: null,
      activeQuest: null,
      activeQuestSave: null,
      recoveryError: `This save could not be verified: ${(e as Error).message}`,
      storageAvailable: true,
    };
  }
}

export function persistWorldSession(session: OverworldSession): boolean {
  try {
    const storage = browserStorage();
    if (!storage) return false;
    storage.setItem(
      JOURNEY_SAVE_KEY,
      JSON.stringify({
        browserSaveVersion: BROWSER_SAVE_VERSION,
        phase: "road",
        world: session.snapshot(),
      }),
    );
    storage.removeItem(LEGACY_OVERWORLD_SAVE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function persistActiveQuest(
  worldSession: OverworldSession,
  questSession: GameSession,
  active: ActiveQuestSaveState,
): boolean {
  try {
    const storage = browserStorage();
    if (!storage) return false;
    storage.setItem(
      JOURNEY_SAVE_KEY,
      JSON.stringify({
        browserSaveVersion: BROWSER_SAVE_VERSION,
        phase: "quest",
        questId: active.questId,
        approachId: active.approachId,
        preQuestWorld: active.preQuestWorld,
        trail: active.trail,
        questSave: questSession.saveEmbedded(active.questId),
        worldSnapshotHash: worldSession.snapshotHash(),
      }),
    );
    storage.removeItem(LEGACY_OVERWORLD_SAVE_KEY);
    return true;
  } catch {
    return false;
  }
}

function clearWorldSessionSave(): void {
  try {
    const storage = browserStorage();
    storage?.removeItem(JOURNEY_SAVE_KEY);
    storage?.removeItem(LEGACY_OVERWORLD_SAVE_KEY);
  } catch {
    // Ignore storage failures; the fresh in-memory session still replaces play state.
  }
}

function suppliesLabel(value: number): string {
  return `${String(value)} ${value === 1 ? "supply" : "supplies"}`;
}

export function splitQuestNotices(
  view: Pick<OverworldView, "departureRecap" | "quests" | "questStarts">,
): Readonly<{
  departureQuest: OverworldQuestView | null;
  noticeBoardQuests: readonly OverworldQuestView[];
}> {
  const departureQuestId = view.departureRecap?.questId;
  const departureQuest =
    departureQuestId && view.questStarts.some(([questId]) => questId === departureQuestId)
      ? (view.quests.find((quest) => quest.id === departureQuestId) ?? null)
      : null;
  return {
    departureQuest,
    noticeBoardQuests: departureQuest
      ? view.quests.filter((quest) => quest.id !== departureQuest.id)
      : view.quests,
  };
}

type StationDispatchBoardView = NonNullable<OverworldView["stationDispatchBoard"]>;

const STATION_SUPPORT_SLOT_LABELS: Readonly<
  Record<StationDispatchBoardView["support"][number]["slot"], string>
> = {
  preparation: "field kit",
  relief_allocation: "relief wagon",
  field_team: "second rider",
};

export function stationSupportActionTitle(
  slot: StationDispatchBoardView["support"][number]["slot"],
): string {
  const label = STATION_SUPPORT_SLOT_LABELS[slot];
  return `${label[0]!.toUpperCase()}${label.slice(1)}`;
}

type StationSupportTarget =
  | { kind: "inspect"; storyChoiceId: string }
  | { kind: "talk"; characterId: string };

export function stationSupportPresentation(
  board: StationDispatchBoardView | null,
  target: StationSupportTarget,
): { summary: string; terms: string } | null {
  const support = board?.support.find((candidate) => {
    if (candidate.status !== "open_optional" || candidate.selectedTitle !== null) return false;
    const action = candidate.action;
    if (!action || action.kind !== target.kind) return false;
    if (action.kind === "inspect" && target.kind === "inspect") {
      return action.storyChoiceId === target.storyChoiceId;
    }
    return action.kind === "talk" && target.kind === "talk"
      ? action.characterId === target.characterId
      : false;
  });
  return support ? { summary: support.purpose, terms: support.detailHint } : null;
}

type JourneyStoryChoiceLogResult = ReturnType<OverworldSession["chooseJourneyStory"]>;

export function journeyStoryChoiceLogEntries(
  kind: JourneyStoryChoicePrompt["kind"] | undefined,
  result: JourneyStoryChoiceLogResult,
): string[] {
  if (result.displaySummary) {
    return [result.displaySummary, `Current goal: ${result.goal.text}`];
  }
  const prefix =
    kind === "registration"
      ? "Background chosen"
      : kind === "lead_source"
        ? "Report chosen"
        : kind === "preparation"
          ? "Field kit chosen"
          : kind === "ally"
            ? "Riding choice made"
            : kind === "relief_allocation"
              ? "Relief wagon choice made"
              : kind === "relief_oath"
                ? "Wolf-Winter promise chosen"
                : "Choice made";
  return [
    `${prefix}: ${result.consequence}`,
    `${kind === undefined ? "New" : "Current"} goal: ${result.goal.text}`,
  ];
}

export default function App(): JSX.Element {
  const [worldState, setWorldState] = useState(loadInitialWorldSession);
  const worldSession = worldState.session;
  const questStageMemoryRef = useRef<QuestStageMemory>({
    scrollTop: 0,
    restoreDecisionFocus: false,
  });
  const [worldView, setWorldView] = useState<OverworldView>(() => worldSession.view());
  const [questSession, setQuestSession] = useState<GameSession | null>(
    () => worldState.questSession,
  );
  const [questView, setQuestView] = useState<View | null>(
    () => worldState.questSession?.view() ?? null,
  );
  const [activeQuest, setActiveQuest] = useState<OverworldQuestView | null>(
    () => worldState.activeQuest,
  );
  const [activeQuestSave, setActiveQuestSave] = useState<ActiveQuestSaveState | null>(
    () => worldState.activeQuestSave,
  );
  const [tutorialOpen, setTutorialOpen] = useState(() => worldState.origin === "new");
  const [inspectedDepartureStory, setInspectedDepartureStory] =
    useState<JourneyStoryChoicePrompt | null>(null);
  const [log, setLog] = useState<string[]>(() => {
    const opener =
      worldState.origin === "resume"
        ? (worldState.notice ?? `Resumed in ${worldView.current.name}.`)
        : `You begin in ${worldView.current.name}. Scout or talk to find local work, or take a known road.`;
    return worldState.notice && worldState.notice !== opener
      ? [worldState.notice, opener]
      : [opener];
  });
  const [error, setError] = useState<string | null>(null);
  const [opportunityInspection, setOpportunityInspection] = useState<{
    snapshotHash: string;
    explanation: JourneyOpportunityExplanation;
  } | null>(null);
  const [nightWatchPanel, setNightWatchPanel] = useState<NightWatchPanel>("scene");
  const [saveStatus, setSaveStatus] = useState<BrowserSaveStatus>(() =>
    !worldState.storageAvailable
      ? "unavailable"
      : worldState.origin === "resume"
        ? "saved"
        : "pending",
  );
  const journey = worldSession.journey();

  const rememberQuestStageScroll = useCallback((scrollTop: number): void => {
    questStageMemoryRef.current.scrollTop = scrollTop;
  }, []);
  const acknowledgeQuestStageRestore = useCallback((): void => {
    questStageMemoryRef.current.restoreDecisionFocus = false;
  }, []);

  function resetQuestStageMemory(): void {
    questStageMemoryRef.current = { scrollTop: 0, restoreDecisionFocus: false };
  }

  useEffect(() => {
    if (!worldState.storageAvailable) {
      setSaveStatus("unavailable");
    } else if (questSession === null && worldState.recoveryError === null) {
      setSaveStatus(persistWorldSession(worldSession) ? "saved" : "unavailable");
    }
  }, [
    questSession,
    worldSession,
    worldState.recoveryError,
    worldState.storageAvailable,
    worldView,
  ]);

  const legalJobChoiceKeys = useMemo(
    () => new Set(worldView.jobChoices.map(([jobId, optionId]) => jobChoiceKey(jobId, optionId))),
    [worldView.jobChoices],
  );
  const legalEventChoiceKeys = useMemo(
    () =>
      new Set(
        worldView.eventChoices.map(([eventId, optionId]) => eventChoiceKey(eventId, optionId)),
      ),
    [worldView.eventChoices],
  );
  const { departureQuest, noticeBoardQuests } = splitQuestNotices(worldView);
  function questAreaName(quest: OverworldQuestView): string {
    return OVERWORLD.areas.find((area) => area.id === quest.area)?.name ?? quest.area;
  }

  function travel(edgeId: string): void {
    try {
      const entry = worldSession.travel(edgeId);
      const next = worldSession.view();
      const roadEvent = entry.roadEvent
        ? ` Road encounter: ${entry.roadEvent.title} — ${entry.roadEvent.summary}`
        : "";
      setWorldView(next);
      setQuestSession(null);
      setQuestView(null);
      setActiveQuest(null);
      setLog((prev) => [
        `Traveled ${entry.distanceMi.toFixed(1)} mi on ${entry.route} to ${entry.to}. Time ${entry.baseMinutes} min${entry.delayMinutes > 0 ? ` + ${entry.delayMinutes} min delay` : ""}. Supplies -${entry.suppliesUsed}; fatigue +${entry.fatigueGained}.${roadEvent}`,
        ...prev,
      ]);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function followGoalPassage(): void {
    try {
      const result = worldSession.followGoalPassage();
      setWorldView(worldSession.view());
      setQuestSession(null);
      setQuestView(null);
      setActiveQuest(null);
      setLog((previous) => [formatGoalPassageLog(result), ...previous]);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function startQuest(quest: OverworldQuestView, approachId?: string): void {
    const manifestQuest = questsById.get(quest.id);
    const source = manifestQuest ? normalizePackPath(manifestQuest.source) : undefined;
    const pack = source ? packsByPath.get(source) : undefined;
    if (!manifestQuest || !pack) {
      setError(`Quest pack is missing: ${source ?? quest.id}`);
      return;
    }
    try {
      const preQuestWorld = worldSession.snapshot();
      // Keep launch failure-atomic: all quest eligibility, pack compilation,
      // target validation, and imported-state construction happen before the
      // overworld records that the quest has started.
      const plan = worldSession.prepareQuestStart(quest.id, approachId);
      // Same shared derivation the MCP bridge uses: a delayed Wolf-Winter
      // dispatch must open the same child state on every interface.
      const launchOverlay = embeddedLaunchOverlayForPlan(plan);
      const session = GameSession.startEmbedded(
        pack.source,
        plan.characterAfter,
        manifestQuest.campaign_imports,
        BROWSER_QUEST_SEED,
        launchOverlay,
      );
      const localQuest = worldSession.commitQuestStart(plan);
      const selectedApproach = localQuest.launch?.options.find(
        (option) => option.id === localQuest.launch?.selected?.optionId,
      );
      setQuestSession(session);
      resetQuestStageMemory();
      setQuestView(session.view());
      setActiveQuest(localQuest);
      const activeSave = {
        questId: localQuest.id,
        approachId: plan.approachId,
        preQuestWorld,
        trail: [],
      };
      setActiveQuestSave(activeSave);
      setSaveStatus(
        worldState.storageAvailable && persistActiveQuest(worldSession, session, activeSave)
          ? "saved"
          : "unavailable",
      );
      setNightWatchPanel("scene");
      setWorldView(worldSession.view());
      setLog((prev) => [
        `Started ${localQuest.title}${selectedApproach ? ` using ${selectedApproach.title}` : ""} in ${questAreaName(localQuest)}, ${worldView.current.name}.`,
        ...prev,
      ]);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function runWorldAction(action: () => OverworldActionResult): void {
    try {
      const result = action();
      setWorldView(worldSession.view());
      const questLead =
        result.discoveredQuests && result.discoveredQuests.length > 0
          ? ` New work posted: ${result.discoveredQuests.map((quest) => quest.title).join(", ")}.`
          : "";
      const areaLead =
        result.discoveredAreas && result.discoveredAreas.length > 0
          ? ` New area mapped: ${result.discoveredAreas.map((area) => area.name).join(", ")}.`
          : "";
      const jobLead =
        result.discoveredJobs && result.discoveredJobs.length > 0
          ? ` New local job posted: ${result.discoveredJobs.map((job) => job.title).join(", ")}.`
          : "";
      setLog((prev) => [
        result.alreadyKnown
          ? `Reviewed ${result.entry.title}: ${result.entry.text}`
          : `Spent ${result.minutes} min. ${result.entry.title}: ${result.entry.text}${areaLead}${jobLead}${questLead}`,
        ...prev,
      ]);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function runServiceAction(action: () => OverworldServiceResult): void {
    try {
      const result = action();
      setWorldView(worldSession.view());
      setLog((prev) => [
        result.changed ? `Spent ${result.minutes} min. ${result.message}` : result.message,
        ...prev,
      ]);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function runRoadEncounterAction(action: () => OverworldRoadEncounterResult): void {
    try {
      const result = action();
      setWorldView(worldSession.view());
      setLog((prev) => [
        `Road encounter resolved: ${result.entry.title}. ${result.entry.text} Time +${result.minutes} min; supplies -${result.suppliesUsed}; fatigue +${result.fatigueGained}${result.renownGained > 0 ? `; renown +${result.renownGained}` : ""}.`,
        ...prev,
      ]);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function moveArea(areaRouteId: string): void {
    try {
      const result: OverworldAreaTravelResult = worldSession.moveArea(areaRouteId);
      setWorldView(worldSession.view());
      setLog((prev) => [
        `Walked ${result.route} to ${result.to.name} in ${worldView.current.name}. Time ${result.minutes} min.`,
        ...prev,
      ]);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function choose(id: string, label: string): void {
    if (!questSession || !activeQuestSave) return;
    setError(null);
    try {
      const out = questSession.choose(id);
      const view = questSession.view();
      setQuestView(view);
      const lines = [
        `> ${label}`,
        ...out.narration,
        ...(out.rejection ? [`(${out.rejection})`] : []),
      ];
      if (out.ok) {
        if (out.journeyActionId === null) throw new Error("Accepted quest action has no id.");
        worldSession.recordQuestDecision(
          out.journeyActionId,
          out.journeyDecision,
          questSession.isCheckpointSafeBoundary(),
        );
        setWorldView(worldSession.view());
        const nextActiveSave = {
          ...activeQuestSave,
          trail: [
            ...activeQuestSave.trail,
            { kind: "quest" as const, actionId: out.journeyActionId },
          ],
        };
        setActiveQuestSave(nextActiveSave);
        setSaveStatus(
          worldState.storageAvailable &&
            persistActiveQuest(worldSession, questSession, nextActiveSave)
            ? "saved"
            : "unavailable",
        );
      }
      // Close a finished quest back into the overworld (MCP-bridge parity,
      // src/mcp/overworld_quest_bridge.ts): a non-death ending completes the lead
      // (journal entry + completedQuestIds); a death ending preserves the unfinished
      // goal and moves play to the journey's mandatory end choice.
      if (view.ended && activeQuest) {
        const ending = questSession.ending();
        if (ending && !ending.death) {
          try {
            const result = worldSession.completeQuest(activeQuest.id, {
              endingId: ending.id,
              endingTitle: ending.title,
              death: ending.death,
            });
            setSaveStatus(
              worldState.storageAvailable && persistWorldSession(worldSession)
                ? "saved"
                : "unavailable",
            );
            setActiveQuestSave(null);
            setWorldView(worldSession.view());
            lines.unshift(`Completed ${result.quest.title}: ${result.entry.text}`);
          } catch (e) {
            setError((e as Error).message);
          }
        } else if (ending?.death) {
          worldSession.recordQuestCharacterDeath(activeQuest.id, {
            endingId: ending.id,
            death: ending.death,
          });
          setSaveStatus(
            worldState.storageAvailable && persistWorldSession(worldSession)
              ? "saved"
              : "unavailable",
          );
          setActiveQuestSave(null);
          setWorldView(worldSession.view());
          lines.unshift(
            `Your character died in ${activeQuest.title}. End this journey; its unfinished goal will remain in the record.`,
          );
        }
      }
      setLog((prev) => [...lines, ...prev]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function returnToRoad(): void {
    if (
      activeQuest &&
      !worldView.completedQuestIds.includes(activeQuest.id) &&
      journey.pendingChoice?.reasons.includes("character_died") !== true
    ) {
      setError("The quest result was not saved to the journey. The quest must remain open.");
      return;
    }
    setQuestSession(null);
    resetQuestStageMemory();
    setQuestView(null);
    setActiveQuest(null);
    setActiveQuestSave(null);
    setSaveStatus(
      worldState.storageAvailable && persistWorldSession(worldSession) ? "saved" : "unavailable",
    );
    setLog((prev) => [`Returned to ${worldView.current.name}.`, ...prev]);
  }

  function startNewJourney(): void {
    const session = new OverworldSession(OVERWORLD);
    clearWorldSessionSave();
    setWorldState({
      session,
      origin: "new",
      notice: null,
      questSession: null,
      activeQuest: null,
      activeQuestSave: null,
      recoveryError: null,
      storageAvailable: worldState.storageAvailable,
    });
    setWorldView(session.view());
    setQuestSession(null);
    resetQuestStageMemory();
    setQuestView(null);
    setActiveQuest(null);
    setActiveQuestSave(null);
    setInspectedDepartureStory(null);
    setOpportunityInspection(null);
    setNightWatchPanel("scene");
    setSaveStatus(worldState.storageAvailable ? "pending" : "unavailable");
    setLog([
      `Started a new journey in ${session.view().current.name}. Scout or talk to find local work, or take a known road.`,
    ]);
    setError(null);
    setTutorialOpen(true);
  }

  function chooseJourney(choice: JourneyChoice): void {
    const option = journey.pendingChoice?.options.find((candidate) => candidate.id === choice);
    try {
      worldSession.chooseJourney(choice);
      if (choice === "continue" && questSession && activeQuestSave) {
        questStageMemoryRef.current.restoreDecisionFocus = true;
      }
      setWorldView(worldSession.view());
      if (questSession && activeQuestSave) {
        const nextActiveSave = {
          ...activeQuestSave,
          trail: [...activeQuestSave.trail, { kind: "journey" as const, choice }],
        };
        setActiveQuestSave(nextActiveSave);
        setSaveStatus(
          worldState.storageAvailable &&
            persistActiveQuest(worldSession, questSession, nextActiveSave)
            ? "saved"
            : "unavailable",
        );
      }
      if (option) setLog((previous) => [option.consequence, ...previous]);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function explainOpportunity(kind: JourneyOpportunityKind, id: string): void {
    try {
      const explanation = worldSession.explainOpportunity({ kind, id });
      setOpportunityInspection({
        snapshotHash: worldSession.snapshotHash(),
        explanation,
      });
      setError(null);
    } catch (e) {
      setOpportunityInspection(null);
      setError((e as Error).message);
    }
  }

  function chooseJourneyStory(choiceId: string): void {
    const storyChoice = inspectedDepartureStory ?? journey.storyChoice;
    try {
      const result = worldSession.chooseJourneyStory(choiceId, inspectedDepartureStory?.id);
      setWorldView(worldSession.view());
      setInspectedDepartureStory(null);
      setLog((previous) => [
        ...journeyStoryChoiceLogEntries(storyChoice?.kind, result),
        ...previous,
      ]);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function inspectDepartureStory(storyChoiceId: string): void {
    try {
      setInspectedDepartureStory(worldSession.inspectJourneyStory(storyChoiceId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function revealJourneyStory(storyChoiceId: string, revealId: string): boolean {
    try {
      const story = worldSession.revealJourneyStory(storyChoiceId, revealId);
      setWorldView(worldSession.view());
      if (inspectedDepartureStory?.id === storyChoiceId) setInspectedDepartureStory(story);
      setError(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  if (worldState.recoveryError) {
    return (
      <main className="save-recovery-page">
        <section className="save-recovery-card" aria-labelledby="save-recovery-title">
          <p className="nw-kicker">Save could not load</p>
          <h1 id="save-recovery-title">Your saved journey was not changed</h1>
          <p>{worldState.recoveryError}</p>
          <p>
            AdventureForge did not replace this save with an older checkpoint. The saved data no
            longer matches the current game or its action record.
          </p>
          <button type="button" onClick={startNewJourney}>
            Discard this save and begin a new journey
          </button>
        </section>
      </main>
    );
  }

  if (tutorialOpen) {
    return (
      <NewJourneyTutorial tutorial={FRESH_GAME_TUTORIAL} onStart={() => setTutorialOpen(false)} />
    );
  }

  if (journey.pendingChoice) {
    return <JourneyChoiceScreen journey={journey} onChoose={chooseJourney} />;
  }

  if (journey.storyChoice || inspectedDepartureStory) {
    const presentedStoryChoice = inspectedDepartureStory ?? journey.storyChoice;
    return (
      <JourneyStoryChoiceScreen
        journey={
          inspectedDepartureStory ? { ...journey, storyChoice: inspectedDepartureStory } : journey
        }
        departureRecap={worldView.departureRecap}
        onChoose={chooseJourneyStory}
        onReveal={revealJourneyStory}
        visibleOptionIds={
          presentedStoryChoice
            ? worldSession
                .journeyStoryOptionsForPresentation(presentedStoryChoice.id)
                .map((option) => option.id)
            : []
        }
        {...(inspectedDepartureStory ? { onDismiss: () => setInspectedDepartureStory(null) } : {})}
      />
    );
  }

  if (journey.status === "ended") {
    return <JourneyEndedScreen journey={journey} onNewJourney={startNewJourney} />;
  }

  if (questView && activeQuest) {
    const latestQuestConsequence =
      log.find((entry) => !entry.startsWith("> ")) ?? `Entered ${questView.title}.`;
    // A death foldback is routed to JourneyChoiceScreen above this branch.
    const canLeaveQuest = worldView.completedQuestIds.includes(activeQuest.id);
    return (
      <QuestPlayScreen
        view={questView}
        quest={activeQuest}
        world={worldView}
        journey={journey}
        latestConsequence={latestQuestConsequence}
        error={error}
        log={log}
        panel={nightWatchPanel}
        saveStatus={saveStatus}
        onPanelChange={setNightWatchPanel}
        onChoose={choose}
        canLeave={canLeaveQuest}
        onLeave={returnToRoad}
        initialStageScrollTop={questStageMemoryRef.current.scrollTop}
        restoreDecisionFocus={questStageMemoryRef.current.restoreDecisionFocus}
        onStageRestore={acknowledgeQuestStageRestore}
        onStageScrollTopChange={rememberQuestStageScroll}
      />
    );
  }

  function questActionCards(
    quests: readonly OverworldQuestView[],
    group: string,
  ): WorldActionCard[] {
    return quests.flatMap((quest) => {
      const areaName = questAreaName(quest);
      const inArea = worldView.currentArea?.id === quest.area;
      if (!quest.launch) {
        const projected = worldView.questStarts.some(([questId]) => questId === quest.id);
        return [
          {
            id: `quest:${quest.id}`,
            group,
            title: quest.title,
            summary: quest.discovery,
            terms: `Posted in ${areaName}`,
            buttonLabel: "Begin",
            tone: "ember" as const,
            ...(!projected
              ? { disabledReason: inArea ? "You cannot start this now." : `Move to ${areaName}.` }
              : {}),
            onChoose: () => startQuest(quest),
          },
        ];
      }

      return quest.launch.options.map((option) => {
        const projected = worldView.questStarts.some(
          ([questId, approachId]) => questId === quest.id && approachId === option.id,
        );
        const blocked =
          option.projection?.blockedReason ?? (!inArea ? `Move to ${areaName}.` : undefined);
        return {
          id: `quest:${quest.id}:${option.id}`,
          group,
          title: option.title,
          summary: option.preview,
          terms: `${option.terms.minutes} min · ${suppliesLabel(option.terms.supplies)} · fatigue +${option.terms.fatigue}`,
          consequence: option.tradeoffSummary ?? option.consequence,
          buttonLabel: `Depart for ${quest.title}`,
          tone: "ember" as const,
          ...(!projected ? { disabledReason: blocked ?? "You cannot start this now." } : {}),
          onChoose: () => startQuest(quest, option.id),
        };
      });
    });
  }

  const worldActionSections: WorldActionSection[] = [];

  if (worldView.pendingRoadEncounter) {
    worldActionSections.push({
      id: "encounter",
      title: worldView.pendingRoadEncounter.event.title,
      description: worldView.pendingRoadEncounter.event.summary,
      actions: worldView.pendingRoadEncounter.options.map((option) => ({
        id: `encounter:${option.strategy}`,
        group: "Road encounter",
        title: option.label,
        summary: worldView.pendingRoadEncounter!.event.summary,
        terms: `${option.minutes} min · supplies -${option.suppliesCost} · fatigue +${option.fatigueGained} · renown +${option.renownGained}`,
        consequence: `This clears the encounter on ${worldView.pendingRoadEncounter!.route}.`,
        buttonLabel: "Choose response",
        tone:
          option.strategy === "press_on"
            ? "ember"
            : option.strategy === "assist_travelers"
              ? "lichen"
              : "ice",
        onChoose: () =>
          runRoadEncounterAction(() => worldSession.resolveRoadEncounter(option.strategy)),
      })),
    });
  }

  if (journey.goalPassage) {
    const passage = journey.goalPassage;
    const roadUnit = passage.roadCount === 1 ? "road" : "roads";
    const supplyUnit = passage.suppliesNeeded === 1 ? "supply" : "supplies";
    worldActionSections.push({
      id: "goal",
      title: "Follow the current goal",
      description: passage.consequence,
      actions: [
        {
          id: `goal:${passage.id}`,
          group: "Goal passage",
          title: passage.label,
          summary: passage.consequence,
          terms: `To ${passage.destination} · ${passage.roadCount} ${roadUnit} · ${passage.baseMinutes} min without delays / ${passage.estimatedMinutes} min estimated · needs ${passage.suppliesNeeded} ${supplyUnit}${passage.supplyDeficit > 0 ? ` · short ${passage.supplyDeficit}` : ""} · ${passage.suppliesAfter} left · arrival fatigue ${passage.fatigueAfter} · ${passage.travelConditionAfter}`,
          consequence: passage.stopRule,
          buttonLabel: "Follow goal",
          tone: "ice",
          goalRelevant: true,
          onChoose: followGoalPassage,
        },
      ],
    });
  }

  const dispatchActions = questActionCards(departureQuest ? [departureQuest] : [], "Dispatch");
  for (const interaction of worldView.departureInteractions) {
    const support = stationSupportPresentation(worldView.stationDispatchBoard, {
      kind: "inspect",
      storyChoiceId: interaction.id,
    });
    dispatchActions.push({
      id: `dispatch:${interaction.id}`,
      group: "Optional support",
      title: stationSupportActionTitle(interaction.kind),
      summary:
        support?.summary ??
        `Compare the ${interaction.kind === "preparation" ? "field kit" : "relief wagon"} options before departure.`,
      terms: support?.terms ?? "Review before choosing",
      buttonLabel: "Review support",
      tone: "ice",
      optionalSupport: true,
      onChoose: () => inspectDepartureStory(interaction.id),
    });
  }
  for (const lead of worldView.departureContactLeads) {
    const support = lead.action
      ? stationSupportPresentation(worldView.stationDispatchBoard, {
          kind: "talk",
          characterId: lead.action.arguments.character_id,
        })
      : null;
    dispatchActions.push({
      id: `dispatch:${lead.id}`,
      group: "Optional support",
      title: stationSupportActionTitle("field_team"),
      summary: support?.summary ?? lead.guidance,
      terms:
        support?.terms ??
        (lead.action ? `Talk with ${lead.contactName}` : "Choose a field kit first"),
      buttonLabel: "Ask about riding",
      tone: "lichen",
      optionalSupport: true,
      ...(!lead.action
        ? { disabledReason: `Choose a field kit before asking ${lead.contactName}.` }
        : {}),
      onChoose: () => {
        if (!lead.action) return;
        runWorldAction(() => worldSession.talkToCharacter(lead.action!.arguments.character_id));
      },
    });
  }
  if (dispatchActions.length > 0) {
    worldActionSections.push({
      id: "dispatch",
      title: departureQuest ? `${departureQuest.title} field briefing` : "Before you depart",
      description:
        worldView.stationDispatchBoard?.guidance ??
        "Choose a route now, or review optional support first.",
      actions: dispatchActions,
    });
  }

  const visibleGoalText = goalDirectionCopy(journey.goal.text, journey.goalGuidance);
  const goalAreaIds = goalRelevantAreaIds(
    journey.goal.text,
    journey.goalGuidance,
    OVERWORLD.quests,
  );
  const areaActions: WorldActionCard[] = worldView.areaExits.map((exit) => {
    const goalRelevant =
      goalAreaIds.has(exit.destination.id) ||
      containsGoalPhrase(visibleGoalText, normalizedGoalPhrase(exit.destination.name));
    return {
      id: `area-route:${exit.id}`,
      group: goalRelevant ? "Next for current goal" : "Local route",
      title: exit.destination.name,
      summary: exit.destination.summary,
      terms: `${exit.route} · ${exit.travel_minutes} min`,
      buttonLabel: goalRelevant ? "Continue toward goal" : "Move locally",
      tone: "ice",
      ...(goalRelevant ? { goalRelevant: true } : {}),
      onChoose: () => moveArea(exit.id),
    };
  });
  for (const area of worldView.areas) {
    if (worldView.currentArea?.id !== area.id || worldView.visitedAreaIds.includes(area.id))
      continue;
    areaActions.push({
      id: `area:${area.id}`,
      group: "Explore",
      title: area.name,
      summary: area.summary,
      terms: `${area.travel_minutes} min on foot`,
      buttonLabel: "Explore area",
      tone: "lichen",
      onChoose: () => runWorldAction(() => worldSession.exploreArea(area.id)),
    });
  }
  worldActionSections.push({
    id: "areas",
    title: "Local movement",
    description: `${worldView.hiddenAreaCount} unmapped local ${worldView.hiddenAreaCount === 1 ? "area" : "areas"} remain.`,
    actions: areaActions,
  });

  const discoveryActions: WorldActionCard[] = worldView.pois.map((poi) => ({
    id: `poi:${poi.id}`,
    group: "Scout",
    title: poi.title,
    summary: poi.summary,
    terms: "Scout nearby",
    buttonLabel: "Scout",
    tone: "lichen",
    onChoose: () => runWorldAction(() => worldSession.scoutPoi(poi.id)),
  }));
  discoveryActions.push(
    ...worldView.sites.map((site) => ({
      id: `site:${site.id}`,
      group: "Regional site",
      title: site.title,
      summary: site.discovery,
      terms: `${site.kind} · danger ${site.danger}`,
      buttonLabel: worldView.exploredSiteIds.includes(site.id) ? "Explored" : "Explore site",
      tone: "ember" as const,
      ...(worldView.exploredSiteIds.includes(site.id)
        ? { disabledReason: "This expedition site is already explored." }
        : {}),
      onChoose: () => runWorldAction(() => worldSession.exploreSite(site.id)),
    })),
  );
  worldActionSections.push({
    id: "discoveries",
    title: "Discoveries and sites",
    description: `${worldView.hiddenSiteCount} regional ${worldView.hiddenSiteCount === 1 ? "site" : "sites"} remain hidden.`,
    actions: discoveryActions,
  });

  worldActionSections.push({
    id: "contacts",
    title: "Local contacts",
    actions: worldView.characters.map((character) => ({
      id: `contact:${character.id}`,
      group: "Talk",
      title: character.name,
      summary: character.agenda,
      terms: `${character.role} · ${character.faction}`,
      buttonLabel: "Talk",
      tone: "ice",
      onChoose: () => runWorldAction(() => worldSession.talkToCharacter(character.id)),
    })),
  });

  const eventActions: WorldActionCard[] = [];
  for (const event of worldView.events) {
    const resolved = worldView.resolvedEventIds.includes(event.id);
    const liveOptions = hasLiveOverworldEventChoice(event.id, worldView.eventChoices)
      ? event.authored_scene?.options.filter((option) =>
          legalEventChoiceKeys.has(eventChoiceKey(event.id, option.id)),
        )
      : undefined;
    if (liveOptions && liveOptions.length > 0) {
      eventActions.push(
        ...liveOptions.map((option) => ({
          id: `event:${event.id}:${option.id}`,
          group: "Current event",
          title: option.title,
          summary: event.authored_scene!.prompt,
          terms: `${option.preview} · ${option.terms.minutes} min · renown ${option.terms.renown}`,
          consequence: option.consequence,
          buttonLabel: "Choose response",
          tone:
            event.pressure === "conflict" || event.pressure === "hazard"
              ? ("ember" as const)
              : event.pressure === "opportunity"
                ? ("lichen" as const)
                : ("ice" as const),
          onChoose: () => runWorldAction(() => worldSession.resolveEvent(event.id, option.id)),
        })),
      );
    } else {
      eventActions.push({
        id: `event:${event.id}:investigate`,
        group: "Current event",
        title: event.title,
        summary: event.summary,
        terms: `${event.pressure} pressure · intensity ${event.intensity}`,
        buttonLabel: resolved ? "Resolved" : "Investigate",
        tone:
          event.pressure === "conflict" || event.pressure === "hazard"
            ? "ember"
            : event.pressure === "opportunity"
              ? "lichen"
              : "ice",
        ...(resolved ? { disabledReason: "This event is resolved." } : {}),
        onChoose: () => runWorldAction(() => worldSession.investigateEvent(event.id)),
      });
      if (!event.authored_scene && !resolved) {
        eventActions.push({
          id: `event:${event.id}:resolve`,
          group: "Current event",
          title: `Resolve ${event.title}`,
          summary: event.summary,
          terms: `${event.pressure} pressure · intensity ${event.intensity}`,
          buttonLabel: "Resolve event",
          tone:
            event.pressure === "conflict" || event.pressure === "hazard"
              ? "ember"
              : event.pressure === "opportunity"
                ? "lichen"
                : "ice",
          onChoose: () => runWorldAction(() => worldSession.resolveEvent(event.id)),
        });
      }
    }
  }
  worldActionSections.push({ id: "events", title: "Current events", actions: eventActions });

  const jobActions: WorldActionCard[] = [];
  for (const job of worldView.jobs) {
    const completed = worldView.completedJobIds.includes(job.id);
    if (job.authored_scene) {
      jobActions.push(
        ...job.authored_scene.options.map((option) => {
          const projected = legalJobChoiceKeys.has(jobChoiceKey(job.id, option.id));
          return {
            id: `job:${job.id}:${option.id}`,
            group: "Local job",
            title: option.title,
            summary: option.preview,
            terms: `${option.terms.minutes} min · renown ${option.terms.renown}`,
            consequence: option.consequence,
            buttonLabel: "Choose priority",
            tone: "lichen" as const,
            ...(!projected
              ? { disabledReason: completed ? "This job is complete." : "Requirements not met." }
              : {}),
            onChoose: () => runWorldAction(() => worldSession.workLocalJob(job.id, option.id)),
          };
        }),
      );
    } else {
      jobActions.push({
        id: `job:${job.id}`,
        group: "Local job",
        title: job.title,
        summary: job.summary,
        terms: `${job.kind.replaceAll("_", " ")} · difficulty ${job.difficulty} · ${job.minutes} min`,
        buttonLabel: completed ? "Completed" : "Work job",
        tone: "lichen",
        ...(completed ? { disabledReason: "This job is complete." } : {}),
        onChoose: () => runWorldAction(() => worldSession.workLocalJob(job.id)),
      });
    }
  }
  worldActionSections.push({ id: "jobs", title: "Local jobs", actions: jobActions });

  worldActionSections.push({
    id: "quests",
    title: "Notice board",
    description:
      noticeBoardQuests.length > 0
        ? "Known work in this town."
        : "Scout, talk, or investigate to find local work.",
    actions: questActionCards(noticeBoardQuests, "Notice board"),
  });

  worldActionSections.push(presentServiceSection(worldView, worldSession, runServiceAction));

  worldActionSections.push({
    id: "roads",
    title: "Roads from here",
    description: worldView.pendingRoadEncounter
      ? "Resolve the road encounter before you travel again."
      : `${worldView.exits.length} direct roads leave ${worldView.current.name}.`,
    actions: worldView.exits.map((exit) => ({
      id: `road:${exit.id}`,
      group: "Road",
      title: exit.destination.name,
      summary: `${exit.route} to ${exit.destination.name}`,
      terms: `${exit.distance_mi.toFixed(1)} mi · ${exit.estimate.baseMinutes} road min${exit.estimate.delayMinutes > 0 ? ` + ${exit.estimate.delayMinutes} delay` : ""} · supplies ${exit.estimate.suppliesUsed}/${exit.estimate.suppliesNeeded} · fatigue +${exit.estimate.fatigueGained}`,
      buttonLabel: "Take road",
      tone: "ice",
      ...(worldView.pendingRoadEncounter
        ? { disabledReason: "Resolve the pending road encounter first." }
        : {}),
      onChoose: () => travel(exit.id),
    })),
  });

  if (worldView.pendingRoadEncounter) {
    const encounterBlock = "Resolve the pending road encounter before taking another action.";
    for (const section of worldActionSections) {
      if (section.id === "encounter") continue;
      for (const action of section.actions) {
        action.disabledReason = encounterBlock;
      }
    }
  }

  const hasLegalDispatchAction = dispatchActions.some(
    (action) => action.disabledReason === undefined,
  );
  const prioritySectionIds = primaryWorldSectionIds(
    worldActionSections,
    worldView.pendingRoadEncounter !== null,
    hasLegalDispatchAction,
  );

  return (
    <OverworldPlayScreen
      world={worldView}
      journey={journey}
      latestConsequence={log[0] ?? `You are in ${worldView.current.name}.`}
      log={log}
      sections={worldActionSections}
      prioritySectionIds={prioritySectionIds}
      panel={nightWatchPanel}
      saveStatus={saveStatus}
      error={error}
      opportunityExplanation={
        opportunityInspection?.snapshotHash === worldSession.snapshotHash()
          ? opportunityInspection.explanation
          : null
      }
      {...(worldView.pendingRoadEncounter ? {} : { onExplainOpportunity: explainOpportunity })}
      onPanelChange={setNightWatchPanel}
      onNewJourney={startNewJourney}
      onOpenTutorial={() => {
        setNightWatchPanel("scene");
        setTutorialOpen(true);
      }}
    />
  );
}
