import type { GameState } from "../core/state.js";
import { cloneGameState } from "../core/state.js";
import { SAVE_MODE, save } from "../persist/save_load.js";
import {
  RPG_COMPACT_STATE_VERSION,
  cloneCompactRpgState,
  compactRpgState,
  type RpgCompactState,
} from "./compact_rpg_state.js";
import {
  blockedActionRowsFor,
  legalActionRowsFor,
  rpgObservationNeedsActions,
  rpgViewField,
  type RpgLegalActionRows,
  type RpgBlockedActionRows,
  type RpgLegalActionsArgs as RpgViewLegalActionsArgs,
  type RpgViewField,
  type RpgViewOptions,
} from "./rpg_view_projection.js";
import { rpgSourceFields, type RpgMcpSessionRuntime } from "./rpg_session_runtime.js";
import {
  embeddedQuestCharacterContinuityField,
  type EmbeddedQuestCharacterContinuityField,
} from "./embedded_quest_character_continuity_projection.js";
import {
  publicRpgStateHash,
  rpgStateHashMatches,
  rpgStateHashRejection,
  rpgStateUnchanged,
  type RpgStateHashRejection,
  type RpgStateUnchanged,
} from "./rpg_state_guards.js";
import type { Session, SessionStore, TranscriptSummary } from "./sessions.js";
import {
  TRANSCRIPT_SUMMARY_PROJECTION_COMPACT,
  cloneTranscriptSummary,
  compactTranscriptSummary,
  hashTranscript,
  publicRpgTranscriptHash,
  rpgTranscriptHashMatches,
  transcriptEventVersion,
  transcriptTurnsFor,
  transcriptTurnsOmitted,
  transcriptUnchanged,
  type TranscriptArgs,
  type TranscriptResponse,
} from "./transcript_projection.js";

type RpgGetObservationToolArgs = {
  session_id: string;
  hide_graph?: boolean;
  if_state_hash?: string;
  include_character_continuity?: boolean;
} & RpgViewOptions;

type RequestedCharacterContinuity<Args extends RpgGetObservationToolArgs> = Args extends {
  include_character_continuity: true;
}
  ? EmbeddedQuestCharacterContinuityField<Args>
  : Record<string, never>;

type RpgObservationToolPayload<Args extends RpgGetObservationToolArgs> = {
  state_hash: string;
} & RpgViewField<Args> &
  RequestedCharacterContinuity<Args>;

type RpgObservationToolResponse<Args extends RpgGetObservationToolArgs> = Args extends {
  include_character_continuity: true;
}
  ? RpgObservationToolPayload<Args>
  : Args extends { if_state_hash: string }
    ? RpgObservationToolPayload<Args> | RpgStateUnchanged
    : RpgObservationToolPayload<Args>;

type RpgLegalActionsToolArgs = {
  session_id: string;
  if_state_hash?: string;
} & RpgViewLegalActionsArgs;

type RpgLegalActionsToolPayload<Args extends RpgLegalActionsToolArgs> = {
  actions: RpgLegalActionRows<Args>;
  blocked_actions?: RpgBlockedActionRows<Args>;
  state_hash: string;
};

type RpgLegalActionsToolResponse<Args extends RpgLegalActionsToolArgs> = Args extends {
  if_state_hash: string;
}
  ? RpgLegalActionsToolPayload<Args> | RpgStateUnchanged
  : RpgLegalActionsToolPayload<Args>;

type RpgGetStateToolArgs = {
  session_id: string;
  include_state?: boolean;
  compact_state?: boolean;
  if_state_hash?: string;
};

type RpgStateHashToolPayload = {
  state_hash: string;
};

type RpgRawStateToolField = {
  state: GameState;
};

type RpgCompactStateToolField = {
  compact_state: RpgCompactState;
};

type RpgStateToolPayloadFor<Args extends RpgGetStateToolArgs> = Args extends {
  include_state: true;
}
  ? RpgStateHashToolPayload &
      RpgRawStateToolField &
      (Args extends { compact_state: true } ? RpgCompactStateToolField : Record<string, never>)
  : RpgStateHashToolPayload &
      (Args extends { compact_state: true } ? RpgCompactStateToolField : Record<string, never>);

type RpgStateToolResponse<Args extends RpgGetStateToolArgs> = Args extends {
  if_state_hash: string;
}
  ? RpgStateToolPayloadFor<Args> | RpgStateUnchanged
  : RpgStateToolPayloadFor<Args>;

type RpgSaveToolArgs = {
  session_id: string;
  expected_state_hash?: string;
  if_state_hash?: string;
  include_source?: boolean;
  include_content_hash?: boolean;
};

type RpgSaveSourceToolFields = {
  world_quest_id?: string;
  generated_rpg_seed?: number;
};

type RpgSaveContentHashToolField<Args extends RpgSaveToolArgs> = Args extends {
  include_content_hash: true;
}
  ? { content_hash: string }
  : Record<string, never>;

type RpgSaveToolSuccess<Args extends RpgSaveToolArgs> = {
  ok: true;
  save: string;
  state_hash: string;
} & RpgSaveContentHashToolField<Args> &
  (Args extends { include_source: true } ? RpgSaveSourceToolFields : Record<string, never>);

type RpgSaveToolRejected<Args extends RpgSaveToolArgs> = Args extends {
  expected_state_hash: string;
}
  ? RpgStateHashRejection
  : never;

type RpgSaveToolUnchanged<Args extends RpgSaveToolArgs> = Args extends {
  if_state_hash: string;
}
  ? RpgStateUnchanged
  : never;

type RpgSaveToolResponse<Args extends RpgSaveToolArgs> =
  | RpgSaveToolSuccess<Args>
  | RpgSaveToolRejected<Args>
  | RpgSaveToolUnchanged<Args>;

type RpgSessionToolDeps = {
  sessions: SessionStore;
  rpgRuntime: RpgMcpSessionRuntime;
};

function visibleTranscriptFlags(state: GameState): string[] {
  return Object.keys(state.flags)
    .filter((flag) => state.flags[flag] === true && !flag.startsWith("__"))
    .sort();
}

function fullTranscriptSummary(session: Session): TranscriptSummary {
  return {
    steps: session.transcriptStats.actionTurns,
    scenes: [...session.transcriptStats.scenes].sort(),
    ended: session.state.ended,
    ending_id: session.state.endingId,
    inventory: [...session.state.inventory],
    flags: visibleTranscriptFlags(session.state),
    journal: [...session.state.journal],
  };
}

function compactTranscriptSummaryForSession(session: Session) {
  return compactTranscriptSummary({
    steps: session.transcriptStats.actionTurns,
    scenes: [...session.transcriptStats.scenes].sort(),
    ended: session.state.ended,
    ending_id: session.state.endingId,
    inventory: session.state.inventory,
    flags: visibleTranscriptFlags(session.state),
    journal: session.state.journal,
  });
}

export function runRpgGetObservation<Args extends RpgGetObservationToolArgs>(
  deps: RpgSessionToolDeps,
  args: Args,
): RpgObservationToolResponse<Args> {
  const { sessions, rpgRuntime } = deps;
  const s = sessions.get(args.session_id);
  const stateHash = s.stateHash;
  if (
    args.include_character_continuity !== true &&
    args.if_state_hash !== undefined &&
    rpgStateHashMatches(args.if_state_hash, stateHash)
  ) {
    return rpgStateUnchanged(stateHash) as RpgObservationToolResponse<Args>;
  }
  const obsOpts = {
    hideGraph: args.hide_graph ?? s.hideGraph ?? false,
    includeAvailableActions: rpgObservationNeedsActions(args),
  };
  return {
    ...rpgViewField(
      sessions,
      s,
      () => rpgRuntime.observationOf(s, obsOpts, args.compact_observation !== true),
      args,
      obsOpts,
    ),
    ...(args.include_character_continuity === true
      ? embeddedQuestCharacterContinuityField(s, args)
      : {}),
    state_hash: publicRpgStateHash(stateHash),
  } as RpgObservationToolResponse<Args>;
}

export function runRpgListLegalActions<Args extends RpgLegalActionsToolArgs>(
  deps: RpgSessionToolDeps,
  args: Args,
): RpgLegalActionsToolResponse<Args> {
  const { sessions, rpgRuntime } = deps;
  const s = sessions.get(args.session_id);
  const stateHash = s.stateHash;
  if (args.if_state_hash !== undefined && rpgStateHashMatches(args.if_state_hash, stateHash)) {
    return rpgStateUnchanged(stateHash) as RpgLegalActionsToolResponse<Args>;
  }
  const actions = rpgRuntime.legalActionsFor(s);
  const blockedActions = rpgRuntime.blockedActionsFor(s);
  return {
    actions: legalActionRowsFor(sessions, s, actions, args),
    ...(blockedActions.length > 0
      ? { blocked_actions: blockedActionRowsFor(sessions, s, blockedActions, args) }
      : {}),
    state_hash: publicRpgStateHash(stateHash),
  } as RpgLegalActionsToolResponse<Args>;
}

export function runRpgGetState<Args extends RpgGetStateToolArgs>(
  deps: Pick<RpgSessionToolDeps, "sessions">,
  args: Args,
): RpgStateToolResponse<Args> {
  const s = deps.sessions.get(args.session_id);
  const stateHash = s.stateHash;
  if (args.if_state_hash !== undefined && rpgStateHashMatches(args.if_state_hash, stateHash)) {
    return rpgStateUnchanged(stateHash) as RpgStateToolResponse<Args>;
  }
  const response: RpgStateHashToolPayload &
    Partial<RpgRawStateToolField & RpgCompactStateToolField> = {
    state_hash: publicRpgStateHash(stateHash),
  };
  if (args.include_state === true) {
    response.state = cloneGameState(s.state);
  }
  if (args.compact_state === true) {
    response.compact_state = cloneCompactRpgState(
      deps.sessions.stateProjection(s.id, `compact-state:v${RPG_COMPACT_STATE_VERSION}`, () =>
        compactRpgState(s.state, {
          maxScore: s.index.pack.meta.max_score ?? 0,
        }),
      ),
    );
  }
  return response as RpgStateToolResponse<Args>;
}

export function runRpgGetTranscript<Args extends TranscriptArgs>(
  deps: Pick<RpgSessionToolDeps, "sessions">,
  args: Args,
): TranscriptResponse<Args> {
  const { sessions } = deps;
  const s = sessions.get(args.session_id);
  const stateHash = s.stateHash;
  const currentTranscriptHash = hashTranscript(s, stateHash);
  if (
    args.if_transcript_hash !== undefined &&
    rpgTranscriptHashMatches(args.if_transcript_hash, currentTranscriptHash)
  ) {
    return transcriptUnchanged(stateHash, currentTranscriptHash) as TranscriptResponse<Args>;
  }
  const summarySource =
    args.compact_summary === true
      ? sessions.transcriptSummaryProjection(s.id, TRANSCRIPT_SUMMARY_PROJECTION_COMPACT, () =>
          compactTranscriptSummaryForSession(s),
        )
      : sessions.transcriptSummary(s.id, () => fullTranscriptSummary(s));
  const summary = cloneTranscriptSummary(summarySource);
  const turnsOmitted = args.summary_only ? 0 : transcriptTurnsOmitted(s, args);
  const response = {
    ...(args.include_session_id === true ? { session_id: s.id } : {}),
    ...(args.include_source === true ? rpgSourceFields(s) : {}),
    state_hash: publicRpgStateHash(stateHash),
    transcript_hash: publicRpgTranscriptHash(currentTranscriptHash),
    ...transcriptEventVersion(args),
    ...(args.summary_only
      ? {}
      : {
          ...(turnsOmitted > 0 ? { turns_omitted: turnsOmitted } : {}),
          turns: transcriptTurnsFor(sessions, s, args),
        }),
    summary,
  };
  return response as unknown as TranscriptResponse<Args>;
}

export function runRpgSaveGame<Args extends RpgSaveToolArgs>(
  deps: Pick<RpgSessionToolDeps, "sessions">,
  args: Args,
): RpgSaveToolResponse<Args> {
  const s = deps.sessions.get(args.session_id);
  const stateHash = s.stateHash;
  if (
    args.expected_state_hash !== undefined &&
    !rpgStateHashMatches(args.expected_state_hash, stateHash)
  ) {
    return rpgStateHashRejection(stateHash) as RpgSaveToolResponse<Args>;
  }
  if (args.if_state_hash !== undefined && rpgStateHashMatches(args.if_state_hash, stateHash)) {
    return rpgStateUnchanged(stateHash) as RpgSaveToolResponse<Args>;
  }
  const saveMetadata = {
    ...(s.worldQuestId ? { worldQuestId: s.worldQuestId } : {}),
    ...(s.generatedRpgSeed !== undefined ? { generatedRpgSeed: s.generatedRpgSeed } : {}),
    ...(s.embeddedCharacterContinuity
      ? { embeddedCharacterContinuity: s.embeddedCharacterContinuity }
      : {}),
  };
  return {
    ok: true,
    save: save(s.state, s.contentHash, SAVE_MODE, saveMetadata),
    ...(args.include_source === true ? rpgSourceFields(s) : {}),
    ...(args.include_content_hash === true ? { content_hash: s.contentHash } : {}),
    state_hash: publicRpgStateHash(stateHash),
  } as RpgSaveToolResponse<Args>;
}
