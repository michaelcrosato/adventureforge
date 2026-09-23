import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { SubjectiveExitInterviewSchema } from "./exit_interview.js";
import { verifyBlindReportText } from "./report_verifier.js";
import { parseRunEvidenceJsonl, PureRunBuildSchema } from "./run_evidence.js";

const ModelUsageSchema = z.record(z.unknown());

const RecoveryClaudeEnvelopeSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.literal("success"),
    is_error: z.literal(false),
    session_id: z.string().uuid(),
    result: z.string(),
    structured_output: z.unknown(),
    stop_reason: z.literal("tool_use"),
    terminal_reason: z.literal("completed"),
    permission_denials: z.array(z.unknown()).length(0),
    modelUsage: ModelUsageSchema,
  })
  .passthrough();

const RatingSchema = z
  .object({ clarity: z.number().int().min(1).max(5), enjoyment: z.number().int().min(1).max(5) })
  .strict();

export const PureReportRecoveryMetadataSchema = z
  .object({
    schema_version: z.literal(1),
    recovery_count: z.literal(1),
    claude_session_id: z.string().uuid(),
    requested_model: z.string().min(1),
    model_usage_key: z.string().min(1),
    run_seed: z.number().int().safe(),
    build: PureRunBuildSchema,
    ratings: RatingSchema,
    initial_report_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    primary_envelope_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    run_evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type PureReportRecoveryMetadata = z.infer<typeof PureReportRecoveryMetadataSchema>;

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

function singletonModelUsageKey(
  modelUsage: Record<string, unknown>,
): { ok: true; key: string } | { ok: false; reason: string } {
  const keys = Object.keys(modelUsage);
  return keys.length === 1
    ? { ok: true, key: keys[0]! }
    : {
        ok: false,
        reason: `Claude modelUsage must contain exactly one model (found ${keys.length})`,
      };
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

function parseStrictSubjective(
  value: unknown,
): ReturnType<typeof SubjectiveExitInterviewSchema.safeParse> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return SubjectiveExitInterviewSchema.safeParse(value);
  }
  const keys = Object.keys(value);
  if (keys.length !== SUBJECTIVE_KEYS.length || SUBJECTIVE_KEYS.some((key) => !(key in value))) {
    return SubjectiveExitInterviewSchema.safeParse({ __invalid_recovery_shape: true });
  }
  return SubjectiveExitInterviewSchema.safeParse(value);
}

export function bytesMatchHash(bytes: Uint8Array, expectedSha256: string): boolean {
  return /^[0-9a-f]{64}$/.test(expectedSha256) && sha256(bytes) === expectedSha256;
}

interface ExtractRecoveredReportInput {
  recoveryEnvelopeBytes: Uint8Array;
  primaryEnvelopeBytes: Uint8Array;
  originalReportBytes: Uint8Array;
  runEvidenceBytes: Uint8Array;
  metadata: PureReportRecoveryMetadata;
}

type RecoveryEnvelopeResult = { ok: true; reportBytes: Uint8Array } | { ok: false; reason: string };

/** Build a final report while preserving every original report byte as its prefix. */
export function extractRecoveredReport(input: ExtractRecoveredReportInput): RecoveryEnvelopeResult {
  const metadataParsed = PureReportRecoveryMetadataSchema.safeParse(input.metadata);
  if (!metadataParsed.success) return { ok: false, reason: "report recovery metadata is invalid" };
  const metadata = metadataParsed.data;
  if (!bytesMatchHash(input.runEvidenceBytes, metadata.run_evidence_sha256)) {
    return { ok: false, reason: "run evidence changed during report recovery" };
  }
  if (!bytesMatchHash(input.originalReportBytes, metadata.initial_report_sha256)) {
    return { ok: false, reason: "original report changed during report recovery" };
  }
  if (!bytesMatchHash(input.primaryEnvelopeBytes, metadata.primary_envelope_sha256)) {
    return { ok: false, reason: "primary Claude envelope changed during report recovery" };
  }

  const recoveryEnvelopeText = exactUtf8(input.recoveryEnvelopeBytes, "report recovery envelope");
  if (!recoveryEnvelopeText.ok) return recoveryEnvelopeText;
  const runEvidenceText = exactUtf8(input.runEvidenceBytes, "run evidence");
  if (!runEvidenceText.ok) return runEvidenceText;
  const originalReportText = exactUtf8(input.originalReportBytes, "original report");
  if (!originalReportText.ok) return originalReportText;

  const evidence = parseRunEvidenceJsonl(runEvidenceText.text);
  if (!evidence.ok || evidence.sidecar.schema_version !== 2) {
    return { ok: false, reason: "current v2 run evidence no longer verifies" };
  }
  if (
    evidence.sidecar.run_seed !== metadata.run_seed ||
    !isDeepStrictEqual(evidence.sidecar.build, metadata.build)
  ) {
    return { ok: false, reason: "run evidence provenance disagrees with recovery metadata" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(recoveryEnvelopeText.text);
  } catch {
    return { ok: false, reason: "report recovery envelope is not valid JSON" };
  }
  const envelope = RecoveryClaudeEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    const issue = envelope.error.issues[0];
    return {
      ok: false,
      reason: `report recovery envelope is not a completed structured turn: ${issue?.path.join(".") ?? "?"} — ${issue?.message ?? "schema mismatch"}`,
    };
  }
  if (envelope.data.session_id !== metadata.claude_session_id) {
    return { ok: false, reason: "report recovery response did not come from the resumed session" };
  }
  const model = singletonModelUsageKey(envelope.data.modelUsage);
  if (!model.ok) return model;
  if (model.key !== metadata.model_usage_key) {
    return { ok: false, reason: "report recovery response used a different actual model" };
  }

  const subjective = parseStrictSubjective(envelope.data.structured_output);
  if (!subjective.success) {
    const issue = subjective.error.issues[0];
    return {
      ok: false,
      reason: `report recovery subjective fields are invalid: ${issue?.path.join(".") ?? "?"} — ${issue?.message ?? "schema mismatch"}`,
    };
  }
  let resultJson: unknown;
  try {
    resultJson = JSON.parse(envelope.data.result);
  } catch {
    return { ok: false, reason: "report recovery result is not valid JSON" };
  }
  if (!isDeepStrictEqual(resultJson, envelope.data.structured_output)) {
    return { ok: false, reason: "report recovery result disagrees with structured_output" };
  }
  if (
    subjective.data.clarity !== metadata.ratings.clarity ||
    subjective.data.enjoyment !== metadata.ratings.enjoyment
  ) {
    return { ok: false, reason: "report recovery ratings do not match the original prose" };
  }

  const provenance = {
    schema_version: 1,
    recovery_count: 1,
    claude_session_id: metadata.claude_session_id,
    model_usage_key: metadata.model_usage_key,
    initial_report_sha256: metadata.initial_report_sha256,
    primary_envelope_sha256: metadata.primary_envelope_sha256,
    run_evidence_sha256: metadata.run_evidence_sha256,
    recovery_envelope_sha256: sha256(input.recoveryEnvelopeBytes),
  } as const;
  const interview = {
    schema_version: 2,
    issue_consistency_version: 1,
    play_mode: "pure",
    start_surface: "fresh_overworld",
    retention_eligible: true,
    journey_exit_receipt: evidence.sidecar.receipt,
    ...subjective.data,
  } as const;
  const separator = originalReportText.text.endsWith("\n\n")
    ? ""
    : originalReportText.text.endsWith("\n")
      ? "\n"
      : "\n\n";
  const appended = `${separator}<!-- adventureforge-report-recovery ${JSON.stringify(provenance)} -->\n\n## Exit interview\n\n\`\`\`json exit-interview\n${JSON.stringify(interview, null, 2)}\n\`\`\`\n`;
  const recoveredReportText = `${originalReportText.text}${appended}`;
  const recoveredVerification = verifyBlindReportText(recoveredReportText, {
    requiredPlayMode: "pure",
    runEvidenceText: runEvidenceText.text,
    requireStructuredIssueConsistency: true,
  });
  if (!recoveredVerification.ok) {
    return {
      ok: false,
      reason: `recovered report fails forward verification: ${recoveredVerification.reason}`,
    };
  }
  return {
    ok: true,
    reportBytes: Buffer.concat([
      Buffer.from(input.originalReportBytes),
      Buffer.from(appended, "utf8"),
    ]),
  };
}
