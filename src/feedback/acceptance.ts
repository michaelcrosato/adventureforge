import { existsSync, lstatSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { parseJsonRejectingDuplicateKeys } from "../blind/strict_json.js";
import { canonicalize } from "../core/hash.js";
import { FeedbackEvidenceSummarySchema, type FeedbackEvidenceSummary } from "./evidence_summary.js";
import { HotspotsFileSchema, type HotspotsFile } from "./schema.js";
import { loadReportManifest, sha256File, type ReportManifest } from "./report_manifest.js";

const SHA256_RE = /^[0-9a-f]{64}$/u;
const REPORT_ID_RE = /^(?:pure|report):[0-9a-f]{64}$/u;
const CYCLE_RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const ACCEPTANCE_MARKER_RE = /^<!-- feedback_acceptance: (.+) -->$/gmu;
const CYCLE_SELECTION_MARKER_RE = /^<!-- feedback_cycle_selection: (.+) -->$/gmu;

const PendingCycleReportSchema = z
  .object({
    run_id: z.string().regex(CYCLE_RUN_ID_RE),
    tested_commit: z.string().regex(COMMIT_RE),
    report_id: z.string().regex(REPORT_ID_RE),
    report_sha256: z.string().regex(SHA256_RE),
    evidence_sha256: z.string().regex(SHA256_RE),
    sidecar_sha256: z.string().regex(SHA256_RE),
  })
  .strict();

const AcceptedCompileSchema = z
  .object({
    manifest_path: z.string().min(1),
    manifest_sha256: z.string().regex(SHA256_RE),
    hotspots_path: z.string().min(1),
    hotspots_sha256: z.string().regex(SHA256_RE),
    consumed_by_run_id: z.string().regex(CYCLE_RUN_ID_RE).nullable(),
  })
  .strict();

export const FeedbackAcceptanceStateSchema = z
  .object({
    schema_version: z.literal(1),
    accepted_compile: AcceptedCompileSchema.nullable(),
    pending_cycle_reports: z.array(PendingCycleReportSchema),
  })
  .strict()
  .superRefine((state, ctx) => {
    const ordered = [...state.pending_cycle_reports].sort(
      (a, b) => a.run_id.localeCompare(b.run_id) || a.report_id.localeCompare(b.report_id),
    );
    if (canonicalize(ordered) !== canonicalize(state.pending_cycle_reports)) {
      ctx.addIssue({
        code: "custom",
        path: ["pending_cycle_reports"],
        message: "pending cycle reports must be sorted by run id and report id",
      });
    }
    if (new Set(state.pending_cycle_reports.map((entry) => entry.run_id)).size !== ordered.length) {
      ctx.addIssue({
        code: "custom",
        path: ["pending_cycle_reports"],
        message: "pending cycle run ids must be unique",
      });
    }
    if (
      new Set(state.pending_cycle_reports.map((entry) => entry.report_id)).size !== ordered.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["pending_cycle_reports"],
        message: "pending cycle report ids must be unique",
      });
    }
  });

export type FeedbackAcceptanceState = z.infer<typeof FeedbackAcceptanceStateSchema>;

const FeedbackCycleSelectionSchema = z
  .object({
    run_id: z.string().regex(CYCLE_RUN_ID_RE),
    selected_recommendation_id: z.string().min(1).max(200).nullable(),
  })
  .strict();

type FeedbackCycleSelection = z.infer<typeof FeedbackCycleSelectionSchema>;

type FeedbackCycleSelectionParse =
  | { ok: true; selection: FeedbackCycleSelection | null }
  | { ok: false; reason: string };

export function formatFeedbackCycleSelectionMarker(
  runId: string,
  selectedRecommendationId: string | null,
): string {
  const selection = FeedbackCycleSelectionSchema.parse({
    run_id: runId,
    selected_recommendation_id: selectedRecommendationId,
  });
  return `<!-- feedback_cycle_selection: ${canonicalize(selection)} -->`;
}

/** Read the exact provisional-commit attestation of what the agent actually chose. */
export function parseFeedbackCycleSelection(
  text: string,
  runId: string,
): FeedbackCycleSelectionParse {
  const markerLines = text
    .split(/\r?\n/u)
    .filter((line) => line.includes("feedback_cycle_selection:"));
  const matches = [...text.matchAll(CYCLE_SELECTION_MARKER_RE)];
  if (matches.length !== markerLines.length) {
    return { ok: false, reason: "AI loop state contains a malformed feedback cycle selection" };
  }
  const selections: FeedbackCycleSelection[] = [];
  for (const match of matches) {
    const strict = parseJsonRejectingDuplicateKeys(match[1]!, "feedback cycle selection marker");
    if (!strict.ok) return { ok: false, reason: strict.reason };
    const parsed = FeedbackCycleSelectionSchema.safeParse(strict.value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        reason: `feedback cycle selection is invalid at ${issue?.path.join(".") || "?"}: ${issue?.message ?? "schema mismatch"}`,
      };
    }
    if (
      match[0] !==
      formatFeedbackCycleSelectionMarker(parsed.data.run_id, parsed.data.selected_recommendation_id)
    ) {
      return { ok: false, reason: "feedback cycle selection marker is not canonical" };
    }
    if (parsed.data.run_id === runId) selections.push(parsed.data);
  }
  if (selections.length > 1) {
    return { ok: false, reason: `AI loop state contains duplicate selections for ${runId}` };
  }
  return { ok: true, selection: selections[0] ?? null };
}

export function removeFeedbackCycleSelectionMarker(text: string, runId: string): string {
  const parsed = parseFeedbackCycleSelection(text, runId);
  if (!parsed.ok) throw new Error(parsed.reason);
  if (!parsed.selection) return text;
  const line = formatFeedbackCycleSelectionMarker(
    parsed.selection.run_id,
    parsed.selection.selected_recommendation_id,
  );
  return text.replace(`${line}\n`, "").replace(line, "");
}

export const EMPTY_FEEDBACK_ACCEPTANCE_STATE: FeedbackAcceptanceState = {
  schema_version: 1,
  accepted_compile: null,
  pending_cycle_reports: [],
};

type FeedbackAcceptanceParse =
  | { ok: true; found: boolean; state: FeedbackAcceptanceState }
  | { ok: false; reason: string };

export function parseFeedbackAcceptanceStateText(text: string): FeedbackAcceptanceParse {
  const matches = [...text.matchAll(ACCEPTANCE_MARKER_RE)];
  if (matches.length === 0) {
    return { ok: true, found: false, state: structuredClone(EMPTY_FEEDBACK_ACCEPTANCE_STATE) };
  }
  if (matches.length !== 1) {
    return { ok: false, reason: "AI loop state contains multiple feedback acceptance markers" };
  }
  const strict = parseJsonRejectingDuplicateKeys(
    matches[0]![1]!,
    "AI loop feedback acceptance marker",
  );
  if (!strict.ok) return { ok: false, reason: strict.reason };
  const raw = strict.value;
  const parsed = FeedbackAcceptanceStateSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `feedback acceptance marker is invalid at ${issue?.path.join(".") || "?"}: ${issue?.message ?? "schema mismatch"}`,
    };
  }
  return { ok: true, found: true, state: parsed.data };
}

export function readFeedbackAcceptanceState(root: string): FeedbackAcceptanceParse {
  const path = join(resolve(root), "AI_LOOP_STATE.md");
  if (!existsSync(path)) return { ok: false, reason: "AI_LOOP_STATE.md is missing" };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { ok: false, reason: "AI_LOOP_STATE.md must be a regular non-symlink file" };
    }
    return parseFeedbackAcceptanceStateText(readFileSync(path, "utf8"));
  } catch (error) {
    return { ok: false, reason: `AI_LOOP_STATE.md could not be read: ${String(error)}` };
  }
}

/**
 * Read the authority marker from committed HEAD, never from the dirty ledger
 * scaffold an operating agent is allowed to edit before finalization.
 */
export function readCommittedFeedbackAcceptanceState(root: string): FeedbackAcceptanceParse {
  try {
    const text = execFileSync("git", ["show", "HEAD:AI_LOOP_STATE.md"], {
      cwd: resolve(root),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseFeedbackAcceptanceStateText(text);
  } catch (error) {
    return {
      ok: false,
      reason: `committed feedback acceptance state is unavailable: ${String(error)}`,
    };
  }
}

export function upsertFeedbackAcceptanceStateText(
  text: string,
  state: FeedbackAcceptanceState,
): string {
  const validated = FeedbackAcceptanceStateSchema.parse(state);
  const line = `<!-- feedback_acceptance: ${canonicalize(validated)} -->`;
  const matches = [...text.matchAll(ACCEPTANCE_MARKER_RE)];
  if (matches.length > 1) {
    throw new Error("AI loop state contains multiple feedback acceptance markers");
  }
  if (matches.length === 1) return text.replace(ACCEPTANCE_MARKER_RE, line);

  const historicalMarker = /^<!--\s*historical_cycle_count:\s*\d+\s*-->$/mu;
  if (historicalMarker.test(text)) {
    return text.replace(historicalMarker, (match) => `${match}\n${line}`);
  }
  const title = /^# AI Loop State\s*$/mu;
  if (!title.test(text)) throw new Error("AI loop state title is missing");
  return text.replace(title, (match) => `${match}\n\n${line}`);
}

export function acceptedCycleReportRef(runId: string): string {
  if (!CYCLE_RUN_ID_RE.test(runId))
    throw new Error(`invalid cycle run id ${JSON.stringify(runId)}`);
  return `ai-runs/${runId}/playtest.md`;
}

function regularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolve only pending reports whose tracked acceptance receipt still matches
 * the ignored local report/evidence/sidecar bytes. Missing local evidence is
 * normal on a clean clone and therefore fails closed without invalidating the
 * tracked state itself.
 */
export function pendingAcceptedCycleReportPaths(
  root: string,
  state: FeedbackAcceptanceState,
  sha256File: (path: string) => string,
): string[] {
  const rootPath = resolve(root);
  const accepted: string[] = [];
  for (const entry of state.pending_cycle_reports) {
    const ref = acceptedCycleReportRef(entry.run_id);
    const report = containedPath(rootPath, ref);
    if (!report) continue;
    const rel = relative(rootPath, report);
    if (
      rel === ".." ||
      rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(rel)
    ) {
      continue;
    }
    const base = report.slice(0, -".md".length);
    const evidence = `${base}.evidence.jsonl`;
    const sidecar = `${base}.run.json`;
    if (!regularFile(report) || !regularFile(evidence) || !regularFile(sidecar)) continue;
    try {
      if (
        sha256File(report) !== entry.report_sha256 ||
        sha256File(evidence) !== entry.evidence_sha256 ||
        sha256File(sidecar) !== entry.sidecar_sha256
      ) {
        continue;
      }
    } catch {
      continue;
    }
    accepted.push(ref);
  }
  return accepted.sort();
}

export type AcceptedFeedbackBundle = {
  manifest: ReportManifest;
  manifestPath: string;
  hotspots: HotspotsFile;
  hotspotsPath: string;
  evidence: FeedbackEvidenceSummary;
};

const MANIFEST_REF_RE = /^ai-runs\/feedback\/(\d{8}T\d{6}Z)\/report-manifest\.json$/u;

function containedPath(root: string, ref: string): string | null {
  if (ref.includes("\\") || isAbsolute(ref)) return null;
  const rootPath = resolve(root);
  const path = resolve(rootPath, ref);
  const rel = relative(rootPath, path).replaceAll("\\", "/");
  if (rel !== ref || rel === ".." || rel.startsWith("../")) return null;
  try {
    let cursor = rootPath;
    for (const segment of ref.split("/")) {
      cursor = join(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) return null;
    }
  } catch {
    return null;
  }
  return path;
}

function readStrictJson(path: string): unknown | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const parsed = parseJsonRejectingDuplicateKeys(readFileSync(path, "utf8"), path);
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

/** Load exactly the compile authorized by tracked state and verify every output digest. */
export function loadAcceptedFeedbackBundle(
  root: string,
  state: FeedbackAcceptanceState,
): AcceptedFeedbackBundle | null {
  const accepted = state.accepted_compile;
  if (!accepted) return null;
  const match = MANIFEST_REF_RE.exec(accepted.manifest_path);
  if (!match) return null;
  const baseRef = `ai-runs/feedback/${match[1]!}`;
  const expectedHotspotsRef = `${baseRef}/hotspots.json`;
  if (accepted.hotspots_path !== expectedHotspotsRef) return null;

  const manifestPath = containedPath(root, accepted.manifest_path);
  const hotspotsPath = containedPath(root, expectedHotspotsRef);
  const retentionPath = containedPath(root, `${baseRef}/retention.json`);
  const markdownPath = containedPath(root, `${baseRef}/hotspots.md`);
  if (!manifestPath || !hotspotsPath || !retentionPath || !markdownPath) return null;

  const loaded = loadReportManifest(manifestPath, accepted.manifest_sha256);
  if (!loaded) return null;
  if (!regularFile(retentionPath) || !regularFile(markdownPath)) return null;
  try {
    if (
      sha256File(hotspotsPath) !== accepted.hotspots_sha256 ||
      accepted.hotspots_sha256 !== loaded.manifest.outputs.hotspots_sha256 ||
      sha256File(retentionPath) !== loaded.manifest.outputs.retention_sha256 ||
      sha256File(markdownPath) !== loaded.manifest.outputs.markdown_sha256
    ) {
      return null;
    }
  } catch {
    return null;
  }

  const hotspots = HotspotsFileSchema.safeParse(readStrictJson(hotspotsPath));
  if (!hotspots.success) return null;
  const evidence = FeedbackEvidenceSummarySchema.safeParse(readStrictJson(retentionPath));
  if (!evidence.success) return null;
  const cumulativeEvidenceReports =
    evidence.data.report_modes.pure +
    evidence.data.report_modes.structural +
    evidence.data.report_modes.legacy_guided;
  if (
    hotspots.data.commit !== loaded.manifest.commit ||
    hotspots.data.generated_at !== loaded.manifest.generated_at ||
    cumulativeEvidenceReports !== loaded.manifest.corpus.seen_report_ids.length ||
    hotspots.data.inputs.verified_reports !== loaded.manifest.cohort.verified_report_ids.length ||
    hotspots.data.inputs.actionable_reports !==
      loaded.manifest.cohort.actionable_report_ids.length ||
    hotspots.data.inputs.excluded_mock_reports !==
      loaded.manifest.cohort.excluded_mock_report_ids.length
  ) {
    return null;
  }
  return {
    manifest: loaded.manifest,
    manifestPath,
    hotspots: hotspots.data,
    hotspotsPath,
    evidence: evidence.data,
  };
}

/** Assessor authority: consumed, missing, untracked, or tampered compiles are inert. */
export function readAcceptedHotspots(root: string): HotspotsFile | null {
  const parsed = readCommittedFeedbackAcceptanceState(root);
  if (!parsed.ok || !parsed.found || parsed.state.accepted_compile?.consumed_by_run_id) return null;
  return loadAcceptedFeedbackBundle(root, parsed.state)?.hotspots ?? null;
}
