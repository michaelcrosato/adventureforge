import { createHash } from "node:crypto";
import { basename, isAbsolute, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
// @ts-expect-error -- hardened runner module is intentionally plain ESM.
import { inspectCodexPureEvidence } from "../../blind-tester/codex-pure-envelope.mjs";
import { verifyBlindReportText } from "../blind/report_verifier.js";
import {
  PureReportRecoveryMetadataSchema,
  extractRecoveredReport,
} from "../blind/report_recovery.js";
import {
  PureReceiptBindingMetadataSchema,
  reproducePureCodexReceiptBinding,
} from "../blind/receipt_binding.js";
import {
  parseBlindRunSidecar,
  parseRunEvidenceJsonl,
  PureRunBuildSchema,
  type PureBlindRunSidecar,
} from "../blind/run_evidence.js";
import { parseJsonRejectingDuplicateKeys } from "../blind/strict_json.js";
import { certifiedModelTransport, isCertifiedFleetModel } from "../blind/providers.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export const PureFleetPrimaryClaudeEnvelopeSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.literal("success"),
    is_error: z.literal(false),
    session_id: z.string().uuid(),
    result: z.string(),
    stop_reason: z.literal("end_turn"),
    terminal_reason: z.literal("completed"),
    permission_denials: z.array(z.unknown()).length(0),
    modelUsage: z.record(z.unknown()),
  })
  .passthrough();

/**
 * Which models may produce certified pure-fleet evidence — DERIVED, not listed.
 *
 * This was four hardcoded model ids and two hardcoded vendor names, and the cost was not
 * theoretical: a model an operator's subscription had just unlocked could not be
 * certified without a TypeScript edit, a rebuild and a sweep of ~18k lines of tests, so
 * in practice the certified fleet stayed frozen at whatever was current the day the array
 * was written. That is precisely the homogeneity `familyDiversity` exists to prevent —
 * forty runs of one model agreeing is one instrument sampled forty times.
 *
 * The authority is now `certifiedFleetModels()` in ../blind/providers.ts, which answers
 * from two facts that cannot be asserted into existence: the model's catalog entry sets
 * `certified: true`, AND its provider derives `runner_enforced` in this checkout (a
 * capture reader for it is actually on disk). Adding a certified model is a catalog edit;
 * adding a certified VENDOR still requires the reader module that can witness it, which
 * is the guarantee this file must never trade away.
 *
 * The type widens to `string` as a consequence, and that is the honest type: the set is
 * a fact about this checkout's catalogs, not about the compiler's view of the world.
 * Runtime validation is unchanged in strength — every id is still checked against the
 * certified set before any evidence is admitted.
 */
export const CertifiedCodexModelSchema = z
  .string()
  .min(1)
  .refine((id) => isCertifiedFleetModel("codex", id), {
    message: "model is not certified for the codex provider in this checkout's catalog",
  });
type CertifiedCodexModel = string;
export type CertifiedClaudeModel = string;
export type PureFleetProvider = string;
export type CertifiedFleetModel = string;

const PureFleetPrimaryCodexEnvelopeSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.literal("success"),
    provider: z.literal("codex"),
    is_error: z.literal(false),
    session_id: z.string().uuid(),
    result: z.string(),
    terminal_reason: z.literal("completed"),
    num_turns: z.number().int().positive(),
    requested_model: CertifiedCodexModelSchema,
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative().safe(),
        cache_read_input_tokens: z.number().int().nonnegative().safe(),
        output_tokens: z.number().int().nonnegative().safe(),
        reasoning_output_tokens: z.number().int().nonnegative().safe(),
      })
      .strict()
      .superRefine((usage, context) => {
        if (usage.cache_read_input_tokens > usage.input_tokens) {
          context.addIssue({
            code: "custom",
            path: ["cache_read_input_tokens"],
            message: "cache-read input cannot exceed total input",
          });
        }
      }),
    modelUsage: z.record(
      z.string(),
      z
        .object({
          inputTokens: z.number().int().nonnegative().safe(),
          cacheReadInputTokens: z.number().int().nonnegative().safe(),
          outputTokens: z.number().int().nonnegative().safe(),
          reasoningOutputTokens: z.number().int().nonnegative().safe(),
        })
        .strict(),
    ),
  })
  .passthrough();

export interface PureFleetRunArtifactBytes {
  report: Uint8Array;
  runSidecar: Uint8Array;
  runEvidence: Uint8Array;
  primaryEnvelope: Uint8Array;
  initialReport: Uint8Array | null;
  receiptBinding?: Uint8Array | null;
  recoveryMetadata: Uint8Array | null;
  recoveryEnvelope: Uint8Array | null;
  providerEvents: Uint8Array | null;
  providerRollout: Uint8Array | null;
  providerCapture: Uint8Array | null;
}

interface PureFleetRunArtifactPaths {
  report: string;
  runSidecar: string;
  runEvidence: string;
  primaryEnvelope: string;
  initialReport: string;
  receiptBinding: string;
  recoveryMetadata: string;
  recoveryEnvelope: string;
  providerEvents: string;
  providerRollout: string;
  providerCapture: string;
}

export function pureFleetRunArtifactPaths(reportPath: string): PureFleetRunArtifactPaths {
  const prefix = /\.md$/iu.test(reportPath) ? reportPath.slice(0, -".md".length) : reportPath;
  return {
    report: reportPath,
    runSidecar: `${prefix}.run.json`,
    runEvidence: `${prefix}.evidence.jsonl`,
    primaryEnvelope: `${prefix}.json`,
    initialReport: `${prefix}.initial-report.txt`,
    receiptBinding: `${prefix}.receipt-bind.json`,
    recoveryMetadata: `${prefix}.repair.meta.json`,
    recoveryEnvelope: `${prefix}.repair.json`,
    providerEvents: `${prefix}.codex.jsonl`,
    providerRollout: `${prefix}.codex-rollout.jsonl`,
    providerCapture: `${prefix}.codex-capture.json`,
  };
}

export interface PureFleetRunArtifactExpectation {
  seed: number;
  provider: PureFleetProvider;
  model: CertifiedFleetModel;
  build: z.infer<typeof PureRunBuildSchema> & { tracked_worktree_clean: true };
  /** Forward-only report contract; omitted for historical artifact readability. */
  requireStructuredIssueConsistency?: boolean;
  /** Ordinary QA may pin a different effort; certification retains its xhigh default. */
  expectedReasoningEffort?: string;
}

interface PureFleetRunArtifactHashes {
  report_sha256: string;
  run_sidecar_sha256: string;
  run_evidence_sha256: string;
  primary_envelope_sha256: string;
  initial_report_sha256: string | null;
  receipt_binding_sha256: string | null;
  recovery_metadata_sha256: string | null;
  recovery_envelope_sha256: string | null;
  provider_events_sha256: string | null;
  provider_rollout_sha256: string | null;
  provider_capture_sha256: string | null;
}

interface PureFleetRunArtifactFacts {
  run: Extract<PureBlindRunSidecar, { schema_version: 2 }>;
  game_session_id: string;
  provider: PureFleetProvider;
  provider_session_id: string;
  actual_model: string;
  actual_provider: "anthropic" | "openai";
  reasoning_effort: string | null;
  provider_turn_id: string | null;
  provider_cwd: string | null;
  code_mode_contract:
    | typeof CODEX_HISTORICAL_STRICT_CONTRACT
    | typeof CODEX_STRICT_CURRENT_CONTRACT
    | null;
  transport_contract:
    | typeof SPARK_DIRECT_MCP_TRANSPORT_CONTRACT
    | typeof GAME_DIRECT_MCP_TRANSPORT_CONTRACT
    | null;
  report_recovered: boolean;
  report_receipt_bound: boolean;
  hashes: PureFleetRunArtifactHashes;
}

type PureFleetRunArtifactValidation =
  | { ok: true; facts: PureFleetRunArtifactFacts }
  | { ok: false; reason: string };

const decoder = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(
  bytes: Uint8Array,
  label: string,
): { ok: true; text: string } | { ok: false; reason: string } {
  try {
    return { ok: true, text: decoder.decode(bytes) };
  } catch {
    return { ok: false, reason: `${label} is not valid UTF-8` };
  }
}

export function sha256ArtifactBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function singletonModelUsageKey(
  modelUsage: Record<string, unknown>,
): { ok: true; key: string } | { ok: false; reason: string } {
  const keys = Object.keys(modelUsage);
  return keys.length === 1
    ? { ok: true, key: keys[0]! }
    : {
        ok: false,
        reason: `primary Claude modelUsage must contain exactly one model (found ${keys.length})`,
      };
}

export function pureFleetModelMatchesRequest(actual: string, requested: string): boolean {
  const normalized = requested.toLowerCase();
  if (["haiku", "sonnet", "opus"].includes(normalized)) {
    return actual.toLowerCase().split("-").includes(normalized);
  }
  return actual === requested;
}

function parsePrimaryEnvelope(
  text: string,
  requestedModel: string,
):
  | {
      ok: true;
      envelope: z.infer<typeof PureFleetPrimaryClaudeEnvelopeSchema>;
      actualModel: string;
    }
  | { ok: false; reason: string } {
  const raw = parseJsonRejectingDuplicateKeys(text, "primary Claude envelope");
  if (!raw.ok) return raw;
  const parsed = PureFleetPrimaryClaudeEnvelopeSchema.safeParse(raw.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `primary Claude envelope is not a completed clean turn: ${issue?.path.join(".") ?? "?"} — ${issue?.message ?? "schema mismatch"}`,
    };
  }
  const model = singletonModelUsageKey(parsed.data.modelUsage);
  if (!model.ok) return model;
  if (!pureFleetModelMatchesRequest(model.key, requestedModel)) {
    return {
      ok: false,
      reason: `primary Claude model ${model.key} does not match planned model ${requestedModel}`,
    };
  }
  return { ok: true, envelope: parsed.data, actualModel: model.key };
}

function parseJsonLines(
  text: string,
  label: string,
): { ok: true; rows: unknown[] } | { ok: false; reason: string } {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { ok: false, reason: `${label} is empty` };
  try {
    return { ok: true, rows: lines.map((line) => JSON.parse(line) as unknown) };
  } catch {
    return { ok: false, reason: `${label} is not valid JSONL` };
  }
}

const CodexSessionMetaSchema = z
  .object({
    id: z.string().uuid(),
    cwd: z.string().min(1),
    cli_version: z.string().min(1),
    model_provider: z.literal("openai"),
  })
  .passthrough();

const CodexTurnContextSchema = z
  .object({
    turn_id: z.string().uuid(),
    cwd: z.string().min(1),
    approval_policy: z.literal("never"),
    sandbox_policy: z.object({ type: z.literal("read-only") }).passthrough(),
    model: CertifiedCodexModelSchema,
    effort: z.string().min(1),
  })
  .passthrough();

const CodexDirectoryIdentitySchema = z
  .object({
    device_id: z.string().regex(/^\d+$/),
    file_id: z.string().regex(/^\d+$/),
  })
  .strict();

const CodexCaptureReceiptSchema = z
  .object({
    schema_version: z.literal(1),
    binding: z.literal("runner_work_player"),
    recorded_session_cwd: z.string().min(1),
    recorded_turn_cwd: z.string().min(1),
    canonical_expected_cwd: z.string().min(1),
    canonical_session_cwd: z.string().min(1),
    canonical_turn_cwd: z.string().min(1),
    expected_directory_identity: CodexDirectoryIdentitySchema,
    session_directory_identity: CodexDirectoryIdentitySchema,
    turn_directory_identity: CodexDirectoryIdentitySchema,
    copied_rollout_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const CODEX_HISTORICAL_STRICT_CONTRACT = "strict-code-mode-v1" as const;
const CODEX_STRICT_CURRENT_CONTRACT = "strict-code-mode-v2" as const;
export const SPARK_DIRECT_MCP_TRANSPORT_CONTRACT = "spark-direct-mcp-v1" as const;
const GAME_DIRECT_MCP_TRANSPORT_CONTRACT = "game-direct-mcp-v1" as const;
export const SPARK_DIRECT_MCP_MODEL = "gpt-5.3-codex-spark" as const;

const HistoricalStrictCodexCaptureReceiptSchema = CodexCaptureReceiptSchema.omit({
  schema_version: true,
})
  .extend({
    schema_version: z.literal(2),
    code_mode_contract: z.literal(CODEX_HISTORICAL_STRICT_CONTRACT),
  })
  .strict();

const CurrentCodexCaptureReceiptSchema = CodexCaptureReceiptSchema.omit({ schema_version: true })
  .extend({
    schema_version: z.literal(3),
    code_mode_contract: z.literal(CODEX_STRICT_CURRENT_CONTRACT),
  })
  .strict();

const SparkDirectMcpCodexCaptureReceiptSchema = CodexCaptureReceiptSchema.omit({
  schema_version: true,
})
  .extend({
    schema_version: z.literal(4),
    transport_contract: z.literal(SPARK_DIRECT_MCP_TRANSPORT_CONTRACT),
  })
  .strict();

const GameDirectMcpCodexCaptureReceiptSchema = CodexCaptureReceiptSchema.omit({
  schema_version: true,
})
  .extend({
    schema_version: z.literal(5),
    transport_contract: z.literal(GAME_DIRECT_MCP_TRANSPORT_CONTRACT),
  })
  .strict();

const AnyCodexCaptureReceiptSchema = z.union([
  CodexCaptureReceiptSchema,
  HistoricalStrictCodexCaptureReceiptSchema,
  CurrentCodexCaptureReceiptSchema,
  SparkDirectMcpCodexCaptureReceiptSchema,
  GameDirectMcpCodexCaptureReceiptSchema,
]);

interface CodexAuthorityFacts {
  sessionId: string;
  actualModel: CertifiedCodexModel;
  reasoningEffort: string;
  turnId: string;
  cwd: string;
  codeModeContract:
    | typeof CODEX_HISTORICAL_STRICT_CONTRACT
    | typeof CODEX_STRICT_CURRENT_CONTRACT
    | null;
  transportContract:
    | typeof SPARK_DIRECT_MCP_TRANSPORT_CONTRACT
    | typeof GAME_DIRECT_MCP_TRANSPORT_CONTRACT
    | null;
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
  };
}

function finalCodexPublicMessage(rows: unknown[]): string | null {
  let final: string | null = null;
  for (const row of rows) {
    if (!isRecord(row) || row.type !== "item.completed" || !isRecord(row.item)) continue;
    if (row.item.type === "agent_message" && typeof row.item.text === "string")
      final = row.item.text;
  }
  return final;
}

function finalCodexRolloutMessage(rows: unknown[]): { text: string; index: number } | null {
  let final: { text: string; index: number } | null = null;
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row) || row.type !== "response_item" || !isRecord(row.payload)) continue;
    if (
      row.payload.type !== "message" ||
      row.payload.role !== "assistant" ||
      !Array.isArray(row.payload.content)
    )
      continue;
    const text = row.payload.content
      .filter(
        (part): part is Record<string, unknown> =>
          isRecord(part) && part.type === "output_text" && typeof part.text === "string",
      )
      .map((part) => String(part.text))
      .join("");
    if (text.length > 0) final = { text, index };
  }
  return final;
}

const CodexTaskStartedSchema = z
  .object({ type: z.literal("task_started"), turn_id: z.string().uuid() })
  .passthrough();

const CodexTaskCompleteSchema = z
  .object({
    type: z.literal("task_complete"),
    turn_id: z.string().uuid(),
    last_agent_message: z.string(),
  })
  .passthrough();

function indexedEventMessages(
  rows: unknown[],
  eventType: string,
): { index: number; row: unknown }[] {
  return rows.flatMap((row, index) =>
    isRecord(row) &&
    row.type === "event_msg" &&
    isRecord(row.payload) &&
    row.payload.type === eventType
      ? [{ index, row }]
      : [],
  );
}

function isAbsolutePlayerDirectory(path: string): boolean {
  const pathBasename = basename(path);
  return (
    (isAbsolute(path) || win32.isAbsolute(path)) &&
    (pathBasename === "player" || win32.basename(path) === "player")
  );
}

function forbiddenCodexLifecycleType(row: unknown): string | null {
  if (!isRecord(row)) return null;
  if (typeof row.type === "string" && /(?:abort|cancel|error|fail)/iu.test(row.type)) {
    return row.type;
  }
  if (
    row.type === "event_msg" &&
    isRecord(row.payload) &&
    typeof row.payload.type === "string" &&
    /(?:abort|cancel|error|fail)/iu.test(row.payload.type)
  ) {
    return row.payload.type;
  }
  return null;
}

function parseCodexCaptureReceipt(
  captureText: string,
  rolloutText: string,
  sessionCwd: string,
  turnCwd: string,
):
  | {
      ok: true;
      canonicalCwd: string;
      codeModeContract:
        | typeof CODEX_HISTORICAL_STRICT_CONTRACT
        | typeof CODEX_STRICT_CURRENT_CONTRACT
        | null;
      transportContract:
        | typeof SPARK_DIRECT_MCP_TRANSPORT_CONTRACT
        | typeof GAME_DIRECT_MCP_TRANSPORT_CONTRACT
        | null;
    }
  | { ok: false; reason: string } {
  const raw = parseJsonRejectingDuplicateKeys(captureText, "Codex capture receipt");
  if (!raw.ok) return { ok: false, reason: raw.reason };
  const parsed = AnyCodexCaptureReceiptSchema.safeParse(raw.value);
  if (!parsed.success) {
    return { ok: false, reason: "Codex capture receipt is not an exact runner-work-player proof" };
  }
  const receipt = parsed.data;
  if (receipt.recorded_session_cwd !== sessionCwd || receipt.recorded_turn_cwd !== turnCwd) {
    return { ok: false, reason: "Codex capture receipt recorded cwd differs from rollout bytes" };
  }
  if (
    receipt.canonical_expected_cwd !== receipt.canonical_session_cwd ||
    receipt.canonical_expected_cwd !== receipt.canonical_turn_cwd ||
    !isAbsolutePlayerDirectory(receipt.canonical_expected_cwd)
  ) {
    return {
      ok: false,
      reason: "Codex capture receipt does not bind one canonical isolated player cwd",
    };
  }
  if (
    !isDeepStrictEqual(receipt.expected_directory_identity, receipt.session_directory_identity) ||
    !isDeepStrictEqual(receipt.expected_directory_identity, receipt.turn_directory_identity)
  ) {
    return { ok: false, reason: "Codex capture receipt directory identities differ" };
  }
  if (receipt.copied_rollout_sha256 !== sha256ArtifactBytes(exactUtf8Bytes(rolloutText))) {
    return { ok: false, reason: "Codex capture receipt rollout hash differs from copied bytes" };
  }
  return {
    ok: true,
    canonicalCwd: receipt.canonical_expected_cwd,
    codeModeContract:
      receipt.schema_version === 2 || receipt.schema_version === 3
        ? receipt.code_mode_contract
        : null,
    transportContract:
      receipt.schema_version === 4 || receipt.schema_version === 5
        ? receipt.transport_contract
        : null,
  };
}

function isExactCodexTurnContextReplay(
  initial: Record<string, unknown>,
  replay: Record<string, unknown>,
): boolean {
  const initialKeys = Object.keys(initial).sort();
  const replayKeys = Object.keys(replay).sort();
  if (!isDeepStrictEqual(replayKeys, initialKeys)) return false;
  if (
    Object.hasOwn(initial, "timestamp") &&
    (typeof initial.timestamp !== "string" || typeof replay.timestamp !== "string")
  ) {
    return false;
  }
  return initialKeys.every(
    (key) => key === "timestamp" || isDeepStrictEqual(replay[key], initial[key]),
  );
}

function codexTurnContexts(
  rows: unknown[],
):
  | { ok: true; initial: { index: number; row: Record<string, unknown> } }
  | { ok: false; reason: string } {
  const contexts = rows.flatMap((row, index) =>
    isRecord(row) && row.type === "turn_context" ? [{ index, row }] : [],
  );
  if (contexts.length === 0) {
    return { ok: false, reason: "Codex rollout requires one initial turn_context" };
  }
  const initial = contexts[0]!;
  for (const duplicate of contexts.slice(1)) {
    const precedingCompacted = rows[duplicate.index - 2];
    const precedingWorldState = rows[duplicate.index - 1];
    const exactDuplicate = isExactCodexTurnContextReplay(initial.row, duplicate.row);
    const followsCompaction =
      duplicate.index >= 2 &&
      isRecord(precedingCompacted) &&
      precedingCompacted.type === "compacted" &&
      isRecord(precedingWorldState) &&
      precedingWorldState.type === "world_state";
    const followsCompletion = rows
      .slice(0, duplicate.index)
      .some(
        (row) =>
          isRecord(row) &&
          row.type === "event_msg" &&
          isRecord(row.payload) &&
          row.payload.type === "task_complete",
      );
    if (!exactDuplicate || !followsCompaction || followsCompletion) {
      return {
        ok: false,
        reason:
          "Codex rollout permits duplicate turn_context only as an exact compacted pre-completion replay",
      };
    }
  }
  return { ok: true, initial };
}

function parseCodexAuthority(
  eventsText: string,
  rolloutText: string,
  captureText: string,
  expectedModel: CertifiedCodexModel,
  report: string,
  expectedEffort = "xhigh",
): { ok: true; facts: CodexAuthorityFacts } | { ok: false; reason: string } {
  const events = parseJsonLines(eventsText, "Codex provider events");
  if (!events.ok) return events;
  const rollout = parseJsonLines(rolloutText, "Codex rollout");
  if (!rollout.ok) return rollout;
  if (finalCodexPublicMessage(events.rows) !== report) {
    return { ok: false, reason: "Codex public final message bytes do not equal the report" };
  }
  const sessionRows = rollout.rows.flatMap((row, index) =>
    isRecord(row) && row.type === "session_meta" ? [{ index, row }] : [],
  );
  if (sessionRows.length !== 1 || sessionRows[0]?.index !== 0) {
    return {
      ok: false,
      reason: `Codex rollout requires one leading session_meta (found ${sessionRows.length})`,
    };
  }
  const turnContexts = codexTurnContexts(rollout.rows);
  if (!turnContexts.ok) return turnContexts;
  const turnRow = turnContexts.initial;
  const session = CodexSessionMetaSchema.safeParse(
    (sessionRows[0]!.row as Record<string, unknown>).payload,
  );
  if (!session.success) return { ok: false, reason: "Codex rollout session_meta is malformed" };
  const turn = CodexTurnContextSchema.safeParse((turnRow.row as Record<string, unknown>).payload);
  if (!turn.success || turn.data.effort !== expectedEffort)
    return {
      ok: false,
      reason: `Codex rollout turn_context is not a strict read-only ${expectedEffort} turn`,
    };
  if (turn.data.model !== expectedModel) {
    return {
      ok: false,
      reason: `Codex rollout actual model ${turn.data.model} differs from planned ${expectedModel}`,
    };
  }
  if (turn.data.cwd !== session.data.cwd) {
    return { ok: false, reason: "Codex rollout turn cwd differs from session cwd" };
  }
  if (!isAbsolutePlayerDirectory(turn.data.cwd)) {
    return { ok: false, reason: "Codex rollout cwd is not an absolute isolated player directory" };
  }
  const capture = parseCodexCaptureReceipt(
    captureText,
    rolloutText,
    session.data.cwd,
    turn.data.cwd,
  );
  if (!capture.ok) return capture;
  // A direct-MCP receipt must name the transport its model's CATALOG declares.
  //
  // This was two hardcoded pairs — "spark-direct-mcp-v1 requires gpt-5.3-codex-spark",
  // "game-direct-mcp-v1 requires gpt-5.6-terra" — which had to be extended by hand for
  // every new direct-MCP model and, being a closed list, silently ADMITTED any pairing
  // it did not enumerate. Asking the catalog instead is both general and strictly
  // tighter: a model whose declared transport disagrees with the receipt is rejected
  // whether or not anyone remembered to write its name here.
  //
  // Only direct-MCP receipts carry `transportContract`; strict-code-mode receipts record
  // `codeModeContract` and leave this null, so they are not gated here — exactly as
  // before, and deliberately, since historical v1 code-mode evidence must stay readable.
  if (capture.transportContract !== null) {
    const declared = certifiedModelTransport("codex", expectedModel)?.contract ?? null;
    if (declared !== capture.transportContract) {
      return {
        ok: false,
        reason:
          `${capture.transportContract} receipt does not match the catalog transport for ` +
          `model ${expectedModel} (declares ${declared ?? "no certified transport"})`,
      };
    }
  }
  const inspected:
    | { ok: true; threadId: string; usage: CodexAuthorityFacts["usage"] }
    | {
        ok: false;
        reason: string;
      } = inspectCodexPureEvidence(events.rows, rollout.rows, expectedModel, {
    codeModeContract: capture.codeModeContract,
    transportContract: capture.transportContract ?? capture.codeModeContract,
    cliVersion: session.data.cli_version,
    expectedEffort,
  });
  if (!inspected.ok)
    return { ok: false, reason: `Codex provider evidence rejected: ${inspected.reason}` };
  if (session.data.id !== inspected.threadId) {
    return { ok: false, reason: "Codex rollout session id differs from public thread.started" };
  }
  const forbiddenTerminal = rollout.rows
    .map(forbiddenCodexLifecycleType)
    .find((type): type is string => type !== null);
  if (forbiddenTerminal !== undefined) {
    return {
      ok: false,
      reason: `Codex rollout contains forbidden abort/error lifecycle ${forbiddenTerminal}`,
    };
  }
  const taskStarts = indexedEventMessages(rollout.rows, "task_started");
  const taskCompletes = indexedEventMessages(rollout.rows, "task_complete");
  if (taskStarts.length !== 1 || taskCompletes.length !== 1) {
    return {
      ok: false,
      reason: `Codex rollout requires exactly one task_started and task_complete (found ${taskStarts.length}/${taskCompletes.length})`,
    };
  }
  if (taskCompletes[0]!.index !== rollout.rows.length - 1) {
    return { ok: false, reason: "Codex rollout task_complete must be the final rollout row" };
  }
  const taskStarted = CodexTaskStartedSchema.safeParse(
    (taskStarts[0]!.row as Record<string, unknown>).payload,
  );
  const taskComplete = CodexTaskCompleteSchema.safeParse(
    (taskCompletes[0]!.row as Record<string, unknown>).payload,
  );
  if (!taskStarted.success || !taskComplete.success) {
    return { ok: false, reason: "Codex rollout task lifecycle is malformed" };
  }
  if (
    taskStarted.data.turn_id !== turn.data.turn_id ||
    taskComplete.data.turn_id !== turn.data.turn_id
  ) {
    return { ok: false, reason: "Codex rollout task lifecycle turn id differs from turn_context" };
  }
  const finalMessage = finalCodexRolloutMessage(rollout.rows);
  if (finalMessage?.text !== report || taskComplete.data.last_agent_message !== report) {
    return {
      ok: false,
      reason: "Codex rollout final assistant and task_complete message bytes must equal the report",
    };
  }
  if (
    !(
      taskStarts[0]!.index < turnRow.index &&
      turnRow.index < finalMessage.index &&
      finalMessage.index < taskCompletes[0]!.index
    )
  ) {
    return {
      ok: false,
      reason: "Codex rollout task lifecycle is out of order",
    };
  }
  return {
    ok: true,
    facts: {
      sessionId: session.data.id,
      actualModel: turn.data.model,
      reasoningEffort: turn.data.effort,
      turnId: turn.data.turn_id,
      cwd: capture.canonicalCwd,
      codeModeContract: capture.codeModeContract,
      transportContract: capture.transportContract,
      usage: inspected.usage,
    },
  };
}

export function validateCodexFleetProviderAuthority(input: {
  events: string;
  rollout: string;
  capture: string;
  model: CertifiedCodexModel;
  report: string;
}): { ok: true; facts: CodexAuthorityFacts } | { ok: false; reason: string } {
  return parseCodexAuthority(input.events, input.rollout, input.capture, input.model, input.report);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function exactUtf8Bytes(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

function artifactHashes(input: PureFleetRunArtifactBytes): PureFleetRunArtifactHashes {
  return {
    report_sha256: sha256ArtifactBytes(input.report),
    run_sidecar_sha256: sha256ArtifactBytes(input.runSidecar),
    run_evidence_sha256: sha256ArtifactBytes(input.runEvidence),
    primary_envelope_sha256: sha256ArtifactBytes(input.primaryEnvelope),
    initial_report_sha256:
      input.initialReport === null ? null : sha256ArtifactBytes(input.initialReport),
    receipt_binding_sha256:
      input.receiptBinding == null ? null : sha256ArtifactBytes(input.receiptBinding),
    recovery_metadata_sha256:
      input.recoveryMetadata === null ? null : sha256ArtifactBytes(input.recoveryMetadata),
    recovery_envelope_sha256:
      input.recoveryEnvelope === null ? null : sha256ArtifactBytes(input.recoveryEnvelope),
    provider_events_sha256:
      input.providerEvents === null ? null : sha256ArtifactBytes(input.providerEvents),
    provider_rollout_sha256:
      input.providerRollout === null ? null : sha256ArtifactBytes(input.providerRollout),
    provider_capture_sha256:
      input.providerCapture === null ? null : sha256ArtifactBytes(input.providerCapture),
  };
}

export function validatePureFleetRunArtifactBytes(
  input: PureFleetRunArtifactBytes,
  expected: PureFleetRunArtifactExpectation,
): PureFleetRunArtifactValidation {
  const decoded = {
    report: decodeUtf8(input.report, "report"),
    runSidecar: decodeUtf8(input.runSidecar, "run sidecar"),
    runEvidence: decodeUtf8(input.runEvidence, "run evidence"),
    primaryEnvelope: decodeUtf8(input.primaryEnvelope, "primary provider envelope"),
    providerEvents:
      input.providerEvents === null
        ? null
        : decodeUtf8(input.providerEvents, "Codex provider events"),
    providerRollout:
      input.providerRollout === null ? null : decodeUtf8(input.providerRollout, "Codex rollout"),
    providerCapture:
      input.providerCapture === null
        ? null
        : decodeUtf8(input.providerCapture, "Codex capture receipt"),
  };
  if (!decoded.report.ok) return decoded.report;
  if (!decoded.runSidecar.ok) return decoded.runSidecar;
  if (!decoded.runEvidence.ok) return decoded.runEvidence;
  if (!decoded.primaryEnvelope.ok) return decoded.primaryEnvelope;
  if (decoded.providerEvents !== null && !decoded.providerEvents.ok) return decoded.providerEvents;
  if (decoded.providerRollout !== null && !decoded.providerRollout.ok)
    return decoded.providerRollout;
  if (decoded.providerCapture !== null && !decoded.providerCapture.ok)
    return decoded.providerCapture;

  const parsedSidecar = parseBlindRunSidecar(decoded.runSidecar.text);
  if (!parsedSidecar.ok) return parsedSidecar;
  if (parsedSidecar.sidecar.play_mode !== "pure" || parsedSidecar.sidecar.schema_version !== 2) {
    return { ok: false, reason: "run sidecar is not current pure evidence schema v2" };
  }
  const run = parsedSidecar.sidecar;
  const parsedEvidence = parseRunEvidenceJsonl(decoded.runEvidence.text);
  if (!parsedEvidence.ok) return { ok: false, reason: parsedEvidence.reason };
  if (parsedEvidence.sidecar.schema_version !== 2) {
    return { ok: false, reason: "raw run evidence is not current schema v2" };
  }
  if (!isDeepStrictEqual(parsedEvidence.sidecar, run)) {
    return { ok: false, reason: "raw run evidence does not reproduce the adjacent run sidecar" };
  }
  if (run.run_seed !== expected.seed) {
    return { ok: false, reason: "run evidence seed does not match the planned slot" };
  }
  if (!isDeepStrictEqual(run.build, expected.build)) {
    return { ok: false, reason: "run evidence build does not match the frozen fleet build" };
  }

  const reportVerification = verifyBlindReportText(decoded.report.text, {
    requiredPlayMode: "pure",
    requireStructuredIssueConsistency: expected.requireStructuredIssueConsistency === true,
    runSidecar: run,
  });
  if (!reportVerification.ok) {
    return { ok: false, reason: `report verification failed: ${reportVerification.reason}` };
  }

  if (expected.provider === "codex") {
    const expectedModel = CertifiedCodexModelSchema.safeParse(expected.model);
    if (!expectedModel.success) {
      return { ok: false, reason: "Codex fleet plan requires one exact certified Codex model id" };
    }
    if (input.recoveryMetadata !== null || input.recoveryEnvelope !== null) {
      return { ok: false, reason: "Codex certified runs do not permit report recovery artifacts" };
    }
    const receiptBindingPresence = [input.initialReport !== null, input.receiptBinding != null];
    if (receiptBindingPresence.some(Boolean) && !receiptBindingPresence.every(Boolean)) {
      return {
        ok: false,
        reason: "Codex receipt-binding artifacts must be either both absent or both present",
      };
    }
    const reportReceiptBound = receiptBindingPresence.every(Boolean);
    if (
      decoded.providerEvents === null ||
      decoded.providerRollout === null ||
      decoded.providerCapture === null
    ) {
      return {
        ok: false,
        reason:
          "Codex certified runs require provider events, one rollout, and its capture receipt",
      };
    }
    const primaryRaw = parseJsonRejectingDuplicateKeys(
      decoded.primaryEnvelope.text,
      "primary Codex envelope",
    );
    if (!primaryRaw.ok) return primaryRaw;
    const primary = PureFleetPrimaryCodexEnvelopeSchema.safeParse(primaryRaw.value);
    if (!primary.success) {
      return { ok: false, reason: "primary Codex envelope is not a completed audited turn" };
    }
    if (primary.data.requested_model !== expectedModel.data) {
      return { ok: false, reason: "primary Codex requested model differs from the planned run" };
    }
    const modelUsageEntries = Object.entries(primary.data.modelUsage);
    if (
      modelUsageEntries.length !== 1 ||
      modelUsageEntries[0]![0] !== primary.data.requested_model
    ) {
      return {
        ok: false,
        reason: "primary Codex modelUsage must contain exactly the requested model",
      };
    }
    const primaryModelUsage = modelUsageEntries[0]![1];
    if (
      primaryModelUsage.inputTokens !== primary.data.usage.input_tokens ||
      primaryModelUsage.cacheReadInputTokens !== primary.data.usage.cache_read_input_tokens ||
      primaryModelUsage.outputTokens !== primary.data.usage.output_tokens ||
      primaryModelUsage.reasoningOutputTokens !== primary.data.usage.reasoning_output_tokens
    ) {
      return { ok: false, reason: "primary Codex modelUsage differs from primary usage" };
    }
    let providerReport = decoded.report.text;
    if (!reportReceiptBound) {
      if (!bytesEqual(input.report, exactUtf8Bytes(primary.data.result))) {
        return { ok: false, reason: "primary Codex result bytes do not equal the final report" };
      }
    } else {
      const decodedInitial = decodeUtf8(input.initialReport!, "initial Codex report");
      const decodedBinding = decodeUtf8(input.receiptBinding!, "receipt binding metadata");
      if (!decodedInitial.ok) return decodedInitial;
      if (!decodedBinding.ok) return decodedBinding;
      if (!bytesEqual(input.initialReport!, exactUtf8Bytes(primary.data.result))) {
        return { ok: false, reason: "primary Codex result bytes do not equal the initial report" };
      }
      const rawMetadata = parseJsonRejectingDuplicateKeys(
        decodedBinding.text,
        "receipt binding metadata",
      );
      if (!rawMetadata.ok) return rawMetadata;
      const parsedMetadata = PureReceiptBindingMetadataSchema.safeParse(rawMetadata.value);
      if (!parsedMetadata.success) {
        return { ok: false, reason: "receipt binding metadata does not match its strict schema" };
      }
      if (
        parsedMetadata.data.requested_model !== expectedModel.data ||
        parsedMetadata.data.run_seed !== expected.seed ||
        !isDeepStrictEqual(parsedMetadata.data.build, expected.build)
      ) {
        return { ok: false, reason: "receipt binding metadata differs from the planned run" };
      }
      const reproduced = reproducePureCodexReceiptBinding({
        primaryEnvelopeBytes: input.primaryEnvelope,
        originalReportBytes: input.initialReport!,
        runEvidenceBytes: input.runEvidence,
        metadata: parsedMetadata.data,
      });
      if (!reproduced.ok) return reproduced;
      if (!bytesEqual(input.report, reproduced.reportBytes)) {
        return { ok: false, reason: "final report is not the deterministic receipt-bound report" };
      }
      providerReport = decodedInitial.text;
    }
    const authority = parseCodexAuthority(
      decoded.providerEvents.text,
      decoded.providerRollout.text,
      decoded.providerCapture.text,
      expectedModel.data,
      providerReport,
      expected.expectedReasoningEffort ?? "xhigh",
    );
    if (!authority.ok) return authority;
    if (primary.data.session_id !== authority.facts.sessionId) {
      return { ok: false, reason: "primary Codex envelope session differs from rollout authority" };
    }
    if (
      primary.data.usage.input_tokens !== authority.facts.usage.input_tokens ||
      primary.data.usage.cache_read_input_tokens !== authority.facts.usage.cached_input_tokens ||
      primary.data.usage.output_tokens !== authority.facts.usage.output_tokens ||
      primary.data.usage.reasoning_output_tokens !== authority.facts.usage.reasoning_output_tokens
    ) {
      return {
        ok: false,
        reason: "primary Codex usage differs from authenticated terminal usage",
      };
    }
    const hashes = artifactHashes(input);
    return {
      ok: true,
      facts: {
        run,
        game_session_id: run.session_id,
        provider: "codex",
        provider_session_id: authority.facts.sessionId,
        actual_model: authority.facts.actualModel,
        actual_provider: "openai",
        reasoning_effort: authority.facts.reasoningEffort,
        provider_turn_id: authority.facts.turnId,
        provider_cwd: authority.facts.cwd,
        code_mode_contract: authority.facts.codeModeContract,
        transport_contract: authority.facts.transportContract,
        report_recovered: false,
        report_receipt_bound: reportReceiptBound,
        hashes,
      },
    };
  }

  if (expected.provider !== "claude" || !["haiku", "sonnet", "opus"].includes(expected.model)) {
    return { ok: false, reason: "Claude fleet plan requires one supported exact alias" };
  }
  if (
    input.providerEvents !== null ||
    input.providerRollout !== null ||
    input.providerCapture !== null
  ) {
    return { ok: false, reason: "Claude fleet artifacts must not contain Codex provider evidence" };
  }
  if (input.receiptBinding != null) {
    return {
      ok: false,
      reason: "Claude fleet artifacts must not contain receipt binding metadata",
    };
  }

  const primary = parsePrimaryEnvelope(decoded.primaryEnvelope.text, expected.model);
  if (!primary.ok) return primary;

  const recoveryPresence = [
    input.initialReport !== null,
    input.recoveryMetadata !== null,
    input.recoveryEnvelope !== null,
  ];
  const recoveryCount = recoveryPresence.filter(Boolean).length;
  if (recoveryCount !== 0 && recoveryCount !== recoveryPresence.length) {
    return {
      ok: false,
      reason: "report recovery artifacts must be either all absent or all present",
    };
  }
  const reportRecovered = recoveryCount === recoveryPresence.length;

  if (!reportRecovered) {
    if (!bytesEqual(input.report, exactUtf8Bytes(primary.envelope.result))) {
      return { ok: false, reason: "primary Claude result bytes do not equal the final report" };
    }
  } else {
    const decodedInitial = decodeUtf8(input.initialReport!, "initial report");
    const decodedMetadata = decodeUtf8(input.recoveryMetadata!, "recovery metadata");
    const decodedRecovery = decodeUtf8(input.recoveryEnvelope!, "recovery Claude envelope");
    if (!decodedInitial.ok) return decodedInitial;
    if (!decodedMetadata.ok) return decodedMetadata;
    if (!decodedRecovery.ok) return decodedRecovery;
    if (!bytesEqual(input.initialReport!, exactUtf8Bytes(primary.envelope.result))) {
      return { ok: false, reason: "primary Claude result bytes do not equal the initial report" };
    }
    let rawMetadata: unknown;
    try {
      rawMetadata = JSON.parse(decodedMetadata.text);
    } catch {
      return { ok: false, reason: "report recovery metadata is not valid JSON" };
    }
    const parsedMetadata = PureReportRecoveryMetadataSchema.safeParse(rawMetadata);
    if (!parsedMetadata.success) {
      return { ok: false, reason: "report recovery metadata does not match its strict schema" };
    }
    const metadata = parsedMetadata.data;
    if (
      metadata.requested_model !== expected.model ||
      metadata.claude_session_id !== primary.envelope.session_id ||
      metadata.model_usage_key !== primary.actualModel ||
      metadata.run_seed !== expected.seed ||
      !isDeepStrictEqual(metadata.build, expected.build)
    ) {
      return { ok: false, reason: "report recovery metadata differs from the planned primary run" };
    }
    const recovered = extractRecoveredReport({
      recoveryEnvelopeBytes: input.recoveryEnvelope!,
      primaryEnvelopeBytes: input.primaryEnvelope,
      originalReportBytes: input.initialReport!,
      runEvidenceBytes: input.runEvidence,
      metadata,
    });
    if (!recovered.ok) return recovered;
    if (!bytesEqual(input.report, recovered.reportBytes)) {
      return { ok: false, reason: "final report is not the deterministic recovered report" };
    }
  }

  const hashes = artifactHashes(input);
  for (const hash of Object.values(hashes)) {
    if (hash !== null && !HASH_PATTERN.test(hash)) {
      return { ok: false, reason: "artifact hashing produced an invalid digest" };
    }
  }
  return {
    ok: true,
    facts: {
      run,
      game_session_id: run.session_id,
      provider: "claude",
      provider_session_id: primary.envelope.session_id,
      actual_model: primary.actualModel,
      actual_provider: "anthropic",
      reasoning_effort: null,
      provider_turn_id: null,
      provider_cwd: null,
      code_mode_contract: null,
      transport_contract: null,
      report_recovered: reportRecovered,
      report_receipt_bound: false,
      hashes,
    },
  };
}
