#!/usr/bin/env -S npx tsx
/**
 * bin/feedback — CLI front end for the feedback compiler (Task 16): compiles
 * verified blind-tester ledger/cycle reports + crawler findings into ranked
 * `hotspots.json` / `hotspots.md` plus the mode-separated `retention.json`.
 *
 * Usage:
 *   npm run feedback:status
 *   npm run feedback:rebootstrap                     # recovery only
 *   npm run feedback:compile -- [--in <path>]... [--out <dir>] [--top K]
 *                                [--prev <dir>] [--llm-labels]
 *
 * Thin main: parse flags -> resolve defaults -> compileFeedback (all the
 * actual logic lives in src/feedback/compile.ts, unit-tested there) -> print
 * a short summary + the artifact paths.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "../src/core/hash.js";
import {
  acceptedCycleReportRef,
  loadAcceptedFeedbackBundle,
  readCommittedFeedbackAcceptanceState,
} from "../src/feedback/acceptance.js";
import {
  compileFeedback,
  inspectFeedbackCohort,
  MIN_FEEDBACK_COHORT_ACTIONABLE_REPORTS,
  type CompileOptions,
  type FeedbackCohortPolicy,
} from "../src/feedback/compile.js";
import { resolveFeedbackInputs } from "../src/feedback/inputs.js";

class FeedbackUsageError extends Error {}

type ParsedArgs = {
  inputs: string[];
  outDir: string | null;
  topK: number;
  llmLabels: boolean;
  prevDir: string | null;
  status: boolean;
  rebootstrap: boolean;
};

function requireValue(flag: string, raw: string | undefined): string {
  if (raw === undefined) throw new FeedbackUsageError(`${flag} requires a value`);
  return raw;
}

export function parseFeedbackArgs(argv: string[]): ParsedArgs {
  const inputs: string[] = [];
  let outDir: string | null = null;
  let topK = 10;
  let llmLabels = false;
  let prevDir: string | null = null;
  let status = false;
  let rebootstrap = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--in":
        inputs.push(requireValue("--in", argv[++i]));
        break;
      case "--out":
        outDir = requireValue("--out", argv[++i]);
        break;
      case "--top": {
        const raw = requireValue("--top", argv[++i]);
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) {
          throw new FeedbackUsageError(`--top must be a positive integer, got "${raw}"`);
        }
        topK = n;
        break;
      }
      case "--prev":
        prevDir = requireValue("--prev", argv[++i]);
        break;
      case "--llm-labels":
        llmLabels = true;
        break;
      case "--status":
        status = true;
        break;
      case "--rebootstrap":
        rebootstrap = true;
        break;
      default:
        throw new FeedbackUsageError(`unrecognized flag "${a}"`);
    }
  }
  if ((status || rebootstrap) && argv.length !== 1) {
    throw new FeedbackUsageError(
      `${status ? "--status" : "--rebootstrap"} cannot be combined with other options`,
    );
  }
  return { inputs, outDir, topK, llmLabels, prevDir, status, rebootstrap };
}

/** yyyymmddThhmmssZ — matches loadPreviousHotspots' lexicographic-sort assumption. */
function utcStamp(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}

function defaultOutDir(): string {
  return join("ai-runs", "feedback", utcStamp());
}

type CommittedAcceptance = ReturnType<typeof readCommittedFeedbackAcceptanceState>;

export function authoritativePolicy(
  root: string,
  rebootstrap = false,
  committed: CommittedAcceptance = readCommittedFeedbackAcceptanceState(root),
): FeedbackCohortPolicy {
  const parsed = committed;
  if (!parsed.ok) throw new Error(`feedback acceptance unavailable: ${parsed.reason}`);
  if (rebootstrap) {
    if (!parsed.state.accepted_compile) {
      throw new Error(
        "feedback rebootstrap refused: committed acceptance state has no accepted compile to recover",
      );
    }
    if (loadAcceptedFeedbackBundle(root, parsed.state)) {
      throw new Error(
        "feedback rebootstrap refused: the committed accepted feedback bundle is still valid",
      );
    }
    return { kind: "bootstrap" };
  }
  if (!parsed.state.accepted_compile) {
    // A committed empty marker is the explicit migration instruction: take a
    // zero-delta baseline. Marker-less installations may compile their first
    // eligible cohort normally.
    return parsed.found ? { kind: "bootstrap" } : { kind: "initial" };
  }
  const previous = loadAcceptedFeedbackBundle(root, parsed.state);
  if (!previous) {
    // The marker naming this compile is committed, but its bundle is gitignored, so every
    // checkout but the one that sealed it lands here — a fresh clone, a lane worktree, CI.
    // The bare "run rebootstrap" this used to end on was half the recovery: the command
    // refuses without a started dev cycle, its compile counts only once sealed, and a
    // sealed rebootstrap re-baselines EVERY checkout. Say all of that where it is needed.
    throw new Error(
      `accepted feedback compile ${parsed.state.accepted_compile.manifest_path} is missing or corrupt ` +
        "in this checkout (the bundle is gitignored, so it exists only where it was sealed). " +
        "Restore that bundle from that machine, or recover with npm run feedback:rebootstrap " +
        'inside a started dev cycle and seal it (docs/afk_loop.md, "If the whole ai-runs/ ' +
        'directory was cleared"). A sealed rebootstrap replaces the committed baseline for ' +
        "every checkout and marks every verified report on disk as already seen.",
    );
  }
  return {
    kind: "delta",
    previousManifest: previous.manifest,
    previousManifestSha256: parsed.state.accepted_compile.manifest_sha256,
    previousHotspots: previous.hotspots,
    previousEvidence: previous.evidence,
  };
}

export type FeedbackStatusCounts = {
  /** Report identities this compile would actually rank. */
  cohortVerified: number;
  cohortActionable: number;
  cohortExcludedMocks: number;
  /** Every verified identity currently on disk, ranked by this compile or not. */
  corpusVerified: number;
};

/**
 * The one-line `feedback:status` verdict.
 *
 * Pure and exported because the bootstrap case is a trap worth pinning. A bootstrap
 * cohort is EMPTY by construction (`inspectFeedbackCohort` sets `cohortVerified = []`),
 * so the counts an operator sees are all zero and the line said "compile ready" — while
 * the compile it authorizes writes EVERY currently-verified report identity into the
 * manifest's `seen_report_ids`. Every later delta compile filters those out, and report
 * identity is content-derived with a monotone lineage, so nothing can re-admit them.
 *
 * That matters most in the one place a bootstrap is normally reached by hand: the
 * documented `npm run feedback:rebootstrap` recovery after a re-clone or a wiped
 * `ai-runs/`. Verified reports sitting in `blind-tester/reports` at that moment are
 * consumed without ever producing a hot spot, and the status line was the last chance
 * to say so. Counting the corpus rather than the cohort is what makes the warning
 * possible at all.
 */
export function formatFeedbackStatusLine(
  policyKind: FeedbackCohortPolicy["kind"],
  counts: FeedbackStatusCounts,
): string {
  const ready =
    policyKind === "bootstrap" ||
    (policyKind !== "standalone" &&
      counts.cohortActionable >= MIN_FEEDBACK_COHORT_ACTIONABLE_REPORTS);
  const line =
    `feedback:status — ${policyKind}; ${counts.cohortVerified} new verified reports, ` +
    `${counts.cohortActionable} actionable, ${counts.cohortExcludedMocks} excluded mocks; ` +
    `${ready ? "compile ready" : `${MIN_FEEDBACK_COHORT_ACTIONABLE_REPORTS} actionable reports required`}.`;
  if (policyKind !== "bootstrap" || counts.corpusVerified === 0) return line;
  const reports = counts.corpusVerified === 1 ? "report" : "reports";
  return (
    `${line} A bootstrap compile ranks nothing and marks all ${counts.corpusVerified} ` +
    `verified ${reports} on disk as already seen; no later delta compile can re-admit them.`
  );
}

function rootRelativeRef(root: string, path: string): string {
  const ref = relative(resolve(root), resolve(root, path)).replaceAll("\\", "/");
  if (ref.length === 0 || ref === ".." || ref.startsWith("../") || isAbsolute(ref)) {
    throw new Error(`feedback artifact is outside the repository: ${path}`);
  }
  return ref;
}

function currentCycleRunId(root: string): string {
  const metadataPath = join(root, "ai-runs", "latest-cycle.json");
  if (!existsSync(metadataPath)) {
    throw new Error(
      "ai-runs/latest-cycle.json is missing; start a dev cycle with npm run ai:loop " +
        "and AI_LOOP_COMMIT=1 in the environment (no coding-agent CLI is required), " +
        "freeze its revision, then retry compilation. See docs/afk_loop.md for recovery and sealing.",
    );
  }
  const stat = lstatSync(metadataPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("ai-runs/latest-cycle.json must be a regular non-symlink file");
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch (error) {
    throw new Error(`ai-runs/latest-cycle.json is invalid: ${String(error)}`, { cause: error });
  }
  if (typeof metadata !== "object" || metadata === null) {
    throw new Error("ai-runs/latest-cycle.json must contain an object");
  }
  const runId = (metadata as Record<string, unknown>).runId;
  if (typeof runId !== "string") throw new Error("latest cycle metadata has no runId");
  // Reuse the tracked-state validator for the exact canonical run-id shape.
  acceptedCycleReportRef(runId);
  return runId;
}

function writeCompilePointer(
  root: string,
  runId: string,
  manifestPath: string,
  manifestSha256: string,
): string {
  const manifestRef = rootRelativeRef(root, manifestPath);
  if (!/^ai-runs\/feedback\/\d{8}T\d{6}Z\/report-manifest\.json$/u.test(manifestRef)) {
    throw new Error(`authoritative feedback manifest has a noncanonical path: ${manifestRef}`);
  }
  const pointerPath = join(root, "ai-runs", runId, "feedback-compile.json");
  mkdirSync(join(root, "ai-runs", runId), { recursive: true });
  writeFileSync(
    pointerPath,
    `${canonicalize({ schema_version: 1, run_id: runId, manifest_path: manifestRef, manifest_sha256: manifestSha256 })}\n`,
    "utf8",
  );
  return rootRelativeRef(root, pointerPath);
}

function main(): void {
  let parsed: ParsedArgs;
  try {
    parsed = parseFeedbackArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof FeedbackUsageError) {
      console.error(`usage error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const root = resolve(process.cwd());
  const authoritative = process.argv.slice(2).length === 0 || parsed.status || parsed.rebootstrap;
  const committed = authoritative ? readCommittedFeedbackAcceptanceState(root) : undefined;
  const policy = authoritative
    ? authoritativePolicy(root, parsed.rebootstrap, committed!)
    : ({ kind: "standalone" } as const);
  // Check the staging destination before the compiler writes its ignored bundle.
  // Status and standalone forensic compiles do not need a dev-cycle handoff.
  const cycleRunId = authoritative && !parsed.status ? currentCycleRunId(root) : null;
  const inputs = resolveFeedbackInputs(
    root,
    parsed.inputs,
    committed?.ok ? committed.state : undefined,
  );

  if (parsed.status) {
    const inspection = inspectFeedbackCohort(root, inputs, policy);
    console.log(
      formatFeedbackStatusLine(policy.kind, {
        cohortVerified: inspection.cohort.verified_report_ids.length,
        cohortActionable: inspection.cohort.actionable_report_ids.length,
        cohortExcludedMocks: inspection.cohort.excluded_mock_report_ids.length,
        corpusVerified: inspection.corpus.verified_report_ids.length,
      }),
    );
    return;
  }

  const outDir = parsed.outDir ?? defaultOutDir();

  if (parsed.llmLabels) {
    console.log("labels pass skipped (not configured)");
  }

  const opts: CompileOptions = {
    root,
    inputs,
    outDir,
    topK: parsed.topK,
    llmLabels: parsed.llmLabels,
    prevDir: parsed.prevDir,
    cohortPolicy: policy,
  };

  const {
    file,
    evidence,
    excludedMockReports,
    jsonPath,
    mdPath,
    retentionPath,
    manifest,
    manifestPath,
    manifestSha256,
  } = compileFeedback(opts);

  console.log(
    `feedback:compile — ${manifest.kind} cohort: ${file.inputs.verified_reports} verified reports, ` +
      `${file.inputs.crawl_findings} crawl findings, ${file.hotspots.length} hot spots.`,
  );
  const cumulativeReports =
    evidence.report_modes.pure +
    evidence.report_modes.structural +
    evidence.report_modes.legacy_guided;
  console.log(
    `Cumulative corpus: ${cumulativeReports} verified reports ` +
      `(${file.inputs.rejected_reports} rejected); ` +
      `${evidence.pure_retention.eligible_reports} pure retention exits, ` +
      `${
        evidence.pure_retention.contract_versions.length === 0
          ? "no contract-specific curves"
          : evidence.pure_retention.contract_versions
              .map(
                (cohort) =>
                  `v${cohort.contract_version}: ${cohort.eligible_reports} exits, ${cohort.continued_reports} continued`,
              )
              .join("; ")
      }; ` +
      `other modes: ${evidence.report_modes.structural} structural, ` +
      `${evidence.report_modes.legacy_guided} legacy-guided.`,
  );
  console.log(
    `Product evidence (${manifest.kind} cohort): ${file.inputs.actionable_reports} actionable reports; ` +
      `${excludedMockReports} deterministic structural mocks excluded.`,
  );
  if (file.recommended_next_fix) {
    console.log(`Recommended next fix: ${file.recommended_next_fix.hotspot_id}`);
  }
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${retentionPath}`);
  console.log(`Wrote ${manifestPath}`);
  if (cycleRunId !== null && manifest.kind !== "standalone") {
    console.log(
      `Staged feedback acceptance pointer ${writeCompilePointer(root, cycleRunId, manifestPath, manifestSha256)}`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
