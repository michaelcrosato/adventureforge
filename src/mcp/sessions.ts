/**
 * In-memory session store for the MCP server.
 *
 * A session binds a compiled pack (its index + rule set + content hash) to a live
 * GameState. The engine stays pure; the session just holds the latest state so an
 * agent can play across multiple tool calls. Session ids are a deterministic
 * counter (no clock/RNG), which keeps handler tests reproducible.
 */
import type { GameState } from "../core/state.js";
import { cloneGameState } from "../core/state.js";
import type { Rules } from "../core/engine.js";
import type { GameEvent } from "../core/events.js";
import type { RpgAction, StepResult } from "../api/types.js";
import type { RpgActionOption } from "../rpg/legal_actions.js";
import type { ObservationOptions, RpgObservation } from "../rpg/observation.js";
import type { RpgIndex } from "../rpg/runner.js";
import {
  cloneEmbeddedQuestCharacterContinuity,
  type EmbeddedQuestCharacterContinuity,
} from "../rpg/embedded_quest_character_continuity.js";
import { hashState } from "../core/hash.js";
import { generatedRpgSeedValidationMessage, isGeneratedRpgSeed } from "../gen/seed.js";
import { cloneMcpEvent } from "./event_clone.js";
import {
  cachedSessionProjection,
  invalidateSessionStateCaches,
  invalidateSessionTranscriptCaches,
  type SessionRuntimeCaches,
  type StateProjectionCacheEntry,
  type StateTranscriptProjectionCacheEntry,
  type TranscriptProjectionCacheEntry,
} from "./session_cache.js";
import {
  compactMcpActionLabel,
  compactMcpTranscriptActionId,
  compactMcpTranscriptSceneId,
  compactMcpTranscriptSummaryValue,
  compactMcpTranscriptTitle,
} from "./action_labels.js";
import { compactMcpVisibleJournalProse } from "./journal_prose.js";

export type TranscriptTurn = {
  step: number;
  scene_id: string;
  title: string;
  action_id: string | null;
  action_text: string | null;
  events: GameEvent[];
  result_scene_id: string;
  ended: boolean;
  ending_id: string | null;
};

export type TranscriptSummary = {
  steps: number;
  scenes: string[];
  ended: boolean;
  ending_id: string | null;
  inventory: string[];
  flags: string[];
  journal: string[];
};

export type RpgStep = (state: GameState, action: RpgAction) => StepResult;

export const MCP_SESSION_STORE_LIMIT = 64;
const MCP_SESSION_TRANSCRIPT_TURN_LIMIT = 128;

export type TranscriptStats = {
  readonly turns: number;
  readonly actionTurns: number;
  readonly scenes: readonly string[];
};

type MutableTranscriptStats = {
  turns: number;
  actionTurns: number;
  scenes: string[];
};

function assertSessionStoreLimit(maxSessions: number): number {
  if (!Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new Error("MCP session store limit must be a positive integer.");
  }
  return maxSessions;
}

function assertTranscriptTurnLimit(maxTurns: number): number {
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error("MCP session transcript turn limit must be a positive integer.");
  }
  return maxTurns;
}

function assertOptionalNonEmptyString(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
    throw new Error(`${label} must be a non-empty string when present.`);
  }
}

function assertSessionSourceIdentity(init: SessionInit): void {
  assertOptionalNonEmptyString(init.worldQuestId, "MCP session worldQuestId");
  assertOptionalNonEmptyString(init.overworldSessionId, "MCP session overworldSessionId");
  if (init.generatedRpgSeed !== undefined && !isGeneratedRpgSeed(init.generatedRpgSeed)) {
    throw new Error(
      generatedRpgSeedValidationMessage("MCP session generatedRpgSeed", init.generatedRpgSeed),
    );
  }
  if (init.generatedRpgSeed !== undefined && init.worldQuestId !== undefined) {
    throw new Error("MCP session source cannot carry both worldQuestId and generatedRpgSeed.");
  }
  if (init.overworldSessionId !== undefined && init.worldQuestId === undefined) {
    throw new Error("MCP session overworldSessionId requires worldQuestId.");
  }
  if (init.worldQuestId === undefined && init.generatedRpgSeed === undefined) {
    throw new Error("MCP session source requires worldQuestId or generatedRpgSeed.");
  }
}

function refreshSessionEntry<Key, Entry>(sessions: Map<Key, Entry>, key: Key): Entry | undefined {
  const session = sessions.get(key);
  if (session === undefined) return undefined;
  sessions.delete(key);
  sessions.set(key, session);
  return session;
}

function rememberSessionEntry<Key, Entry>(
  sessions: Map<Key, Entry>,
  key: Key,
  entry: Entry,
  maxEntries: number,
): void {
  sessions.delete(key);
  sessions.set(key, entry);
  while (sessions.size > maxEntries) {
    const oldest = sessions.keys().next();
    if (oldest.done) break;
    sessions.delete(oldest.value);
  }
}

function emptyTranscriptStats(): MutableTranscriptStats {
  return {
    turns: 0,
    actionTurns: 0,
    scenes: [],
  };
}

function recordTranscriptTurn(stats: MutableTranscriptStats, turn: TranscriptTurn): void {
  stats.turns += 1;
  if (turn.action_id !== null) stats.actionTurns += 1;
  for (const scene of [turn.scene_id, turn.result_scene_id]) {
    if (!stats.scenes.includes(scene)) stats.scenes.push(scene);
  }
}

function freezeTranscriptStats(stats: MutableTranscriptStats): TranscriptStats {
  return Object.freeze({
    turns: stats.turns,
    actionTurns: stats.actionTurns,
    scenes: Object.freeze([...stats.scenes]),
  });
}

function transcriptStatsFor(transcript: readonly TranscriptTurn[]): TranscriptStats {
  const stats = emptyTranscriptStats();
  for (const turn of transcript) recordTranscriptTurn(stats, turn);
  return freezeTranscriptStats(stats);
}

function transcriptStatsWithTurn(stats: TranscriptStats, turn: TranscriptTurn): TranscriptStats {
  const nextStats = {
    turns: stats.turns,
    actionTurns: stats.actionTurns,
    scenes: [...stats.scenes],
  };
  recordTranscriptTurn(nextStats, turn);
  return freezeTranscriptStats(nextStats);
}

function rejectSessionCacheMutation(): never {
  throw new TypeError("MCP session cache values are immutable.");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  const object = value as object;
  if (seen.has(object) || Object.isFrozen(object)) return value;
  seen.add(object);

  if (value instanceof Map) {
    for (const [key, child] of value.entries()) {
      deepFreeze(key, seen);
      deepFreeze(child, seen);
    }
    Object.defineProperties(value, {
      set: { value: rejectSessionCacheMutation, writable: false, configurable: false },
      delete: { value: rejectSessionCacheMutation, writable: false, configurable: false },
      clear: { value: rejectSessionCacheMutation, writable: false, configurable: false },
    });
    return Object.freeze(value);
  }

  if (value instanceof Set) {
    for (const child of value.values()) deepFreeze(child, seen);
    Object.defineProperties(value, {
      add: { value: rejectSessionCacheMutation, writable: false, configurable: false },
      delete: { value: rejectSessionCacheMutation, writable: false, configurable: false },
      clear: { value: rejectSessionCacheMutation, writable: false, configurable: false },
    });
    return Object.freeze(value);
  }

  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function cloneFrozenGameState(state: GameState): GameState {
  return deepFreeze(cloneGameState(state));
}

const SESSION_IMMUTABLE_FIELDS = [
  "id",
  "contentHash",
  "worldQuestId",
  "overworldSessionId",
  "embeddedCharacterContinuity",
  "generatedRpgSeed",
  "index",
  "rules",
  "step",
  "hideGraph",
] as const satisfies readonly (keyof Session)[];

function lockSessionMetadata(session: Session): Session {
  for (const field of SESSION_IMMUTABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(session, field)) continue;
    Object.defineProperty(session, field, {
      configurable: false,
      writable: false,
    });
  }
  return session;
}

function transcriptLogHashFor(transcript: readonly TranscriptTurn[]): string {
  return transcript.reduce((previous, turn) => hashState({ previous, turn }), hashState([]));
}

function cloneTranscriptTurn(turn: TranscriptTurn): TranscriptTurn {
  return {
    ...turn,
    scene_id: compactMcpTranscriptSceneId(turn.scene_id),
    title: compactMcpTranscriptTitle(turn.title),
    action_id: turn.action_id === null ? null : compactMcpTranscriptActionId(turn.action_id),
    action_text: turn.action_text === null ? null : compactMcpActionLabel(turn.action_text),
    result_scene_id: compactMcpTranscriptSceneId(turn.result_scene_id),
    events: turn.events.map((event) => cloneMcpEvent(event) as GameEvent),
  };
}

function cloneTranscriptRows(transcript: readonly TranscriptTurn[]): TranscriptTurn[] {
  return transcript.map(cloneTranscriptTurn);
}

function compactSummaryList(
  values: string[],
  compact: (value: string) => string,
): { values: string[]; changed: boolean } {
  let changed = false;
  const compacted = values.map((value) => {
    const next = compact(value);
    if (next !== value) changed = true;
    return next;
  });
  return { values: compacted, changed };
}

function normalizeTranscriptSummary(summary: TranscriptSummary): TranscriptSummary {
  const endingId =
    summary.ending_id === null ? null : compactMcpTranscriptSummaryValue(summary.ending_id);
  const scenes = compactSummaryList(summary.scenes, compactMcpTranscriptSceneId);
  const inventory = compactSummaryList(summary.inventory, compactMcpTranscriptSummaryValue);
  const flags = compactSummaryList(summary.flags, compactMcpTranscriptSummaryValue);
  const journal = compactSummaryList(summary.journal, compactMcpVisibleJournalProse);
  if (
    endingId === summary.ending_id &&
    !scenes.changed &&
    !inventory.changed &&
    !flags.changed &&
    !journal.changed
  ) {
    return summary;
  }
  return {
    ...summary,
    ending_id: endingId,
    scenes: scenes.values,
    inventory: inventory.values,
    flags: flags.values,
    journal: journal.values,
  };
}

function freezeTranscriptRows(transcript: readonly TranscriptTurn[]): readonly TranscriptTurn[] {
  return deepFreeze(cloneTranscriptRows(transcript));
}

function retainedTranscript(
  transcript: readonly TranscriptTurn[],
  maxTurns: number,
): readonly TranscriptTurn[] {
  const retained =
    transcript.length > maxTurns ? transcript.slice(transcript.length - maxTurns) : transcript;
  return freezeTranscriptRows(retained);
}

export type Session = SessionRuntimeCaches<TranscriptSummary> & {
  id: string;
  contentHash: string;
  /** Shipped quest id (from the New York overworld quest registry) for quest sessions. */
  worldQuestId?: string;
  /** Overworld session that launched this RPG quest, when started through the bridge. */
  overworldSessionId?: string;
  /** Player-facing continuity metadata for a quest launched from a campaign parent. */
  embeddedCharacterContinuity?: EmbeddedQuestCharacterContinuity;
  /**
   * Every accepted action id since launch, kept for an embedded child only. It is the
   * replay trail `export_overworld_session` persists so a restore can PROVE the child's
   * state was reached from its launch (bug_0654) — the same proof the terminal journey
   * and browser UI require. The transcript cannot serve: it is capped at
   * MCP_SESSION_TRANSCRIPT_TURN_LIMIT turns and stores compacted action ids.
   */
  embeddedActionIds?: readonly string[];
  /** Procedural RPG generation seed for in-memory generated sessions. */
  generatedRpgSeed?: number;
  /** The compiled RPG index for this session. */
  index: RpgIndex;
  rules: Rules<RpgAction>;
  step: RpgStep;
  state: GameState;
  stateHash: string;
  transcript: readonly TranscriptTurn[];
  transcriptLogHash: string;
  transcriptStats: TranscriptStats;
  /** Difficulty: when true, the agent-facing observation hides each exit's
   *  destination (`exit.to`) so the spatial graph must be reasoned out, not read
   *  off. Default false — full graph, the legacy behavior. */
  hideGraph?: boolean;
};

export type SessionInit = Omit<
  Session,
  | "id"
  | "stateHash"
  | "legalActionsCache"
  | "legalActionProjectionCaches"
  | "stateProjectionCaches"
  | "observationCache"
  | "observationProjectionCaches"
  | "transcriptLogHash"
  | "transcriptStats"
  | "transcriptSummaryCache"
  | "transcriptSummaryProjectionCaches"
  | "transcriptProjectionCaches"
>;

type ObservationCacheOptions = Pick<
  ObservationOptions,
  "hideGraph" | "includeWorldIntro" | "includeAvailableActions"
>;

export class SessionStore {
  private counter = 0n;
  private readonly sessions = new Map<string, Session>();
  private readonly embeddedJourneyPauses = new Map<string, string>();

  constructor(
    private readonly maxSessions = MCP_SESSION_STORE_LIMIT,
    private readonly maxTranscriptTurns = MCP_SESSION_TRANSCRIPT_TURN_LIMIT,
  ) {
    assertSessionStoreLimit(maxSessions);
    assertTranscriptTurnLimit(maxTranscriptTurns);
  }

  create(init: SessionInit): Session {
    assertSessionSourceIdentity(init);
    const id = `r${++this.counter}`;
    const state = cloneFrozenGameState(init.state);
    const transcript = cloneTranscriptRows(init.transcript);
    const { embeddedActionIds, ...rest } = init;
    const session: Session = {
      ...rest,
      ...(init.embeddedCharacterContinuity
        ? {
            embeddedCharacterContinuity: deepFreeze(
              cloneEmbeddedQuestCharacterContinuity(init.embeddedCharacterContinuity),
            ),
          }
        : {}),
      // Only a child bound to a parent keeps a trail; a standalone session has nothing
      // to be restored beside.
      ...(init.overworldSessionId !== undefined
        ? { embeddedActionIds: deepFreeze([...(embeddedActionIds ?? [])]) }
        : {}),
      id,
      state,
      stateHash: hashState(state),
      transcript: retainedTranscript(transcript, this.maxTranscriptTurns),
      transcriptLogHash: transcriptLogHashFor(transcript),
      transcriptStats: transcriptStatsFor(transcript),
    };
    rememberSessionEntry(this.sessions, id, lockSessionMetadata(session), this.maxSessions);
    return session;
  }

  get(id: string): Session {
    const session = refreshSessionEntry(this.sessions, id);
    if (!session) {
      throw new Error(
        `RPG session "${id}" was not found. Pass the child session_id returned by the RPG start, or its embedded rpg_session_id. Do not pass an overworld session id. (Sessions live in server memory and only the most recent are retained, so a long-idle handle may have been evicted — save_game before setting a session aside.)`,
      );
    }
    return session;
  }

  /** Remember the exact embedded quest whose accepted decision opened a parent journey pause. */
  markEmbeddedJourneyPause(id: string): Session {
    const session = this.get(id);
    if (!session.overworldSessionId) {
      throw new Error("Only an RPG session launched from the overworld can pause its journey.");
    }
    this.embeddedJourneyPauses.set(session.overworldSessionId, session.id);
    return session;
  }

  /** Return the exact embedded quest interrupted by this overworld journey pause, if retained. */
  embeddedJourneyPause(overworldSessionId: string): Session | null {
    const id = this.embeddedJourneyPauses.get(overworldSessionId);
    if (!id) return null;
    const session = refreshSessionEntry(this.sessions, id);
    if (!session || session.overworldSessionId !== overworldSessionId) {
      this.embeddedJourneyPauses.delete(overworldSessionId);
      return null;
    }
    return session;
  }

  clearEmbeddedJourneyPause(overworldSessionId: string): void {
    this.embeddedJourneyPauses.delete(overworldSessionId);
  }

  /** Append one accepted action to an embedded child's replay trail. */
  recordEmbeddedAction(id: string, actionId: string): Session {
    const session = this.get(id);
    if (!session.overworldSessionId || !session.embeddedActionIds) {
      throw new Error("Only an RPG session launched from the overworld keeps a replay trail.");
    }
    session.embeddedActionIds = deepFreeze([...session.embeddedActionIds, actionId]);
    return session;
  }

  /**
   * The retained child a parent launched for `worldQuestId`, if it is still in memory.
   * The most recently created match wins; a parent has at most one unfinished quest.
   */
  embeddedChildFor(overworldSessionId: string, worldQuestId: string): Session | null {
    let found: Session | null = null;
    for (const session of this.sessions.values()) {
      if (
        session.overworldSessionId === overworldSessionId &&
        session.worldQuestId === worldQuestId &&
        (found === null || BigInt(session.id.slice(1)) > BigInt(found.id.slice(1)))
      ) {
        found = session;
      }
    }
    return found;
  }

  update(id: string, state: GameState): Session {
    const session = this.get(id);
    const nextState = cloneFrozenGameState(state);
    const stateHash = hashState(nextState);
    session.state = nextState;
    if (stateHash === session.stateHash) {
      return session;
    }
    session.stateHash = stateHash;
    invalidateSessionStateCaches(session);
    return session;
  }

  legalActions(id: string, enumerate: () => RpgActionOption[]): RpgActionOption[] {
    const session = this.get(id);
    if (session.legalActionsCache?.stateHash === session.stateHash) {
      return session.legalActionsCache.actions;
    }
    const actions = deepFreeze(enumerate());
    session.legalActionsCache = {
      stateHash: session.stateHash,
      actions,
    };
    return actions;
  }

  legalActionProjection<T>(id: string, key: string, build: () => T): T {
    const session = this.get(id);
    const cached = cachedSessionProjection<T, StateProjectionCacheEntry>(
      session.legalActionProjectionCaches,
      key,
      (entry) => entry.stateHash === session.stateHash,
      (projection) => ({
        stateHash: session.stateHash,
        projection,
      }),
      () => deepFreeze(build()),
    );
    session.legalActionProjectionCaches = cached.cacheMap;
    return cached.value;
  }

  stateProjection<T>(id: string, key: string, build: () => T): T {
    const session = this.get(id);
    const cached = cachedSessionProjection<T, StateProjectionCacheEntry>(
      session.stateProjectionCaches,
      key,
      (entry) => entry.stateHash === session.stateHash,
      (projection) => ({
        stateHash: session.stateHash,
        projection,
      }),
      () => deepFreeze(build()),
    );
    session.stateProjectionCaches = cached.cacheMap;
    return cached.value;
  }

  observation(
    id: string,
    opts: ObservationCacheOptions,
    build: () => RpgObservation,
  ): RpgObservation {
    const session = this.get(id);
    const hideGraph = opts.hideGraph === true;
    const includeWorldIntro = opts.includeWorldIntro === true;
    const includeAvailableActions = opts.includeAvailableActions !== false;
    if (
      session.observationCache?.stateHash === session.stateHash &&
      session.observationCache.hideGraph === hideGraph &&
      session.observationCache.includeWorldIntro === includeWorldIntro &&
      session.observationCache.includeAvailableActions === includeAvailableActions
    ) {
      return session.observationCache.observation;
    }
    const observation = deepFreeze(build());
    session.observationCache = {
      stateHash: session.stateHash,
      hideGraph,
      includeWorldIntro,
      includeAvailableActions,
      observation,
    };
    return observation;
  }

  observationProjection<T>(id: string, key: string, build: () => T): T {
    const session = this.get(id);
    const cached = cachedSessionProjection<T, StateProjectionCacheEntry>(
      session.observationProjectionCaches,
      key,
      (entry) => entry.stateHash === session.stateHash,
      (projection) => ({
        stateHash: session.stateHash,
        projection,
      }),
      () => deepFreeze(build()),
    );
    session.observationProjectionCaches = cached.cacheMap;
    return cached.value;
  }

  transcriptSummary(id: string, build: () => TranscriptSummary): TranscriptSummary {
    const session = this.get(id);
    if (
      session.transcriptSummaryCache?.stateHash === session.stateHash &&
      session.transcriptSummaryCache.transcriptLogHash === session.transcriptLogHash
    ) {
      return session.transcriptSummaryCache.summary;
    }
    const summary = deepFreeze(normalizeTranscriptSummary(build()));
    session.transcriptSummaryCache = {
      stateHash: session.stateHash,
      transcriptLogHash: session.transcriptLogHash,
      summary,
    };
    return summary;
  }

  transcriptSummaryProjection<T>(id: string, key: string, build: () => T): T {
    const session = this.get(id);
    const cached = cachedSessionProjection<T, StateTranscriptProjectionCacheEntry>(
      session.transcriptSummaryProjectionCaches,
      key,
      (entry) =>
        entry.stateHash === session.stateHash &&
        entry.transcriptLogHash === session.transcriptLogHash,
      (projection) => ({
        stateHash: session.stateHash,
        transcriptLogHash: session.transcriptLogHash,
        projection,
      }),
      () => deepFreeze(build()),
    );
    session.transcriptSummaryProjectionCaches = cached.cacheMap;
    return cached.value;
  }

  transcriptProjection<T>(id: string, key: string, build: () => T): T {
    const session = this.get(id);
    const cached = cachedSessionProjection<T, TranscriptProjectionCacheEntry>(
      session.transcriptProjectionCaches,
      key,
      (entry) => entry.transcriptLogHash === session.transcriptLogHash,
      (projection) => ({
        transcriptLogHash: session.transcriptLogHash,
        projection,
      }),
      () => deepFreeze(build()),
    );
    session.transcriptProjectionCaches = cached.cacheMap;
    return cached.value;
  }

  appendTranscript(id: string, turn: TranscriptTurn): Session {
    const session = this.get(id);
    const storedTurn = cloneTranscriptTurn(turn);
    session.transcriptStats = transcriptStatsWithTurn(session.transcriptStats, storedTurn);
    session.transcript = retainedTranscript(
      [...session.transcript, storedTurn],
      this.maxTranscriptTurns,
    );
    session.transcriptLogHash = hashState({
      previous: session.transcriptLogHash,
      turn: storedTurn,
    });
    invalidateSessionTranscriptCaches(session);
    return session;
  }

  replaceTranscript(id: string, transcript: TranscriptTurn[]): Session {
    const session = this.get(id);
    const storedTranscript = cloneTranscriptRows(transcript);
    session.transcript = retainedTranscript(storedTranscript, this.maxTranscriptTurns);
    session.transcriptLogHash = transcriptLogHashFor(storedTranscript);
    session.transcriptStats = transcriptStatsFor(storedTranscript);
    invalidateSessionTranscriptCaches(session);
    return session;
  }
}
