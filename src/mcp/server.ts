/**
 * MCP server (spec §9.4) — exposes the engine as agent tools over stdio.
 *
 * Every tool is a thin adapter over the pure handlers in tools.ts (which are the
 * unit-tested source of truth). The server confines all paths to the project
 * root and treats content/traces as data only — never code or shell (§16).
 *
 * Tool descriptions are the agent-facing contract: each one is a single sentence
 * that says what the tool does and when to use it (blind playtesters have no
 * other manual). The compact positional payloads are documented by the `legend`
 * field on session creation plus `legend_delta` patches on first field use;
 * tests/unit/compact_legend.test.ts guards both halves of that contract via the
 * exported TOOL_REGISTRATIONS registry.
 *
 * Run: `npm run mcp` (or register the project's .mcp.json in an MCP client).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { z, type ZodRawShape } from "zod";
import * as z4 from "zod/v4-mini";
import type { $ZodType } from "zod/v4/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { appendFileSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { createToolApi } from "./tools.js";
import type {
  OverworldMcpContextPayload,
  OverworldMcpLegendPatch,
  OverworldMcpReadArgs,
  OverworldMcpReadUnchanged,
  OverworldMcpResponseOptions,
  OverworldMcpSessionResponse,
} from "./overworld_sessions.js";
import type { OverworldCompactActionResult } from "./compact_overworld_result.js";
import type { CompactJourneyPresentation } from "./journey_projection.js";
import type { JourneyDecisionClassification } from "../world/journey_contract.js";
import type { OverworldActionResult } from "../world/session.js";
import { TRANSCRIPT_TURN_LIMIT_DEFAULT } from "./transcript_projection.js";
import { isGeneratedRpgSeed as genSeed } from "../gen/seed.js";
import { formatSpectateEntry } from "./spectate.js";
import { compactText } from "../core/compact_text.js";
import { OverworldSessionSnapshotSchema } from "../world/session_snapshot.js";
import { compactOverworldAreaRoutes } from "../world/compact_view.js";
import {
  FreshStartRunEvidenceV2Schema,
  JourneyExitRunEvidenceV2Schema,
  PureRunBuildSchema,
} from "../blind/run_evidence.js";
import { JourneyExitReceiptSchema } from "../blind/exit_interview.js";
import {
  STATION_DISPATCH_BOARD_VERSION,
  STATION_DISPATCH_SUPPORT_REVEAL_ID,
  type OpeningCompactStationDispatchBoard,
} from "../world/station_dispatch_board.js";

/**
 * Server-side, `structural` is deliberately identical to `full`: the only
 * behavioral branches anywhere test `=== "pure"`. The name exists for the blind
 * harness, whose attestations record that a run was a scripted structural check
 * rather than a live model — the restriction it implies lives entirely in that
 * harness, never here. Do not add a structural-only branch without updating
 * blind-tester's attestation semantics first.
 */
export type McpPlayMode = "full" | "structural" | "pure";

function parsePlayMode(): McpPlayMode {
  const value = argValue("--play-mode") ?? "full";
  if (value === "full" || value === "structural" || value === "pure") return value;
  throw new Error(
    `Invalid --play-mode ${JSON.stringify(value)}; expected "full", "structural", or "pure".`,
  );
}

/**
 * Pure play exposes ONE fresh journey through the moves a player makes in the game UI —
 * travel, talk, scout, work, quest steps, journey and story choices — plus read-only aids
 * that answer only from what that player already knows: context reads, opportunity
 * explanations, and `plan_overworld_session_route`, which plans over discovered roads
 * only. The UI never calls a planner (it draws the same roads on its map), so the rule is
 * not "only what the UI calls"; it is "nothing a player inside the game could not learn or
 * do". Authoring, validation, raw-state, direct-quest, export/restore, and generated-game
 * tools therefore stay in the default full server used by developers and structural
 * tests.
 */
export const PURE_PLAYER_TOOLS = new Set<string>([
  "start_overworld",
  "get_overworld_session",
  "get_overworld_session_context",
  "explain_overworld_session_opportunity",
  "plan_overworld_session_route",
  "travel_overworld_session",
  "follow_overworld_session_goal",
  "resolve_overworld_session_road_encounter",
  "care_overworld_session",
  "resupply_overworld_session",
  "rest_overworld_session",
  "scout_overworld_session_poi",
  "talk_overworld_session_contact",
  "investigate_overworld_session_event",
  "resolve_overworld_session_event",
  "explore_overworld_session_site",
  "explore_overworld_session_area",
  "move_overworld_session_area",
  "work_overworld_session_job",
  "start_overworld_session_quest",
  "choose_overworld_session_journey",
  "inspect_overworld_session_story",
  "choose_overworld_session_story",
  "get_observation",
  "list_legal_actions",
  "step_action",
]);

export function toolAvailableInPlayMode(name: string, playMode: McpPlayMode): boolean {
  return playMode !== "pure" || PURE_PLAYER_TOOLS.has(name);
}

const PLAY_MODE = parsePlayMode();

const RUN_EVIDENCE_PATH = (() => {
  const requested = process.argv.includes("--run-evidence");
  const value = argValue("--run-evidence");
  if (!requested) return null;
  if (!value || value.startsWith("--")) {
    throw new Error("--run-evidence requires a JSONL path.");
  }
  return resolve(value);
})();

const RUN_SEED: number | null = (() => {
  if (!process.argv.includes("--run-seed")) return null;
  const raw = argValue("--run-seed");
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`--run-seed requires a JavaScript safe integer, got ${JSON.stringify(raw)}.`);
  }
  return value;
})();

const BUILD_COMMIT: string | null = (() => {
  if (!process.argv.includes("--build-commit")) return null;
  const value = argValue("--build-commit");
  if (!value || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error("--build-commit requires the full 40-character lowercase Git commit hash.");
  }
  return value;
})();

const TRACKED_WORKTREE_CLEAN: boolean | null = (() => {
  if (!process.argv.includes("--tracked-worktree-clean")) return null;
  const value = argValue("--tracked-worktree-clean");
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error('--tracked-worktree-clean requires exactly "true" or "false".');
})();

const PURE_RUN_PROVENANCE = (() => {
  if (PLAY_MODE !== "pure" || RUN_EVIDENCE_PATH === null) return null;
  if (RUN_SEED === null) {
    throw new Error("Pure run evidence requires --run-seed.");
  }
  if (BUILD_COMMIT === null) {
    throw new Error("Pure run evidence requires --build-commit.");
  }
  if (TRACKED_WORKTREE_CLEAN === null) {
    throw new Error("Pure run evidence requires --tracked-worktree-clean.");
  }
  return {
    runSeed: RUN_SEED,
    gitCommit: BUILD_COMMIT,
    trackedWorktreeClean: TRACKED_WORKTREE_CLEAN,
  };
})();

const api = createToolApi({
  root: process.cwd(),
  ...(PLAY_MODE === "pure" && RUN_SEED !== null ? { embeddedQuestSeed: RUN_SEED } : {}),
});

type PureRunBuild = z.infer<typeof PureRunBuildSchema>;
type FreshStartRunEvidenceV2 = z.infer<typeof FreshStartRunEvidenceV2Schema>;
type JourneyExitRunEvidenceV2 = z.infer<typeof JourneyExitRunEvidenceV2Schema>;
type PureRunEvidenceV2 = FreshStartRunEvidenceV2 | JourneyExitRunEvidenceV2;

const pureRunState: {
  overworldSessionId: string | null;
  rpgSessionId: string | null;
  journeyExitRecorded: boolean;
  journeyExitResponse: unknown | null;
  journeyExitEvidence: JourneyExitRunEvidenceV2 | null;
  journeyExitRetryable: boolean;
  journeyExitWriteFailures: number;
  freshStartEvidence: FreshStartRunEvidenceV2 | null;
  callInFlight: boolean;
  build: PureRunBuild | null;
} = {
  overworldSessionId: null,
  rpgSessionId: null,
  journeyExitRecorded: false,
  journeyExitResponse: null,
  journeyExitEvidence: null,
  journeyExitRetryable: false,
  journeyExitWriteFailures: 0,
  freshStartEvidence: null,
  callInFlight: false,
  build: null,
};

const PURE_RPG_SESSION_TOOLS = new Set(["get_observation", "list_legal_actions", "step_action"]);
const PURE_OVERWORLD_SESSION_TOOLS = new Set(
  [...PURE_PLAYER_TOOLS].filter(
    (name) => name !== "start_overworld" && !PURE_RPG_SESSION_TOOLS.has(name),
  ),
);
const PURE_OVERWORLD_TOOLS_DURING_RPG = new Set([
  "get_overworld_session",
  "get_overworld_session_context",
  "choose_overworld_session_journey",
  "choose_overworld_session_story",
]);

function validateRunEvidence(event: PureRunEvidenceV2): PureRunEvidenceV2 {
  return event.event === "fresh_start"
    ? FreshStartRunEvidenceV2Schema.parse(event)
    : JourneyExitRunEvidenceV2Schema.parse(event);
}

/**
 * Replace the tiny two-row pure evidence ledger from validated in-memory events.
 * Writing a sibling first prevents a failed write from leaving a partial JSONL row;
 * the unlink fallback is only for Windows, where rename does not replace a file.
 */
function writeRunEvidence(events: readonly PureRunEvidenceV2[]): void {
  if (!RUN_EVIDENCE_PATH) return;
  const validated = events.map(validateRunEvidence);
  mkdirSync(dirname(RUN_EVIDENCE_PATH), { recursive: true });
  const temporaryPath = `${RUN_EVIDENCE_PATH}.tmp`;
  try {
    writeFileSync(temporaryPath, `${validated.map((event) => JSON.stringify(event)).join("\n")}\n`);
    try {
      renameSync(temporaryPath, RUN_EVIDENCE_PATH);
    } catch (renameError) {
      try {
        unlinkSync(RUN_EVIDENCE_PATH);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
      }
      renameSync(temporaryPath, RUN_EVIDENCE_PATH);
    }
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup only; never mask the evidence write/replace result.
    }
  }
}

function pureRunSnapshot(sessionId: string) {
  const exported = api.export_overworld_session({ session_id: sessionId });
  if (!exported.ok) throw new Error("Pure run evidence could not export its overworld session.");
  return OverworldSessionSnapshotSchema.parse(exported.snapshot);
}

function pureRunBuild(snapshot: z.infer<typeof OverworldSessionSnapshotSchema>): PureRunBuild {
  if (PURE_RUN_PROVENANCE === null) {
    throw new Error("Pure run evidence provenance was not configured.");
  }
  return PureRunBuildSchema.parse({
    git_commit: PURE_RUN_PROVENANCE.gitCommit,
    tracked_worktree_clean: PURE_RUN_PROVENANCE.trackedWorktreeClean,
    world_id: snapshot.worldId,
    world_hash: snapshot.worldHash,
  });
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

type PureSessionField = "overworld_session_id" | "rpg_session_id";

class PureSessionRecoveryError extends Error {
  constructor(
    message: string,
    readonly expectedSessionField: PureSessionField,
    readonly expectedArgument = "session_id",
  ) {
    super(message);
    this.name = "PureSessionRecoveryError";
  }
}

function pureSessionRecoveryFields(): Record<string, string> {
  return {
    ...(pureRunState.overworldSessionId
      ? { overworld_session_id: pureRunState.overworldSessionId }
      : {}),
    ...(pureRunState.rpgSessionId ? { rpg_session_id: pureRunState.rpgSessionId } : {}),
  };
}

/**
 * Longest tool-error text that may leave the server. Sits at the top of the band the
 * repo already uses for diagnostic strings (180-1200 chars elsewhere): enough to carry
 * a real message and the first few zod issues, far short of a context-destroying wall.
 */
export const MCP_TOOL_ERROR_CHAR_LIMIT = 1_200;

/**
 * Boundary sizes for the two tools that accept an opaque blob. A real overworld
 * snapshot is ~2 KB and grows with the journal and travel log; a real save is
 * comparable. These sit orders of magnitude above anything the game produces and
 * orders of magnitude below the payloads that made zod build a multi-megabyte
 * issue list. They stop the work, not just the response: the deep schema parse
 * inside the handler is what generates one pretty-printed object per failing
 * element, so refusing an implausible blob at the boundary is cheaper than
 * trimming the wreckage afterwards.
 */
export const MCP_SNAPSHOT_CHAR_LIMIT = 512_000;
export const MCP_SAVE_CHAR_LIMIT = 512_000;
/** Content patches are authored op lists, not bulk data. */
export const MCP_PATCH_OPS_LIMIT = 512;

function withinSerializedLimit(value: unknown, limit: number): boolean {
  try {
    return JSON.stringify(value).length <= limit;
  } catch {
    return false;
  }
}

/**
 * Declared here rather than inline in the tool block: `registeredToolBlock` measures the
 * registration's SOURCE length to keep the schema text a client is shown terse, and a
 * multi-line refine in the block would spend that budget on a server-side size guard.
 */
const BOUNDED_SNAPSHOT_RECORD = z
  .record(z.unknown())
  .refine((value) => withinSerializedLimit(value, MCP_SNAPSHOT_CHAR_LIMIT), {
    message: "Snapshot is too large to restore.",
  });

/**
 * Read an error's message without letting it become the failure.
 *
 * Zod v3's `ZodError.message` is a GETTER that runs
 * `JSON.stringify(this.issues, replacer, 2)` on every read — one pretty-printed
 * object per failing element. The tools that accept unbounded collections hand
 * that straight to a response: a 108 KB `restore_overworld_session` snapshot
 * produced a 3.9 MB error string, 1 MB produced 59 MB, and at roughly 300k issues
 * the read itself throws `RangeError: Invalid string length` — from INSIDE the
 * catch block, so the structured pure-mode error contract never ran and the
 * spectate record was skipped. The server survived only because the MCP SDK
 * happened to catch the rejection.
 *
 * So the getter access itself is guarded, not just its result: any
 * `compactText(e.message, N)` would still evaluate the getter first.
 */
function safeErrorMessage(error: unknown): string {
  try {
    return compactText(
      error instanceof Error ? error.message : String(error),
      MCP_TOOL_ERROR_CHAR_LIMIT,
    );
  } catch {
    return "Tool error message could not be rendered (too large).";
  }
}

function pureSessionErrorPayload(error: unknown): Record<string, unknown> {
  // `instanceof` against the original error, so a non-Error never round-trips
  // through String() — which for a ZodError routes to the same amplifying getter.
  const resolved = error;
  return {
    ok: false,
    error: safeErrorMessage(error),
    ...(resolved instanceof PureSessionRecoveryError
      ? {
          // `expected_session_field` is retained for existing clients. The two
          // additive names distinguish the MCP input key from the response key
          // carrying the recoverable handle.
          expected_session_field: resolved.expectedSessionField,
          expected_argument: resolved.expectedArgument,
          returned_handle_field: resolved.expectedSessionField,
        }
      : {}),
    ...pureSessionRecoveryFields(),
  };
}

function pureSessionResponsePayload(name: string, value: unknown): unknown {
  if (PLAY_MODE !== "pure") return value;
  const response = objectRecord(value);
  if (!response) return value;
  const { rpg_session_id: _staleResponseChildId, ...responseWithoutChild } = response;
  const parentId =
    name === "start_overworld" && typeof response.session_id === "string"
      ? response.session_id
      : pureRunState.overworldSessionId;
  const childId = pureRunState.rpgSessionId;
  const nestedRpg = objectRecord(response.rpg_session);
  const nestedRpgWithoutChild = nestedRpg
    ? (({ rpg_session_id: _staleNestedChildId, ...rest }) => rest)(nestedRpg)
    : null;
  return {
    ...responseWithoutChild,
    ...(parentId ? { overworld_session_id: parentId } : {}),
    ...(childId ? { rpg_session_id: childId } : {}),
    ...(nestedRpgWithoutChild && parentId
      ? {
          rpg_session: {
            ...nestedRpgWithoutChild,
            overworld_session_id: parentId,
            ...(childId ? { rpg_session_id: childId } : {}),
          },
        }
      : {}),
  };
}

export const PURE_STATION_DISPATCH_REVEAL_VERSION = 1 as const;

export type PureStationDispatchRevealResponseV1 = Readonly<{
  ok: true;
  overworld_session_id: string;
  snapshot_hash: string;
  station_dispatch_reveal: Readonly<{
    version: typeof PURE_STATION_DISPATCH_REVEAL_VERSION;
    base_snapshot_hash: string;
    station_dispatch_board: OpeningCompactStationDispatchBoard;
  }>;
}>;

export const PURE_STATION_JUNE_MODAL_VERSION = 1 as const;

export type PureStationJuneModalResponseV1 = Readonly<{
  ok: true;
  overworld_session_id: string;
  snapshot_hash: string;
  journey: CompactJourneyPresentation;
  journeyDecision: JourneyDecisionClassification;
  legend_delta?: OverworldMcpLegendPatch;
  result: OverworldCompactActionResult;
  station_dispatch_modal: Readonly<{
    version: typeof PURE_STATION_JUNE_MODAL_VERSION;
    base_snapshot_hash: string;
  }>;
}>;

type PureCompactOverworldTalkArgs<Args extends OverworldMcpResponseOptions> =
  ("expected_snapshot_hash" extends keyof Args
    ? { expected_snapshot_hash: string }
    : Record<never, never>) & {
    compact_context: true;
    compact_result: true;
    include_ids: false;
    include_route_options: false;
  };

type PureFullOverworldTalkWireResponse<Args extends OverworldMcpResponseOptions> =
  OverworldMcpSessionResponse<
    "result",
    OverworldActionResult,
    PureCompactOverworldTalkArgs<Args>,
    OverworldCompactActionResult
  > &
    PureOverworldWireHandles;

type PureOverworldTalkAddress =
  | { character_id: string; contact_id?: string }
  | { character_id?: undefined; contact_id: string };

export type PureOverworldTalkArgs = { session_id: string } & PureOverworldTalkAddress &
  OverworldMcpResponseOptions;

type PureOverworldTalkCharacterId<Args extends PureOverworldTalkArgs> = Args extends {
  character_id: string;
}
  ? Args["character_id"]
  : Args extends { contact_id: string }
    ? Args["contact_id"]
    : never;

type PureStationJuneModalForArgs<Args extends PureOverworldTalkArgs> =
  typeof PURE_STATION_JUNE_CONTACT_ID extends PureOverworldTalkCharacterId<Args>
    ? PureStationJuneModalResponseV1
    : never;

/** Exact non-June literals stay full; June-capable callers model V1 plus safe fallback. */
export type PureOverworldTalkWireResponse<Args extends PureOverworldTalkArgs> =
  | PureFullOverworldTalkWireResponse<Args>
  | PureStationJuneModalForArgs<Args>;

/** The pure wire contract narrows only the exact Station reveal member. */
type PureOverworldWireHandles = {
  overworld_session_id: string;
  rpg_session_id?: string;
};

type PurePotentialUnchangedWireResponse<Args extends OverworldMcpReadArgs> =
  "if_snapshot_hash" extends keyof Args
    ? Args extends { if_snapshot_hash?: undefined }
      ? never
      : OverworldMcpReadUnchanged & PureOverworldWireHandles
    : never;

type PureFullOverworldContextWireResponse<Args extends OverworldMcpReadArgs> =
  OverworldMcpContextPayload<Args> & PureOverworldWireHandles;

type PureStationExpansionRequest =
  | { include_departure_recap_terms: true }
  | { include_station_dispatch_support: true };

type PureNoRevealContextWireResponse<Args extends OverworldMcpReadArgs> =
  | PureFullOverworldContextWireResponse<Args>
  | PurePotentialUnchangedWireResponse<Args>;

type PureKnownRevealContextWireResponse<Args extends OverworldMcpReadArgs> =
  Args extends PureStationExpansionRequest
    ? PureFullOverworldContextWireResponse<Args>
    : PureStationDispatchRevealResponseV1 | PureFullOverworldContextWireResponse<Args>;

type PureMaybeRevealContextWireResponse<Args extends OverworldMcpReadArgs> =
  Args extends PureStationExpansionRequest
    ? PureNoRevealContextWireResponse<Args>
    : PureStationDispatchRevealResponseV1 | PureNoRevealContextWireResponse<Args>;

export type PureOverworldContextWireResponse<Args extends OverworldMcpReadArgs> =
  "reveal_station_dispatch_support" extends keyof Args
    ? Args extends { reveal_station_dispatch_support?: undefined }
      ? PureNoRevealContextWireResponse<Args>
      : Args extends { reveal_station_dispatch_support: string }
        ? PureKnownRevealContextWireResponse<Args>
        : PureMaybeRevealContextWireResponse<Args>
    : PureNoRevealContextWireResponse<Args>;

type PureStationDispatchRevealBase = Readonly<{
  sessionId: string;
  snapshotHash: string;
}>;

function isPureStationRevealDeltaRequest(name: string, args: unknown): boolean {
  if (PLAY_MODE !== "pure" || name !== "get_overworld_session_context") return false;
  const input = objectRecord(args);
  return (
    typeof input?.reveal_station_dispatch_support === "string" &&
    input.include_departure_recap_terms !== true &&
    input.include_station_dispatch_support !== true
  );
}

/**
 * Capture and authenticate the retained compact context before the canonical
 * reveal mutates its durable receipt. The delta may only be applied to this
 * exact immediately-prior snapshot.
 */
function pureStationDispatchRevealBase(
  name: string,
  args: unknown,
): PureStationDispatchRevealBase | null {
  if (!isPureStationRevealDeltaRequest(name, args)) return null;
  const input = objectRecord(args);
  if (!input) return null;
  const sessionId = input.session_id;
  const retainedHash = input.if_snapshot_hash;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("To reveal Station support, pass the current parent session_id.");
  }
  if (typeof retainedHash !== "string" || retainedHash.length === 0) {
    throw new Error("Also pass if_snapshot_hash from the latest compact context.");
  }
  const exported = objectRecord(api.export_overworld_session({ session_id: sessionId }));
  const snapshotHash = exported?.snapshot_hash;
  if (exported?.ok !== true || typeof snapshotHash !== "string" || snapshotHash.length === 0) {
    throw new Error("Pure Station support reveal could not capture its base snapshot hash.");
  }
  if (retainedHash !== snapshotHash) {
    throw new Error("The snapshot changed. Read a new compact context, then reveal again.");
  }
  return { sessionId, snapshotHash };
}

/**
 * Replace the canonical full-context reveal response with one versioned board
 * delta after the session mutation and pure evidence hooks have succeeded.
 */
function pureStationDispatchRevealResponse(
  name: string,
  args: unknown,
  value: unknown,
  base: PureStationDispatchRevealBase | null,
): unknown {
  if (!isPureStationRevealDeltaRequest(name, args)) return value;
  if (base === null) {
    throw new Error("Station support cannot be revealed here. Read a full compact context first.");
  }
  const response = objectRecord(value);
  const context = objectRecord(response?.context);
  const board = context?.station_dispatch_board;
  if (
    response?.ok !== true ||
    typeof response.snapshot_hash !== "string" ||
    response.snapshot_hash.length === 0 ||
    !Array.isArray(board) ||
    board.length !== 6 ||
    board[0] !== STATION_DISPATCH_BOARD_VERSION ||
    board[5] !== null
  ) {
    // The canonical mutation has already happened. Never turn that success into
    // an error after the fact: an unexpected projection keeps the complete
    // canonical response, while only the exact V6 revealed board is narrowed.
    return value;
  }
  const receipt: Omit<PureStationDispatchRevealResponseV1, "overworld_session_id"> = {
    ok: true,
    snapshot_hash: response.snapshot_hash,
    station_dispatch_reveal: {
      version: PURE_STATION_DISPATCH_REVEAL_VERSION,
      base_snapshot_hash: base.snapshotHash,
      station_dispatch_board: board as unknown as OpeningCompactStationDispatchBoard,
    },
  };
  return receipt;
}

export const PURE_STATION_JUNE_CONTACT_ID = "albany_city__transport_hub__june_pike" as const;
const PURE_STATION_JUNE_STORY_ID = "albany:wolf_ally_commitment";
const PURE_STATION_JUNE_OPTION_IDS = new Set([
  "albany:ally_june_cattle_first",
  "albany:ally_june_relay_only",
  "albany:ally_travel_solo",
]);

type PureStationJuneModalBase = Readonly<{
  sessionId: string;
  snapshotHash: string;
}>;

function isPureStationJuneTalk(name: string, args: unknown): boolean {
  if (PLAY_MODE !== "pure" || name !== "talk_overworld_session_contact") return false;
  const input = objectRecord(args);
  return input?.character_id === PURE_STATION_JUNE_CONTACT_ID;
}

function hasExactStationDispatchRevealReceipt(snapshot: Record<string, unknown>): boolean {
  const receipts = snapshot.stationDispatchSupportReveals;
  return (
    Array.isArray(receipts) &&
    receipts.length === 1 &&
    Array.isArray(receipts[0]) &&
    receipts[0].length === 2 &&
    receipts[0][0] === "wolf_winter" &&
    receipts[0][1] === STATION_DISPATCH_SUPPORT_REVEAL_ID
  );
}

/**
 * Authenticate June's revealed Station modal against the player's retained
 * compact snapshot before the canonical talk mutates time, journal, and story.
 * Ordinary contacts and June outside this exact reveal lifecycle remain full.
 */
function pureStationJuneModalBase(name: string, args: unknown): PureStationJuneModalBase | null {
  if (!isPureStationJuneTalk(name, args)) return null;
  const input = objectRecord(args);
  if (!input) return null;
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const exported = objectRecord(api.export_overworld_session({ session_id: sessionId }));
  const snapshot = objectRecord(exported?.snapshot);
  if (
    exported?.ok !== true ||
    snapshot === null ||
    !hasExactStationDispatchRevealReceipt(snapshot)
  ) {
    return null;
  }
  const snapshotHash = exported.snapshot_hash;
  if (typeof snapshotHash !== "string" || snapshotHash.length === 0) {
    throw new Error("Pure Station June talk could not capture its base snapshot hash.");
  }
  const current = objectRecord(
    api.get_overworld_session({ session_id: sessionId, include_observation: true }),
  );
  const observation = objectRecord(current?.observation);
  const currentJourney = objectRecord(current?.journey);
  if (
    current === null ||
    current.session_id !== sessionId ||
    current.snapshot_hash !== snapshotHash ||
    currentJourney?.storyChoice !== null ||
    !exactReadyStationJuneBoard(observation?.stationDispatchBoard)
  ) {
    return null;
  }
  const retainedHash = input.expected_snapshot_hash;
  if (typeof retainedHash !== "string" || retainedHash.length === 0) {
    throw new Error(
      "To talk to June here, pass expected_snapshot_hash from the revealed Station board.",
    );
  }
  if (retainedHash !== snapshotHash) {
    throw new Error("The snapshot changed. Read the latest Station response, then talk to June.");
  }
  return { sessionId, snapshotHash };
}

function exactReadyStationJuneBoard(value: unknown): boolean {
  const board = objectRecord(value);
  if (board?.version !== STATION_DISPATCH_BOARD_VERSION || board.questId !== "wolf_winter") {
    return false;
  }
  const support = board.support;
  if (!Array.isArray(support)) return false;
  const fieldTeamRows = support.map(objectRecord).filter((row) => row?.slot === "field_team");
  if (fieldTeamRows.length !== 1) return false;
  const fieldTeam = fieldTeamRows[0];
  const action = objectRecord(fieldTeam?.action);
  return (
    fieldTeam?.status === "open_optional" &&
    fieldTeam.selectedTitle === null &&
    action?.kind === "talk" &&
    action.tool === "talk_overworld_session_contact" &&
    action.characterId === PURE_STATION_JUNE_CONTACT_ID &&
    action.contactName === "June Pike"
  );
}

function hasExactStationJuneOptions(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== PURE_STATION_JUNE_OPTION_IDS.size) return false;
  const optionIds = value.map((option) => objectRecord(option)?.id);
  return (
    optionIds.every((optionId): optionId is string => typeof optionId === "string") &&
    new Set(optionIds).size === PURE_STATION_JUNE_OPTION_IDS.size &&
    optionIds.every((optionId) => PURE_STATION_JUNE_OPTION_IDS.has(optionId))
  );
}

/**
 * Narrow only the exact June story-modal transition. If the canonical success
 * ever changes shape, preserve it whole because the mutation has already landed.
 */
function pureStationJuneModalResponse(
  name: string,
  args: unknown,
  value: unknown,
  base: PureStationJuneModalBase | null,
): unknown {
  if (!isPureStationJuneTalk(name, args) || base === null) return value;
  const response = objectRecord(value);
  const journey = objectRecord(response?.journey);
  const storyChoice = objectRecord(journey?.storyChoice);
  const options = storyChoice?.options;
  const journeyDecision = objectRecord(response?.journeyDecision);
  const result = objectRecord(response?.result);
  const context = objectRecord(response?.context);
  const legendDelta =
    response?.legend_delta === undefined ? undefined : objectRecord(response.legend_delta);
  if (
    response?.ok !== true ||
    response.session_id !== base.sessionId ||
    typeof response.snapshot_hash !== "string" ||
    response.snapshot_hash.length === 0 ||
    response.snapshot_hash === base.snapshotHash ||
    storyChoice?.id !== PURE_STATION_JUNE_STORY_ID ||
    storyChoice.kind !== "ally" ||
    !hasExactStationJuneOptions(options) ||
    journeyDecision?.countsTowardJourney !== true ||
    journeyDecision.reason !== "substantive_dialogue" ||
    typeof result?.m !== "number" ||
    !Array.isArray(result.entry) ||
    typeof result.text !== "string" ||
    context === null ||
    (legendDelta !== undefined &&
      (legendDelta === null ||
        Object.values(legendDelta).some((entry) => typeof entry !== "string")))
  ) {
    return value;
  }
  const receipt: Omit<PureStationJuneModalResponseV1, "overworld_session_id"> = {
    ok: true,
    snapshot_hash: response.snapshot_hash,
    journey: journey as unknown as CompactJourneyPresentation,
    journeyDecision: journeyDecision as JourneyDecisionClassification,
    ...(legendDelta ? { legend_delta: legendDelta as OverworldMcpLegendPatch } : {}),
    result: result as OverworldCompactActionResult,
    station_dispatch_modal: {
      version: PURE_STATION_JUNE_MODAL_VERSION,
      base_snapshot_hash: base.snapshotHash,
    },
  };
  return receipt;
}

function pureCallPreflight(name: string, args: unknown): void {
  if (PLAY_MODE !== "pure") return;
  const input = objectRecord(args);
  const exactCommittedEndReplay =
    pureRunState.journeyExitResponse !== null &&
    name === "choose_overworld_session_journey" &&
    input?.session_id === pureRunState.overworldSessionId &&
    input.choice === "end" &&
    (pureRunState.journeyExitRecorded || pureRunState.journeyExitRetryable);
  if (pureRunState.journeyExitResponse !== null && !exactCommittedEndReplay) {
    throw new Error(
      "This journey has ended. Its exit receipt is final; do not take another gameplay action.",
    );
  }
  if (exactCommittedEndReplay) return;
  if (pureRunState.journeyExitRecorded) {
    throw new Error(
      "This journey has ended. Its exit receipt is final; do not take another gameplay action.",
    );
  }
  if (name === "start_overworld") {
    if (pureRunState.overworldSessionId !== null) {
      throw new PureSessionRecoveryError(
        "Pure play allows one new overworld session. Continue with the recovered overworld_session_id.",
        "overworld_session_id",
      );
    }
    return;
  }
  if (pureRunState.overworldSessionId === null) {
    throw new Error("Start pure play with start_overworld.");
  }
  const sessionId = input?.session_id;
  if (PURE_OVERWORLD_SESSION_TOOLS.has(name) && sessionId !== pureRunState.overworldSessionId) {
    throw new PureSessionRecoveryError(
      pureRunState.rpgSessionId !== null && sessionId === pureRunState.rpgSessionId
        ? "This overworld tool needs the parent overworld_session_id, not the active child rpg_session_id."
        : "Pass the current parent overworld_session_id. The supplied session_id is missing, invalid, stale, or unknown.",
      "overworld_session_id",
    );
  }
  if (
    pureRunState.rpgSessionId !== null &&
    PURE_OVERWORLD_SESSION_TOOLS.has(name) &&
    !PURE_OVERWORLD_TOOLS_DURING_RPG.has(name)
  ) {
    throw new PureSessionRecoveryError(
      "Finish the active quest with its rpg_session_id before taking another overworld action.",
      "rpg_session_id",
    );
  }
  if (PURE_RPG_SESSION_TOOLS.has(name)) {
    if (pureRunState.rpgSessionId === null) {
      throw new PureSessionRecoveryError(
        "No RPG quest is active. Start a visible overworld quest before using RPG tools.",
        "rpg_session_id",
      );
    }
    if (sessionId !== pureRunState.rpgSessionId) {
      throw new PureSessionRecoveryError(
        "This RPG tool needs the active child rpg_session_id, not the parent overworld_session_id.",
        "rpg_session_id",
      );
    }
    const rpgSession = api.sessions.get(sessionId);
    if (rpgSession.overworldSessionId !== pureRunState.overworldSessionId) {
      throw new PureSessionRecoveryError(
        "This rpg_session_id does not belong to the current overworld session.",
        "rpg_session_id",
      );
    }
  }
}

function pureJourneyExitEvidenceFailure(
  response: Record<string, unknown>,
  detail: string,
  retryable: boolean,
): unknown {
  pureRunState.journeyExitRetryable = retryable;
  process.stderr.write(`Pure journey-exit evidence finalization failed: ${detail}\n`);
  return {
    ...response,
    run_evidence: {
      recorded: false,
      retryable,
      message: retryable
        ? "The journey ended and its exit receipt is final, but evidence was not saved. Make exactly one more End call with the same parent session to retry."
        : "The journey ended and its exit receipt is final, but evidence was not saved. Do not retry or make another gameplay call.",
    },
  };
}

function persistPureJourneyExitEvidence(response: Record<string, unknown>): unknown {
  if (RUN_EVIDENCE_PATH === null) {
    pureRunState.journeyExitRecorded = true;
    pureRunState.journeyExitRetryable = false;
    return pureRunState.journeyExitResponse;
  }
  if (pureRunState.freshStartEvidence === null || pureRunState.journeyExitEvidence === null) {
    return pureJourneyExitEvidenceFailure(
      response,
      "validated fresh-start or journey-exit evidence is unavailable",
      false,
    );
  }
  try {
    writeRunEvidence([pureRunState.freshStartEvidence, pureRunState.journeyExitEvidence]);
    pureRunState.journeyExitRecorded = true;
    pureRunState.journeyExitRetryable = false;
    return pureRunState.journeyExitResponse;
  } catch (error) {
    pureRunState.journeyExitWriteFailures += 1;
    const retryable = pureRunState.journeyExitWriteFailures === 1;
    const detail = safeErrorMessage(error);
    return pureJourneyExitEvidenceFailure(response, detail, retryable);
  }
}

function pureCallEvidence(name: string, value: unknown): unknown {
  if (PLAY_MODE !== "pure") return value;
  const response = objectRecord(value);
  if (!response) return value;
  if (name === "start_overworld") {
    const sessionId = response.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("Fresh overworld start returned no session id.");
    }
    pureRunState.overworldSessionId = sessionId;
    if (RUN_EVIDENCE_PATH !== null) {
      const snapshot = pureRunSnapshot(sessionId);
      const build = pureRunBuild(snapshot);
      pureRunState.build = build;
      const freshStartEvidence = FreshStartRunEvidenceV2Schema.parse({
        schema_version: 2,
        play_mode: "pure",
        event: "fresh_start",
        start_surface: "fresh_overworld",
        session_id: sessionId,
        run_seed: PURE_RUN_PROVENANCE!.runSeed,
        build,
      });
      pureRunState.freshStartEvidence = freshStartEvidence;
      writeRunEvidence([freshStartEvidence]);
    }
    return value;
  }
  const receipt =
    name === "choose_overworld_session_journey"
      ? (response.exitReceipt ?? objectRecord(response.result)?.exitReceipt)
      : undefined;
  const receiptRecord = objectRecord(receipt);
  if (receiptRecord && pureRunState.journeyExitRecorded) {
    pureRunState.rpgSessionId = null;
    return pureRunState.journeyExitResponse ?? value;
  }
  if (name === "start_overworld_session_quest" && response.ok === true) {
    const rpgSessionId = response.rpg_session_id;
    if (typeof rpgSessionId !== "string" || rpgSessionId.length === 0) {
      throw new Error("Embedded quest start returned no RPG session id.");
    }
    pureRunState.rpgSessionId = rpgSessionId;
  } else if (
    name === "choose_overworld_session_journey" &&
    typeof response.rpg_session_id === "string"
  ) {
    pureRunState.rpgSessionId = response.rpg_session_id;
  } else if (
    name === "step_action" &&
    response.ok === true &&
    response.questCompletion !== undefined
  ) {
    pureRunState.rpgSessionId = null;
  }
  if (name !== "choose_overworld_session_journey" || pureRunState.journeyExitRecorded) return value;
  if (!receiptRecord) return value;

  // The game mutation has already committed by the time the raw receipt reaches
  // this boundary. Retain that terminal response and release any embedded child
  // before fallible validation/export/file IO so a recorder failure cannot
  // strand the run between an ended journey and an active child handle.
  pureRunState.journeyExitResponse ??= value;
  pureRunState.rpgSessionId = null;
  if (pureRunState.journeyExitEvidence !== null) {
    return persistPureJourneyExitEvidence(response);
  }
  let verifiedReceipt: z.infer<typeof JourneyExitReceiptSchema>;
  try {
    verifiedReceipt = JourneyExitReceiptSchema.parse(receipt);
  } catch (error) {
    const detail = safeErrorMessage(error);
    return pureJourneyExitEvidenceFailure(response, detail, false);
  }
  if (RUN_EVIDENCE_PATH !== null) {
    try {
      const snapshot = pureRunSnapshot(pureRunState.overworldSessionId!);
      const build = pureRunBuild(snapshot);
      if (pureRunState.build === null || !isDeepStrictEqual(build, pureRunState.build)) {
        throw new Error("Pure run world/build provenance changed between start and journey exit.");
      }
      pureRunState.journeyExitEvidence = JourneyExitRunEvidenceV2Schema.parse({
        schema_version: 2,
        play_mode: "pure",
        event: "journey_exit",
        start_surface: "fresh_overworld",
        session_id: pureRunState.overworldSessionId!,
        run_seed: PURE_RUN_PROVENANCE!.runSeed,
        build,
        quest_outcomes: snapshot.questOutcomes,
        receipt: verifiedReceipt,
      });
    } catch (error) {
      const detail = safeErrorMessage(error);
      return pureJourneyExitEvidenceFailure(response, detail, false);
    }
  }
  return persistPureJourneyExitEvidence(response);
}

function pureCommittedJourneyExitResponse(name: string, args: unknown): unknown | null {
  if (PLAY_MODE !== "pure" || pureRunState.journeyExitResponse === null) return null;
  const input = objectRecord(args);
  return name === "choose_overworld_session_journey" &&
    input?.session_id === pureRunState.overworldSessionId &&
    input.choice === "end" &&
    (pureRunState.journeyExitRecorded || pureRunState.journeyExitRetryable)
    ? pureRunState.journeyExitResponse
    : null;
}

// ── Spectate mode ─────────────────────────────────────────────────────────────
// A human-facing live feed of every tool call (plus an optional pacing delay
// before each response returns) so a person can watch an LLM playthrough in
// real time and verify what is happening — `npm run spectate` tails the feed
// from another terminal. Configure via CLI args (`npm run mcp -- --spectate
// [path] --spectate-delay-ms N` — args survive every MCP client) or env
// (AF_SPECTATE=1|<path>, AF_SPECTATE_DELAY_MS=N). Entirely inert when unset:
// no files are touched and no delay is added, so importing this module (tests)
// and normal blind/loop runs are unaffected. The feed goes to a FILE — stdout
// is the JSON-RPC transport and must stay clean.
const SPECTATE_DEFAULT_LOG = "ai-runs/spectate.log";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const SPECTATE_LOG: string | null = (() => {
  const fromArg = process.argv.includes("--spectate")
    ? (argValue("--spectate") ?? "")
    : (process.env.AF_SPECTATE ?? "");
  if (!fromArg && !process.argv.includes("--spectate") && !process.env.AF_SPECTATE) return null;
  const isPath = fromArg !== "" && fromArg !== "1" && !fromArg.startsWith("--");
  return resolve(isPath ? fromArg : SPECTATE_DEFAULT_LOG);
})();

const SPECTATE_DELAY_MS: number = Math.max(
  0,
  Number(argValue("--spectate-delay-ms") ?? process.env.AF_SPECTATE_DELAY_MS ?? 0) || 0,
);

/** On startup (direct run only): banner into the feed + a stderr pointer. */
function announceSpectate(): void {
  if (!SPECTATE_LOG) return;
  try {
    mkdirSync(dirname(SPECTATE_LOG), { recursive: true });
    appendFileSync(
      SPECTATE_LOG,
      `\n═══ adventureforge spectate — session started ${new Date().toISOString()}${SPECTATE_DELAY_MS > 0 ? ` (delay ${SPECTATE_DELAY_MS}ms)` : ""} ═══\n`,
    );
  } catch {
    // best-effort
  }
  process.stderr.write(
    `spectate feed → ${SPECTATE_LOG}${SPECTATE_DELAY_MS > 0 ? ` (delay ${SPECTATE_DELAY_MS}ms per tool response)` : ""} — watch with: npm run spectate\n`,
  );
}

/** Append one human-readable play-by-play entry per tool call. Best-effort. */
function spectateRecord(name: string, args: unknown, result: CallToolResult): void {
  if (!SPECTATE_LOG) return;
  const first = result.content?.[0];
  const body = first && first.type === "text" ? first.text : "";
  const entry = formatSpectateEntry(name, args, body, result.isError === true, new Date());
  try {
    mkdirSync(dirname(SPECTATE_LOG), { recursive: true });
    appendFileSync(SPECTATE_LOG, entry);
  } catch {
    // Spectating is best-effort; a feed write failure must not fail the tool call.
  }
}

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

const RPG_SESSION_ALIAS_TOOLS = new Set([
  "get_observation",
  "list_legal_actions",
  "step_action",
  "get_state",
  "get_transcript",
  "save_game",
]);

function normalizeEquivalentAlias(
  input: Record<string, unknown>,
  canonicalName: string,
  aliasName: string,
): Record<string, unknown> {
  const canonical = input[canonicalName];
  const alias = input[aliasName];
  if (canonical !== undefined && alias !== undefined && canonical !== alias) {
    throw new Error(
      `${canonicalName} and ${aliasName} conflict. Pass one field, or use the same value in both.`,
    );
  }
  if (alias === undefined) return input;
  const normalized = { ...input, [canonicalName]: canonical ?? alias };
  delete normalized[aliasName];
  return normalized;
}

function normalizeSimplePlayerAliases(name: string, args: unknown): unknown {
  const input = objectRecord(args);
  if (!input) return args;
  let normalized = input;
  if (RPG_SESSION_ALIAS_TOOLS.has(name)) {
    normalized = normalizeEquivalentAlias(normalized, "session_id", "rpg_session_id");
  }
  if (name === "step_action") {
    normalized = normalizeEquivalentAlias(normalized, "action_id", "action");
  }
  if (name === "travel_overworld_session" || name === "plan_overworld_session_route") {
    normalized = normalizeEquivalentAlias(normalized, "destination_town_id", "dest_town_id");
  }
  if (name === "talk_overworld_session_contact") {
    normalized = normalizeEquivalentAlias(normalized, "character_id", "contact_id");
  }
  if (name === "choose_overworld_session_story") {
    normalized = normalizeEquivalentAlias(normalized, "choice", "option_id");
  }
  return normalized;
}

export function resolveVisibleAreaRouteId(
  routes: readonly (readonly [routeId: string, destinationAreaId: string, minutes: number])[],
  destinationAreaId: string,
): string {
  const matches = routes.filter(([, candidateAreaId]) => candidateAreaId === destinationAreaId);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Area ${JSON.stringify(destinationAreaId)} is not a visible destination from here.`
        : `More than one visible route leads to area ${JSON.stringify(destinationAreaId)}. Pass area_route_id or route_id.`,
    );
  }
  return matches[0]![0];
}

type AreaRouteSelector = {
  area_route_id?: string;
  route_id?: string;
  area_id?: string;
};

export function resolveAreaMoveSelector(
  routes: readonly (readonly [routeId: string, destinationAreaId: string, minutes: number])[],
  selector: AreaRouteSelector,
  requireVisibleExactRoute = false,
): string | undefined {
  const canonicalRouteId = selector.area_route_id;
  const routeIdAlias = selector.route_id;
  if (
    canonicalRouteId !== undefined &&
    routeIdAlias !== undefined &&
    canonicalRouteId !== routeIdAlias
  ) {
    throw new Error(
      "area_route_id and route_id conflict. Pass one field, or use the same value in both.",
    );
  }

  const routeSelector = canonicalRouteId ?? routeIdAlias;
  const routeSelectorName =
    canonicalRouteId !== undefined && routeIdAlias !== undefined
      ? "route selector"
      : canonicalRouteId !== undefined
        ? "area_route_id"
        : "route_id";
  if (
    requireVisibleExactRoute &&
    routeSelector !== undefined &&
    !routes.some(([candidateRouteId]) => candidateRouteId === routeSelector)
  ) {
    throw new Error(`Area route ${JSON.stringify(routeSelector)} is not visible from here.`);
  }

  if (selector.area_id === undefined) return routeSelector;
  const matchingRoutes = routes.filter(
    ([, candidateAreaId]) => candidateAreaId === selector.area_id,
  );
  if (matchingRoutes.length === 0) {
    return resolveVisibleAreaRouteId(routes, selector.area_id);
  }
  if (
    matchingRoutes.length > 1 &&
    (!routeSelector ||
      !matchingRoutes.some(([candidateRouteId]) => candidateRouteId === routeSelector))
  ) {
    throw new Error(
      `More than one visible route leads to area ${JSON.stringify(selector.area_id)}. Pass area_route_id or route_id.`,
    );
  }
  if (
    routeSelector !== undefined &&
    !matchingRoutes.some(([candidateRouteId]) => candidateRouteId === routeSelector)
  ) {
    throw new Error(
      `${routeSelectorName} and area_id conflict. That route does not lead to the visible destination.`,
    );
  }
  // An exact route selector truthfully resolves an ambiguous destination alias
  // when that exact edge is one of its visible matches.
  return routeSelector ?? matchingRoutes[0]![0];
}

function visibleAreaRoutesForMove(input: Record<string, unknown>) {
  if (typeof input.session_id !== "string") return [] as const;
  const routes = api.get_overworld_session({
    session_id: input.session_id,
    include_observation: true,
  }).observation.areaExits;
  if (PLAY_MODE !== "pure" && input.compact_context === false) {
    return routes.map((route) => [route.id, route.destination.id, route.travel_minutes] as const);
  }
  // Alias normalization is an internal read: reuse the exact player-visible
  // compact cap without advancing progressive legend disclosure.
  return compactOverworldAreaRoutes(routes);
}

function normalizeAreaDestinationAlias(name: string, args: unknown): unknown {
  if (name !== "move_overworld_session_area") return args;
  const input = objectRecord(args);
  if (!input) return args;
  const canonicalRouteId = input.area_route_id;
  const routeIdAlias = input.route_id;
  const destinationAreaId = input.area_id;
  if (
    (canonicalRouteId !== undefined && typeof canonicalRouteId !== "string") ||
    (routeIdAlias !== undefined && typeof routeIdAlias !== "string") ||
    (destinationAreaId !== undefined && typeof destinationAreaId !== "string") ||
    typeof input.session_id !== "string"
  ) {
    return args;
  }

  // In pure play the compact context is the entire player-visible local map.
  // Exact route tokens must obey that same boundary as destination aliases: a
  // guessed full-view edge may not turn a bounded disclosure into a hidden exit.
  const needsVisibleRoutes = PLAY_MODE === "pure" || destinationAreaId !== undefined;
  const routes = needsVisibleRoutes ? visibleAreaRoutesForMove(input) : undefined;
  const resolvedRouteId = resolveAreaMoveSelector(
    routes ?? [],
    {
      ...(typeof canonicalRouteId === "string" ? { area_route_id: canonicalRouteId } : {}),
      ...(typeof routeIdAlias === "string" ? { route_id: routeIdAlias } : {}),
      ...(typeof destinationAreaId === "string" ? { area_id: destinationAreaId } : {}),
    },
    PLAY_MODE === "pure",
  );
  if (resolvedRouteId === undefined) return args;
  const normalized: Record<string, unknown> = {
    ...input,
    area_route_id: resolvedRouteId,
  };
  delete normalized.route_id;
  delete normalized.area_id;
  return normalized;
}

function wrap<A>(name: string, handler: (args: A) => unknown) {
  return async (args: A): Promise<CallToolResult> => {
    let result: CallToolResult;
    let ownsPureCall = false;
    try {
      if (PLAY_MODE === "pure") {
        if (pureRunState.callInFlight) {
          throw new Error(
            "Another tool call is still running. Wait for its response before trying again.",
          );
        }
        pureRunState.callInFlight = true;
        ownsPureCall = true;
      }
      const simpleNormalizedArgs = normalizeSimplePlayerAliases(name, args);
      pureCallPreflight(name, simpleNormalizedArgs);
      const normalizedArgs = normalizeAreaDestinationAlias(name, simpleNormalizedArgs) as A;
      const committedExit = pureCommittedJourneyExitResponse(name, normalizedArgs);
      const stationDispatchRevealBase = pureStationDispatchRevealBase(name, normalizedArgs);
      const stationJuneModalBase = pureStationJuneModalBase(name, normalizedArgs);
      const rawValue = committedExit ?? (await handler(normalizedArgs)); // await is a no-op for sync handlers
      const evidencedValue = pureCallEvidence(name, rawValue);
      const revealValue = pureStationDispatchRevealResponse(
        name,
        normalizedArgs,
        evidencedValue,
        stationDispatchRevealBase,
      );
      const stationJuneValue = pureStationJuneModalResponse(
        name,
        normalizedArgs,
        revealValue,
        stationJuneModalBase,
      );
      const value = pureSessionResponsePayload(name, stationJuneValue);
      result = ok(value);
    } catch (e) {
      // Bound the text on BOTH branches. Trimming only the dev branch leaves the pure
      // payload amplifying; trimming only inside pureSessionErrorPayload leaves the dev
      // branch amplifying; trimming downstream (spectate, ok()) is too late, because the
      // oversized string is already on the wire.
      result =
        PLAY_MODE === "pure"
          ? {
              content: [{ type: "text", text: JSON.stringify(pureSessionErrorPayload(e)) }],
              isError: true,
            }
          : {
              content: [{ type: "text", text: `Error: ${safeErrorMessage(e)}` }],
              isError: true,
            };
    } finally {
      if (ownsPureCall) pureRunState.callInFlight = false;
    }
    spectateRecord(name, args, result);
    if (SPECTATE_DELAY_MS > 0) await new Promise((r) => setTimeout(r, SPECTATE_DELAY_MS));
    return result;
  };
}

const server = new McpServer({ name: "adventureforge", version: "0.1.0" });

/** MCP behavioral hints (see the spec's tool annotations). */
export type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type ToolRegistration = {
  name: string;
  description: string;
  annotations: ToolAnnotations;
};

/** Every registered tool, exported so tests can hold descriptions + annotations to a floor. */
export const TOOL_REGISTRATIONS: ToolRegistration[] = [];

/**
 * Tools that neither mutate session/engine state nor have side effects — pure reads,
 * previews, serializers, and deterministic mint/validate/replay analyses. Everything
 * else creates or advances a session (a session-store mutation), so it is left as the
 * mutating default. This engine is closed and deterministic, so EVERY tool is
 * non-destructive and non-open-world (no external entities); read-only tools are also
 * idempotent in the MCP sense (repeating the call adds no further effect).
 *
 * Membership is decided by what a tool CAN do, not by what the common call does.
 * `get_overworld_session_context` and `inspect_overworld_session_story` are reads for
 * most arguments, but `reveal_station_dispatch_support` / `reveal_id` route into
 * `revealStationDispatchSupport` / `revealJourneyStory`, which write a durable reveal
 * receipt into `persistenceState()` and therefore move the snapshot hash the agent is
 * holding. A client that trusts `readOnlyHint` on those would auto-approve, cache, or
 * replay a call that silently invalidates every `expected_snapshot_hash` /
 * `if_snapshot_hash` it retained, so both are annotated as mutating. Annotations are
 * per-tool and static; there is no way to say "read-only unless this argument is
 * present", and the conservative side of that is the honest one.
 *
 * Note also that read-only is NOT "same args ⇒ byte-identical response": the compact
 * legend is disclosed once per session, so a repeated `plan_overworld_session_route`
 * returns the same route with no second `legend_delta`. That is a disclosure ledger,
 * not game state, which is why these tools stay idempotent.
 */
export const READ_ONLY_TOOLS = new Set<string>([
  "list_overworld",
  "get_overworld_session",
  "explain_overworld_session_opportunity",
  "export_overworld_session",
  "plan_overworld_session_route",
  "get_observation",
  "list_legal_actions",
  "get_state",
  "get_transcript",
  "save_game",
  "validate_quest",
  "load_quest",
  "generate_rpg_pack",
  "replay_trace",
  "inspect_trace",
  "adapt_story",
  "apply_content_patch",
]);

function tool(
  name: string,
  description: string,
  inputSchema: ZodRawShape | z.ZodTypeAny | $ZodType,
  handler: (args: never) => unknown,
): void {
  if (!toolAvailableInPlayMode(name, PLAY_MODE)) return;
  const readOnly = READ_ONLY_TOOLS.has(name);
  const annotations: ToolAnnotations = {
    // Deterministic, closed engine: no external entities, and nothing is destroyed
    // (sessions are in-memory; saves/snapshots are returned strings).
    openWorldHint: false,
    destructiveHint: false,
    ...(readOnly ? { readOnlyHint: true, idempotentHint: true } : {}),
  };
  TOOL_REGISTRATIONS.push({ name, description, annotations });
  server.registerTool(
    name,
    { description, inputSchema: inputSchema as never, annotations },
    wrap(name, handler) as never,
  );
}

function formatArgumentAlternatives(argumentNames: readonly string[]): string {
  if (argumentNames.length === 1) return argumentNames[0]!;
  if (argumentNames.length === 2) return `${argumentNames[0]} or ${argumentNames[1]}`;
  return `${argumentNames.slice(0, -1).join(", ")}, or ${argumentNames.at(-1)}`;
}

type RequiredArgumentGroup = readonly [string, ...string[]];

function requireArgumentGroups(
  inputShape: ZodRawShape,
  argumentGroups: readonly RequiredArgumentGroup[],
): $ZodType {
  const objectSchema = z.object(inputShape);
  const schema = z4.pipe(
    z4.custom((value) => value !== null && typeof value === "object", "Expected an object."),
    z4.transform((value, context) => {
      const parsed = objectSchema.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.issues.push({
            code: "custom",
            input: value,
            path: issue.path,
            message: issue.message,
          });
        }
      }
      for (const argumentNames of argumentGroups) {
        if (
          !argumentNames.some((argumentName) =>
            Object.prototype.hasOwnProperty.call(value, argumentName),
          )
        ) {
          context.issues.push({
            code: "custom",
            input: value,
            path: [argumentNames[0]],
            message: `Required: Provide ${formatArgumentAlternatives(argumentNames)}.`,
          });
        }
      }
      return parsed.success && context.issues.length === 0 ? parsed.data : z4.NEVER;
    }),
  );
  const requiredGroups = argumentGroups.map((argumentNames) => ({
    anyOf: argumentNames.map((argumentName) => ({ required: [argumentName] })),
  }));
  const publishedSchema = {
    ...toJsonSchemaCompat(objectSchema, { strictUnions: true, pipeStrategy: "input" }),
    ...(requiredGroups.length === 1
      ? requiredGroups[0]
      : {
          allOf: requiredGroups,
        }),
  };
  // The MCP SDK accepts Zod v4 object schemas, and v4 deliberately exposes a
  // JSON-schema override hook. This one root pipe keeps v3's established
  // field-level diagnostics while publishing every independent presence group.
  // `shape` lets the SDK recognize the pipe as an object input.
  Object.defineProperty(schema._zod.def, "shape", { value: {} });
  schema._zod.toJSONSchema = () => publishedSchema;
  return schema;
}

function requireOneOfArguments(
  inputShape: ZodRawShape,
  argumentNames: RequiredArgumentGroup,
): $ZodType {
  return requireArgumentGroups(inputShape, [argumentNames]);
}

// Mutual exclusion, published rather than hidden. A bare `z.object(shape).refine(…)`
// looks like the obvious way to say "not both of these", but it hands registerTool a
// ZodEffects where a ZodRawShape is expected: zodToJsonSchema then finds no shape and
// publishes `{"properties":{}}`, so the tool advertises NO arguments at all while its
// description documents several. Clients that validate or strip against the advertised
// schema send `{}` and the call fails at the handler. This mirrors requireArgumentGroups
// above — same root pipe for field-level diagnostics, same toJSONSchema override so the
// real properties still reach `tools/list`, plus a JSON-Schema `not/required` clause that
// states the exclusion machine-readably instead of only in prose.
function forbidArgumentCombination(
  inputShape: ZodRawShape,
  exclusiveNames: RequiredArgumentGroup,
  message: string,
): $ZodType {
  const objectSchema = z.object(inputShape);
  const schema = z4.pipe(
    z4.custom((value) => value !== null && typeof value === "object", "Expected an object."),
    z4.transform((value, context) => {
      const parsed = objectSchema.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.issues.push({
            code: "custom",
            input: value,
            path: issue.path,
            message: issue.message,
          });
        }
      }
      const supplied = exclusiveNames.filter(
        (argumentName) =>
          Object.prototype.hasOwnProperty.call(value, argumentName) &&
          (value as Record<string, unknown>)[argumentName] !== undefined,
      );
      if (supplied.length > 1) {
        context.issues.push({
          code: "custom",
          input: value,
          path: [exclusiveNames.at(-1)!],
          message,
        });
      }
      return parsed.success && context.issues.length === 0 ? parsed.data : z4.NEVER;
    }),
  );
  const publishedSchema = {
    ...toJsonSchemaCompat(objectSchema, { strictUnions: true, pipeStrategy: "input" }),
    not: { required: [...exclusiveNames] },
  };
  Object.defineProperty(schema._zod.def, "shape", { value: {} });
  schema._zod.toJSONSchema = () => publishedSchema;
  return schema;
}

function requireAliasedArgument(
  inputShape: ZodRawShape,
  canonicalName: string,
  aliasName: string,
): $ZodType {
  return requireArgumentGroups(inputShape, [[canonicalName, aliasName]]);
}

const WORLD_QUEST_SOURCE = {
  world_quest_id: z.string().describe("Quest id from the shipped overworld quest registry."),
};
const G = z.number().int().refine(genSeed);
const B = (d: string) => z.boolean().optional().describe(d);
const REQUIRED_SESSION_HANDLE = (description: string) =>
  (PLAY_MODE === "pure" ? z.coerce.string() : z.string()).describe(description);
const SESSION_HANDLE = (description: string) =>
  PLAY_MODE === "pure"
    ? REQUIRED_SESSION_HANDLE(description).optional()
    : REQUIRED_SESSION_HANDLE(description);
const OVERWORLD_SESSION = {
  session_id: SESSION_HANDLE("Parent overworld_session_id. Do not use rpg_session_id."),
};
const HIDE_GRAPH = {
  hide_graph: B("Omit the world graph."),
};
const PLAYER_HIDE_GRAPH = PLAY_MODE === "pure" ? {} : HIDE_GRAPH;
const EMBEDDED_QUEST_SEED =
  PLAY_MODE === "pure"
    ? {}
    : {
        seed: z.number().int().safe().optional().describe("Runtime seed."),
      };
const COMPACT_ACTIONS = {
  compact_actions: B("Return action ids without labels."),
};
const COMPACT_EVENTS = {
  compact_events: B("Return events as tagged tuples defined by the session legend."),
  include_event_version: B("Include the event schema version."),
};
const COMPACT_OBSERVATION = {
  compact_observation: B("Set false to return the verbose observation."),
  include_actions: B(
    "Include legal action ids and active dialogue replies. Always true in pure compact play.",
  ),
  include_context_version: B("Include the context schema version."),
};
const IF_STATE_HASH = {
  if_state_hash: z
    .string()
    .optional()
    .describe("Return unchanged:true if this state hash matches."),
};
const IF_TRANSCRIPT_HASH = {
  if_transcript_hash: z
    .string()
    .optional()
    .describe("Return unchanged:true if this transcript hash matches."),
};
const EXPECTED_STATE_HASH = {
  expected_state_hash: z
    .string()
    .optional()
    .describe("Reject the action if this state hash is stale."),
};
tool(
  "list_overworld",
  "Return overworld counts and the start town. Design notes are optional.",
  {
    include_design_notes: z.boolean().optional().describe("Include source notes and design rules."),
  },
  (a) => api.list_overworld(a),
);

const CONTACT_ID = z.string().describe("Contact id.");
const CONTACT_ID_ALIAS = z.string().describe("Alias for character_id.");
const CONTACT_INPUT = (shape: ZodRawShape) =>
  requireAliasedArgument(
    { ...shape, character_id: CONTACT_ID.optional(), contact_id: CONTACT_ID_ALIAS.optional() },
    "character_id",
    "contact_id",
  );
const AREA_ROUTE_ID = z.string().describe("Route id from area_routes.");
const ROUTE_ID_ALIAS = z.string().describe("Alias for area_route_id.");
const AREA_ID_ALIAS = z.string().describe("Visible destination alias.");
const AREA_MOVE_INPUT = (shape: ZodRawShape) =>
  requireOneOfArguments(
    {
      ...shape,
      area_route_id: AREA_ROUTE_ID.optional(),
      route_id: ROUTE_ID_ALIAS.optional(),
      area_id: AREA_ID_ALIAS.optional(),
    },
    ["area_route_id", "route_id", "area_id"],
  );

/**
 * Give ordinary play the same inline action ids that pure play already gets.
 *
 * Action ids are not derivable from room prose — narration says "DON padded byre-jerkin"
 * where the only legal action is `take_byre_jerkin` — so without them a player has to
 * call `list_legal_actions` before nearly every step. One playtest lead measured roughly
 * a third of its tool calls as that discovery overhead rather than play, which on a
 * mass-parallel cheap fleet is a third of the token budget buying no coverage.
 *
 * Measured on a fresh session, so this is not a trade-off in either direction: inline
 * costs 48 characters (+16%) on an observation, while the separate call costs 89
 * characters AND a whole extra round trip. Pure play has had it all along; every other
 * caller — a person, the dev loop, a hand-driven MCP session — was paying the extra turn
 * for strictly less information.
 *
 * An explicit `include_actions` from the caller still wins.
 */
function withInlineActions(
  response: Record<string, unknown>,
  input: Record<string, unknown>,
): never {
  return (
    input.include_actions === undefined ? { ...response, include_actions: true } : response
  ) as never;
}

function defaultCompactRpg(args: unknown): never {
  const input: Record<string, unknown> =
    typeof args === "object" && args !== null ? { ...(args as Record<string, unknown>) } : {};
  if (PLAY_MODE === "pure") {
    delete input.hide_graph;
    delete input.seed;
  }
  const response = {
    hide_graph: true,
    compact_actions: true,
    compact_events: true,
    compact_observation: true,
    ...input,
  };
  if (PLAY_MODE !== "pure") return withInlineActions(response, input);
  return {
    ...response,
    hide_graph: true,
    ...(input.compact_observation === false
      ? { compact_actions: input.compact_actions ?? false }
      : { include_actions: true }),
  } as never;
}

function defaultCompactActions(args: unknown): never {
  const input = typeof args === "object" && args !== null ? args : {};
  return { compact_actions: PLAY_MODE === "pure" ? false : true, ...input } as never;
}

function defaultCompactOverworld(args: unknown): never {
  const input = typeof args === "object" && args !== null ? args : {};
  return {
    compact_context: true,
    compact_result: true,
    ...input,
    ...(PLAY_MODE === "pure"
      ? {
          compact_context: true,
          compact_result: true,
          include_ids: false,
          include_route_options: false,
        }
      : {}),
  } as never;
}

function defaultCompactOverworldAndRpg(args: unknown): never {
  const input: Record<string, unknown> =
    typeof args === "object" && args !== null ? { ...(args as Record<string, unknown>) } : {};
  if (PLAY_MODE === "pure") {
    delete input.hide_graph;
    delete input.seed;
  }
  const response = {
    compact_context: true,
    compact_result: true,
    hide_graph: true,
    compact_actions: true,
    compact_observation: true,
    ...input,
  };
  if (PLAY_MODE !== "pure") return withInlineActions(response, input);
  return {
    ...response,
    hide_graph: true,
    compact_context: true,
    compact_result: true,
    include_ids: false,
    include_route_options: false,
    ...(input.compact_observation === false
      ? { compact_actions: input.compact_actions ?? false }
      : { include_actions: true }),
  } as never;
}

function defaultCompactTranscript(args: unknown): never {
  const input = typeof args === "object" && args !== null ? args : {};
  return {
    summary_only: true,
    compact_events: true,
    compact_summary: true,
    turn_limit: TRANSCRIPT_TURN_LIMIT_DEFAULT,
    ...input,
  } as never;
}

type McpStateArgs = {
  session_id: string;
  include_state?: boolean;
  compact_state?: boolean;
  if_state_hash?: string;
};

function compactMcpState(args: McpStateArgs): unknown {
  return api.get_state(args);
}

type McpOverworldReadArgs = {
  session_id: string;
  include_observation?: boolean;
  if_snapshot_hash?: string;
  include_ids?: boolean;
  include_route_options?: boolean;
};

function compactMcpOverworldSession(args: McpOverworldReadArgs): unknown {
  return PLAY_MODE !== "pure" && args.include_observation === true
    ? api.get_overworld_session(args)
    : api.get_overworld_session_context(args);
}

const EXPECTED_SNAPSHOT_HASH = {
  expected_snapshot_hash: z
    .string()
    .optional()
    .describe("Reject the action if this snapshot hash is stale."),
};
const IF_SNAPSHOT_HASH = {
  if_snapshot_hash: z
    .string()
    .optional()
    .describe("Return unchanged:true if this snapshot hash matches."),
};
const ROUTES = {
  include_route_options: B("Include multi-road route_options."),
};
const IDS = {
  include_ids: B("Include discovered and completed id lists."),
};
const W = {
  include_world_name: B("Include the world name."),
};
const S = {
  include_session_id: B("Include the session id."),
};
const STATION_SUPPORT = {
  include_station_dispatch_support: B("Include legacy Station support details."),
  reveal_station_dispatch_support: z
    .string()
    .optional()
    .describe(
      PLAY_MODE === "pure"
        ? "Station board[5] reveal id. Also pass the latest if_snapshot_hash."
        : "Station board[5] reveal id. Records a durable receipt, so the snapshot hash moves.",
    ),
};
const OVERWORLD_READ_DETAILS = PLAY_MODE === "pure" ? {} : { ...S, ...W, ...IDS, ...ROUTES };
const COMPACT_OVERWORLD_CONTEXT =
  PLAY_MODE === "pure"
    ? {}
    : {
        compact_context: B("Set false to return the verbose observation."),
        ...W,
        ...IDS,
        ...ROUTES,
      };
const COMPACT_OVERWORLD_RESULT =
  PLAY_MODE === "pure"
    ? {}
    : {
        compact_result: B("Set false to return the verbose action result."),
      };
const OVERWORLD_ACTION_CONTEXT = {
  ...EXPECTED_SNAPSHOT_HASH,
  ...COMPACT_OVERWORLD_CONTEXT,
  ...COMPACT_OVERWORLD_RESULT,
};
const OVERWORLD_CONTEXT_DESCRIPTION =
  PLAY_MODE === "pure"
    ? "Read current compact context without acting. A Station reveal returns only its new fields."
    : "Read current context without acting. Station support uses the exact board[5] id.";

tool(
  "start_overworld",
  "Start fresh overworld play. Keep the tutorial, session_id, and legend. Add later legend_delta keys.",
  {
    ...COMPACT_OVERWORLD_CONTEXT,
  },
  (a) => api.start_overworld(defaultCompactOverworld(a)),
);
tool(
  "get_overworld_session",
  PLAY_MODE === "pure"
    ? "Read the current compact overworld context without acting."
    : "Read the current overworld context without acting. Set include_observation for the verbose view.",
  {
    ...OVERWORLD_SESSION,
    ...IF_SNAPSHOT_HASH,
    ...(PLAY_MODE === "pure"
      ? {}
      : {
          include_observation: z.boolean().optional().describe("Return the verbose view."),
        }),
    ...OVERWORLD_READ_DETAILS,
  },
  (a) => compactMcpOverworldSession(a),
);
tool(
  "get_overworld_session_context",
  OVERWORLD_CONTEXT_DESCRIPTION,
  {
    ...OVERWORLD_SESSION,
    ...IF_SNAPSHOT_HASH,
    include_departure_recap_terms: B("Include the full terms of the selected plan."),
    ...STATION_SUPPORT,
    ...OVERWORLD_READ_DETAILS,
  },
  (a) => api.get_overworld_session_context(a),
);
tool(
  "explain_overworld_session_opportunity",
  "Check one current event or job lead and return its legal next action. Does not change state.",
  {
    ...OVERWORLD_SESSION,
    kind: z.enum(["event", "job"]).describe("Exact lead kind from opportunity_leads."),
    id: z.string().describe("Exact lead id from opportunity_leads."),
    ...OVERWORLD_ACTION_CONTEXT,
  },
  (a) => api.explain_overworld_session_opportunity(defaultCompactOverworld(a)),
);
tool(
  "export_overworld_session",
  "Export a snapshot, plus embedded_quest mid-quest. Pass both to restore_overworld_session to continue later.",
  {
    ...OVERWORLD_SESSION,
    ...EXPECTED_SNAPSHOT_HASH,
    ...IF_SNAPSHOT_HASH,
  },
  (a) => api.export_overworld_session(a),
);
tool(
  "restore_overworld_session",
  "Restore an exported snapshot as a new session. The start tutorial is not repeated. Keep the returned legend and add later legend_delta values by key.",
  {
    snapshot: BOUNDED_SNAPSHOT_RECORD.describe("Snapshot from export_overworld_session."),
    embedded_quest: BOUNDED_SNAPSHOT_RECORD.optional().describe("Required if that export had one."),
    ...COMPACT_OVERWORLD_CONTEXT,
  },
  (a) => api.restore_overworld_session(defaultCompactOverworld(a)),
);

const DESTINATION_TOWN_ID = z.string().describe("Destination town id.");
const DEST_TOWN_ID_ALIAS = z.string().describe("Alias for destination_town_id.");
const DESTINATION_TOWN = {
  destination_town_id: DESTINATION_TOWN_ID.optional(),
  dest_town_id: DEST_TOWN_ID_ALIAS.optional(),
};
const DESTINATION_TOWN_INPUT = (shape: ZodRawShape) =>
  requireAliasedArgument({ ...shape, ...DESTINATION_TOWN }, "destination_town_id", "dest_town_id");

tool(
  "travel_overworld_session",
  "Travel one road to an adjacent town. This spends time and supplies, adds fatigue, and may start a road encounter.",
  {
    ...OVERWORLD_SESSION,
    destination_town_id: z.string().optional().describe("Adjacent destination town."),
    dest_town_id: DEST_TOWN_ID_ALIAS.optional(),
    road_id: z.string().optional().describe("Adjacent road id. Use instead of a town id."),
    ...OVERWORLD_ACTION_CONTEXT,
  },
  (a) => api.travel_overworld_session(defaultCompactOverworld(a)),
);
tool(
  "follow_overworld_session_goal",
  "Travel toward the current goal. Stops at the objective, a road encounter, or a resource boundary.",
  {
    ...OVERWORLD_SESSION,
    ...OVERWORLD_ACTION_CONTEXT,
  },
  (a) => api.follow_overworld_session_goal(defaultCompactOverworld(a)),
);
tool(
  "resolve_overworld_session_road_encounter",
  "Resolve the pending road encounter. Travel remains blocked until you choose a strategy.",
  {
    ...OVERWORLD_SESSION,
    strategy: z
      .enum(["cautious_scout", "assist_travelers", "press_on"])
      .describe("Option from pending_road.options."),
    ...OVERWORLD_ACTION_CONTEXT,
  },
  (a) => api.resolve_overworld_session_road_encounter(defaultCompactOverworld(a)),
);
tool(
  "care_overworld_session",
  "Use the current area's one-time wound care. The shown time cost applies.",
  {
    ...OVERWORLD_SESSION,
    ...OVERWORLD_ACTION_CONTEXT,
  },
  (a) => api.care_overworld_session(defaultCompactOverworld(a)),
);
tool(
  "resupply_overworld_session",
  "Buy supplies back up to the cap at the current town, spending time.",
  {
    ...OVERWORLD_SESSION,
    ...OVERWORLD_ACTION_CONTEXT,
  },
  (a) => api.resupply_overworld_session(defaultCompactOverworld(a)),
);
tool(
  "rest_overworld_session",
  "Rest at the current town to lower fatigue, spending time.",
  {
    ...OVERWORLD_SESSION,
    ...OVERWORLD_ACTION_CONTEXT,
  },
  (a) => api.rest_overworld_session(defaultCompactOverworld(a)),
);
tool(
  "plan_overworld_session_route",
  "Preview the best route to a town. Shows time, supplies, and arrival fatigue without moving.",
  DESTINATION_TOWN_INPUT({
    ...OVERWORLD_SESSION,
    ...OVERWORLD_ACTION_CONTEXT,
  }),
  (a) => api.plan_overworld_session_route(defaultCompactOverworld(a)),
);
tool(
  "scout_overworld_session_poi",
  "Scout a point of interest in the current area. This may reveal areas, jobs, sites, or quests.",
  {
    ...OVERWORLD_SESSION,
    poi_id: z.string().describe("POI id."),
    ...OVERWORLD_ACTION_CONTEXT,
  },
  (a) => api.scout_overworld_session_poi(defaultCompactOverworld(a)),
);
tool(
  "talk_overworld_session_contact",
  "Talk to a visible contact. For Station, pass character_id from ['talk', character_id, contact_name]. Contact order does not matter.",
  CONTACT_INPUT({
    ...OVERWORLD_SESSION,
    ...OVERWORLD_ACTION_CONTEXT,
  }),
  (a) => api.talk_overworld_session_contact(defaultCompactOverworld(a)),
);
tool(
  "investigate_overworld_session_event",
  "Investigate a local event to uncover details before resolving it.",
  {
    ...OVERWORLD_SESSION,
    event_id: z.string().describe("Event id."),
    ...OVERWORLD_ACTION_CONTEXT,
  },
  (a) => api.investigate_overworld_session_event(defaultCompactOverworld(a)),
);
tool(
  "resolve_overworld_session_event",
  "Resolve an investigated event. For a scene with options, pass an exact option_id.",
  {
    ...OVERWORLD_SESSION,
    event_id: z.string().describe("Event id."),
    option_id: z.string().optional().describe("Exact option id."),
    ...OVERWORLD_ACTION_CONTEXT,
  },
  (a) => api.resolve_overworld_session_event(defaultCompactOverworld(a)),
);
tool(
  "explore_overworld_session_site",
  "Explore a discovered site. This grants the shown renown and records its find.",
  {
    ...OVERWORLD_SESSION,
    site_id: z.string().describe("Site id."),
    ...OVERWORLD_ACTION_CONTEXT,
  },
  (a) => api.explore_overworld_session_site(defaultCompactOverworld(a)),
);
tool(
  "explore_overworld_session_area",
  "Survey the current area. This reveals its points of interest, contacts, events, and exits.",
  {
    ...OVERWORLD_SESSION,
    area_id: z.string().describe("Area id."),
    ...OVERWORLD_ACTION_CONTEXT,
  },
  (a) => api.explore_overworld_session_area(defaultCompactOverworld(a)),
);
tool(
  "move_overworld_session_area",
  "Move within the current town. Pass a visible area_route_id, route_id, or destination area_id.",
  AREA_MOVE_INPUT({
    ...OVERWORLD_SESSION,
    ...OVERWORLD_ACTION_CONTEXT,
  }),
  (a) => api.move_overworld_session_area(defaultCompactOverworld(a)),
);
tool(
  "work_overworld_session_job",
  "Work a discovered job. For a scene with options, pass the required exact option_id.",
  {
    ...OVERWORLD_SESSION,
    job_id: z.string().describe("Job id."),
    option_id: z.string().optional().describe("Required exact option id."),
    ...OVERWORLD_ACTION_CONTEXT,
  },
  (a) => api.work_overworld_session_job(defaultCompactOverworld(a)),
);
tool(
  "start_overworld_session_quest",
  "Start a discovered quest. Use its returned rpg_session_id with step_action. Non-death endings return to the overworld automatically.",
  {
    ...OVERWORLD_SESSION,
    quest_id: z.string().describe("Quest id."),
    approach_id: z
      .string()
      .optional()
      .describe("Required approach id when the quest shows launch options."),
    ...EMBEDDED_QUEST_SEED,
    ...PLAYER_HIDE_GRAPH,
    ...COMPACT_ACTIONS,
    ...COMPACT_OBSERVATION,
    ...OVERWORLD_ACTION_CONTEXT,
  },
  (a) => api.start_overworld_session_quest(defaultCompactOverworldAndRpg(a)),
);
tool(
  "complete_overworld_session_quest",
  "Return an ended child quest manually only if its ending still includes rpg_session_id. Non-death endings normally return automatically.",
  {
    ...OVERWORLD_SESSION,
    rpg_session_id: SESSION_HANDLE(
      "Ended child rpg_session_id. Do not use the parent overworld_session_id.",
    ),
    expected_rpg_state_hash: z.string().optional().describe("Reject stale RPG state."),
    ...OVERWORLD_ACTION_CONTEXT,
  },
  (a) => api.complete_overworld_session_quest(defaultCompactOverworld(a)),
);
tool(
  "choose_overworld_session_journey",
  "Choose continue or end at a shown journey pause.",
  {
    ...OVERWORLD_SESSION,
    choice: z.enum(["continue", "end"]).describe("Choice from journey.pendingChoice.options."),
    ...COMPACT_ACTIONS,
    ...COMPACT_OBSERVATION,
    ...OVERWORLD_ACTION_CONTEXT,
  },
  (a) => api.choose_overworld_session_journey(defaultCompactOverworldAndRpg(a)),
);
tool(
  "inspect_overworld_session_story",
  "Inspect a visible story choice without choosing it. Only reveal_id changes state.",
  forbidArgumentCombination(
    {
      ...OVERWORLD_SESSION,
      story_choice_id: z
        .string()
        .describe(
          "Exact id from journey.storyChoice, Station ['inspect', id], or departure_interactions.",
        ),
      option_id: z
        .string()
        .optional()
        .describe("Exact id from story.options. Returns that option's full detail."),
      reveal_id: z
        .string()
        .optional()
        .describe(
          "Exact revealOption id. Unlocks staged options for this session; survives export or restore.",
        ),
      ...OVERWORLD_ACTION_CONTEXT,
    },
    ["option_id", "reveal_id"],
    "option_id and reveal_id are mutually exclusive.",
  ),
  (a) => api.inspect_overworld_session_story(defaultCompactOverworld(a)),
);
tool(
  "choose_overworld_session_story",
  "Choose a visible story option. If revealOption exists, reveal it first. Pass story_choice_id for a Station support choice.",
  PLAY_MODE === "pure"
    ? {
        ...OVERWORLD_SESSION,
        choice: z.string().describe("Exact visible option id. Departure story id is inferred."),
        story_choice_id: z.string().optional().describe("Story id required for Station support."),
        ...OVERWORLD_ACTION_CONTEXT,
      }
    : requireAliasedArgument(
        {
          ...OVERWORLD_SESSION,
          choice: z
            .string()
            .optional()
            .describe("Exact visible option id. Departure story id is inferred."),
          option_id: z.string().optional().describe("Alias for choice."),
          story_choice_id: z.string().optional().describe("Story id required for Station support."),
          ...OVERWORLD_ACTION_CONTEXT,
        },
        "choice",
        "option_id",
      ),
  (a) => api.choose_overworld_session_story(defaultCompactOverworld(a)),
);
tool(
  "validate_quest",
  "Validate one shipped RPG quest by id and return its validation report.",
  WORLD_QUEST_SOURCE,
  (a) => api.validate_quest(a),
);
tool(
  "load_quest",
  "Compile a shipped RPG quest and return its metadata, content hash, and validation report.",
  WORLD_QUEST_SOURCE,
  (a) => api.load_quest(a),
);

const RPG_SESSION_ID = REQUIRED_SESSION_HANDLE(
  "Child rpg_session_id. Do not use overworld_session_id.",
);
const RPG_SESSION_ID_ALIAS = REQUIRED_SESSION_HANDLE("Alias for session_id.");
const RPG_SESSION_INPUT = (shape: ZodRawShape) =>
  requireAliasedArgument(
    {
      ...shape,
      session_id: RPG_SESSION_ID.optional(),
      rpg_session_id: RPG_SESSION_ID_ALIAS.optional(),
    },
    "session_id",
    "rpg_session_id",
  );
const ACTION_ID = z.string().describe("Exact id from actions or unavailable rows.");
const ACTION_ID_ALIAS = z.string().describe("Alias for action_id.");
const RPG_STEP_ACTION_INPUT = (shape: ZodRawShape) =>
  requireArgumentGroups(
    {
      ...shape,
      session_id: RPG_SESSION_ID.optional(),
      rpg_session_id: RPG_SESSION_ID_ALIAS.optional(),
      action_id: ACTION_ID.optional(),
      action: ACTION_ID_ALIAS.optional(),
    },
    [
      ["session_id", "rpg_session_id"],
      ["action_id", "action"],
    ],
  );

tool(
  "generate_rpg_pack",
  "Generate and validate a deterministic RPG pack from a seed without writing files. Start it with new_game.generate_rpg_seed.",
  {
    seed: G.describe("Generation seed."),
  },
  (a) => api.generate_rpg_pack(a),
);

tool(
  "new_game",
  "Start an RPG session from a generated pack (generate_rpg_seed is required; mint one with generate_rpg_pack). Shipped quests start with start_world_quest. Returns session_id, state_hash, compact context, and its legend.",
  {
    generate_rpg_seed: G.optional().describe("Seed from generate_rpg_pack."),
    seed: z.number().int().safe().optional().describe("Runtime seed."),
    ...HIDE_GRAPH,
    ...COMPACT_ACTIONS,
    ...COMPACT_OBSERVATION,
  },
  (a) => api.new_game(defaultCompactRpg(a)),
);
tool(
  "start_world_quest",
  "Start a shipped quest directly for development or QA. Players normally enter quests from the overworld. Returns session_id, state_hash, compact context, and its legend.",
  {
    world_quest_id: z.string().describe("Quest id from the shipped overworld quest registry."),
    seed: z.number().int().safe().optional().describe("Runtime seed."),
    ...HIDE_GRAPH,
    ...COMPACT_ACTIONS,
    ...COMPACT_OBSERVATION,
  },
  (a) => api.start_world_quest(defaultCompactRpg(a)),
);

tool(
  "get_observation",
  "Read the current RPG context without acting. Embedded quests also include the parent journey.",
  RPG_SESSION_INPUT({
    ...PLAYER_HIDE_GRAPH,
    ...IF_STATE_HASH,
    ...COMPACT_ACTIONS,
    ...COMPACT_OBSERVATION,
    include_character_continuity: B("Include the embedded quest's character continuity."),
  }),
  (a) => api.get_observation(defaultCompactRpg(a)),
);
tool(
  "list_legal_actions",
  "List legal actions and visible blocked actions with reasons.",
  RPG_SESSION_INPUT({
    ...IF_STATE_HASH,
    compact_actions: z
      .boolean()
      .optional()
      .describe(
        PLAY_MODE === "pure"
          ? "Set true for action ids without labels. The default includes labels."
          : "Set false to include action labels.",
      ),
  }),
  (a) => api.list_legal_actions(defaultCompactActions(a)),
);

tool(
  "step_action",
  "Take one legal RPG action. You may also submit a visible unavailable id to receive its blocked reason.",
  RPG_STEP_ACTION_INPUT({
    ...EXPECTED_STATE_HASH,
    ...PLAYER_HIDE_GRAPH,
    ...COMPACT_ACTIONS,
    ...COMPACT_EVENTS,
    ...COMPACT_OBSERVATION,
  }),
  (a) => api.step_action(defaultCompactRpg(a)),
);
tool(
  "get_state",
  "Read the RPG state hash without acting. Raw and compact state are optional.",
  RPG_SESSION_INPUT({
    ...IF_STATE_HASH,
    include_state: z.boolean().optional().describe("Include the raw state object."),
    compact_state: z.boolean().optional().describe("Include a compact state summary."),
  }),
  (a) => compactMcpState(a),
);
tool(
  "get_transcript",
  "Summarize the RPG play history. Turn rows and events are optional.",
  RPG_SESSION_INPUT({
    ...S,
    include_source: z.boolean().optional(),
    ...IF_TRANSCRIPT_HASH,
    summary_only: z.boolean().optional().describe("False adds per-turn rows."),
    compact_summary: z.boolean().optional().describe("False keeps verbose summary labels."),
    compact_turns: z.boolean().optional().describe("Turn rows as tuples."),
    turn_limit: z.number().int().min(0).optional().describe("Max turn rows."),
    ...COMPACT_EVENTS,
  }),
  (a) => api.get_transcript(defaultCompactTranscript(a)),
);
tool(
  "save_game",
  "Create a save string for load_game. The expected hash rejects stale state.",
  RPG_SESSION_INPUT({
    ...EXPECTED_STATE_HASH,
    ...IF_STATE_HASH,
    include_source: z.boolean().optional().describe("Echo source id."),
    include_content_hash: z.boolean().optional().describe("Echo content hash."),
  }),
  (a) => api.save_game(a),
);
tool(
  "load_game",
  "Restore an RPG save as a new session. Returns a new session_id, compact context, and its legend.",
  {
    world_quest_id: z.string().optional().describe("World quest id."),
    generate_rpg_seed: G.optional().describe("Seed for generated-pack saves."),
    save: z.string().max(MCP_SAVE_CHAR_LIMIT).describe("Save string from save_game."),
    ...HIDE_GRAPH,
    ...COMPACT_ACTIONS,
    ...COMPACT_OBSERVATION,
  },
  (a) => api.load_game(defaultCompactRpg(a)),
);

tool(
  "replay_trace",
  "Replay an action trace and verify its final state hash.",
  {
    trace_path: z.string().describe("Trace path."),
    world_quest_id: z.string().optional().describe("World quest id."),
  },
  (a) => api.replay_trace(a),
);

tool(
  "adapt_story",
  "Run the offline demo authoring pipeline and return its report. Its canned author returns the same sample Lighthouse pack for any premise.",
  {
    premise: z.string().describe("Story premise (not used by the canned author)."),
    include_pack: z.boolean().optional().describe("Echo the authored pack."),
  },
  (a) => api.adapt_story(a),
);

tool(
  "inspect_trace",
  "Inspect an action trace. Returns step summaries, hash checks, and possible bug causes.",
  {
    trace_path: z.string().describe("Trace path."),
    world_quest_id: z.string().optional().describe("World quest id."),
    compact_summary: z.boolean().optional().describe("Step summaries as tuple rows."),
  },
  (a) => api.inspect_trace(a),
);

tool(
  "apply_content_patch",
  "Validate a proposed content patch for a shipped quest and return proof. Does not write files.",
  {
    ...WORLD_QUEST_SOURCE,
    include_pack: z.boolean().optional().describe("Echo the patched pack."),
    proposal: z
      .object({
        layer: z.enum([
          "content",
          "engine_rule",
          "validator",
          "test",
          "hint_text",
          "quest_structure",
        ]),
        summary: z.string(),
        ops: z
          .array(z.record(z.string(), z.unknown()))
          .max(MCP_PATCH_OPS_LIMIT)
          .describe("Validated patch ops."),
      })
      .describe("Op-based patch proposal."),
  },
  (a) => api.apply_content_patch(a as never),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is the MCP transport.
  process.stderr.write("adventureforge MCP server ready on stdio\n");
  announceSpectate();
}

// Connect the stdio transport only when this module is the process entrypoint
// (`npm run mcp` / `tsx src/mcp/server.ts`). Importing it — e.g. from
// tests/unit/compact_legend.test.ts to read TOOL_REGISTRATIONS — must not
// hijack stdin/stdout.
const entryPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
const isDirectRun =
  entryPath !== "" && entryPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isDirectRun) {
  main().catch((e) => {
    process.stderr.write(`Fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
