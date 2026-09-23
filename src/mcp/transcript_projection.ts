import { hashState } from "../core/hash.js";
import type { GameEvent } from "../core/events.js";
import { SessionStore, type Session, type TranscriptSummary } from "./sessions.js";
import {
  compactPlayerEvent,
  RPG_COMPACT_EVENT_VERSION,
  type RpgCompactEvent,
} from "./compact_rpg_event.js";
import { cloneMcpEvent } from "./event_clone.js";
import {
  compactHead,
  compactRecent,
  compactTrailingOmissionCounts,
  omittedCount,
} from "./compact_truncation.js";
import { compactMcpTranscriptSceneId, compactMcpTranscriptSummaryValue } from "./action_labels.js";
import { compactMcpVisibleJournalProse } from "./journal_prose.js";
import { publicRpgStateHash } from "./rpg_state_guards.js";

export type RpgEventOptions = {
  compact_events?: boolean;
  include_event_version?: boolean;
};

export type RpgStepEvents<Args extends RpgEventOptions> = Args extends { compact_events: true }
  ? RpgCompactEvent[]
  : ReturnType<typeof playerVisibleEvents>;

export type RpgStepEventVersion<Args extends RpgEventOptions> = Args extends {
  compact_events: true;
  include_event_version: true;
}
  ? { event_v: typeof RPG_COMPACT_EVENT_VERSION }
  : Record<string, never>;

export type TranscriptArgs = {
  session_id: string;
  include_session_id?: boolean;
  include_source?: boolean;
  summary_only?: boolean;
  compact_turns?: boolean;
  compact_events?: boolean;
  include_event_version?: boolean;
  compact_summary?: boolean;
  if_transcript_hash?: string;
  turn_limit?: number;
};

type TranscriptFullTurn = Session["transcript"][number];
type TranscriptCompactEventTurn = Omit<TranscriptFullTurn, "events"> & {
  events: RpgCompactEvent[];
};
type TranscriptCompactTurn = readonly [
  step: number,
  scene_id: string,
  action_id: string | null,
  result_scene_id: string,
];
type TranscriptCompactMore = readonly [
  scenes: number,
  inventory?: number,
  flags?: number,
  journal?: number,
];
type TranscriptCompactSummary = Omit<
  TranscriptSummary,
  "ending_id" | "inventory" | "flags" | "journal"
> & {
  ending_id?: string;
  inventory?: string[];
  flags?: string[];
  journal?: string[];
  more?: TranscriptCompactMore;
};
type TranscriptSummarySource = Omit<
  TranscriptSummary,
  "scenes" | "inventory" | "flags" | "journal"
> & {
  scenes: readonly string[];
  inventory: readonly string[];
  flags: readonly string[];
  journal: readonly string[];
};
type TranscriptSummaryFor<Args extends TranscriptArgs> = Args extends { compact_summary: true }
  ? TranscriptCompactSummary
  : TranscriptSummary;
type TranscriptSessionIdField<Args extends Pick<TranscriptArgs, "include_session_id">> =
  Args extends {
    include_session_id: true;
  }
    ? { session_id: string }
    : Record<string, never>;
type TranscriptPayloadBase<Args extends TranscriptArgs> = TranscriptSessionIdField<Args> & {
  state_hash: string;
  transcript_hash: string;
  summary: TranscriptSummaryFor<Args>;
  turns_omitted?: number;
} & (Args extends { include_source: true }
    ? {
        world_quest_id?: string;
        generated_rpg_seed?: number;
      }
    : Record<string, never>);
type TranscriptTurnFor<Args extends TranscriptArgs> = Args extends { compact_turns: true }
  ? TranscriptCompactTurn
  : Args extends { compact_events: true }
    ? TranscriptCompactEventTurn
    : TranscriptFullTurn;
type TranscriptEventVersion<Args extends TranscriptArgs> = Args extends { summary_only: true }
  ? Record<string, never>
  : Args extends { compact_turns: true }
    ? Record<string, never>
    : Args extends { compact_events: true; include_event_version: true }
      ? { event_v: typeof RPG_COMPACT_EVENT_VERSION }
      : Record<string, never>;
export type TranscriptPayload<Args extends TranscriptArgs> = TranscriptPayloadBase<Args> &
  TranscriptEventVersion<Args> &
  (Args extends { summary_only: true }
    ? Record<string, never>
    : { turns: TranscriptTurnFor<Args>[] });
export type TranscriptUnchanged = {
  state_hash: string;
  transcript_hash: string;
  unchanged: true;
};
export type TranscriptResponse<Args extends TranscriptArgs> = Args extends {
  if_transcript_hash: string;
}
  ? TranscriptPayload<Args> | TranscriptUnchanged
  : TranscriptPayload<Args>;

const TRANSCRIPT_PROJECTION_COMPACT_TURNS = "compact-turns:v1";
const TRANSCRIPT_PROJECTION_VISIBLE_EVENTS = "visible-events:v1";
const TRANSCRIPT_PROJECTION_COMPACT_EVENTS = `compact-events:v${RPG_COMPACT_EVENT_VERSION}`;
export const TRANSCRIPT_SUMMARY_PROJECTION_COMPACT = "compact-summary:v2";
const TRANSCRIPT_SUMMARY_LIST_LIMIT = 16;
const TRANSCRIPT_SUMMARY_JOURNAL_LIMIT = 5;
export const TRANSCRIPT_TURN_LIMIT_DEFAULT = 64;
export const RPG_PUBLIC_TRANSCRIPT_HASH_LENGTH = 24;

export function publicRpgTranscriptHash(transcriptHash: string): string {
  return transcriptHash.slice(0, RPG_PUBLIC_TRANSCRIPT_HASH_LENGTH);
}

export function rpgTranscriptHashMatches(expectedTranscriptHash: string, transcriptHash: string) {
  return (
    expectedTranscriptHash === transcriptHash ||
    expectedTranscriptHash === publicRpgTranscriptHash(transcriptHash)
  );
}

export function transcriptUnchanged(
  stateHash: string,
  transcriptHash: string,
): TranscriptUnchanged {
  return {
    state_hash: publicRpgStateHash(stateHash),
    transcript_hash: publicRpgTranscriptHash(transcriptHash),
    unchanged: true,
  };
}

export function hashTranscript(session: Session, stateHash: string): string {
  return hashState({
    state_hash: stateHash,
    transcript_log_hash: session.transcriptLogHash,
  });
}

export function compactTranscriptSummary(
  summary: TranscriptSummarySource,
): TranscriptCompactSummary {
  const scenes = compactHead(summary.scenes, TRANSCRIPT_SUMMARY_LIST_LIMIT).map(
    compactMcpTranscriptSceneId,
  );
  const inventory = compactHead(summary.inventory, TRANSCRIPT_SUMMARY_LIST_LIMIT).map(
    compactMcpTranscriptSummaryValue,
  );
  const flags = compactHead(summary.flags, TRANSCRIPT_SUMMARY_LIST_LIMIT).map(
    compactMcpTranscriptSummaryValue,
  );
  const journal = compactRecent(summary.journal, TRANSCRIPT_SUMMARY_JOURNAL_LIMIT).map(
    compactMcpVisibleJournalProse,
  );
  const omittedScenes = omittedCount(summary.scenes, scenes);
  const omittedInventory = omittedCount(summary.inventory, inventory);
  const omittedFlags = omittedCount(summary.flags, flags);
  const omittedJournal = omittedCount(summary.journal, journal);
  const more = compactTrailingOmissionCounts([
    omittedScenes ?? 0,
    omittedInventory ?? 0,
    omittedFlags ?? 0,
    omittedJournal ?? 0,
  ]) as TranscriptCompactMore | undefined;
  const {
    ending_id: endingId,
    inventory: _fullInventory,
    flags: _fullFlags,
    journal: _fullJournal,
    ...baseSummary
  } = summary;
  return {
    ...baseSummary,
    ...(endingId ? { ending_id: compactMcpTranscriptSummaryValue(endingId) } : {}),
    scenes,
    ...(inventory.length > 0 ? { inventory } : {}),
    ...(flags.length > 0 ? { flags } : {}),
    ...(journal.length > 0 ? { journal } : {}),
    ...(more ? { more } : {}),
  };
}

type PublicTranscriptSummary = TranscriptSummary | TranscriptCompactSummary;

export function cloneTranscriptSummary<Summary extends PublicTranscriptSummary>(
  summary: Summary,
): Summary {
  const source = summary as PublicTranscriptSummary;
  return {
    ...source,
    scenes: [...source.scenes],
    ...("inventory" in source && source.inventory !== undefined
      ? { inventory: [...source.inventory] }
      : {}),
    ...("flags" in source && source.flags !== undefined ? { flags: [...source.flags] } : {}),
    ...("journal" in source && source.journal !== undefined
      ? { journal: [...source.journal] }
      : {}),
    ...("more" in source && source.more !== undefined ? { more: [...source.more] } : {}),
  } as Summary;
}

function transcriptTurnLimit(args: Pick<TranscriptArgs, "turn_limit">, total: number): number {
  if (args.turn_limit === undefined) return Math.min(TRANSCRIPT_TURN_LIMIT_DEFAULT, total);
  if (!Number.isInteger(args.turn_limit) || args.turn_limit < 0) {
    throw new Error(`Transcript turn_limit must be a non-negative integer.`);
  }
  return Math.min(args.turn_limit, total);
}

function transcriptTurnWindow<Args extends TranscriptArgs>(
  session: Session,
  args: Args,
): { turns: Session["transcript"]; omitted: number; keySuffix: string } {
  const total = session.transcriptStats.turns;
  const retainedOffset = total - session.transcript.length;
  const limit = transcriptTurnLimit(args, total);
  const firstRequested = total - limit;
  const firstReturned = Math.max(retainedOffset, firstRequested);
  const omitted = firstReturned;
  const retainedStart = firstReturned - retainedOffset;
  return {
    turns: retainedStart > 0 ? session.transcript.slice(retainedStart) : session.transcript,
    omitted,
    keySuffix:
      args.turn_limit === undefined
        ? `default:${limit}:from:${firstReturned}:of:${total}`
        : `last:${limit}:from:${firstReturned}:of:${total}`,
  };
}

export function transcriptTurnsOmitted<Args extends TranscriptArgs>(
  session: Session,
  args: Args,
): number {
  return transcriptTurnWindow(session, args).omitted;
}

/**
 * Strip internal-bookkeeping `state_change` events from the player-facing event
 * stream. The engine state and state hashes keep the full event/effect history;
 * MCP player surfaces never show `__`-prefixed mechanics keys.
 */
export function playerVisibleEvents(events: GameEvent[]): GameEvent[] {
  return events.filter((e) => {
    if (e.type !== "state_change") return true;
    const sc = e as { flag?: unknown; name?: unknown };
    const key = typeof sc.flag === "string" ? sc.flag : typeof sc.name === "string" ? sc.name : "";
    return !key.startsWith("__");
  });
}

function cloneTranscriptTurn<Turn extends TranscriptFullTurn | TranscriptCompactEventTurn>(
  turn: Turn,
): Turn {
  return {
    ...turn,
    events: turn.events.map(cloneMcpEvent),
  } as Turn;
}

function cloneTranscriptTurns<Args extends TranscriptArgs>(
  turns: readonly TranscriptTurnFor<Args>[],
): TranscriptTurnFor<Args>[] {
  return turns.map((turn) =>
    Array.isArray(turn)
      ? ([...turn] as unknown as TranscriptTurnFor<Args>)
      : (cloneTranscriptTurn(
          turn as TranscriptFullTurn | TranscriptCompactEventTurn,
        ) as unknown as TranscriptTurnFor<Args>),
  );
}

export function transcriptTurnsFor<Args extends TranscriptArgs>(
  sessions: SessionStore,
  session: Session,
  args: Args,
): TranscriptTurnFor<Args>[] {
  const window = transcriptTurnWindow(session, args);
  if (args.compact_turns) {
    const turns = sessions.transcriptProjection(
      session.id,
      `${TRANSCRIPT_PROJECTION_COMPACT_TURNS}:${window.keySuffix}`,
      () => window.turns.map((t) => [t.step, t.scene_id, t.action_id, t.result_scene_id] as const),
    ) as TranscriptTurnFor<Args>[];
    return cloneTranscriptTurns(turns);
  }

  if (args.compact_events === true) {
    const turns = sessions.transcriptProjection(
      session.id,
      `${TRANSCRIPT_PROJECTION_COMPACT_EVENTS}:${window.keySuffix}`,
      () =>
        window.turns.map((t) => ({
          ...t,
          events: playerVisibleEvents(t.events).map(compactPlayerEvent),
        })),
    ) as TranscriptTurnFor<Args>[];
    return cloneTranscriptTurns(turns);
  }

  const turns = sessions.transcriptProjection(
    session.id,
    `${TRANSCRIPT_PROJECTION_VISIBLE_EVENTS}:${window.keySuffix}`,
    () =>
      window.turns.map((t) => ({
        ...t,
        events: playerVisibleEvents(t.events),
      })),
  ) as TranscriptTurnFor<Args>[];
  return cloneTranscriptTurns(turns);
}

export function rpgStepEvents<Args extends RpgEventOptions>(
  events: GameEvent[],
  args: Args,
): RpgStepEvents<Args> {
  const visible = playerVisibleEvents(events);
  return (
    args.compact_events === true
      ? visible.map((event) => cloneMcpEvent(compactPlayerEvent(event)))
      : visible.map(cloneMcpEvent)
  ) as RpgStepEvents<Args>;
}

export function rpgStepEventVersion<Args extends RpgEventOptions>(
  args: Args,
): RpgStepEventVersion<Args> {
  return (
    args.compact_events === true && args.include_event_version === true
      ? { event_v: RPG_COMPACT_EVENT_VERSION }
      : {}
  ) as RpgStepEventVersion<Args>;
}

export function transcriptEventVersion<Args extends TranscriptArgs>(
  args: Args,
): TranscriptEventVersion<Args> {
  return (
    args.compact_events === true &&
    args.include_event_version === true &&
    args.summary_only !== true &&
    args.compact_turns !== true
      ? { event_v: RPG_COMPACT_EVENT_VERSION }
      : {}
  ) as TranscriptEventVersion<Args>;
}
