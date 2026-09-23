import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { SubjectiveExitInterviewSchema } from "./exit_interview.js";
import { verifyBlindReportText } from "./report_verifier.js";
import { parseRunEvidenceJsonl, PureRunBuildSchema } from "./run_evidence.js";
import { parseJsonRejectingDuplicateKeys } from "./strict_json.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RECEIPT_FIELD = "journey_exit_receipt";

const CodexUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().safe(),
    cache_read_input_tokens: z.number().int().nonnegative().safe(),
    output_tokens: z.number().int().nonnegative().safe(),
    reasoning_output_tokens: z.number().int().nonnegative().safe(),
  })
  .strict();

const CodexModelUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().safe(),
    cacheReadInputTokens: z.number().int().nonnegative().safe(),
    outputTokens: z.number().int().nonnegative().safe(),
    reasoningOutputTokens: z.number().int().nonnegative().safe(),
  })
  .strict();

/**
 * The envelope `blind-tester/claude-session.mjs envelope` emits, which is that lane's
 * equivalent of the Codex envelope below: a completed, audited single-session turn whose
 * `result` is the report text. It is a different SHAPE — no `type`/`subtype`, no
 * `terminal_reason`, no per-model usage split — because it is built from a stream-json
 * result event rather than a Codex rollout, and pretending otherwise by widening the
 * Codex schema would let a half-populated envelope of either vendor satisfy the other's
 * checks. Two schemas, each strict about its own producer.
 */
const PrimaryClaudeEnvelopeSchema = z
  .object({
    schema_version: z.literal(1),
    provider: z.literal("claude_code"),
    transport_contract: z.string().min(1),
    model: z.string().min(1),
    session_id: z.string().uuid(),
    is_error: z.literal(false),
    duration_ms: z.number().int().nonnegative().safe().nullable(),
    num_turns: z.number().int().positive().safe().nullable(),
    total_cost_usd: z.number().nonnegative().nullable(),
    usage: z.record(z.unknown()).nullable(),
    result: z.string(),
    capture: z.record(z.unknown()),
  })
  .strict();

const PrimaryCodexEnvelopeSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.literal("success"),
    provider: z.literal("codex"),
    is_error: z.literal(false),
    duration_ms: z.number().int().nonnegative().safe(),
    num_turns: z.number().int().positive().safe(),
    result: z.string(),
    session_id: z.string().uuid(),
    requested_model: z.string().min(1),
    terminal_reason: z.literal("completed"),
    usage: CodexUsageSchema,
    modelUsage: z.record(CodexModelUsageSchema),
  })
  .strict();

const RatingSchema = z
  .object({
    clarity: z.number().int().min(1).max(5),
    enjoyment: z.number().int().min(1).max(5),
  })
  .strict();

export const PureReceiptBindingMetadataSchema = z
  .object({
    schema_version: z.literal(1),
    binding_kind: z.literal("server_exit_receipt"),
    binding_count: z.literal(1),
    render_version: z.literal(1),
    provider: z.enum(["codex", "claude_code"]),
    provider_session_id: z.string().uuid(),
    requested_model: z.string().min(1),
    run_seed: z.number().int().safe(),
    build: PureRunBuildSchema,
    game_session_id: z.string().min(1),
    report_schema_version: z.literal(2),
    replaced_field: z.literal(RECEIPT_FIELD),
    initial_failure: z.enum(["receipt_invalid", "receipt_mismatch"]),
    ratings: RatingSchema,
    receipt_hash: z.string().regex(SHA256_PATTERN),
    receipt_sha256: z.string().regex(SHA256_PATTERN),
    original_report_sha256: z.string().regex(SHA256_PATTERN),
    primary_envelope_sha256: z.string().regex(SHA256_PATTERN),
    run_evidence_sha256: z.string().regex(SHA256_PATTERN),
    bound_report_sha256: z.string().regex(SHA256_PATTERN),
  })
  .strict();

type PureReceiptBindingMetadata = z.infer<typeof PureReceiptBindingMetadataSchema>;

interface PureReceiptBindingInput {
  playMode: string;
  provider: string;
  agentExitStatus: number;
  verifierExitStatus: number;
  attempt: number;
  requestedModel: string;
  expectedRunSeed: number;
  expectedGitCommit: string;
  expectedTrackedWorktreeClean: boolean;
  primaryEnvelopeBytes: Uint8Array;
  runEvidenceBytes: Uint8Array;
  reportBytes: Uint8Array;
  /**
   * Replay-only escape hatch for `receipt_mismatch`, set by
   * `reproducePureCodexReceiptBinding` from stored metadata and by nothing else. A live
   * run must never pass it: see the gate in `bindPureCodexReceipt`.
   */
  allowHistoricalMismatch?: boolean;
}

type PureReceiptBindingResult =
  | {
      ok: true;
      metadata: PureReceiptBindingMetadata;
      reportBytes: Uint8Array;
    }
  | { ok: false; reason: string };

interface ReproducePureReceiptBindingInput {
  primaryEnvelopeBytes: Uint8Array;
  originalReportBytes: Uint8Array;
  runEvidenceBytes: Uint8Array;
  metadata: PureReceiptBindingMetadata;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactUtf8(
  bytes: Uint8Array,
  label: string,
): { ok: true; text: string } | { ok: false; reason: string } {
  const raw = Buffer.from(bytes);
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw)) {
    return { ok: false, reason: `${label} is not canonical UTF-8` };
  }
  return { ok: true, text };
}

function uniqueProseRating(
  report: string,
  label: "clarity" | "enjoyment",
): { ok: true; value: number } | { ok: false; reason: string } {
  const values = new Set<number>();
  const patterns = [
    new RegExp(`\\b${label}\\b[^\\r\\n.;]{0,80}?\\b([1-5])\\s*(?:\\/\\s*5)?\\b`, "giu"),
    new RegExp(`\\b([1-5])\\s*\\/\\s*5\\b[^\\r\\n.;]{0,40}?\\b${label}\\b`, "giu"),
  ];
  for (const pattern of patterns) {
    for (const match of report.matchAll(pattern)) values.add(Number(match[1]));
  }
  if (values.size !== 1) {
    return {
      ok: false,
      reason: `receipt binding requires exactly one unambiguous ${label} rating (found ${values.size})`,
    };
  }
  return { ok: true, value: [...values][0]! };
}

function skipJsonWhitespace(source: string, index: number): number {
  while (index < source.length && /[\t\n\r ]/u.test(source[index]!)) index += 1;
  return index;
}

function scanJsonString(source: string, index: number): { end: number; value: string } {
  if (source[index] !== '"') throw new Error("expected JSON string");
  let cursor = index + 1;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (source[cursor] === '"') {
      const end = cursor + 1;
      return { end, value: JSON.parse(source.slice(index, end)) as string };
    }
    cursor += 1;
  }
  throw new Error("unterminated JSON string");
}

interface JsonScanState {
  readonly source: string;
  receiptSpan: { start: number; end: number } | null;
}

function scanJsonValue(state: JsonScanState, index: number, depth: number): number {
  const { source } = state;
  const start = skipJsonWhitespace(source, index);
  if (source[start] === "{") return scanJsonObject(state, start, depth);
  if (source[start] === "[") return scanJsonArray(state, start, depth);
  if (source[start] === '"') return scanJsonString(source, start).end;

  let cursor = start;
  while (cursor < source.length && !/[\t\n\r ,}\]]/u.test(source[cursor]!)) cursor += 1;
  if (cursor === start) throw new Error("expected JSON value");
  return cursor;
}

function scanJsonArray(state: JsonScanState, index: number, depth: number): number {
  const { source } = state;
  let cursor = skipJsonWhitespace(source, index + 1);
  if (source[cursor] === "]") return cursor + 1;
  while (cursor < source.length) {
    cursor = scanJsonValue(state, cursor, depth + 1);
    cursor = skipJsonWhitespace(source, cursor);
    if (source[cursor] === "]") return cursor + 1;
    if (source[cursor] !== ",") throw new Error("expected JSON array separator");
    cursor = skipJsonWhitespace(source, cursor + 1);
  }
  throw new Error("unterminated JSON array");
}

function scanJsonObject(state: JsonScanState, index: number, depth: number): number {
  const { source } = state;
  const keys = new Set<string>();
  let cursor = skipJsonWhitespace(source, index + 1);
  if (source[cursor] === "}") return cursor + 1;
  while (cursor < source.length) {
    const key = scanJsonString(source, cursor);
    if (keys.has(key.value)) throw new Error(`duplicate JSON object key ${key.value}`);
    keys.add(key.value);
    cursor = skipJsonWhitespace(source, key.end);
    if (source[cursor] !== ":") throw new Error("expected JSON object colon");
    const valueStart = skipJsonWhitespace(source, cursor + 1);
    const valueEnd = scanJsonValue(state, valueStart, depth + 1);
    if (depth === 0 && key.value === RECEIPT_FIELD) {
      state.receiptSpan = { start: valueStart, end: valueEnd };
    }
    cursor = skipJsonWhitespace(source, valueEnd);
    if (source[cursor] === "}") return cursor + 1;
    if (source[cursor] !== ",") throw new Error("expected JSON object separator");
    cursor = skipJsonWhitespace(source, cursor + 1);
  }
  throw new Error("unterminated JSON object");
}

function locateReceiptSpan(
  body: string,
): { ok: true; span: { start: number; end: number } } | { ok: false; reason: string } {
  const state: JsonScanState = { source: body, receiptSpan: null };
  try {
    const start = skipJsonWhitespace(body, 0);
    if (body[start] !== "{") return { ok: false, reason: "exit interview must be one JSON object" };
    const end = scanJsonObject(state, start, 0);
    if (skipJsonWhitespace(body, end) !== body.length) {
      return { ok: false, reason: "exit interview contains trailing JSON content" };
    }
  } catch (error) {
    return {
      ok: false,
      reason: `exit interview JSON is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (state.receiptSpan === null) {
    return { ok: false, reason: `exit interview is missing ${RECEIPT_FIELD}` };
  }
  return { ok: true, span: state.receiptSpan };
}

const SUBJECTIVE_KEYS = [
  "clarity",
  "enjoyment",
  "goal_understood",
  "got_stuck",
  "confusions",
  "bugs",
  "best_moment",
  "worst_moment",
  "would_replay",
  "verdict",
] as const;

const PURE_INTERVIEW_KEYS = [
  "schema_version",
  "play_mode",
  "start_surface",
  "retention_eligible",
  RECEIPT_FIELD,
  ...SUBJECTIVE_KEYS,
] as const;

const PURE_INTERVIEW_KEYS_WITH_ISSUE_CONSISTENCY = [
  ...PURE_INTERVIEW_KEYS,
  "issue_consistency_version",
] as const;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

type ParsedBindableReport =
  | {
      ok: true;
      blockBody: string;
      bodyStart: number;
      receiptSpan: { start: number; end: number };
      subjective: z.infer<typeof SubjectiveExitInterviewSchema>;
    }
  | { ok: false; reason: string };

function parseBindableReport(report: string): ParsedBindableReport {
  const block = /(```json exit-interview[^\S\r\n]*\r?\n)([\s\S]*?)(```)/gu;
  const matches = [...report.matchAll(block)];
  if (matches.length !== 1) {
    return {
      ok: false,
      reason: `receipt binding requires exactly one exit-interview block (found ${matches.length})`,
    };
  }
  const match = matches[0]!;
  const index = match.index;
  const header = match[1];
  const body = match[2];
  if (index === undefined || header === undefined || body === undefined) {
    return { ok: false, reason: "exit interview block offsets are unavailable" };
  }
  if (report.slice(index + match[0].length).trim().length !== 0) {
    return { ok: false, reason: "receipt binding requires the exit-interview block to be final" };
  }

  const raw = parseJsonRejectingDuplicateKeys(body, "exit interview block");
  if (!raw.ok) return raw;
  if (typeof raw.value !== "object" || raw.value === null || Array.isArray(raw.value)) {
    return { ok: false, reason: "exit interview must be one JSON object" };
  }
  const record = raw.value as Record<string, unknown>;
  if (
    !hasExactKeys(record, PURE_INTERVIEW_KEYS) &&
    !hasExactKeys(record, PURE_INTERVIEW_KEYS_WITH_ISSUE_CONSISTENCY)
  ) {
    return { ok: false, reason: "exit interview does not have the exact V2 pure field set" };
  }
  if (
    record.schema_version !== 2 ||
    record.play_mode !== "pure" ||
    record.start_surface !== "fresh_overworld" ||
    record.retention_eligible !== true
  ) {
    return { ok: false, reason: "exit interview does not have the required pure run identity" };
  }
  if ("issue_consistency_version" in record && record.issue_consistency_version !== 1) {
    return { ok: false, reason: "exit interview issue consistency version is unsupported" };
  }

  const subjectiveRaw = Object.fromEntries(SUBJECTIVE_KEYS.map((key) => [key, record[key]]));
  const subjective = SubjectiveExitInterviewSchema.safeParse(subjectiveRaw);
  if (!subjective.success) {
    const issue = subjective.error.issues[0];
    return {
      ok: false,
      reason: `receipt binding subjective fields are invalid: ${issue?.path.join(".") ?? "?"} — ${issue?.message ?? "schema mismatch"}`,
    };
  }
  const receipt = locateReceiptSpan(body);
  if (!receipt.ok) return receipt;
  return {
    ok: true,
    blockBody: body,
    bodyStart: index + header.length,
    receiptSpan: receipt.span,
    subjective: subjective.data,
  };
}

function parseCodexEnvelope(
  text: string,
  requestedModel: string,
):
  | { ok: true; envelope: z.infer<typeof PrimaryCodexEnvelopeSchema> }
  | { ok: false; reason: string } {
  const raw = parseJsonRejectingDuplicateKeys(text, "primary Codex envelope");
  if (!raw.ok) return raw;
  const parsed = PrimaryCodexEnvelopeSchema.safeParse(raw.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `primary Codex envelope is not a completed audited turn: ${issue?.path.join(".") ?? "?"} — ${issue?.message ?? "schema mismatch"}`,
    };
  }
  const envelope = parsed.data;
  if (envelope.requested_model !== requestedModel) {
    return { ok: false, reason: "primary Codex envelope requested a different model" };
  }
  const modelKeys = Object.keys(envelope.modelUsage);
  if (modelKeys.length !== 1 || modelKeys[0] !== requestedModel) {
    return {
      ok: false,
      reason: "primary Codex envelope does not bind exactly one requested model",
    };
  }
  const modelUsage = envelope.modelUsage[requestedModel]!;
  if (
    modelUsage.inputTokens !== envelope.usage.input_tokens ||
    modelUsage.cacheReadInputTokens !== envelope.usage.cache_read_input_tokens ||
    modelUsage.outputTokens !== envelope.usage.output_tokens ||
    modelUsage.reasoningOutputTokens !== envelope.usage.reasoning_output_tokens
  ) {
    return { ok: false, reason: "primary Codex envelope token accounting is inconsistent" };
  }
  return { ok: true, envelope };
}

/** Providers whose envelope this module can authenticate well enough to bind against. */
const BINDABLE_PROVIDERS = new Set(["codex", "claude_code"]);

function parseClaudeEnvelope(
  text: string,
  requestedModel: string,
): { ok: true; sessionId: string; result: string } | { ok: false; reason: string } {
  const raw = parseJsonRejectingDuplicateKeys(text, "primary claude_code envelope");
  if (!raw.ok) return raw;
  const parsed = PrimaryClaudeEnvelopeSchema.safeParse(raw.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `primary claude_code envelope is not a completed audited turn: ${issue?.path.join(".") ?? "?"} — ${issue?.message ?? "schema mismatch"}`,
    };
  }
  // The capture reader already refused the run if the transcript's recorded model differed
  // from the requested one; this re-checks the envelope's own claim so the binder never
  // trusts a field it did not verify itself.
  if (parsed.data.model !== requestedModel) {
    return { ok: false, reason: "primary claude_code envelope requested a different model" };
  }
  return { ok: true, sessionId: parsed.data.session_id, result: parsed.data.result };
}

/**
 * Authenticate whichever provider's envelope this run produced.
 *
 * Each provider's envelope is checked against ITS OWN strict schema — the vendor gate that
 * used to live in `bindPureCodexReceipt` was never really about Codex, it was about the
 * binder having only one envelope shape it could authenticate. Everything downstream of
 * this function is already vendor-neutral: the repair value comes from server-authored run
 * evidence, and the bound report must satisfy the unchanged verifier.
 */
function parsePrimaryEnvelope(
  text: string,
  provider: string,
  requestedModel: string,
): { ok: true; sessionId: string; result: string } | { ok: false; reason: string } {
  if (provider === "claude_code") return parseClaudeEnvelope(text, requestedModel);
  const codex = parseCodexEnvelope(text, requestedModel);
  if (!codex.ok) return codex;
  return { ok: true, sessionId: codex.envelope.session_id, result: codex.envelope.result };
}

function classifyReceiptFailure(reason: string): "receipt_invalid" | "receipt_mismatch" | null {
  if (reason.startsWith("exit interview invalid: journey_exit_receipt")) {
    return "receipt_invalid";
  }
  if (reason === "exit interview journey_exit_receipt does not match server run evidence") {
    return "receipt_mismatch";
  }
  return null;
}

function renderReceiptValue(
  report: string,
  parsed: Extract<ParsedBindableReport, { ok: true }>,
  receipt: unknown,
): Uint8Array {
  const absoluteStart = parsed.bodyStart + parsed.receiptSpan.start;
  const absoluteEnd = parsed.bodyStart + parsed.receiptSpan.end;
  const lineStart = parsed.blockBody.lastIndexOf("\n", parsed.receiptSpan.start - 1) + 1;
  const lineIndent = /^[\t ]*/u.exec(parsed.blockBody.slice(lineStart))?.[0] ?? "";
  const replacement = JSON.stringify(receipt, null, 2).replaceAll("\n", `\n${lineIndent}`);
  return Buffer.from(
    `${report.slice(0, absoluteStart)}${replacement}${report.slice(absoluteEnd)}`,
    "utf8",
  );
}

/** Bind the exact server-authored exit receipt without another provider turn. */
export function bindPureCodexReceipt(input: PureReceiptBindingInput): PureReceiptBindingResult {
  if (input.playMode !== "pure") {
    return { ok: false, reason: "receipt binding is available only for pure live runs" };
  }
  if (!BINDABLE_PROVIDERS.has(input.provider)) {
    return {
      ok: false,
      reason: `receipt binding has no authenticated envelope shape for provider "${input.provider}"`,
    };
  }
  if (input.agentExitStatus !== 0) {
    return {
      ok: false,
      reason: `receipt binding requires a normally exited provider run (exit ${input.agentExitStatus})`,
    };
  }
  if (input.verifierExitStatus === 0) {
    return { ok: false, reason: "receipt binding requires an initial verifier failure" };
  }
  if (input.attempt !== 0) {
    return { ok: false, reason: "receipt binding is allowed only on attempt zero" };
  }

  const envelopeText = exactUtf8(input.primaryEnvelopeBytes, "primary provider envelope");
  if (!envelopeText.ok) return envelopeText;
  const evidenceText = exactUtf8(input.runEvidenceBytes, "run evidence");
  if (!evidenceText.ok) return evidenceText;
  const reportText = exactUtf8(input.reportBytes, "original report");
  if (!reportText.ok) return reportText;

  const evidence = parseRunEvidenceJsonl(evidenceText.text);
  if (!evidence.ok) {
    return {
      ok: false,
      reason: `run evidence is not receipt-binding eligible: ${evidence.reason}`,
    };
  }
  if (evidence.sidecar.schema_version !== 2) {
    return { ok: false, reason: "receipt binding requires current v2 run evidence" };
  }
  if (evidence.sidecar.run_seed !== input.expectedRunSeed) {
    return { ok: false, reason: "run evidence seed does not match the runner launch" };
  }
  if (evidence.sidecar.build.git_commit !== input.expectedGitCommit) {
    return { ok: false, reason: "run evidence commit does not match the runner launch" };
  }
  if (evidence.sidecar.build.tracked_worktree_clean !== input.expectedTrackedWorktreeClean) {
    return { ok: false, reason: "run evidence cleanliness does not match the runner launch" };
  }

  const envelope = parsePrimaryEnvelope(envelopeText.text, input.provider, input.requestedModel);
  if (!envelope.ok) return envelope;
  if (envelope.result !== reportText.text) {
    return {
      ok: false,
      reason: "primary provider envelope result does not exactly match report bytes",
    };
  }

  const initialVerification = verifyBlindReportText(reportText.text, {
    requiredPlayMode: "pure",
    runEvidenceText: evidenceText.text,
  });
  if (initialVerification.ok) {
    return { ok: false, reason: "the original report passes verification" };
  }
  const initialFailure = classifyReceiptFailure(initialVerification.reason);
  if (initialFailure === null) {
    return {
      ok: false,
      reason: `verifier failure is not receipt-only: ${initialVerification.reason}`,
    };
  }
  // A receipt that is WELL-FORMED but disagrees with the server is not a transcription
  // slip, it is a player reporting a journey it did not take. Binding would silently
  // overwrite it with the server's receipt and the run would pass as though the player had
  // reported accurately — so this class is refused outright.
  //
  // `allowHistoricalMismatch` exists only so already-sealed evidence stays REPRODUCIBLE:
  // `reproducePureCodexReceiptBinding` replays a stored binding and must be able to rebuild
  // one minted before this rule. It never opens the door for a new run, because only stored
  // metadata that already records `receipt_mismatch` can set it.
  if (initialFailure === "receipt_mismatch" && input.allowHistoricalMismatch !== true) {
    return {
      ok: false,
      reason: "receipt binding refuses a well-formed receipt that contradicts server run evidence",
    };
  }

  const parsedReport = parseBindableReport(reportText.text);
  if (!parsedReport.ok) return parsedReport;
  const clarity = uniqueProseRating(reportText.text, "clarity");
  if (!clarity.ok) return clarity;
  const enjoyment = uniqueProseRating(reportText.text, "enjoyment");
  if (!enjoyment.ok) return enjoyment;
  if (
    parsedReport.subjective.clarity !== clarity.value ||
    parsedReport.subjective.enjoyment !== enjoyment.value
  ) {
    return { ok: false, reason: "exit interview ratings do not match the original prose" };
  }

  const boundReportBytes = renderReceiptValue(
    reportText.text,
    parsedReport,
    evidence.sidecar.receipt,
  );
  const boundReportText = exactUtf8(boundReportBytes, "receipt-bound report");
  if (!boundReportText.ok) return boundReportText;
  const finalVerification = verifyBlindReportText(boundReportText.text, {
    requiredPlayMode: "pure",
    runEvidenceText: evidenceText.text,
  });
  if (!finalVerification.ok) {
    return {
      ok: false,
      reason: `receipt-bound report still fails the unchanged verifier: ${finalVerification.reason}`,
    };
  }
  if (
    !("journey_exit_receipt" in finalVerification.interview) ||
    !isDeepStrictEqual(finalVerification.interview.journey_exit_receipt, evidence.sidecar.receipt)
  ) {
    return { ok: false, reason: "receipt-bound report did not preserve the exact server receipt" };
  }
  const finalSubjective = SubjectiveExitInterviewSchema.safeParse(
    Object.fromEntries(SUBJECTIVE_KEYS.map((key) => [key, finalVerification.interview[key]])),
  );
  if (
    !finalSubjective.success ||
    !isDeepStrictEqual(finalSubjective.data, parsedReport.subjective)
  ) {
    return { ok: false, reason: "receipt binding changed subjective exit-interview fields" };
  }

  const canonicalReceiptBytes = Buffer.from(JSON.stringify(evidence.sidecar.receipt), "utf8");
  return {
    ok: true,
    reportBytes: boundReportBytes,
    metadata: {
      schema_version: 1,
      binding_kind: "server_exit_receipt",
      binding_count: 1,
      render_version: 1,
      provider: input.provider as PureReceiptBindingMetadata["provider"],
      provider_session_id: envelope.sessionId,
      requested_model: input.requestedModel,
      run_seed: evidence.sidecar.run_seed,
      build: evidence.sidecar.build,
      game_session_id: evidence.sidecar.session_id,
      report_schema_version: 2,
      replaced_field: RECEIPT_FIELD,
      initial_failure: initialFailure,
      ratings: { clarity: clarity.value, enjoyment: enjoyment.value },
      receipt_hash: evidence.sidecar.receipt.receiptHash,
      receipt_sha256: sha256(canonicalReceiptBytes),
      original_report_sha256: sha256(input.reportBytes),
      primary_envelope_sha256: sha256(input.primaryEnvelopeBytes),
      run_evidence_sha256: sha256(input.runEvidenceBytes),
      bound_report_sha256: sha256(boundReportBytes),
    },
  };
}

/** Reproduce a bound report from its immutable inputs and strict metadata. */
export function reproducePureCodexReceiptBinding(
  input: ReproducePureReceiptBindingInput,
): PureReceiptBindingResult {
  const metadata = PureReceiptBindingMetadataSchema.safeParse(input.metadata);
  if (!metadata.success) return { ok: false, reason: "receipt binding metadata is invalid" };
  if (sha256(input.primaryEnvelopeBytes) !== metadata.data.primary_envelope_sha256) {
    return { ok: false, reason: "primary provider envelope changed after receipt binding" };
  }
  if (sha256(input.originalReportBytes) !== metadata.data.original_report_sha256) {
    return { ok: false, reason: "original report changed after receipt binding" };
  }
  if (sha256(input.runEvidenceBytes) !== metadata.data.run_evidence_sha256) {
    return { ok: false, reason: "run evidence changed after receipt binding" };
  }

  const reproduced = bindPureCodexReceipt({
    playMode: "pure",
    provider: metadata.data.provider,
    agentExitStatus: 0,
    verifierExitStatus: 1,
    attempt: 0,
    // Replaying stored evidence, not minting new: a binding sealed before the mismatch
    // rule must still rebuild byte-for-byte, or every historical artifact carrying one
    // becomes unverifiable the day the rule lands.
    allowHistoricalMismatch: metadata.data.initial_failure === "receipt_mismatch",
    requestedModel: metadata.data.requested_model,
    expectedRunSeed: metadata.data.run_seed,
    expectedGitCommit: metadata.data.build.git_commit,
    expectedTrackedWorktreeClean: metadata.data.build.tracked_worktree_clean,
    primaryEnvelopeBytes: input.primaryEnvelopeBytes,
    runEvidenceBytes: input.runEvidenceBytes,
    reportBytes: input.originalReportBytes,
  });
  if (!reproduced.ok) return reproduced;
  if (!isDeepStrictEqual(reproduced.metadata, metadata.data)) {
    return { ok: false, reason: "receipt binding metadata does not reproduce exactly" };
  }
  return reproduced;
}
