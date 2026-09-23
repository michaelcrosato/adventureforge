import { z } from "zod";
import { actionEquals, makeStep } from "../core/engine.js";
import type { GameEvent } from "../core/events.js";
import { canonicalize, hashState } from "../core/hash.js";
import { cloneGameState, type GameState } from "../core/state.js";
import { assertCampaignImportReceiptCatalogCompatibility } from "../persist/campaign_import_integrity.js";
import {
  SAVE_MODE,
  SaveIntegrityError,
  assertSaveContentHash,
  load,
  save,
} from "../persist/save_load.js";
import {
  EmbeddedQuestCharacterContinuitySchema,
  buildEmbeddedQuestCharacterContinuity,
  cloneEmbeddedQuestCharacterContinuity,
  type EmbeddedQuestCharacterContinuity,
} from "../rpg/embedded_quest_character_continuity.js";
import type { RpgActionOption } from "../rpg/legal_actions.js";
import {
  buildRpgRules,
  enumerateRpgActions,
  indexRpgPack,
  initStateForRpgPack,
  isRpgCheckpointSafeBoundary,
  type RpgIndex,
} from "../rpg/runner.js";
import { assertRpgStateReferences } from "../rpg/state_integrity.js";
import { RpgSourceRuntime } from "../mcp/rpg_source_runtime.js";
import type {
  JourneyDecisionClassification,
  JourneyPresentation,
} from "../world/journey_contract.js";
import { classifyRpgJourneyDecision, excludedJourneyDecision } from "../world/journey_decision.js";
import {
  CampaignCharacterStateSchema,
  cloneCampaignCharacterState,
  type CampaignCharacterState,
} from "../world/campaign_character_state.js";
import type { OverworldManifest } from "../world/overworld.js";
import {
  embeddedLaunchOverlayForPlan,
  embeddedLaunchOverlayFromPersistedReceipt,
} from "../world/embedded_launch_overlay.js";
import {
  OverworldSession,
  type OverworldJourneyQuestCompletionResult,
  type OverworldJourneyQuestStartResult,
} from "../world/session.js";

export const CLI_JOURNEY_SAVE_KIND = "adventureforge_cli_journey" as const;
export const CLI_JOURNEY_SAVE_VERSION = 1 as const;

type CliEmbeddedQuestPhase = "active" | "suspended" | "terminal";
export type CliJourneyPhase = "overworld" | `quest_${CliEmbeddedQuestPhase}`;

type CliEmbeddedQuest = {
  worldQuestId: string;
  title: string;
  contentHash: string;
  launchCharacter: CampaignCharacterState;
  continuity: EmbeddedQuestCharacterContinuity;
  actionIds: string[];
  phase: CliEmbeddedQuestPhase;
  index: RpgIndex;
  state: GameState;
};

type CliEmbeddedQuestView = Readonly<{
  worldQuestId: string;
  title: string;
  contentHash: string;
  continuity: EmbeddedQuestCharacterContinuity;
  phase: CliEmbeddedQuestPhase;
  index: RpgIndex;
  state: GameState;
  stateHash: string;
  actions: readonly RpgActionOption[];
}>;

type CliQuestStepResult = {
  ok: boolean;
  rejectionReason: string | null;
  events: readonly GameEvent[];
  actionOption: RpgActionOption;
  journeyDecision: JourneyDecisionClassification;
  stateHash: string;
  questCompletion: OverworldJourneyQuestCompletionResult | null;
  terminalDeath: boolean;
};

type CliJourneySaveChild = {
  worldQuestId: string;
  title: string;
  contentHash: string;
  launchCharacter: CampaignCharacterState;
  continuity: EmbeddedQuestCharacterContinuity;
  actionIds: string[];
  rpgSave: string;
};

export type CliJourneySave = {
  kind: typeof CLI_JOURNEY_SAVE_KIND;
  version: typeof CLI_JOURNEY_SAVE_VERSION;
  phase: CliJourneyPhase;
  overworld: unknown;
  child: CliJourneySaveChild | null;
};

const CliJourneySaveChildSchema = z
  .object({
    worldQuestId: z.string().min(1),
    title: z.string().min(1),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    launchCharacter: CampaignCharacterStateSchema,
    continuity: EmbeddedQuestCharacterContinuitySchema,
    actionIds: z.array(z.string().min(1)),
    rpgSave: z.string().min(1),
  })
  .strict();

const CliJourneySaveSchema = z
  .object({
    kind: z.literal(CLI_JOURNEY_SAVE_KIND),
    version: z.literal(CLI_JOURNEY_SAVE_VERSION),
    phase: z.enum(["overworld", "quest_active", "quest_suspended", "quest_terminal"]),
    overworld: z.unknown(),
    child: CliJourneySaveChildSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const childExpected = value.phase !== "overworld";
    if (childExpected !== (value.child !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["child"],
        message: "CLI journey phase and embedded child must agree.",
      });
    }
  });

/**
 * The persisted form of ONE embedded quest child: its launch anchor, the save bundle of its
 * current state, and the exact accepted action trail that reaches that state from launch.
 *
 * This is the shape the terminal journey writes beside its parent snapshot, and it is
 * exported so the MCP server persists a mid-quest child in the very same form
 * (`export_overworld_session` / `restore_overworld_session`, bug_0654). Before that, MCP
 * exported only the parent, so a journey saved mid-quest restored with its quest started
 * and no child able to finish it. One record and one verifier mean the two surfaces cannot
 * disagree about what makes a restored child trustworthy.
 */
export type EmbeddedQuestChildRecord = CliJourneySaveChild;
export const EmbeddedQuestChildRecordSchema = CliJourneySaveChildSchema;

/** The live state an embedded child record is written from. */
type EmbeddedQuestChildSource = Readonly<{
  worldQuestId: string;
  title: string;
  contentHash: string;
  launchCharacter: CampaignCharacterState;
  continuity: EmbeddedQuestCharacterContinuity;
  actionIds: readonly string[];
  state: GameState;
}>;

/** Write one embedded child in its persisted, content-bound form. */
export function embeddedQuestChildRecord(
  child: EmbeddedQuestChildSource,
): EmbeddedQuestChildRecord {
  return {
    worldQuestId: child.worldQuestId,
    title: child.title,
    contentHash: child.contentHash,
    launchCharacter: cloneCampaignCharacterState(child.launchCharacter),
    continuity: cloneEmbeddedQuestCharacterContinuity(child.continuity),
    actionIds: [...child.actionIds],
    rpgSave: save(child.state, child.contentHash, SAVE_MODE, {
      worldQuestId: child.worldQuestId,
      embeddedCharacterContinuity: child.continuity,
    }),
  };
}

/** A child whose record survived every restore check, ready to be bound to a live parent. */
type RestoredEmbeddedQuestChild = Readonly<{
  worldQuestId: string;
  title: string;
  contentHash: string;
  continuity: EmbeddedQuestCharacterContinuity;
  actionIds: readonly string[];
  phase: CliEmbeddedQuestPhase;
  index: RpgIndex;
  state: GameState;
}>;

/**
 * Quests the parent has started and not completed. While the journey is live, a non-empty
 * answer means a persisted parent is only restorable together with its embedded child.
 */
export function unfinishedEmbeddedQuestIds(parent: OverworldSession): string[] {
  return unfinishedQuestIds(parent);
}

class CliJourneyIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliJourneyIntegrityError";
  }
}

export function isCliJourneyIntegrityError(error: unknown): boolean {
  return error instanceof CliJourneyIntegrityError || error instanceof SaveIntegrityError;
}

function phaseFor(child: CliEmbeddedQuest | null): CliJourneyPhase {
  return child === null ? "overworld" : `quest_${child.phase}`;
}

function unfinishedQuestIds(session: OverworldSession): string[] {
  const snapshot = session.snapshot();
  const completed = new Set(snapshot.completedQuestIds);
  return snapshot.startedQuestIds.filter((id) => !completed.has(id)).sort();
}

function wrapIntegrity(label: string, error: unknown): CliJourneyIntegrityError {
  if (error instanceof CliJourneyIntegrityError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new CliJourneyIntegrityError(`${label}: ${detail}`, {
    ...(error instanceof Error ? { cause: error } : {}),
  });
}

function assertSame(label: string, left: unknown, right: unknown): void {
  if (canonicalize(left) !== canonicalize(right)) {
    throw new CliJourneyIntegrityError(`${label} does not match its authoritative source.`);
  }
}

function childTitle(world: OverworldManifest, worldQuestId: string): string {
  const quest = world.quests.find((candidate) => candidate.id === worldQuestId);
  if (!quest) {
    throw new CliJourneyIntegrityError(
      `Embedded child references unknown overworld quest "${worldQuestId}".`,
    );
  }
  return quest.title;
}

function authoritativeQuestDecisionsAfterLaunch(
  parent: OverworldSession,
  worldQuestId: string,
): readonly Readonly<{ actionId: string; reason: string }>[] {
  const snapshot = parent.snapshot();
  const trail = snapshot.openingLeadSourceDecisionTrail;
  if (!trail) {
    throw new CliJourneyIntegrityError(
      `Parent journey has no replayable decision trail for embedded quest "${worldQuestId}".`,
    );
  }
  const entry = snapshot.journalEntries.find(
    (candidate) => candidate.id === `quest:${worldQuestId}`,
  );
  if (!entry) {
    throw new CliJourneyIntegrityError(
      `Parent journey has no canonical launch journal for embedded quest "${worldQuestId}".`,
    );
  }
  const launchNumber =
    entry.questStartProof?.boundary.acceptedDecisions ??
    (() => {
      const matches = trail.decisions.filter(
        (decision) =>
          decision.surface === "overworld" && decision.actionId === `quest_start:${worldQuestId}`,
      );
      if (matches.length !== 1) {
        throw new CliJourneyIntegrityError(
          `Parent journey does not contain one exact start decision for embedded quest "${worldQuestId}".`,
        );
      }
      return matches[0]!.number;
    })();
  return trail.decisions
    .filter((decision) => decision.number > launchNumber && decision.surface === "quest")
    .map((decision) => ({ actionId: decision.actionId, reason: decision.reason }));
}

function assertParentChildConsistency(
  world: OverworldManifest,
  parent: OverworldSession,
  child: CliEmbeddedQuest | null,
): void {
  const unfinished = unfinishedQuestIds(parent);
  const parentSnapshot = parent.snapshot();
  const journey = parent.journey();
  const deathBoundary = parentSnapshot.questCharacterDeathBoundary;
  const deathGate =
    journey.status === "awaiting_choice" &&
    journey.pendingChoice?.reasons.includes("character_died") === true &&
    journey.pendingChoice.options.length === 1 &&
    journey.pendingChoice.options[0]?.id === "end";
  if (child === null) {
    if (unfinished.length > 0 && journey.status !== "ended") {
      throw new CliJourneyIntegrityError(
        `Journey save has unfinished quest state (${unfinished.join(", ")}) but no embedded child.`,
      );
    }
    return;
  }
  if (journey.status === "ended") {
    throw new CliJourneyIntegrityError("An ended parent journey cannot retain an embedded child.");
  }
  if (unfinished.length !== 1 || unfinished[0] !== child.worldQuestId) {
    throw new CliJourneyIntegrityError(
      `Embedded child "${child.worldQuestId}" does not match the parent's single unfinished quest.`,
    );
  }
  if (child.title !== childTitle(world, child.worldQuestId)) {
    throw new CliJourneyIntegrityError(
      `Embedded child title does not match overworld quest "${child.worldQuestId}".`,
    );
  }
  const ending = child.state.endingId
    ? child.index.pack.endings.find((candidate) => candidate.id === child.state.endingId)
    : undefined;
  if (child.phase === "terminal") {
    if (!child.state.ended || !ending?.death) {
      throw new CliJourneyIntegrityError(
        "Only an ended death outcome may occupy the terminal embedded-child phase.",
      );
    }
    if (
      !deathGate ||
      deathBoundary?.questId !== child.worldQuestId ||
      deathBoundary.endingId !== child.state.endingId
    ) {
      throw new CliJourneyIntegrityError(
        "A terminal embedded child must match the parent's exact character-death boundary and end-only gate.",
      );
    }
  } else if (child.state.ended) {
    throw new CliJourneyIntegrityError(
      "A live or suspended embedded child cannot already be at an ending.",
    );
  } else if (deathBoundary !== undefined || deathGate) {
    throw new CliJourneyIntegrityError(
      "A parent character-death boundary cannot retain a live or suspended embedded child.",
    );
  }
}

function restoreChild(args: {
  world: OverworldManifest;
  runtime: RpgSourceRuntime;
  parent: OverworldSession;
  phase: Exclude<CliJourneyPhase, "overworld">;
  saved: CliJourneySaveChild;
}): CliEmbeddedQuest {
  try {
    const source = args.runtime.requireWorldQuestPlayable(args.saved.worldQuestId);
    if (source.questId !== args.saved.worldQuestId) {
      throw new CliJourneyIntegrityError("Embedded child source id changed while loading.");
    }
    if (source.compiled.contentHash !== args.saved.contentHash) {
      throw new CliJourneyIntegrityError(
        `Embedded child content hash mismatch: save names ${args.saved.contentHash}, source is ${source.compiled.contentHash}.`,
      );
    }
    const bundle = load(args.saved.rpgSave, args.saved.contentHash, SAVE_MODE);
    assertSaveContentHash(bundle, source.compiled.contentHash);
    if (bundle.source_ref[0] !== "wq" || bundle.source_ref[1] !== args.saved.worldQuestId) {
      throw new CliJourneyIntegrityError(
        "Embedded RPG save source does not match the wrapper world quest.",
      );
    }
    const savedContinuity = bundle.embedded_character_continuity?.character_continuity;
    if (!savedContinuity) {
      throw new CliJourneyIntegrityError(
        "Embedded RPG save is missing campaign character continuity.",
      );
    }
    assertSame("Embedded wrapper continuity", args.saved.continuity, savedContinuity);
    const index = indexRpgPack(source.compiled.pack);
    assertRpgStateReferences(index, bundle.state);
    assertCampaignImportReceiptCatalogCompatibility(bundle.state, source.campaignImports);

    // Recreate the authoritative launch boundary from its saved character
    // anchor and child seed. The parent may legitimately evolve while this
    // exact child is suspended; imports must remain bound to the original
    // launch instead of being silently rebased at restore time.
    const provenLaunchCharacter = args.parent.questLaunchCharacterState(args.saved.worldQuestId);
    if (!provenLaunchCharacter) {
      throw new CliJourneyIntegrityError(
        "Embedded child has no parent-proven quest launch character.",
      );
    }
    assertSame("Embedded launch character", args.saved.launchCharacter, provenLaunchCharacter);
    const launchCharacter = provenLaunchCharacter;
    const launchOverlay = embeddedLaunchOverlayFromPersistedReceipt(
      bundle.state.embeddedLaunchOverlayReceipt,
    );
    const launchState =
      source.campaignImports === undefined
        ? initStateForRpgPack(index, bundle.state.seed, undefined, launchOverlay)
        : initStateForRpgPack(
            index,
            bundle.state.seed,
            {
              character: launchCharacter,
              imports: source.campaignImports,
            },
            launchOverlay,
          );
    assertSame(
      "Embedded campaign import receipt",
      bundle.state.campaignImportReceipt,
      launchState.campaignImportReceipt,
    );
    const expectedContinuity = buildEmbeddedQuestCharacterContinuity({
      character: launchCharacter,
      pack: source.compiled.pack,
      state: launchState,
    });
    assertSame("Embedded campaign character continuity", savedContinuity, expectedContinuity);

    let replayedState = launchState;
    const replayedCountedDecisions: { actionId: string; reason: string }[] = [];
    const rules = buildRpgRules(index);
    for (const actionId of args.saved.actionIds) {
      const options = enumerateRpgActions(index, replayedState).filter(
        (candidate) => candidate.id === actionId,
      );
      if (options.length !== 1) {
        throw new CliJourneyIntegrityError(
          `Embedded action trail id "${actionId}" does not resolve to one exact legal row.`,
        );
      }
      const option = options[0]!;
      const result = makeStep(rules)(replayedState, option.action);
      if (!result.ok) {
        throw new CliJourneyIntegrityError(
          `Embedded action trail id "${actionId}" is rejected during deterministic replay.`,
        );
      }
      const classification = classifyRpgJourneyDecision({
        action: option.action,
        before: replayedState,
        after: result.state,
        events: result.events,
        accepted: true,
        isSkillCheck: option.skill_check !== undefined,
      });
      if (classification.countsTowardJourney) {
        replayedCountedDecisions.push({ actionId, reason: classification.reason });
      }
      replayedState = result.state;
    }
    assertSame("Embedded action trail state", replayedState, bundle.state);
    assertSame(
      "Embedded action trail parent decisions",
      replayedCountedDecisions,
      authoritativeQuestDecisionsAfterLaunch(args.parent, args.saved.worldQuestId),
    );

    const child: CliEmbeddedQuest = {
      worldQuestId: args.saved.worldQuestId,
      title: args.saved.title,
      contentHash: args.saved.contentHash,
      launchCharacter,
      continuity: cloneEmbeddedQuestCharacterContinuity(savedContinuity),
      actionIds: [...args.saved.actionIds],
      phase: args.phase.slice("quest_".length) as CliEmbeddedQuestPhase,
      index,
      state: bundle.state,
    };
    assertParentChildConsistency(args.world, args.parent, child);
    return child;
  } catch (error) {
    throw wrapIntegrity("Could not restore embedded quest", error);
  }
}

/**
 * Verify a persisted embedded child against its restored parent with every check the
 * terminal journey applies — content hash, save/source identity, character continuity, the
 * parent-proven launch character and campaign import receipt, a deterministic replay of the
 * whole action trail to the saved state, the replayed decisions against the parent's own
 * decision trail, and parent/child phase consistency — and return it ready to bind. Throws
 * a `CliJourneyIntegrityError` naming the first check that failed.
 */
export function restoreEmbeddedQuestChild(args: {
  world: OverworldManifest;
  runtime: RpgSourceRuntime;
  parent: OverworldSession;
  phase: CliEmbeddedQuestPhase;
  saved: EmbeddedQuestChildRecord;
}): RestoredEmbeddedQuestChild {
  return restoreChild({
    world: args.world,
    runtime: args.runtime,
    parent: args.parent,
    phase: `quest_${args.phase}`,
    saved: args.saved,
  });
}

/**
 * Persistent terminal authority for one overworld parent and at most one
 * embedded RPG child. The parent journey gate always outranks child actions.
 */
export class CliJourneySession {
  private constructor(
    private readonly world: OverworldManifest,
    private parentSession: OverworldSession,
    private readonly runtime: RpgSourceRuntime,
    private childSession: CliEmbeddedQuest | null,
  ) {}

  static fresh(root: string, world: OverworldManifest): CliJourneySession {
    return new CliJourneySession(
      world,
      new OverworldSession(world),
      new RpgSourceRuntime(root),
      null,
    );
  }

  static fromParent(
    root: string,
    world: OverworldManifest,
    parent: OverworldSession,
    runtime = new RpgSourceRuntime(root),
  ): CliJourneySession {
    assertParentChildConsistency(world, parent, null);
    return new CliJourneySession(world, parent, runtime, null);
  }

  static restore(root: string, world: OverworldManifest, raw: unknown): CliJourneySession {
    const runtime = new RpgSourceRuntime(root);
    const record =
      raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    if (record?.["kind"] !== CLI_JOURNEY_SAVE_KIND) {
      try {
        const parent = OverworldSession.restore(world, raw);
        const unfinished = unfinishedQuestIds(parent);
        if (unfinished.length > 0 && parent.journey().status !== "ended") {
          throw new CliJourneyIntegrityError(
            `Legacy overworld save has unfinished quest state (${unfinished.join(", ")}) but no embedded child.`,
          );
        }
        assertParentChildConsistency(world, parent, null);
        return new CliJourneySession(world, parent, runtime, null);
      } catch (error) {
        throw wrapIntegrity("Could not restore legacy overworld journey", error);
      }
    }

    const parsed = CliJourneySaveSchema.safeParse(raw);
    if (!parsed.success) {
      throw new CliJourneyIntegrityError(`CLI journey save is malformed: ${parsed.error.message}`);
    }
    try {
      const parent = OverworldSession.restore(world, parsed.data.overworld);
      const child =
        parsed.data.child === null
          ? null
          : restoreChild({
              world,
              runtime,
              parent,
              phase: parsed.data.phase as Exclude<CliJourneyPhase, "overworld">,
              saved: parsed.data.child,
            });
      assertParentChildConsistency(world, parent, child);
      return new CliJourneySession(world, parent, runtime, child);
    } catch (error) {
      throw wrapIntegrity("Could not restore CLI journey", error);
    }
  }

  overworld(): OverworldSession {
    return this.parentSession;
  }

  journey(): JourneyPresentation {
    return this.parentSession.journey();
  }

  child(): CliEmbeddedQuestView | null {
    const child = this.childSession;
    if (!child) return null;
    return {
      worldQuestId: child.worldQuestId,
      title: child.title,
      contentHash: child.contentHash,
      continuity: cloneEmbeddedQuestCharacterContinuity(child.continuity),
      phase: child.phase,
      index: child.index,
      state: cloneGameState(child.state),
      stateHash: hashState(child.state),
      actions: enumerateRpgActions(child.index, child.state),
    };
  }

  beginQuest(questId: string, seed: number, approachId?: string): OverworldJourneyQuestStartResult {
    if (this.childSession) {
      throw new Error(
        `Finish or resume ${this.childSession.title} before starting another embedded quest.`,
      );
    }
    if (this.parentSession.journey().pendingChoice || this.parentSession.journey().storyChoice) {
      throw new Error("Answer the active parent journey choice before starting a quest.");
    }
    const plan = this.parentSession.prepareQuestStart(questId, approachId);
    const launchOverlay = embeddedLaunchOverlayForPlan(plan);
    let source;
    let index: RpgIndex;
    let state: GameState;
    let continuity: EmbeddedQuestCharacterContinuity;
    try {
      source = this.runtime.requireWorldQuestPlayable(plan.quest.id);
      index = indexRpgPack(source.compiled.pack);
      state =
        source.campaignImports === undefined
          ? initStateForRpgPack(index, seed, undefined, launchOverlay)
          : initStateForRpgPack(
              index,
              seed,
              {
                character: plan.characterAfter,
                imports: source.campaignImports,
              },
              launchOverlay,
            );
      continuity = buildEmbeddedQuestCharacterContinuity({
        character: plan.characterAfter,
        pack: source.compiled.pack,
        state,
      });
    } catch (error) {
      throw wrapIntegrity(`Could not load quest "${plan.quest.id}"`, error);
    }
    const started = this.parentSession.commitQuestStart(plan);
    this.childSession = {
      worldQuestId: plan.quest.id,
      title: plan.quest.title,
      contentHash: source.compiled.contentHash,
      launchCharacter: cloneCampaignCharacterState(plan.characterAfter),
      continuity,
      actionIds: [],
      phase: "active",
      index,
      state,
    };
    assertParentChildConsistency(this.world, this.parentSession, this.childSession);
    return started;
  }

  resumeQuest(questId: string): CliEmbeddedQuestView {
    const child = this.childSession;
    if (!child || child.worldQuestId !== questId) {
      throw new Error(`There is no suspended embedded quest "${questId}" to resume.`);
    }
    if (child.phase === "terminal") {
      throw new Error(`${child.title} has already reached a terminal death outcome.`);
    }
    child.phase = "active";
    return this.child()!;
  }

  suspendQuest(): CliEmbeddedQuestView {
    const child = this.requireActiveChild();
    child.phase = "suspended";
    return this.child()!;
  }

  stepQuest(option: RpgActionOption): CliQuestStepResult {
    const child = this.requireActiveChild();
    if (this.parentSession.journey().pendingChoice || this.parentSession.journey().storyChoice) {
      throw new Error("The parent journey choice must be answered before the quest can continue.");
    }
    const currentOptions = enumerateRpgActions(child.index, child.state);
    const currentMatches = currentOptions.filter(
      (candidate) => candidate.id === option.id && actionEquals(candidate.action, option.action),
    );
    const current = currentMatches.length === 1 ? currentMatches[0] : undefined;
    if (!current) {
      return {
        ok: false,
        rejectionReason: "That action is not available right now.",
        events: [],
        actionOption: option,
        journeyDecision: excludedJourneyDecision("rejected"),
        stateHash: hashState(child.state),
        questCompletion: null,
        terminalDeath: false,
      };
    }
    const before = child.state;
    let result;
    try {
      result = makeStep(buildRpgRules(child.index))(before, current.action);
    } catch (error) {
      throw wrapIntegrity("Embedded quest reducer failed", error);
    }
    const journeyDecision = classifyRpgJourneyDecision({
      action: current.action,
      before,
      after: result.state,
      events: result.events,
      accepted: result.ok,
      isSkillCheck: current.skill_check !== undefined,
    });
    if (!result.ok) {
      return {
        ok: false,
        rejectionReason: result.rejectionReason ?? "Action rejected.",
        events: result.events,
        actionOption: current,
        journeyDecision,
        stateHash: hashState(child.state),
        questCompletion: null,
        terminalDeath: false,
      };
    }

    // Parent decision authority is committed first. If its integrity gate
    // rejects, the child remains byte-for-byte at the prior state.
    let questCompletion: OverworldJourneyQuestCompletionResult | null = null;
    let terminalDeath = false;
    try {
      this.parentSession.recordQuestDecision(
        current.id,
        journeyDecision,
        isRpgCheckpointSafeBoundary(child.index, result.state),
      );
      child.state = result.state;
      child.actionIds.push(current.id);

      if (child.state.ended && child.state.endingId) {
        const ending = child.index.pack.endings.find(
          (candidate) => candidate.id === child.state.endingId,
        );
        if (!ending) {
          throw new CliJourneyIntegrityError(
            `Embedded quest ended at unknown ending "${child.state.endingId}".`,
          );
        }
        if (ending.death) {
          const deathOutcome = {
            endingId: ending.id,
            endingTitle: ending.title,
            death: true,
          } as const;
          this.parentSession.recordQuestCharacterDeath(child.worldQuestId, deathOutcome);
          child.phase = "terminal";
          terminalDeath = true;
        } else {
          questCompletion = this.parentSession.completeQuest(child.worldQuestId, {
            endingId: ending.id,
            endingTitle: ending.title,
            death: false,
          });
          this.childSession = null;
        }
      }
    } catch (error) {
      throw wrapIntegrity("Could not commit embedded quest decision", error);
    }
    assertParentChildConsistency(this.world, this.parentSession, this.childSession);
    return {
      ok: true,
      rejectionReason: null,
      events: result.events,
      actionOption: current,
      journeyDecision,
      stateHash: hashState(result.state),
      questCompletion,
      terminalDeath,
    };
  }

  afterParentChoice(): void {
    if (this.parentSession.journey().status === "ended") {
      this.childSession = null;
    }
    assertParentChildConsistency(this.world, this.parentSession, this.childSession);
  }

  document(): CliJourneySave {
    assertParentChildConsistency(this.world, this.parentSession, this.childSession);
    const child = this.childSession;
    return {
      kind: CLI_JOURNEY_SAVE_KIND,
      version: CLI_JOURNEY_SAVE_VERSION,
      phase: phaseFor(child),
      overworld: this.parentSession.snapshot(),
      child: child === null ? null : embeddedQuestChildRecord(child),
    };
  }

  serialize(): string {
    return JSON.stringify(this.document(), null, 2);
  }

  snapshotHash(): string {
    // Preserve the historical parent-only CLI hash when there is no retained
    // child. Once a child exists, bind both authorities into one hash.
    return this.childSession === null
      ? this.parentSession.snapshotHash()
      : hashState(this.document());
  }

  private requireActiveChild(): CliEmbeddedQuest {
    const child = this.childSession;
    if (!child || child.phase !== "active") {
      throw new Error("There is no active embedded quest turn.");
    }
    return child;
  }
}
