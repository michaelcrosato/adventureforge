import type { RpgAction } from "../api/types.js";
import { makeStep, type Rules } from "../core/engine.js";
import type { GameState } from "../core/state.js";
import {
  buildRpgObservation,
  type ObservationOptions,
  type RpgObservation,
} from "../rpg/observation.js";
import type { CompiledRpgSource } from "../rpg/source.js";
import type { RpgPack } from "../rpg/schema.js";
import { assertRpgStateReferences } from "../rpg/state_integrity.js";
import {
  buildRpgRules,
  enumerateRpgActions,
  enumerateRpgBlockedActions,
  indexRpgPack,
  initStateForRpgPack,
  type RpgIndex,
} from "../rpg/runner.js";
import {
  rpgObservationNeedsActions,
  rpgViewField,
  type RpgObservationViewOptions,
  type RpgViewField,
  type RpgViewOptions,
} from "./rpg_view_projection.js";
import { RPG_COMPACT_LEGEND, type RpgCompactLegend } from "./compact_rpg_observation.js";
import { publicRpgStateHash } from "./rpg_state_guards.js";
import { SessionStore, type RpgStep, type Session } from "./sessions.js";
import type { EmbeddedQuestCharacterContinuity } from "../rpg/embedded_quest_character_continuity.js";
import { assertEmbeddedLaunchOverlayWorldQuest } from "../core/embedded_launch_overlay_receipt.js";
import {
  embeddedQuestCharacterContinuityField,
  type EmbeddedQuestCharacterContinuityField,
} from "./embedded_quest_character_continuity_projection.js";

export type RpgRuntimeCacheEntry = {
  readonly index: RpgIndex;
  readonly rules: Rules<RpgAction>;
  readonly step: RpgStep;
};

export type RpgSourceFields = {
  world_quest_id?: string;
  generated_rpg_seed?: number;
};

/**
 * Field guide for every positional field this session can ship, sent on
 * session-creating responses only — never repeated per step.
 *
 * It rides unconditionally, including beside a verbose observation. `compact_events`
 * and `compact_observation` are per-call flags that both default to true, so the step
 * after a `compact_observation:false` start returns tagged event tuples AND a
 * positional `context`. Gating the only carrier on the creating call's own flag made
 * that whole session undecodable; the definitions cost ~1.5KB once.
 */
export type RpgSessionLegendField = { legend: RpgCompactLegend };

export function rpgSessionLegendField(): RpgSessionLegendField {
  return { legend: RPG_COMPACT_LEGEND };
}

/**
 * Everything a session payload carries EXCEPT the one-time legend. A resumed
 * embedded quest re-projects a session that was created earlier, so it must not
 * repeat definitions the launch response already sent.
 */
export type RpgSessionPayloadBody<Args extends RpgViewOptions = RpgViewOptions> = {
  session_id: string;
  state_hash: string;
} & RpgSourceFields &
  RpgViewField<Args> &
  EmbeddedQuestCharacterContinuityField<Args>;

export type RpgSessionPayload<Args extends RpgViewOptions = RpgViewOptions> =
  RpgSessionPayloadBody<Args> & RpgSessionLegendField;

type RpgOpeningViewOptions = RpgViewOptions & {
  include_world_intro?: boolean;
};

export type RpgSessionSource = {
  worldQuestId?: string | null;
  overworldSessionId?: string | null;
  generatedRpgSeed?: number | null;
  embeddedCharacterContinuity?: EmbeddedQuestCharacterContinuity | null;
};

export type RpgSessionStartOptions = RpgSessionSource & {
  hideGraph?: boolean;
  seed?: number;
  /** Replay trail of a restored embedded child; see `Session.embeddedActionIds`. */
  embeddedActionIds?: readonly string[];
};

export function rpgSourceFields(source: {
  worldQuestId?: string | null;
  generatedRpgSeed?: number | null;
}): RpgSourceFields {
  return {
    ...(source.worldQuestId ? { world_quest_id: source.worldQuestId } : {}),
    ...(source.generatedRpgSeed !== undefined && source.generatedRpgSeed !== null
      ? { generated_rpg_seed: source.generatedRpgSeed }
      : {}),
  };
}

export function rpgRoomTitle(index: RpgIndex, state: GameState): string {
  return index.rooms.get(state.current)?.name ?? state.current;
}

export function rpgStateTitle(index: RpgIndex, state: GameState): string {
  if (state.ended && state.endingId) {
    return (
      index.pack.endings.find((ending) => ending.id === state.endingId)?.title ?? state.endingId
    );
  }
  return rpgRoomTitle(index, state);
}

function rejectRuntimeGraphMutation(): never {
  throw new TypeError("RPG runtime graph indexes are immutable.");
}

function deepFreezeRuntimeGraph<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  const object = value as object;
  if (seen.has(object) || Object.isFrozen(object)) return value;
  seen.add(object);

  if (value instanceof Map) {
    for (const [key, child] of value.entries()) {
      deepFreezeRuntimeGraph(key, seen);
      deepFreezeRuntimeGraph(child, seen);
    }
    Object.defineProperties(value, {
      set: { value: rejectRuntimeGraphMutation, writable: false, configurable: false },
      delete: { value: rejectRuntimeGraphMutation, writable: false, configurable: false },
      clear: { value: rejectRuntimeGraphMutation, writable: false, configurable: false },
    });
    return Object.freeze(value);
  }

  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeRuntimeGraph(child, seen);
  }
  return Object.freeze(value);
}

function freezeRuntimeCacheEntry(entry: RpgRuntimeCacheEntry): RpgRuntimeCacheEntry {
  return deepFreezeRuntimeGraph(entry);
}

export class RpgMcpSessionRuntime {
  private readonly runtimeCache = new WeakMap<RpgPack, RpgRuntimeCacheEntry>();

  constructor(private readonly sessions: SessionStore) {}

  runtimeFor(pack: RpgPack): RpgRuntimeCacheEntry {
    const cached = this.runtimeCache.get(pack);
    if (cached) return cached;
    const index = indexRpgPack(pack);
    const rules = buildRpgRules(index);
    const entry = freezeRuntimeCacheEntry({ index, rules, step: makeStep(rules) });
    this.runtimeCache.set(pack, entry);
    return entry;
  }

  legalActionsFor(session: Session) {
    return this.sessions.legalActions(session.id, () =>
      enumerateRpgActions(session.index, session.state),
    );
  }

  blockedActionsFor(session: Session) {
    return enumerateRpgBlockedActions(session.index, session.state);
  }

  private buildObservation(session: Session, opts: ObservationOptions = {}): RpgObservation {
    const includeAvailableActions = opts.includeAvailableActions !== false;
    return buildRpgObservation(session.index, session.state, {
      ...opts,
      ...(includeAvailableActions ? { availableActions: this.legalActionsFor(session) } : {}),
    });
  }

  observationOf(
    session: Session,
    opts: ObservationOptions = {},
    cacheObservation = true,
  ): RpgObservation {
    if (!cacheObservation) return this.buildObservation(session, opts);
    return this.sessions.observation(session.id, opts, () => this.buildObservation(session, opts));
  }

  startSession(
    compiled: CompiledRpgSource,
    state?: GameState,
    opts: RpgSessionStartOptions = {},
  ): Session {
    const { index, rules, step } = this.runtimeFor(compiled.pack);
    const initialState = state ?? initStateForRpgPack(index, opts.seed ?? 1);
    if (state !== undefined) {
      assertRpgStateReferences(index, initialState);
      assertEmbeddedLaunchOverlayWorldQuest(initialState, opts.worldQuestId);
    }
    const session = this.sessions.create({
      contentHash: compiled.contentHash,
      ...(opts.worldQuestId ? { worldQuestId: opts.worldQuestId } : {}),
      ...(opts.overworldSessionId ? { overworldSessionId: opts.overworldSessionId } : {}),
      ...(opts.generatedRpgSeed !== undefined && opts.generatedRpgSeed !== null
        ? { generatedRpgSeed: opts.generatedRpgSeed }
        : {}),
      ...(opts.embeddedCharacterContinuity
        ? { embeddedCharacterContinuity: opts.embeddedCharacterContinuity }
        : {}),
      ...(opts.embeddedActionIds ? { embeddedActionIds: opts.embeddedActionIds } : {}),
      index,
      rules,
      step,
      state: initialState,
      transcript: [],
      ...(opts.hideGraph ? { hideGraph: true } : {}),
    });
    this.sessions.appendTranscript(session.id, {
      step: initialState.step,
      scene_id: initialState.current,
      title: rpgStateTitle(index, initialState),
      action_id: null,
      action_text: null,
      events: [],
      result_scene_id: initialState.current,
      ended: initialState.ended,
      ending_id: initialState.endingId,
    });
    return session;
  }

  openingObservationOptions(
    session: Session,
    opts: { includeWorldIntro?: boolean } = {},
  ): RpgObservationViewOptions {
    return {
      hideGraph: session.hideGraph ?? false,
      includeWorldIntro: opts.includeWorldIntro ?? true,
    };
  }

  openingObservationOf(
    session: Session,
    opts = this.openingObservationOptions(session),
    cacheObservation = true,
  ): RpgObservation {
    return this.observationOf(session, opts, cacheObservation);
  }

  startRpgSession<Args extends RpgOpeningViewOptions>(
    compiled: CompiledRpgSource,
    args: Args & { seed?: number; hide_graph?: boolean },
    source: RpgSessionSource,
    initialState?: GameState,
  ): RpgSessionPayload<Args> {
    const session = this.startSession(compiled, initialState, {
      seed: args.seed ?? 1,
      ...(args.hide_graph ? { hideGraph: true } : {}),
      ...(source.worldQuestId ? { worldQuestId: source.worldQuestId } : {}),
      ...(source.overworldSessionId ? { overworldSessionId: source.overworldSessionId } : {}),
      ...(source.generatedRpgSeed !== undefined && source.generatedRpgSeed !== null
        ? { generatedRpgSeed: source.generatedRpgSeed }
        : {}),
      ...(source.embeddedCharacterContinuity
        ? { embeddedCharacterContinuity: source.embeddedCharacterContinuity }
        : {}),
    });
    const openingOpts = this.openingObservationOptions(session, {
      includeWorldIntro: args.compact_observation !== true || args.include_world_intro === true,
    });
    openingOpts.includeAvailableActions = rpgObservationNeedsActions(args);
    return {
      session_id: session.id,
      // The legend rides only on session-creating responses, keeping every
      // subsequent per-step payload lean — but it rides on every one of them,
      // because the next default step is compact whatever this call asked for.
      ...rpgSessionLegendField(),
      ...rpgViewField(
        this.sessions,
        session,
        () => this.openingObservationOf(session, openingOpts, args.compact_observation !== true),
        args,
        openingOpts,
      ),
      ...rpgSourceFields(session),
      ...embeddedQuestCharacterContinuityField(session, args),
      state_hash: publicRpgStateHash(session.stateHash),
      // RpgViewField<Args> stays conditional on an unresolved generic here, so the
      // compiler cannot relate the literal to the payload type either way.
    } as unknown as RpgSessionPayload<Args>;
  }
}
