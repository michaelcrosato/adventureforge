/**
 * MCP tool handlers as PURE functions (spec §9.4).
 *
 * Each handler is a thin wrapper over engine/validator/runner code we already
 * built — the engine stays the source of truth. These are unit-tested directly,
 * without a live MCP client (a §9.4 rule); server.ts only adapts them to stdio.
 *
 * The public world catalog, quest loading path, and live session dispatch are all
 * RPG-only. Legacy content files may still exist as data during migration, but MCP
 * never indexes, observes, starts, or validates them as playable sessions. Content
 * and traces are data only — no handler runs shell or code (§16).
 */
import { readFileSync } from "node:fs";
import type { RpgAction } from "../api/types.js";
import { assertRuntimeSeed, type GameState } from "../core/state.js";
import { hashState } from "../core/hash.js";

import type { CompiledRpgSource } from "../rpg/source.js";
import { assertRpgStateReferences } from "../rpg/state_integrity.js";
import { initStateForRpgPack, isRpgCheckpointSafeBoundary } from "../rpg/runner.js";
import { buildEmbeddedQuestCharacterContinuity } from "../rpg/embedded_quest_character_continuity.js";

import type { ValidationReport } from "../validate/report.js";
import { assertWellFormedState } from "../persist/save_load.js";
import { assertCampaignImportReceiptCatalogCompatibility } from "../persist/campaign_import_integrity.js";
import { assertTraceMode, replayTrace } from "../trace/replay.js";
import type { Trace } from "../trace/record.js";
import { safeResolve } from "./paths.js";
import { SessionStore } from "./sessions.js";
import { type McpActionOption, type McpBlockedActionOption, type McpObservation } from "./types.js";
import type { RpgCompactLegend, RpgCompactObservation } from "./compact_rpg_observation.js";
import type { RpgCompactState } from "./compact_rpg_state.js";
import { RpgMcpSessionRuntime } from "./rpg_session_runtime.js";
import type { EmbeddedQuestCharacterContinuityField } from "./embedded_quest_character_continuity_projection.js";
import {
  runRpgLoadGame,
  runRpgNewGame,
  runRpgStartWorldQuest,
  type RpgWorldQuestStartPayload as RpgRuntimeWorldQuestStartPayload,
} from "./rpg_session_lifecycle.js";
import { RpgSourceRuntime } from "./rpg_source_runtime.js";
import {
  runRpgGetObservation,
  runRpgGetState,
  runRpgGetTranscript,
  runRpgListLegalActions,
  runRpgSaveGame,
} from "./rpg_session_tools.js";
import {
  runRpgStepAction,
  type RpgStepActionResponse as RpgRuntimeStepActionResponse,
} from "./rpg_step_action.js";
import type { RpgStateHashRejection, RpgStateUnchanged } from "./rpg_state_guards.js";
import { compactMcpTranscriptSummaryValue } from "./action_labels.js";
import {
  TRANSCRIPT_TURN_LIMIT_DEFAULT,
  rpgStepEventVersion,
  rpgStepEvents,
  type TranscriptArgs,
  type TranscriptResponse,
} from "./transcript_projection.js";
import { OverworldMcpSessionStore } from "./overworld_sessions.js";
import { createOverworldToolHandlers } from "./overworld_tool_handlers.js";
import { createEmbeddedQuestPersistence } from "./embedded_quest_persistence.js";
import { overworldQuestCompletionFromRpgSession } from "./overworld_quest_bridge.js";
import {
  embeddedJourneyFocus,
  journeyBlocksGameplay,
  suppressRpgGameplayActions,
  type EmbeddedJourneyField,
  type EmbeddedJourneyFocus,
} from "./journey_projection.js";
import { excludedJourneyDecision } from "../world/journey_decision.js";
import type { OverworldJourneyQuestCompletionResult } from "../world/session.js";
import {
  loadOverworldManifest as loadOverworldManifestFromRoot,
  resolveWorldQuestSourceId,
} from "../world/source.js";
import { loadWorldQuestReport, validateWorldQuestReport } from "./world_quest_reports.js";
import { MockAuthorProvider } from "../../agents/authoring/mock_author.js";
import { loadEngineContract, runWriter } from "../../agents/authoring/writer.js";
import { runRpgAdapter } from "../../agents/authoring/adapter.js";
import { diagnose } from "../../agents/debugger.js";
import { applyContentPatch, type ContentPatchProposal } from "../../agents/fixer.js";

export type ToolApi = ReturnType<typeof createToolApi>;

type RpgViewOptions = {
  compact_actions?: boolean;
  compact_observation?: boolean;
  include_actions?: boolean;
};

type DefaultCompactRpgView<Args extends RpgViewOptions> = Args extends {
  compact_observation: false;
}
  ? Args
  : Args & { compact_observation: true };

type DefaultCompactRpgActions<Args extends Pick<RpgViewOptions, "compact_actions">> = Args extends {
  compact_actions: false;
}
  ? Args
  : Args & { compact_actions: true };

type RpgEventOptions = {
  compact_events?: boolean;
  include_event_version?: boolean;
};

type DefaultCompactRpgEvents<Args extends RpgEventOptions> = Args extends {
  compact_events: false;
}
  ? Args
  : Args & { compact_events: true };

type DefaultCompactRpgStep<Args extends RpgViewOptions & RpgEventOptions> = DefaultCompactRpgView<
  DefaultCompactRpgEvents<Args>
>;

type DefaultTranscriptSummaryOnly<Args extends TranscriptArgs> = Args extends {
  summary_only: false;
}
  ? Args
  : Args & { summary_only: true };

type DefaultTranscriptCompactEvents<Args extends TranscriptArgs> = Args extends {
  compact_events: false;
}
  ? Args
  : Args & { compact_events: true };

type DefaultTranscriptCompactSummary<Args extends TranscriptArgs> = Args extends {
  compact_summary: false;
}
  ? Args
  : Args & { compact_summary: true };

type DefaultTranscriptTurnLimit<Args extends TranscriptArgs> = Args extends {
  turn_limit: number;
}
  ? Args
  : Args & { turn_limit: typeof TRANSCRIPT_TURN_LIMIT_DEFAULT };

type DefaultCompactTranscript<Args extends TranscriptArgs> = DefaultTranscriptTurnLimit<
  DefaultTranscriptCompactSummary<
    DefaultTranscriptCompactEvents<DefaultTranscriptSummaryOnly<Args>>
  >
>;

type RpgViewField<Args extends RpgViewOptions> = Args extends {
  compact_observation: true;
}
  ? { context: RpgCompactObservation }
  : { observation: McpObservation };

type RpgSourceFields = {
  world_quest_id?: string;
  generated_rpg_seed?: number;
};

type RpgSessionPayload<Args extends RpgViewOptions = RpgViewOptions> = {
  session_id: string;
  state_hash: string;
  /** Field guide for the compact context/events; sent only on session-creating responses. */
  legend?: RpgCompactLegend;
} & RpgSourceFields &
  RpgViewField<Args> &
  EmbeddedQuestCharacterContinuityField<Args> &
  Partial<EmbeddedJourneyField>;

type RpgEmbeddedJourneyForView<Args extends RpgViewOptions> = Args extends {
  compact_observation: true;
}
  ? Partial<EmbeddedJourneyField<EmbeddedJourneyFocus>>
  : Partial<EmbeddedJourneyField>;

type RequestedCharacterContinuity<Args extends RpgGetObservationArgs> = Args extends {
  include_character_continuity: true;
}
  ? EmbeddedQuestCharacterContinuityField<Args>
  : Record<string, never>;

type RpgObservationPayload<Args extends RpgGetObservationArgs> = {
  state_hash: string;
} & RpgViewField<Args> &
  RpgEmbeddedJourneyForView<Args> &
  RequestedCharacterContinuity<Args>;

type RpgObservationUnchanged<Args extends RpgGetObservationArgs> = RpgStateUnchanged &
  RpgEmbeddedJourneyForView<Args>;

type RpgObservationResponse<Args extends RpgGetObservationArgs> = Args extends {
  include_character_continuity: true;
}
  ? RpgObservationPayload<Args>
  : Args extends { if_state_hash: string }
    ? RpgObservationPayload<Args> | RpgObservationUnchanged<Args>
    : RpgObservationPayload<Args>;

type RpgLegalActionsArgs = {
  session_id: string;
  compact_actions?: boolean;
  if_state_hash?: string;
};

type RpgLegalActionRows<Args extends RpgLegalActionsArgs> = Args extends {
  compact_actions: true;
}
  ? string[]
  : McpActionOption[];

type RpgBlockedActionRows<Args extends RpgLegalActionsArgs> = Args extends {
  compact_actions: true;
}
  ? Array<readonly [id: string, reason: string]>
  : McpBlockedActionOption[];

type RpgLegalActionsPayload<Args extends RpgLegalActionsArgs> = {
  actions: RpgLegalActionRows<Args>;
  blocked_actions?: RpgBlockedActionRows<Args>;
  state_hash: string;
} & RpgEmbeddedJourneyForActions<Args>;

type RpgEmbeddedJourneyForActions<Args extends RpgLegalActionsArgs> = Args extends {
  compact_actions: true;
}
  ? Partial<EmbeddedJourneyField<EmbeddedJourneyFocus>>
  : Partial<EmbeddedJourneyField>;

type RpgLegalActionsUnchanged<Args extends RpgLegalActionsArgs> = RpgStateUnchanged &
  RpgEmbeddedJourneyForActions<Args>;

type RpgLegalActionsResponse<Args extends RpgLegalActionsArgs> = Args extends {
  if_state_hash: string;
}
  ? RpgLegalActionsPayload<Args> | RpgLegalActionsUnchanged<Args>
  : RpgLegalActionsPayload<Args>;

type RpgNewGameArgs = {
  generate_rpg_seed?: number;
  seed?: number;
  hide_graph?: boolean;
  include_world_intro?: boolean;
} & RpgViewOptions;

type RpgStartWorldQuestArgs = {
  world_quest_id: string;
  seed?: number;
  hide_graph?: boolean;
  include_world_intro?: boolean;
} & RpgViewOptions;

type RpgGetObservationArgs = {
  session_id: string;
  hide_graph?: boolean;
  if_state_hash?: string;
  include_character_continuity?: boolean;
} & RpgViewOptions;

type RpgStepActionArgs = {
  session_id: string;
  action_id: string;
  expected_state_hash?: string;
  hide_graph?: boolean;
} & RpgViewOptions &
  RpgEventOptions;

type RpgStepActionResponse<Args extends RpgStepActionArgs> = RpgRuntimeStepActionResponse<Args> &
  RpgEmbeddedJourneyForView<Args> & {
    questCompletion?: OverworldJourneyQuestCompletionResult;
  };

type RpgLoadGameArgs = {
  world_quest_id?: string;
  generate_rpg_seed?: number;
  save: string;
  hide_graph?: boolean;
  include_world_intro?: boolean;
} & RpgViewOptions;

type InspectTraceArgs = {
  trace_path: string;
  world_quest_id?: string;
  compact_summary?: boolean;
};

type ApplyContentPatchArgs = {
  world_quest_id?: string;
  include_pack?: boolean;
  proposal: ContentPatchProposal;
};

type AdaptStoryArgs = {
  premise: string;
  include_pack?: boolean;
};

type InspectTraceStepSummary = {
  i: number;
  action: RpgAction;
  ok: boolean;
  location: string;
  ended: boolean;
  ending_id: string | null;
};

type CompactInspectTraceStepSummary = readonly [
  i: number,
  action: string,
  ok: boolean,
  location: string,
  ended: boolean,
  ending_id: string | null,
];

const INSPECT_TRACE_STEP_SUMMARY_VERSION = 1 as const;

/**
 * Read + parse a client-named trace file with SANITIZED errors. `trace_path` is
 * client input, and the raw failures leak internals to a (possibly blind) MCP
 * client: Node fs errors embed the resolved ABSOLUTE path ("ENOENT: ... open
 * 'C:\\...\\traces\\x.json'") and JSON.parse embeds parser positions. Echo only
 * the path the client itself sent. Path confinement (safeResolve) still runs
 * first and keeps its own message, which names nothing but that client path.
 */
function readTraceJson(root: string, tracePath: string): Trace<RpgAction> {
  const abs = safeResolve(root, tracePath);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    throw new Error(`Trace "${tracePath}" was not found or could not be read.`);
  }
  try {
    return JSON.parse(raw) as Trace<RpgAction>;
  } catch {
    throw new Error(`Trace "${tracePath}" is not valid JSON.`);
  }
}

function compactTraceActionLabel(action: RpgAction): string {
  switch (action.type) {
    case "LOOK":
      return compactMcpTranscriptSummaryValue(
        action.npc !== undefined
          ? `LOOK:NPC:${action.npc}`
          : action.target === undefined
            ? "LOOK"
            : `LOOK:${action.target}`,
      );
    case "MOVE":
      return compactMcpTranscriptSummaryValue(`MOVE:${action.direction}`);
    case "TAKE":
      return compactMcpTranscriptSummaryValue(`TAKE:${action.item}`);
    case "DROP":
      return compactMcpTranscriptSummaryValue(`DROP:${action.item}`);
    case "OPEN":
      return compactMcpTranscriptSummaryValue(`OPEN:${action.target}`);
    case "CLOSE":
      return compactMcpTranscriptSummaryValue(`CLOSE:${action.target}`);
    case "UNLOCK":
      return compactMcpTranscriptSummaryValue(`UNLOCK:${action.target}:${action.with}`);
    case "USE":
      return compactMcpTranscriptSummaryValue(
        action.item === undefined ? `USE:${action.target}` : `USE:${action.item}:${action.target}`,
      );
    case "TALK":
      return compactMcpTranscriptSummaryValue(`TALK:${action.npc}`);
    case "ASK":
      return compactMcpTranscriptSummaryValue(`ASK:${action.npc}:${action.topic}`);
    case "GIVE":
      return compactMcpTranscriptSummaryValue(`GIVE:${action.item}:${action.npc}`);
    case "READ":
      return compactMcpTranscriptSummaryValue(`READ:${action.target}`);
    case "INSPECT":
      return compactMcpTranscriptSummaryValue(`INSPECT:${action.target}`);
    case "INVENTORY":
      return "INVENTORY";
    case "MANEUVER":
      return compactMcpTranscriptSummaryValue(`MANEUVER:${action.enemy}:${action.maneuver}`);
    case "ATTACK":
      return compactMcpTranscriptSummaryValue(`ATTACK:${action.enemy}`);
  }
}

function compactInspectTraceStepSummary(
  steps: InspectTraceStepSummary[],
): CompactInspectTraceStepSummary[] {
  return steps.map((step) => [
    step.i,
    compactTraceActionLabel(step.action),
    step.ok,
    compactMcpTranscriptSummaryValue(step.location),
    step.ended,
    step.ending_id === null ? null : compactMcpTranscriptSummaryValue(step.ending_id),
  ]);
}

type RpgWorldQuestStartPayload<Args extends RpgStartWorldQuestArgs> =
  RpgRuntimeWorldQuestStartPayload<Args>;

type RpgGetStateArgs = {
  session_id: string;
  include_state?: boolean;
  compact_state?: boolean;
  if_state_hash?: string;
};
type RpgStateHashPayload = {
  state_hash: string;
};
type RpgRawStatePayloadField = {
  state: GameState;
};
type RpgCompactStatePayloadField = {
  compact_state: RpgCompactState;
};
type RpgStatePayloadFor<Args extends RpgGetStateArgs> = Args extends { include_state: true }
  ? RpgStateHashPayload &
      RpgRawStatePayloadField &
      (Args extends { compact_state: true } ? RpgCompactStatePayloadField : Record<string, never>)
  : RpgStateHashPayload &
      (Args extends { compact_state: true } ? RpgCompactStatePayloadField : Record<string, never>);
type RpgStateResponse<Args extends RpgGetStateArgs> = Args extends { if_state_hash: string }
  ? RpgStatePayloadFor<Args> | RpgStateUnchanged
  : RpgStatePayloadFor<Args>;

type RpgSaveArgs = {
  session_id: string;
  expected_state_hash?: string;
  if_state_hash?: string;
  include_source?: boolean;
  include_content_hash?: boolean;
};

type RpgSaveContentHashField<Args extends RpgSaveArgs> = Args extends {
  include_content_hash: true;
}
  ? { content_hash: string }
  : Record<string, never>;

type RpgSaveSuccess<Args extends RpgSaveArgs> = {
  ok: true;
  save: string;
  state_hash: string;
} & RpgSaveContentHashField<Args> &
  (Args extends { include_source: true } ? RpgSourceFields : Record<string, never>);

type RpgSaveRejection = RpgStateHashRejection;

type RpgSaveUnchanged = RpgStateUnchanged;

type RpgSaveResponse<Args extends RpgSaveArgs> =
  | RpgSaveSuccess<Args>
  | (Args extends { expected_state_hash: string } ? RpgSaveRejection : never)
  | (Args extends { if_state_hash: string } ? RpgSaveUnchanged : never);

export function createToolApi(opts: { root: string; embeddedQuestSeed?: number }) {
  const root = opts.root;
  if (opts.embeddedQuestSeed !== undefined) {
    assertRuntimeSeed(opts.embeddedQuestSeed, "Embedded quest seed");
  }
  const sessions = new SessionStore();
  const rpgSources = new RpgSourceRuntime(root);
  const rpgRuntime = new RpgMcpSessionRuntime(sessions);
  const overworldSessions = new OverworldMcpSessionStore(() => loadOverworldManifestFromRoot(root));
  const embeddedQuests = createEmbeddedQuestPersistence({
    sessions,
    rpgRuntime,
    rpgSources,
    loadOverworldManifest: () => loadOverworldManifestFromRoot(root),
  });

  function embeddedJourneyField(rpgSessionId: string): EmbeddedJourneyField | null {
    const rpgSession = sessions.get(rpgSessionId);
    if (!rpgSession.overworldSessionId) return null;
    const overworldSession = overworldSessions.get(rpgSession.overworldSessionId);
    return {
      journey: overworldSession.journey(),
      overworld_snapshot_hash: overworldSessions.snapshotHash(overworldSession),
    };
  }

  function withEmbeddedJourney<Payload extends object>(
    rpgSessionId: string,
    payload: Payload,
    compact: boolean,
  ): Payload & Partial<EmbeddedJourneyField<EmbeddedJourneyFocus> | EmbeddedJourneyField> {
    const field = embeddedJourneyField(rpgSessionId);
    if (!field) return payload;
    const blocked = journeyBlocksGameplay(field.journey);
    const projectedPayload = blocked ? suppressRpgGameplayActions(payload) : payload;
    const visiblePayload =
      blocked && "actions" in projectedPayload
        ? {
            ...projectedPayload,
            actions: [],
            ...("blocked_actions" in projectedPayload ? { blocked_actions: [] } : {}),
          }
        : projectedPayload;
    return {
      ...visiblePayload,
      ...field,
      ...(compact ? { journey: embeddedJourneyFocus(field.journey) } : {}),
    };
  }

  const api = {
    sessions,

    ...createOverworldToolHandlers({
      sessions,
      rpgRuntime,
      overworldSessions,
      loadOverworldManifest: () => loadOverworldManifestFromRoot(root),
      embeddedQuests,
      startEmbeddedWorldQuest: (startArgs, context) => {
        const responseOptions = {
          compact_observation: true,
          ...startArgs,
        };
        const source = rpgSources.requireWorldQuestPlayable(startArgs.world_quest_id);
        const index = rpgRuntime.runtimeFor(source.compiled.pack).index;
        const seed = startArgs.seed ?? opts.embeddedQuestSeed ?? 1;
        const initialState =
          source.campaignImports === undefined
            ? initStateForRpgPack(index, seed, undefined, context.launchOverlay)
            : initStateForRpgPack(
                index,
                seed,
                {
                  character: context.character,
                  imports: source.campaignImports,
                },
                context.launchOverlay,
              );
        const embeddedCharacterContinuity = buildEmbeddedQuestCharacterContinuity({
          character: context.character,
          pack: source.compiled.pack,
          state: initialState,
        });
        return rpgRuntime.startRpgSession(
          source.compiled,
          responseOptions,
          {
            worldQuestId: source.questId,
            overworldSessionId: context.overworldSessionId,
            embeddedCharacterContinuity,
          },
          initialState,
        );
      },
    }),

    validate_quest(args: { world_quest_id?: string }): {
      ok: boolean;
      world_quest_id: string | null;
      report: ValidationReport;
    } {
      return validateWorldQuestReport(args, "validate_quest", (worldQuestId) =>
        rpgSources.loadWorldQuestReport(worldQuestId),
      );
    },

    load_quest(args: { world_quest_id?: string }): {
      ok: boolean;
      world_quest_id: string | null;
      meta?: CompiledRpgSource["pack"]["meta"];
      content_hash?: string;
      report: ValidationReport;
    } {
      return loadWorldQuestReport(args, "load_quest", (worldQuestId) =>
        rpgSources.loadWorldQuestReport(worldQuestId),
      );
    },

    /**
     * Mint a fresh RPG pack from a seed and validate it against the SAME `validateRpg` gate
     * the curated RPG packs clear. This is the single public MCP generation surface.
     * Pure + deterministic (same seed ⇒ identical pack) and read-only — nothing is
     * written to disk. To PLAY the minted pack, pass the same value to `new_game`'s
     * `generate_rpg_seed`.
     */
    generate_rpg_pack(args: { seed: number }): {
      ok: boolean;
      content_hash: string;
      seed: number;
      meta: CompiledRpgSource["pack"]["meta"];
      room_count: number;
      enemy_count: number;
      ending_count: number;
      report: ValidationReport;
    } {
      const {
        compiled: { pack, contentHash },
        report,
      } = rpgSources.generatedRpg(args.seed);
      return {
        ok: report.ok,
        content_hash: contentHash,
        seed: args.seed,
        meta: pack.meta,
        room_count: pack.rooms.length,
        enemy_count: pack.enemies.length,
        ending_count: pack.endings.length,
        report,
      };
    },

    new_game<Args extends RpgNewGameArgs>(
      args: Args,
    ): RpgSessionPayload<DefaultCompactRpgView<Args>> {
      const responseOptions = {
        compact_observation: true,
        ...args,
      } as DefaultCompactRpgView<Args>;
      return runRpgNewGame({ root, rpgRuntime, rpgSources }, responseOptions) as RpgSessionPayload<
        DefaultCompactRpgView<Args>
      >;
    },

    start_world_quest<Args extends RpgStartWorldQuestArgs>(
      args: Args,
    ): RpgWorldQuestStartPayload<DefaultCompactRpgView<Args>> {
      const responseOptions = {
        compact_observation: true,
        ...args,
      } as DefaultCompactRpgView<Args>;
      return runRpgStartWorldQuest(
        { rpgRuntime, rpgSources },
        responseOptions,
      ) as RpgWorldQuestStartPayload<DefaultCompactRpgView<Args>>;
    },

    get_observation<Args extends RpgGetObservationArgs>(
      args: Args,
    ): RpgObservationResponse<DefaultCompactRpgView<Args>> {
      const responseOptions = {
        compact_observation: true,
        ...args,
      } as DefaultCompactRpgView<Args>;
      const response = runRpgGetObservation({ sessions, rpgRuntime }, responseOptions);
      return withEmbeddedJourney(
        args.session_id,
        response,
        responseOptions.compact_observation === true,
      ) as RpgObservationResponse<DefaultCompactRpgView<Args>>;
    },

    list_legal_actions<Args extends RpgLegalActionsArgs>(
      args: Args,
    ): RpgLegalActionsResponse<DefaultCompactRpgActions<Args>> {
      const responseOptions = {
        compact_actions: true,
        ...args,
      } as DefaultCompactRpgActions<Args>;
      const response = runRpgListLegalActions({ sessions, rpgRuntime }, responseOptions);
      return withEmbeddedJourney(
        args.session_id,
        response,
        responseOptions.compact_actions === true,
      ) as RpgLegalActionsResponse<DefaultCompactRpgActions<Args>>;
    },

    step_action<Args extends RpgStepActionArgs>(
      args: Args,
    ): RpgStepActionResponse<DefaultCompactRpgStep<Args>> {
      const responseOptions = {
        compact_events: true,
        compact_observation: true,
        ...args,
      } as DefaultCompactRpgStep<Args>;
      const before = embeddedJourneyField(args.session_id);
      if (before && journeyBlocksGameplay(before.journey)) {
        const read = runRpgGetObservation({ sessions, rpgRuntime }, responseOptions);
        const rejectionReason =
          before.journey.pendingChoice?.message ??
          before.journey.storyChoice?.message ??
          "This journey has ended. No more gameplay actions are available.";
        const blockedResponse = {
          ok: false,
          rejection_reason: rejectionReason,
          events: rpgStepEvents([], responseOptions),
          ...rpgStepEventVersion(responseOptions),
          ...suppressRpgGameplayActions(read),
          journeyDecision: excludedJourneyDecision("rejected"),
          journeyActionId: null,
        };
        return withEmbeddedJourney(
          args.session_id,
          blockedResponse,
          responseOptions.compact_observation === true,
        ) as RpgStepActionResponse<DefaultCompactRpgStep<Args>>;
      }

      const response = runRpgStepAction({ sessions, rpgRuntime }, responseOptions);
      let questCompletion: OverworldJourneyQuestCompletionResult | undefined;
      if (response.ok === true) {
        const rpgSession = sessions.get(args.session_id);
        if (rpgSession.overworldSessionId) {
          const overworldSession = overworldSessions.get(rpgSession.overworldSessionId);
          if (response.journeyActionId === null) {
            throw new Error("Accepted RPG journey decision is missing its canonical action id.");
          }
          // The child's state has already advanced, so its replay trail advances with it;
          // an export must be able to replay exactly to the state it saves (bug_0654).
          sessions.recordEmbeddedAction(rpgSession.id, response.journeyActionId);
          const journey = overworldSession.recordQuestDecision(
            response.journeyActionId,
            response.journeyDecision,
            isRpgCheckpointSafeBoundary(rpgSession.index, rpgSession.state),
          );
          if (rpgSession.state.ended) {
            const completion = overworldQuestCompletionFromRpgSession(
              rpgSession,
              rpgSession.overworldSessionId,
            );
            if (completion.outcome.death) {
              overworldSession.recordQuestCharacterDeath(completion.questId, completion.outcome);
              sessions.markEmbeddedJourneyPause(rpgSession.id);
            } else {
              questCompletion = overworldSession.completeQuest(
                completion.questId,
                completion.outcome,
              );
            }
          } else if (journey.pendingChoice !== null) {
            sessions.markEmbeddedJourneyPause(rpgSession.id);
          }
        }
      }
      const completedResponse = questCompletion ? { ...response, questCompletion } : response;
      return withEmbeddedJourney(
        args.session_id,
        completedResponse,
        responseOptions.compact_observation === true,
      ) as RpgStepActionResponse<DefaultCompactRpgStep<Args>>;
    },

    get_state<Args extends RpgGetStateArgs>(args: Args): RpgStateResponse<Args> {
      return runRpgGetState({ sessions }, args) as RpgStateResponse<Args>;
    },

    get_transcript<Args extends TranscriptArgs>(
      args: Args,
    ): TranscriptResponse<DefaultCompactTranscript<Args>> {
      const responseOptions = {
        summary_only: true,
        compact_events: true,
        compact_summary: true,
        turn_limit: TRANSCRIPT_TURN_LIMIT_DEFAULT,
        ...args,
      } as DefaultCompactTranscript<Args>;
      return runRpgGetTranscript({ sessions }, responseOptions) as TranscriptResponse<
        DefaultCompactTranscript<Args>
      >;
    },

    save_game<Args extends RpgSaveArgs>(args: Args): RpgSaveResponse<Args> {
      return runRpgSaveGame({ sessions }, args) as RpgSaveResponse<Args>;
    },

    load_game<Args extends RpgLoadGameArgs>(
      args: Args,
    ): RpgSessionPayload<DefaultCompactRpgView<Args>> {
      const responseOptions = {
        compact_observation: true,
        ...args,
      } as DefaultCompactRpgView<Args>;
      return runRpgLoadGame(
        { root, sessions, rpgRuntime, rpgSources },
        responseOptions,
      ) as RpgSessionPayload<DefaultCompactRpgView<Args>>;
    },

    async adapt_story(args: AdaptStoryArgs) {
      // Run the writer → adapter → validator loop (§12.1–3) using the deterministic,
      // keyless MockAuthorProvider — so it runs fully offline with no API keys. That
      // provider is the ONLY one wired here and it answers from canned JSON: the premise
      // reaches the writer prompt, but every premise yields the same Lighthouse pack, and
      // the tool description says so rather than promising authoring "from a premise".
      // Mirrors bin/author.ts. Returns compact story/validation proof by default;
      // callers opt into echoing the full authored pack. Never writes files.
      if ((args as { mode?: unknown }).mode !== undefined) {
        throw new Error("adapt_story is RPG-only; mode is no longer supported.");
      }
      const provider = new MockAuthorProvider();
      const contract = loadEngineContract();
      const story = await runWriter(provider, { premise: args.premise, contract });
      const result = await runRpgAdapter(provider, { story, contract });
      return {
        ok: result.ok,
        rounds: result.rounds,
        story: { title: story.title, beats: story.beats.map((b) => b.id) },
        classifications: result.classifications,
        ...(result.ok ? { content_hash: hashState(result.pack) } : {}),
        ...(args.include_pack === true && result.ok ? { pack: result.pack } : {}),
        report: result.report,
      };
    },

    replay_trace(args: { trace_path: string; world_quest_id?: string }) {
      const trace = readTraceJson(root, args.trace_path);
      assertTraceMode(trace);
      const source = rpgSources.resolveTraceSource(args, trace, "replay_trace");
      const { compiled } = source;
      if (trace.content_hash !== compiled.contentHash) {
        return {
          ok: false,
          message: `Trace was recorded against content ${trace.content_hash}, but the source is ${compiled.contentHash}.`,
        };
      }
      // §16 integrity at load: trace.initial_state came off an UNTRUSTED file (the
      // content-hash check above guards WHICH source, not WHETHER the state is well-
      // formed). Gate it the same way a loaded save is gated, BEFORE any engine call.
      assertWellFormedState(trace.initial_state);
      assertCampaignImportReceiptCatalogCompatibility(
        trace.initial_state,
        source.kind === "worldQuest" ? source.campaignImports : undefined,
      );
      const { index, rules } = rpgRuntime.runtimeFor(compiled.pack);
      assertRpgStateReferences(index, trace.initial_state);
      // Replay asserts the recorded final hash, and — for a Trace-v2 trace that
      // also carries `per_step_hashes` — localizes the FIRST divergent action via
      // `divergedAtStep` (returned straight through). A v1 trace (final hash only)
      // surfaces ok/final/expected as before.
      return replayTrace(trace, rules);
    },

    inspect_trace(args: InspectTraceArgs) {
      // Summarize a recorded trace and surface suspected bugs (§9.4). Replays the
      // actions through the engine for a per-step location/event summary, asserts
      // the recorded final hash, localizes the first divergent step when the trace
      // carries a Trace-v2 per-step baseline (§8.8), and runs the debugger's
      // classifier (§12.5).
      const trace = readTraceJson(root, args.trace_path);
      assertTraceMode(trace);
      const source = rpgSources.resolveTraceSource(args, trace, "inspect_trace");
      const { compiled } = source;
      if (trace.content_hash !== compiled.contentHash) {
        return {
          ok: false,
          message: `Trace content ${trace.content_hash} != source ${compiled.contentHash}.`,
        };
      }
      // §16 integrity at load: same untrusted-file gate as replay_trace — the state
      // is fed RAW into the per-step loop (let state = trace.initial_state) and into
      // diagnose() below, so it must be well-formed + referentially sound first.
      assertWellFormedState(trace.initial_state);
      assertCampaignImportReceiptCatalogCompatibility(
        trace.initial_state,
        source.kind === "worldQuest" ? source.campaignImports : undefined,
      );
      const { index, rules, step } = rpgRuntime.runtimeFor(compiled.pack);
      assertRpgStateReferences(index, trace.initial_state);
      let state = trace.initial_state;
      const steps: InspectTraceStepSummary[] = [];
      trace.actions.forEach((action, i) => {
        const r = step(state, action);
        state = r.state;
        steps.push({
          i,
          action,
          ok: r.ok,
          location: state.current,
          ended: state.ended,
          ending_id: state.endingId,
        });
      });
      const replay = replayTrace(trace, rules);
      // `diagnose` defaults to "any ending wins", so without this predicate a run that
      // ended on a DEATH ending is summarized as `no_failure` (low) and the debugger's
      // one high-severity ending verdict, `death_unrecoverable`, can never be reached
      // from this surface. The pack already knows: EndingSchema carries `death`. This
      // mirrors bin/inspect.ts, which is the same tool over the same traces; the two
      // disagreeing about whether a death run failed is worse than either answer.
      const d = diagnose(rules, trace.initial_state, trace.actions, {
        isWinningEnding: (endingId) =>
          index.pack.endings.find((e) => e.id === endingId)?.death !== true,
      });
      const compactSummary = args.compact_summary !== false;
      return {
        ok: true,
        world_quest_id: source.worldQuestId,
        ...(source.generateRpgSeed !== null ? { generated_rpg_seed: source.generateRpgSeed } : {}),
        content_hash: trace.content_hash,
        seed: trace.seed,
        steps: trace.actions.length,
        hash_ok: replay.ok,
        final_hash: replay.finalHash,
        expected_final_hash: replay.expectedFinalHash ?? null,
        // The first action whose post-state diverged from the trace's Trace-v2
        // per-step baseline (index into step_summary / actions), or null when the
        // trace is faithful or carries no per-step baseline (v1). This catches a
        // mid-trace divergence that a self-correcting final hash would miss.
        diverged_at_step: replay.divergedAtStep ?? null,
        diagnosis: d,
        ...(compactSummary ? { step_summary_v: INSPECT_TRACE_STEP_SUMMARY_VERSION } : {}),
        step_summary: compactSummary ? compactInspectTraceStepSummary(steps) : steps,
      };
    },

    apply_content_patch(args: ApplyContentPatchArgs) {
      // Apply a structured patch with deterministic code and return validation
      // proof; the full modified pack is an explicit debug echo. The model never
      // writes files: a patch is data, validated before it can be played (§16).
      // The fixer is RPG-only, matching the public catalog and runtime.
      //
      // `args.proposal` is untrusted MCP input — server.ts's wire-level schema
      // leaves each op's shape as an open record on purpose, so the closed op
      // vocabulary is enforced exactly once: here, by passing the proposal straight
      // through, UNPARSED, to applyContentPatch. That function already runs its own
      // `ContentPatchProposalSchema.safeParse` and returns a structured
      // `PATCH_INVALID` report on failure (agents/fixer.ts). A local, throwing
      // `.parse()` here used to run first and reject a malformed op with a bare
      // Zod exception before that branch ever saw it, which surfaced to the MCP
      // client as a raw error message instead of the promised report (bug_0628).
      // Do not reintroduce a pre-parse here.
      const requestedWorldQuestId = resolveWorldQuestSourceId(args, "apply_content_patch");
      const source = rpgSources.loadWorldQuestReport(requestedWorldQuestId);
      const loaded = source.result;
      if (!loaded.ok) {
        return {
          ok: false,
          world_quest_id: source.questId,
          report: loaded.report,
        };
      }
      // The patched pack is held to the quest's own load-path bar — import-aware
      // validation plus campaign catalog parity — not to plain validateRpg, which
      // cannot see flags a campaign import supplies and so failed even a zero-op patch
      // on Wolf-Winter (bug_0653).
      const result = applyContentPatch(loaded.compiled.pack, args.proposal, {
        validate: (pack) => rpgSources.validateWorldQuestPack(source.questId, pack),
      });
      if (!result.ok) {
        return {
          ok: false,
          world_quest_id: source.questId,
          report: result.report,
        };
      }
      return {
        ok: true,
        world_quest_id: source.questId,
        applied: result.applied,
        report: result.report,
        ...(args.include_pack === true ? { pack: result.pack } : {}),
      };
    },
  };
  return api;
}
