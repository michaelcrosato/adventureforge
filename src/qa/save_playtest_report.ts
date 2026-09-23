/**
 * Persist a hand-played / operator-attested playtest report fail-closed on the
 * interview. A completed session is only written when extractExitInterview accepts
 * a pure V2 block; a plain json fence, missing subjective fields, or trailing text
 * after the fence cannot be stored as completed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { hashState } from "../core/hash.js";
import {
  extractExitInterview,
  isPureExitInterviewV2,
  type ExitInterview,
  type ExitInterviewExtraction,
} from "../blind/exit_interview.js";
import { verifyBlindReportText, type BlindReportVerification } from "../blind/report_verifier.js";
import type { PureRunBuild } from "../blind/run_evidence.js";
import {
  findCatalogModel,
  findPlaytestProvider,
  parsePlaytestCatalog,
} from "../blind/providers.js";
import { parseOverworldManifest } from "../world/overworld.js";
import {
  PlaytestOutcomeSchema,
  sealPlaytestSession,
  splitExitInterview,
  type PlaytestOutcome,
  type PlaytestSessionBody,
  type PlaytestSessionRecord,
} from "./session_record.js";
import { DEFAULT_SESSION_STORE, sha256Hex, writePlaytestSession } from "./session_store.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORLD_PATH = join(REPO_ROOT, "content/world/new_york_overworld.json");
const PERSONA_DIR = join(REPO_ROOT, "blind-tester/personas");

type SavePlaytestReportInput = {
  reportText: string;
  transcript: string;
  store?: string;
  providerId: string;
  modelId: string;
  personaId?: string;
  personaTitle?: string;
  seed: number;
  gameSessionId: string;
  attestedBy: string;
  method: string;
  recordedAt?: string;
  requestedOutcome?: PlaytestOutcome;
  turns?: number;
  acceptedDecisions?: number | null;
  buildCommit?: string;
  trackedWorktreeClean?: boolean;
  transcriptFilename?: string;
  /** Private server JSONL. When present, the report receipt must match it exactly. */
  runEvidenceText?: string;
  /** Server-authored build provenance from verified V2 run evidence. */
  build?: PureRunBuild;
};

type SavePlaytestReportResult = {
  record: PlaytestSessionRecord;
  dir: string;
  extract: ExitInterviewExtraction;
  verification: BlindReportVerification;
};

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

/**
 * Interview extraction is the completed-outcome gate. Pure V2 + receipt → completed;
 * anything else is malformed_report (or the caller's non-completed label).
 */
function classifyPlaytestReportOutcome(
  reportText: string,
  requestedOutcome?: PlaytestOutcome,
  runEvidenceText?: string,
): {
  extract: ExitInterviewExtraction;
  verification: BlindReportVerification;
  verifiedInterview: ExitInterview | null;
  outcome: PlaytestOutcome;
  failureNote: string | null;
} {
  const extract = extractExitInterview(reportText);
  const verification = verifyBlindReportText(
    reportText,
    runEvidenceText === undefined
      ? {}
      : {
          requiredPlayMode: "pure",
          runEvidenceText,
        },
  );
  const verifiedInterview =
    verification.ok && isPureExitInterviewV2(verification.interview)
      ? verification.interview
      : null;
  if (verifiedInterview !== null) {
    const outcome =
      requestedOutcome && requestedOutcome !== "completed" ? requestedOutcome : "completed";
    return {
      extract,
      verification,
      verifiedInterview,
      outcome,
      failureNote: outcome === "completed" ? null : `session recorded with outcome "${outcome}"`,
    };
  }
  const reason = verification.ok
    ? "exit interview is not a pure V2 block with a journey receipt"
    : verification.reason;
  if (requestedOutcome === "completed" || requestedOutcome === undefined) {
    return {
      extract,
      verification,
      verifiedInterview,
      outcome: "malformed_report",
      failureNote: `report did not verify: ${reason}`,
    };
  }
  return {
    extract,
    verification,
    verifiedInterview,
    outcome: requestedOutcome,
    failureNote: `report did not verify: ${reason}`,
  };
}

export function savePlaytestReport(input: SavePlaytestReportInput): SavePlaytestReportResult {
  const provider = findPlaytestProvider(input.providerId);
  if (!provider) {
    throw new Error(`unknown provider "${input.providerId}"`);
  }
  const catalog = parsePlaytestCatalog(
    provider,
    JSON.parse(readFileSync(join(REPO_ROOT, provider.catalogPath), "utf8")),
  );
  const model = findCatalogModel(catalog, input.modelId);
  const personaId = input.personaId ?? "default";
  const personaText = readFileSync(join(PERSONA_DIR, `${personaId}.md`), "utf8");
  const classified = classifyPlaytestReportOutcome(
    input.reportText,
    input.requestedOutcome,
    input.runEvidenceText,
  );

  let interview: PlaytestSessionBody["exit_interview"] = null;
  let receipt: PlaytestSessionBody["journey_receipt"] = null;
  if (classified.verifiedInterview !== null) {
    const split = splitExitInterview(classified.verifiedInterview);
    interview = split.interview;
    receipt = split.receipt;
  }

  const outcome = classified.outcome;
  if (outcome === "completed" && (interview === null || receipt === null)) {
    throw new Error("a completed session needs an extracted pure V2 interview and journey receipt");
  }

  const verifiedRun = classified.verification.ok ? classified.verification.run : null;
  const evidenceBuild =
    verifiedRun?.play_mode === "pure" && verifiedRun.schema_version === 2
      ? verifiedRun.build
      : undefined;
  if (verifiedRun?.play_mode === "pure" && verifiedRun.session_id !== input.gameSessionId) {
    throw new Error("gameSessionId does not match verified run evidence");
  }
  if (
    verifiedRun?.play_mode === "pure" &&
    verifiedRun.schema_version === 2 &&
    verifiedRun.run_seed !== input.seed
  ) {
    throw new Error("seed does not match verified run evidence");
  }
  if (
    evidenceBuild !== undefined &&
    input.build !== undefined &&
    !isDeepStrictEqual(input.build, evidenceBuild)
  ) {
    throw new Error("build does not match verified run evidence");
  }
  const suppliedBuild = evidenceBuild ?? input.build;
  if (
    suppliedBuild !== undefined &&
    input.buildCommit !== undefined &&
    suppliedBuild.git_commit !== input.buildCommit
  ) {
    throw new Error("build.git_commit does not match buildCommit");
  }
  if (
    suppliedBuild !== undefined &&
    input.trackedWorktreeClean !== undefined &&
    suppliedBuild.tracked_worktree_clean !== input.trackedWorktreeClean
  ) {
    throw new Error("build.tracked_worktree_clean does not match trackedWorktreeClean");
  }
  const build: PureRunBuild =
    suppliedBuild ??
    (() => {
      const world = parseOverworldManifest(JSON.parse(readFileSync(WORLD_PATH, "utf8")));
      return {
        git_commit: input.buildCommit ?? git(["rev-parse", "HEAD"]),
        tracked_worktree_clean:
          input.trackedWorktreeClean ?? git(["status", "--porcelain"]).length === 0,
        world_id: world.id,
        world_hash: hashState(world),
      };
    })();
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const transcriptFilename = input.transcriptFilename ?? "transcript.jsonl";
  const body: PlaytestSessionBody = {
    schema_version: 1,
    recorded_at: recordedAt,
    game_session_id: input.gameSessionId,
    run_seed: input.seed,
    build,
    provider: {
      id: provider.id,
      vendor: provider.vendor,
      family: provider.family,
      isolation: "operator_attested",
      transport_contract: provider.transportContract,
      operator_attestation: {
        attested_by: input.attestedBy,
        method: input.method,
        attested_at: recordedAt,
      },
    },
    model: { id: model.id, tier: model.tier, settings: model.settings },
    persona: {
      id: personaId,
      title: input.personaTitle ?? personaId,
      source_sha256: sha256Hex(personaText),
    },
    outcome,
    log: {
      turns: input.turns ?? 0,
      accepted_decisions:
        input.acceptedDecisions ??
        (receipt && "acceptedDecisions" in receipt ? receipt.acceptedDecisions : null),
      transcript_filename: transcriptFilename,
      transcript_sha256: sha256Hex(input.transcript),
      transcript_bytes: Buffer.byteLength(input.transcript, "utf8"),
    },
    exit_interview: interview,
    journey_receipt: receipt,
    failure_note: classified.failureNote,
  };

  PlaytestOutcomeSchema.parse(outcome);
  const record = sealPlaytestSession(body);
  const store = input.store ?? DEFAULT_SESSION_STORE;
  const dir = writePlaytestSession(store, record, input.transcript);
  return {
    record,
    dir,
    extract: classified.extract,
    verification: classified.verification,
  };
}
