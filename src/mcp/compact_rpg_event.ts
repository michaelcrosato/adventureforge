import type { GameEvent } from "../core/events.js";
import { compactText } from "./compact_truncation.js";
import { compactMcpTranscriptSceneId, compactMcpTranscriptSummaryValue } from "./action_labels.js";
import {
  compactMcpVisibleJournalProse,
  MCP_VISIBLE_JOURNAL_PROSE_CHAR_LIMIT,
} from "./journal_prose.js";

export const COMPACT_EVENT_NARRATION_CHAR_LIMIT = 1200;
export const COMPACT_EVENT_REJECTION_CHAR_LIMIT = 180;
export const COMPACT_EVENT_JOURNAL_CHAR_LIMIT = MCP_VISIBLE_JOURNAL_PROSE_CHAR_LIMIT;
export const COMPACT_EVENT_DIAGNOSTIC_CHAR_LIMIT = 180;

export type RpgCompactEvent =
  | readonly ["r", reason: string]
  | readonly ["n", text: string]
  | readonly [
      "s",
      effect: string,
      key: string | null,
      value?: unknown,
      extra?: unknown,
      diagnostic?: string,
    ]
  | readonly ["o", id: string]
  | readonly ["c", id: string]
  | readonly ["m", from: string, to: string]
  | readonly ["t", item: string]
  | readonly ["d", item: string]
  | readonly ["q", npc: string, node: string]
  | readonly ["e", endingId: string];

// v8: the `u=unlock_exit` tag is gone with the effect it encoded.
export const RPG_COMPACT_EVENT_VERSION = 8 as const;

/**
 * Agent-facing one-line legend for the RpgCompactEvent tuples above; co-located
 * with the encoder so it cannot drift, and folded into RPG_COMPACT_LEGEND.events
 * so blind agents receive it once per session.
 */
export const RPG_COMPACT_EVENT_LEGEND =
  "step_action events use [tag, ...]. Tags: r rejected[reason]; n narration[text]; " +
  "s state_change[code,key,value?,extra?]. State codes: f set_flag; x clear_flag; " +
  "v set_var; + inc_var[name,delta,new]; - dec_var[name,delta,new]; j journal; " +
  "l set_locked; p place_object; q quest_stage. Other tags: o open_object[id]; " +
  "c close_object[id]; m move[from,to]; t take[item]; d drop[item]; " +
  "q dialogue[npc_id,node_id]; e ending[ending_id]";

type RpgStateChangeEvent = Extract<GameEvent, { type: "state_change" }>;

function field(event: GameEvent, key: string): unknown {
  return (event as unknown as Record<string, unknown>)[key];
}

function stringField(event: GameEvent, key: string): string {
  const value = field(event, key);
  return typeof value === "string" ? value : "";
}

function diagnosticField(event: GameEvent): string | undefined {
  const diagnostic = field(event, "diagnostic");
  return typeof diagnostic === "string"
    ? compactText(diagnostic, COMPACT_EVENT_DIAGNOSTIC_CHAR_LIMIT)
    : undefined;
}

function compactValue(value: unknown): unknown {
  return typeof value === "string" ? compactMcpTranscriptSummaryValue(value) : value;
}

function compactFallbackKey(event: GameEvent): string | null {
  const key =
    stringField(event, "flag") ||
    stringField(event, "name") ||
    stringField(event, "id") ||
    stringField(event, "item") ||
    stringField(event, "text") ||
    stringField(event, "quest");
  return key ? compactMcpTranscriptSummaryValue(key) : null;
}

function withDiagnostic(event: GameEvent, compact: readonly unknown[]): RpgCompactEvent {
  const diagnostic = diagnosticField(event);
  return (diagnostic ? [...compact, diagnostic] : compact) as unknown as RpgCompactEvent;
}

function compactStateChangeEvent(event: RpgStateChangeEvent): RpgCompactEvent {
  switch (event.effect) {
    case "set_flag":
      return withDiagnostic(event, [
        "s",
        "f",
        compactMcpTranscriptSummaryValue(stringField(event, "flag")),
      ]);
    case "clear_flag":
      return withDiagnostic(event, [
        "s",
        "x",
        compactMcpTranscriptSummaryValue(stringField(event, "flag")),
      ]);
    case "set_var":
      return withDiagnostic(event, [
        "s",
        "v",
        compactMcpTranscriptSummaryValue(stringField(event, "name")),
        compactValue(field(event, "value")),
      ]);
    case "inc_var":
      return withDiagnostic(event, [
        "s",
        "+",
        compactMcpTranscriptSummaryValue(stringField(event, "name")),
        compactValue(field(event, "delta")),
        compactValue(field(event, "value")),
      ]);
    case "dec_var":
      return withDiagnostic(event, [
        "s",
        "-",
        compactMcpTranscriptSummaryValue(stringField(event, "name")),
        compactValue(field(event, "delta")),
        compactValue(field(event, "value")),
      ]);
    case "add_journal":
      return withDiagnostic(event, [
        "s",
        "j",
        compactMcpVisibleJournalProse(stringField(event, "text")),
      ]);
    case "set_object_locked":
      return withDiagnostic(event, [
        "s",
        "l",
        compactMcpTranscriptSummaryValue(stringField(event, "id")),
        compactValue(field(event, "locked")),
      ]);
    case "place_object":
      return withDiagnostic(event, [
        "s",
        "p",
        compactMcpTranscriptSummaryValue(stringField(event, "id")),
        compactMcpTranscriptSceneId(stringField(event, "room")),
      ]);
    case "set_quest_stage":
      return withDiagnostic(event, [
        "s",
        "q",
        compactMcpTranscriptSummaryValue(stringField(event, "quest")),
        compactMcpTranscriptSummaryValue(stringField(event, "stage")),
      ]);
    default: {
      const key = compactFallbackKey(event);
      const value = compactValue(
        field(event, "value") ??
          field(event, "delta") ??
          field(event, "to") ??
          field(event, "amount") ??
          field(event, "locked") ??
          field(event, "room") ??
          field(event, "stage"),
      );
      return value !== undefined
        ? withDiagnostic(event, ["s", compactMcpTranscriptSummaryValue(event.effect), key, value])
        : withDiagnostic(event, ["s", compactMcpTranscriptSummaryValue(event.effect), key]);
    }
  }
}

export function compactPlayerEvent(event: GameEvent): RpgCompactEvent {
  switch (event.type) {
    case "rejected":
      return ["r", compactText(event.reason, COMPACT_EVENT_REJECTION_CHAR_LIMIT)];
    case "narration":
      return ["n", compactText(event.text, COMPACT_EVENT_NARRATION_CHAR_LIMIT)];
    case "state_change":
      return compactStateChangeEvent(event);
    case "open_object":
      return ["o", compactMcpTranscriptSummaryValue(event.id)];
    case "close_object":
      return ["c", compactMcpTranscriptSummaryValue(event.id)];
    case "move":
      return ["m", compactMcpTranscriptSceneId(event.from), compactMcpTranscriptSceneId(event.to)];
    case "take":
      return ["t", compactMcpTranscriptSummaryValue(event.item)];
    case "drop":
      return ["d", compactMcpTranscriptSummaryValue(event.item)];
    case "dialogue":
      return [
        "q",
        compactMcpTranscriptSummaryValue(event.npc),
        compactMcpTranscriptSummaryValue(event.node),
      ];
    case "ending":
      return ["e", compactMcpTranscriptSummaryValue(event.endingId)];
  }
}
