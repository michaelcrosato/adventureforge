#!/usr/bin/env -S npx tsx
/**
 * Turn one finished `blind-tester/run.sh` run into a session record.
 *
 * This is the connector that makes the automated playtest loop actually feed the dev
 * loop. `run.sh` publishes the artifacts it always has — a report, a provider envelope,
 * run evidence, and a verified sidecar — but those are per-run files in a reports
 * directory, not a corpus. Triage reads a CORPUS. Without this step a QA loop can run
 * forty players, produce forty reports, and promote nothing, because the store it
 * triages is empty.
 *
 * Two rules it holds to:
 *
 * 1. NOTHING IS THROWN AWAY. A run that timed out, crashed, or produced an unparseable
 *    interview still gets a record, with an outcome that says so. A player who gave up
 *    is evidence; silently dropping those runs is how a corpus becomes a
 *    survivorship-biased advertisement for itself.
 *
 * 2. IT NEVER OVERSTATES PROVENANCE. Only a provider the runner actually owns the
 *    process of is stamped `runner_enforced`. Any weaker lane requires an explicit
 *    operator attestation; the recorder cannot be talked into labelling a run as proven.
 *
 * Usage (called by playtest-loop.sh; also fine by hand):
 *   npm run playtest:record -- --out <run.sh --out prefix> \
 *     --provider codex --model gpt-5.3-codex-spark --persona default [--store <dir>]
 * Pass the launch's --effort (or BLIND_REASONING_EFFORT) when overriding the catalog.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashState } from "../src/core/hash.js";
import { JourneyExitReceiptSchema } from "../src/blind/exit_interview.js";
import { verifyBlindReportText } from "../src/blind/report_verifier.js";
import { parseBlindRunSidecar } from "../src/blind/run_evidence.js";
import { PureReceiptBindingMetadataSchema } from "../src/blind/receipt_binding.js";
import {
  findCatalogModel,
  findPlaytestProvider,
  parsePlaytestCatalog,
  playtestProviderIds,
  runnerCanDriveProvider,
} from "../src/blind/providers.js";
import { parseOverworldManifest } from "../src/world/overworld.js";
import {
  splitExitInterview,
  sealPlaytestSession,
  type PlaytestOutcome,
  type PlaytestSessionBody,
} from "../src/qa/session_record.js";
import { DEFAULT_SESSION_STORE, sha256Hex, writePlaytestSession } from "../src/qa/session_store.js";
import { verifyRecordedRunnerEvidence } from "../src/qa/runner_evidence.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORLD_PATH = join(REPO_ROOT, "content/world/new_york_overworld.json");
const PERSONA_DIR = join(REPO_ROOT, "blind-tester/personas");

function arg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function required(flag: string): string {
  const value = arg(flag);
  if (value === null) throw new Error(`${flag} is required`);
  return value;
}

function readIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Tool calls the player made, counted off the run-evidence stream when it exists. */
function countTurns(evidence: string | null): number {
  if (!evidence) return 0;
  return evidence.split("\n").filter((line) => line.trim().length > 0).length;
}

function main(): void {
  const outPrefix = required("--out");
  const providerId = required("--provider");
  const provider = findPlaytestProvider(providerId);
  if (!provider) {
    throw new Error(
      `unknown provider "${providerId}"; registered: ${playtestProviderIds().join(", ")}`,
    );
  }

  const catalog = parsePlaytestCatalog(
    provider,
    JSON.parse(readFileSync(join(REPO_ROOT, provider.catalogPath), "utf8")),
  );
  const model = findCatalogModel(catalog, required("--model"));
  const reasoningEffort =
    arg("--effort") ??
    (process.env.BLIND_REASONING_EFFORT || undefined) ??
    model.settings.reasoning_effort;
  if (
    reasoningEffort !== undefined &&
    !/^(minimal|low|medium|high|xhigh|max)$/.test(String(reasoningEffort))
  ) {
    throw new Error("--effort / BLIND_REASONING_EFFORT must name a supported reasoning effort");
  }

  const personaId = arg("--persona") ?? "default";
  const personaText = readFileSync(join(PERSONA_DIR, `${personaId}.md`), "utf8");

  // The binder writes this only when it actually replaced the receipt, so its presence is
  // the fact being recorded. Parsed through the same schema the binder seals, because a
  // hand-edited sidecar must not be able to stamp a record with a repair that never ran.
  const receiptBindingText = readIfPresent(`${outPrefix}.receipt-bind.json`);
  let receiptRepair: { replaced_field: string; count: number; initial_failure: string } | undefined;
  if (receiptBindingText !== null) {
    const parsed = PureReceiptBindingMetadataSchema.safeParse(JSON.parse(receiptBindingText));
    if (!parsed.success) {
      throw new Error("receipt binding metadata is present but invalid");
    }
    receiptRepair = {
      replaced_field: parsed.data.replaced_field,
      count: parsed.data.binding_count,
      initial_failure: parsed.data.initial_failure,
    };
  }

  const reportText = readIfPresent(`${outPrefix}.md`);
  const sidecarText = readIfPresent(`${outPrefix}.run.json`);
  const evidenceText = readIfPresent(`${outPrefix}.evidence.jsonl`);

  // The sidecar is the run's server-authored spine: it carries the exact seed, the
  // build that was played, and the game session id. Without it we know a run happened
  // but not precisely what it played, so the record says exactly that rather than
  // guessing from the surrounding files.
  // Takes the raw TEXT, not a parsed object: it rejects duplicate keys itself, which it
  // cannot do once `JSON.parse` has already collapsed them. Handing it `JSON.parse(...)`
  // type-checks silently — `JSON.parse` returns `any` — and then fails every single
  // parse with "not valid JSON", which is how this went unnoticed: the sidecar was never
  // read at all, so every recorded session silently fell back to seed 0, an
  // `unknown-<path>` session id, and the checkout's HEAD instead of the build played.
  const parsedSidecar = sidecarText ? parseBlindRunSidecar(sidecarText) : null;

  // A STRUCTURAL run is not evidence and must never enter the corpus.
  //
  // `--mock` and `--smoke` drive the game with a scripted agent and no model behind it
  // at all, yet still emit a report carrying a filled-in exit interview. Recorded
  // naively, that canned text becomes a vendor's opinion: the provider's registry entry
  // stamps the record `runner_enforced`, and its family counts toward corroboration — so
  // three mock runs under three provider ids read as three independent vendors agreeing
  // and promote straight into the dev queue. Fabricated evidence that looks verified is
  // worse than no evidence, which is the whole reason the isolation classes exist.
  //
  // The sidecar states it plainly (`play_mode: "structural"`, `evidence_status:
  // "not_applicable"`); the defect was only that this reader ignored it, while
  // the retired feedback-ledger reader always applied the same rule. Skipping is not
  // discarding a playthrough — nothing played. Exits 0 so a wiring check driven through
  // playtest-loop.sh reports a clean skip instead of looking like a crash.
  if (parsedSidecar?.ok === true && parsedSidecar.sidecar.play_mode !== "pure") {
    // Non-pure narrows to the structural sidecar, which always names its kind.
    const kind = parsedSidecar.sidecar.structural_kind;
    console.log(
      `skipped ${outPrefix}: ${kind} run, not a playtest. Structural runs exercise the ` +
        `wiring with no model behind them, so recording one would file a scripted exit ` +
        `interview in the corpus as a vendor's opinion.`,
    );
    return;
  }

  // Only the V2 pure sidecar carries the seed and the build. A V1 or structural sidecar
  // is still a real artifact, but it cannot tell us WHICH build was played — so the
  // record falls back to the checkout below and does not pretend otherwise.
  const pureSidecar =
    parsedSidecar?.ok === true &&
    parsedSidecar.sidecar.play_mode === "pure" &&
    "build" in parsedSidecar.sidecar
      ? parsedSidecar.sidecar
      : null;

  let interview: PlaytestSessionBody["exit_interview"] = null;
  let receipt: PlaytestSessionBody["journey_receipt"] = null;
  let failureNote: string | null = null;

  if (reportText) {
    const verified = verifyBlindReportText(reportText);
    if (verified.ok) {
      const split = splitExitInterview(verified.interview);
      interview = split.interview;
      receipt = split.receipt;
    } else {
      failureNote = `report did not verify: ${verified.reason}`;
    }
  } else {
    failureNote = `no report was published at ${outPrefix}.md`;
  }

  // Prefer the sidecar's receipt: it is server-authored and survives a report whose
  // fenced block was mangled by the client.
  if (!receipt && pureSidecar && "receipt" in pureSidecar) {
    receipt = JourneyExitReceiptSchema.parse(pureSidecar.receipt);
  }

  const explicit = arg("--outcome");
  const outcome: PlaytestOutcome = explicit
    ? (explicit as PlaytestOutcome)
    : interview && receipt
      ? "completed"
      : interview
        ? "abandoned"
        : reportText
          ? "malformed_report"
          : "failed";

  if (outcome !== "completed" && failureNote === null) {
    failureNote =
      arg("--failure-note") ??
      (receipt === null
        ? "the game never confirmed a journey exit for this run"
        : `session recorded with outcome "${outcome}"`);
  }

  const world = parseOverworldManifest(JSON.parse(readFileSync(WORLD_PATH, "utf8")));
  const build = pureSidecar?.build ?? {
    git_commit: git(["rev-parse", "HEAD"]) || "0".repeat(40),
    tracked_worktree_clean: git(["status", "--porcelain"]).length === 0,
    world_id: world.id,
    world_hash: hashState(world),
  };

  const drivable = runnerCanDriveProvider(provider);
  const proof = drivable.drivable
    ? verifyRecordedRunnerEvidence({
        outPrefix,
        provider: provider.id,
        model: model.id,
        transportContract: provider.transportContract,
        reasoningEffort: String(reasoningEffort ?? "xhigh"),
        reportText,
        sidecarText,
        evidenceText,
      })
    : { ok: false as const, reason: drivable.reason };
  const runnerIsolation = proof.ok ? "runner_enforced" : "operator_attested";
  if (provider.isolation === "runner_enforced" && !proof.ok) {
    console.error(
      `! sealing ${provider.id} as operator_attested rather than runner_enforced: ${proof.reason}`,
    );
  }

  const recordedAt = new Date().toISOString();
  let operatorAttestation:
    | {
        attested_by: string;
        method: string;
        attested_at: string;
      }
    | undefined;
  if (runnerIsolation === "operator_attested") {
    const attestedBy = arg("--attested-by");
    const method = arg("--method");
    if (!attestedBy || !method) {
      throw new Error(
        `recording ${provider.id} as operator_attested requires both --attested-by and ` +
          `--method; use npm run playtest:ingest for a manually driven session`,
      );
    }
    operatorAttestation = {
      attested_by: attestedBy,
      method,
      attested_at: recordedAt,
    };
  }

  const transcript = evidenceText ?? reportText ?? "";
  const body: PlaytestSessionBody = {
    schema_version: 1,
    recorded_at: recordedAt,
    game_session_id: pureSidecar?.session_id ?? arg("--game-session-id") ?? `unknown-${outPrefix}`,
    run_seed: pureSidecar?.run_seed ?? Number.parseInt(arg("--seed") ?? "0", 10),
    build,
    provider: {
      id: provider.id,
      vendor: provider.vendor,
      family: provider.family,
      // Re-audited artifacts, not the provider's potential capabilities, own this label.
      isolation: runnerIsolation,
      ...(proof.ok ? { client_evidence: proof.clientEvidence } : {}),
      transport_contract: provider.transportContract,
      ...(operatorAttestation ? { operator_attestation: operatorAttestation } : {}),
    },
    model: {
      id: model.id,
      tier: model.tier,
      settings: {
        ...model.settings,
        ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
      },
    },
    ...(receiptRepair === undefined ? {} : { receipt_repair: receiptRepair }),
    persona: {
      id: personaId,
      title: arg("--persona-title") ?? personaId,
      source_sha256: sha256Hex(personaText),
    },
    outcome,
    log: {
      turns: countTurns(evidenceText),
      accepted_decisions: receipt?.acceptedDecisions ?? null,
      transcript_filename: "transcript.jsonl",
      transcript_sha256: sha256Hex(transcript),
      transcript_bytes: Buffer.byteLength(transcript, "utf8"),
    },
    exit_interview: interview,
    journey_receipt: receipt,
    failure_note: failureNote,
  };

  const record = sealPlaytestSession(body);
  const store = arg("--store") ?? process.env.PLAYTEST_STORE ?? DEFAULT_SESSION_STORE;
  const dir = writePlaytestSession(store, record, transcript);
  console.log(
    `recorded ${record.outcome} ${provider.id}/${model.id} (${model.tier}) → ${dir.split("/").pop()}`,
  );
  // A session with no interview is provenance, not evidence: it yields no issues, so no
  // cluster and no ticket. Worth one line, because a whole cohort can look healthy in the
  // wave log while contributing nothing triage can act on.
  if (record.exit_interview === null) {
    console.log(`  ! no exit interview — contributes no issues to triage`);
  }
}

main();
