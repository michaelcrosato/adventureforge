import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
// @ts-expect-error -- the runner's capture reader is intentionally plain ESM.
import * as claudeCapture from "../../blind-tester/claude-session.mjs";
import { verifyBlindReportText } from "../blind/report_verifier.js";
import { parseBlindRunSidecar, parseRunEvidenceJsonl } from "../blind/run_evidence.js";
import { parseJsonRejectingDuplicateKeys } from "../blind/strict_json.js";
import {
  pureFleetRunArtifactPaths,
  sha256ArtifactBytes,
  validatePureFleetRunArtifactBytes,
} from "../starting_slice/fleet_run_artifacts.js";
import { sha256Hex } from "./session_store.js";

type RunnerEvidenceInput = {
  outPrefix: string;
  provider: string;
  model: string;
  transportContract: string;
  reasoningEffort: string;
  reportText: string | null;
  sidecarText: string | null;
  evidenceText: string | null;
};

type RecordedRunnerEvidence =
  | { ok: true; clientEvidence: Record<string, string> }
  | { ok: false; reason: string };

const ClaudeCaptureLocationSchema = z
  .object({
    session_id: z.string().uuid(),
    cwd: z.string().min(1),
    transcript: z.object({ path: z.string().min(1) }).passthrough(),
  })
  .passthrough();

/**
 * A provider's launch capability is not proof about a particular session. Reproduce
 * the retained runner artifacts before granting the label that moves experience
 * metrics. Missing or rejected proof can only take the explicit attestation path.
 * Read only adjacent artifacts; capture receipts never authorize private-state reads.
 */
export function verifyRecordedRunnerEvidence(input: RunnerEvidenceInput): RecordedRunnerEvidence {
  try {
    return verifyArtifacts(input);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function verifyArtifacts(input: RunnerEvidenceInput): RecordedRunnerEvidence {
  if (input.reportText === null || input.sidecarText === null || input.evidenceText === null) {
    return { ok: false, reason: "runner report, sidecar, and raw run evidence are required" };
  }
  const parsed = parseBlindRunSidecar(input.sidecarText);
  if (!parsed.ok) return parsed;
  const run = parsed.sidecar;
  if (run.play_mode !== "pure" || run.schema_version !== 2) {
    return { ok: false, reason: "runner proof requires a current pure V2 sidecar" };
  }
  if (!run.build.tracked_worktree_clean) {
    return { ok: false, reason: "runner proof requires a clean tracked build" };
  }
  const evidence = parseRunEvidenceJsonl(input.evidenceText);
  if (!evidence.ok) return evidence;
  if (!isDeepStrictEqual(evidence.sidecar, run)) {
    return { ok: false, reason: "raw run evidence does not reproduce the adjacent run sidecar" };
  }
  const verified = verifyBlindReportText(input.reportText, {
    requiredPlayMode: "pure",
    runSidecar: run,
  });
  if (!verified.ok) return verified;

  const paths = pureFleetRunArtifactPaths(`${input.outPrefix}.md`);
  const primaryEnvelope = readFileSync(paths.primaryEnvelope);
  const common = {
    report_sha256: sha256Hex(input.reportText),
    run_sidecar_sha256: sha256Hex(input.sidecarText),
    run_evidence_sha256: sha256Hex(input.evidenceText),
    primary_envelope_sha256: sha256ArtifactBytes(primaryEnvelope),
    game_session_id: run.session_id,
  };
  if (input.provider === "codex") {
    const optional = (path: string): Buffer | null =>
      existsSync(path) ? readFileSync(path) : null;
    const validated = validatePureFleetRunArtifactBytes(
      {
        report: Buffer.from(input.reportText),
        runSidecar: Buffer.from(input.sidecarText),
        runEvidence: Buffer.from(input.evidenceText),
        primaryEnvelope,
        initialReport: optional(paths.initialReport),
        receiptBinding: optional(paths.receiptBinding),
        recoveryMetadata: optional(paths.recoveryMetadata),
        recoveryEnvelope: optional(paths.recoveryEnvelope),
        providerEvents: optional(paths.providerEvents),
        providerRollout: optional(paths.providerRollout),
        providerCapture: optional(paths.providerCapture),
      },
      {
        seed: run.run_seed,
        provider: "codex",
        model: input.model,
        build: { ...run.build, tracked_worktree_clean: true },
        expectedReasoningEffort: input.reasoningEffort,
      },
    );
    if (!validated.ok) return validated;
    const facts = validated.facts;
    return {
      ok: true,
      clientEvidence: {
        ...common,
        ...Object.fromEntries(
          Object.entries(facts.hashes).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        provider_session_id: facts.provider_session_id,
        model: facts.actual_model,
        reasoning_effort: facts.reasoning_effort!,
      },
    };
  }
  if (input.provider !== "claude_code") {
    return { ok: false, reason: `no retained-artifact verifier for ${input.provider}` };
  }

  const captureBytes = readFileSync(`${input.outPrefix}.claude-capture.json`);
  const raw = parseJsonRejectingDuplicateKeys(captureBytes.toString("utf8"), "Claude capture");
  if (!raw.ok) return raw;
  const location = ClaudeCaptureLocationSchema.safeParse(raw.value);
  if (!location.success) return { ok: false, reason: "Claude capture has no session binding" };
  const transcriptBytes = readFileSync(`${input.outPrefix}.claude-session.jsonl`);
  const streamBytes = readFileSync(`${input.outPrefix}.claude.jsonl`);
  const receipt = claudeCapture.inspectClaudeSessionBytes({
    transcriptBytes,
    streamBytes,
    sessionId: location.data.session_id,
    cwd: location.data.cwd,
    path: location.data.transcript.path,
  });
  if (!isDeepStrictEqual(receipt, raw.value)) {
    return { ok: false, reason: "Claude capture does not reproduce from retained client bytes" };
  }
  if (receipt.client.model !== input.model) {
    return { ok: false, reason: "Claude captured model differs from the requested model" };
  }
  const streamRows = claudeCapture.parseClaudeJsonl(streamBytes.toString("utf8"), "Claude stream");
  const transcriptRows = claudeCapture.parseClaudeJsonl(
    transcriptBytes.toString("utf8"),
    "Claude transcript",
  );
  // The stream supplies the final report; the copied transcript is hash-bound by
  // the receipt. Neither can vouch for changed calls or prose in the other.
  const assistantContent = (rows: { type?: string; message?: { content?: unknown } }[]) =>
    rows.filter((row) => row.type === "assistant").map((row) => row.message?.content);
  const messages = assistantContent(transcriptRows);
  if (!isDeepStrictEqual(assistantContent(streamRows), messages)) {
    return {
      ok: false,
      reason: "Claude stream assistant messages differ from the retained transcript",
    };
  }
  claudeCapture.auditClaudeToolCalls(claudeCapture.extractClaudeToolCalls(streamRows));
  const finalContent = z
    .array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
    .safeParse(messages.at(-1));
  const finalText = finalContent.success
    ? finalContent.data
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n\n")
    : "";
  const results = (streamRows as { type?: string; result?: unknown }[]).filter(
    (row) => row.type === "result",
  );
  if (!finalText || results.length !== 1 || results[0]?.result !== finalText) {
    return {
      ok: false,
      reason: "Claude result does not match its transcript's final assistant text",
    };
  }
  const envelope = claudeCapture.buildClaudeEnvelope({
    receipt,
    streamRows,
    model: input.model,
    transportContract: input.transportContract,
  });
  const rawEnvelope = parseJsonRejectingDuplicateKeys(
    primaryEnvelope.toString("utf8"),
    "Claude envelope",
  );
  if (!rawEnvelope.ok) return rawEnvelope;
  if (!isDeepStrictEqual(envelope, rawEnvelope.value) || envelope.result !== input.reportText) {
    return { ok: false, reason: "Claude envelope and report do not reproduce from client bytes" };
  }
  return {
    ok: true,
    clientEvidence: {
      ...common,
      provider_session_id: receipt.session_id,
      model: receipt.client.model,
      ...(receipt.client.version ? { cli_version: receipt.client.version } : {}),
      provider_capture_sha256: sha256ArtifactBytes(captureBytes),
      provider_events_sha256: sha256ArtifactBytes(streamBytes),
      provider_transcript_sha256: sha256ArtifactBytes(transcriptBytes),
    },
  };
}
