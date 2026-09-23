import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  authoritativePolicy,
  formatFeedbackStatusLine,
  parseFeedbackArgs,
} from "../../bin/feedback.js";
import {
  upsertFeedbackAcceptanceStateText,
  type FeedbackAcceptanceState,
} from "../../src/feedback/acceptance.js";
import {
  serializeReportManifest,
  sha256File,
  type ReportManifest,
} from "../../src/feedback/report_manifest.js";
import { HOTSPOTS_VERSION, type HotspotsFile } from "../../src/feedback/schema.js";

const REPO_ROOT = process.cwd();
const RUN_ID = "2026-08-08T23-30-00-000Z";
const TEMP_ROOTS: string[] = [];
const TSX_LOADER = pathToFileURL(join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const FEEDBACK_CLI = join(REPO_ROOT, "bin", "feedback.ts");

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "feedback-rebootstrap-"));
  TEMP_ROOTS.push(root);
  return root;
}

afterEach(() => {
  while (TEMP_ROOTS.length > 0) {
    rmSync(TEMP_ROOTS.pop()!, { recursive: true, force: true });
  }
});

function runGit(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function commitAcceptanceState(root: string, state: FeedbackAcceptanceState): string {
  writeFileSync(
    join(root, "AI_LOOP_STATE.md"),
    upsertFeedbackAcceptanceStateText("# AI Loop State\n", state),
  );
  runGit(root, ["init", "-q"]);
  runGit(root, ["config", "user.email", "rebootstrap@example.invalid"]);
  runGit(root, ["config", "user.name", "feedback-rebootstrap-test"]);
  runGit(root, ["add", "AI_LOOP_STATE.md"]);
  runGit(root, ["commit", "-qm", "acceptance-state"]);
  return runGit(root, ["rev-parse", "HEAD"]);
}

function missingBundleState(): FeedbackAcceptanceState {
  return {
    schema_version: 1,
    accepted_compile: {
      manifest_path: "ai-runs/feedback/20260808T220000Z/report-manifest.json",
      manifest_sha256: "a".repeat(64),
      hotspots_path: "ai-runs/feedback/20260808T220000Z/hotspots.json",
      hotspots_sha256: "b".repeat(64),
      consumed_by_run_id: null,
    },
    pending_cycle_reports: [],
  };
}

function writeHealthyBundle(root: string, commit: string): FeedbackAcceptanceState {
  const stamp = "20260808T220000Z";
  const dir = join(root, "ai-runs", "feedback", stamp);
  mkdirSync(dir, { recursive: true });
  const generatedAt = "2026-08-08T22:00:00.000Z";
  const hotspots: HotspotsFile = {
    version: HOTSPOTS_VERSION,
    generated_at: generatedAt,
    commit,
    inputs: {
      report_dirs: [],
      crawl_files: [],
      verified_reports: 0,
      actionable_reports: 0,
      excluded_mock_reports: 0,
      rejected_reports: 0,
      crawl_findings: 0,
    },
    metrics: [],
    sycophancy: {
      reports: 0,
      zero_negative_rate: 0,
      clarity_histogram: [0, 0, 0, 0, 0],
      enjoyment_histogram: [0, 0, 0, 0, 0],
      by_persona_zero_negative: {},
    },
    hotspots: [],
    recommended_next_fix: null,
  };
  const evidence = {
    schema_version: 2,
    report_modes: { pure: 0, structural: 0, legacy_guided: 0 },
    pure_retention: { eligible_reports: 0, contract_versions: [] },
  };
  const hotspotsPath = join(dir, "hotspots.json");
  const retentionPath = join(dir, "retention.json");
  const markdownPath = join(dir, "hotspots.md");
  writeFileSync(hotspotsPath, `${JSON.stringify(hotspots)}\n`);
  writeFileSync(retentionPath, `${JSON.stringify(evidence)}\n`);
  writeFileSync(markdownPath, "# Feedback\n");
  const manifest: ReportManifest = {
    schema_version: 1,
    kind: "bootstrap",
    generated_at: generatedAt,
    commit,
    previous_manifest_sha256: null,
    corpus: {
      verified_report_ids: [],
      actionable_report_ids: [],
      excluded_mock_report_ids: [],
      seen_report_ids: [],
    },
    cohort: {
      verified_report_ids: [],
      actionable_report_ids: [],
      excluded_mock_report_ids: [],
    },
    outputs: {
      hotspots_sha256: sha256File(hotspotsPath),
      retention_sha256: sha256File(retentionPath),
      markdown_sha256: sha256File(markdownPath),
    },
  };
  const manifestPath = join(dir, "report-manifest.json");
  writeFileSync(manifestPath, serializeReportManifest(manifest));
  return {
    schema_version: 1,
    accepted_compile: {
      manifest_path: `ai-runs/feedback/${stamp}/report-manifest.json`,
      manifest_sha256: sha256File(manifestPath),
      hotspots_path: `ai-runs/feedback/${stamp}/hotspots.json`,
      hotspots_sha256: manifest.outputs.hotspots_sha256,
      consumed_by_run_id: null,
    },
    pending_cycle_reports: [],
  };
}

function runRebootstrap(root: string) {
  return spawnSync(process.execPath, ["--import", TSX_LOADER, FEEDBACK_CLI, "--rebootstrap"], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("feedback rebootstrap recovery CLI", () => {
  it("is an exclusive recovery flag with a dedicated package command", () => {
    expect(parseFeedbackArgs(["--rebootstrap"])).toMatchObject({ rebootstrap: true });
    expect(() => parseFeedbackArgs(["--rebootstrap", "--top", "3"])).toThrow(/cannot be combined/u);
    const scripts = (
      JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["feedback:rebootstrap"]).toBe("tsx bin/feedback.ts --rebootstrap");
  });

  it("warns that a bootstrap consumes the verified reports it will never rank", () => {
    // A bootstrap cohort is empty by construction, so every count on the status line is
    // zero — while the compile it authorizes marks every verified identity on disk as
    // seen forever. An operator following the documented recovery with reports sitting
    // in blind-tester/reports had no signal that they were about to be swallowed.
    const bootstrap = formatFeedbackStatusLine("bootstrap", {
      cohortVerified: 0,
      cohortActionable: 0,
      cohortExcludedMocks: 0,
      corpusVerified: 12,
    });
    expect(bootstrap).toContain("compile ready");
    expect(bootstrap).toContain("marks all 12 verified reports on disk as already seen");
    expect(bootstrap).toContain("no later delta compile can re-admit them");

    // Nothing to lose, nothing to warn about.
    expect(
      formatFeedbackStatusLine("bootstrap", {
        cohortVerified: 0,
        cohortActionable: 0,
        cohortExcludedMocks: 0,
        corpusVerified: 0,
      }),
    ).toBe(
      "feedback:status — bootstrap; 0 new verified reports, 0 actionable, 0 excluded mocks; compile ready.",
    );
  });

  it("leaves the delta verdict byte-identical to what the loop has always printed", () => {
    // Cycle records quote this line verbatim (traces/bugs/*.yaml), so the non-bootstrap
    // wording is a contract, not a detail.
    expect(
      formatFeedbackStatusLine("delta", {
        cohortVerified: 3,
        cohortActionable: 3,
        cohortExcludedMocks: 0,
        corpusVerified: 41,
      }),
    ).toBe(
      "feedback:status — delta; 3 new verified reports, 3 actionable, 0 excluded mocks; compile ready.",
    );
    expect(
      formatFeedbackStatusLine("delta", {
        cohortVerified: 1,
        cohortActionable: 1,
        cohortExcludedMocks: 0,
        corpusVerified: 41,
      }),
    ).toBe(
      "feedback:status — delta; 1 new verified reports, 1 actionable, 0 excluded mocks; 3 actionable reports required.",
    );
  });

  // `feedback:status` fails in every checkout but the one that sealed the accepted compile,
  // because the bundle is gitignored. The message used to end on a bare "run
  // feedback:rebootstrap", which refuses outside a started dev cycle, counts only once
  // sealed, and re-baselines every checkout. The whole recovery has to be in the message.
  it("names the missing bundle and the whole recovery when status cannot load it", () => {
    const committed = { ok: true as const, found: true, state: missingBundleState() };
    const status = () => authoritativePolicy(tempRoot(), false, committed);
    expect(status).toThrow(
      "accepted feedback compile ai-runs/feedback/20260808T220000Z/report-manifest.json is missing or corrupt",
    );
    expect(status).toThrow(/npm run feedback:rebootstrap\s+inside a started dev cycle and seal it/);
    expect(status).toThrow(/replaces the committed baseline for every checkout/);
  });

  it("refuses recovery without an accepted pointer or while its bundle remains valid", () => {
    const emptyRoot = tempRoot();
    commitAcceptanceState(emptyRoot, {
      schema_version: 1,
      accepted_compile: null,
      pending_cycle_reports: [],
    });
    const empty = runRebootstrap(emptyRoot);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("has no accepted compile to recover");

    const healthyRoot = tempRoot();
    writeFileSync(join(healthyRoot, "AI_LOOP_STATE.md"), "# placeholder\n");
    runGit(healthyRoot, ["init", "-q"]);
    runGit(healthyRoot, ["config", "user.email", "rebootstrap@example.invalid"]);
    runGit(healthyRoot, ["config", "user.name", "feedback-rebootstrap-test"]);
    runGit(healthyRoot, ["add", "AI_LOOP_STATE.md"]);
    runGit(healthyRoot, ["commit", "-qm", "placeholder"]);
    const healthyState = writeHealthyBundle(
      healthyRoot,
      runGit(healthyRoot, ["rev-parse", "HEAD"]),
    );
    writeFileSync(
      join(healthyRoot, "AI_LOOP_STATE.md"),
      upsertFeedbackAcceptanceStateText("# AI Loop State\n", healthyState),
    );
    runGit(healthyRoot, ["add", "AI_LOOP_STATE.md"]);
    runGit(healthyRoot, ["commit", "-qm", "accepted-bundle"]);
    const healthy = runRebootstrap(healthyRoot);
    expect(healthy.status).toBe(1);
    expect(healthy.stderr).toContain("accepted feedback bundle is still valid");
  });

  it("writes a bootstrap manifest and current-cycle authority pointer only for missing state", () => {
    const root = tempRoot();
    const head = commitAcceptanceState(root, missingBundleState());
    cpSync(join(REPO_ROOT, "content"), join(root, "content"), { recursive: true });
    mkdirSync(join(root, "blind-tester", "reports"), { recursive: true });
    const runDir = join(root, "ai-runs", RUN_ID);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(root, "ai-runs", "latest-cycle.json"),
      JSON.stringify({ runId: RUN_ID, playtestRecord: `ai-runs/${RUN_ID}/playtest.md` }),
    );

    const result = runRebootstrap(root);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("bootstrap cohort");
    expect(result.stdout).toContain("Staged feedback acceptance pointer");
    const pointer = JSON.parse(readFileSync(join(runDir, "feedback-compile.json"), "utf8")) as {
      schema_version: number;
      run_id: string;
      manifest_path: string;
      manifest_sha256: string;
    };
    expect(pointer).toMatchObject({ schema_version: 1, run_id: RUN_ID });
    const manifest = JSON.parse(readFileSync(join(root, pointer.manifest_path), "utf8")) as {
      kind: string;
      commit: string;
      previous_manifest_sha256: string | null;
    };
    expect(manifest).toMatchObject({
      kind: "bootstrap",
      commit: head,
      previous_manifest_sha256: null,
    });
  });

  it("explains how to recreate a cleared cycle directory before writing a recovery bundle", () => {
    const root = tempRoot();
    commitAcceptanceState(root, missingBundleState());
    cpSync(join(REPO_ROOT, "content"), join(root, "content"), { recursive: true });
    mkdirSync(join(root, "blind-tester", "reports"), { recursive: true });
    const stateBefore = readFileSync(join(root, "AI_LOOP_STATE.md"), "utf8");
    expect(existsSync(join(root, "ai-runs"))).toBe(false);

    const result = runRebootstrap(root);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("ai-runs/latest-cycle.json is missing");
    expect(result.stderr).toContain("npm run ai:loop");
    expect(result.stderr).toContain("AI_LOOP_COMMIT=1");
    expect(result.stderr).toContain("no coding-agent CLI is required");
    expect(result.stdout).not.toContain("Wrote");
    expect(existsSync(join(root, "ai-runs"))).toBe(false);
    expect(readFileSync(join(root, "AI_LOOP_STATE.md"), "utf8")).toBe(stateBefore);
  });

  it("rejects malformed cycle metadata before writing a recovery bundle", () => {
    const root = tempRoot();
    commitAcceptanceState(root, missingBundleState());
    cpSync(join(REPO_ROOT, "content"), join(root, "content"), { recursive: true });
    mkdirSync(join(root, "blind-tester", "reports"), { recursive: true });
    mkdirSync(join(root, "ai-runs"));
    writeFileSync(join(root, "ai-runs", "latest-cycle.json"), "{");

    const result = runRebootstrap(root);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("ai-runs/latest-cycle.json is invalid");
    expect(result.stdout).not.toContain("Wrote");
    expect(existsSync(join(root, "ai-runs", "feedback"))).toBe(false);
    expect(readFileSync(join(root, "ai-runs", "latest-cycle.json"), "utf8")).toBe("{");
  });
});
