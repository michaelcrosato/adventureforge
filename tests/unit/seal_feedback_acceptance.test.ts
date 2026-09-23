import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  countCycleEntries,
  historicalCycleCount,
  LOOP_ARCHIVE_FILE,
  rotateLoopState,
} from "../../src/afk/loop_state.js";
import {
  FeedbackCompilePointerSchema,
  sealFeedbackAcceptance,
} from "../../scripts/seal-feedback-acceptance.js";
import {
  formatFeedbackCycleSelectionMarker,
  loadAcceptedFeedbackBundle,
  parseFeedbackAcceptanceStateText,
  upsertFeedbackAcceptanceStateText,
  type FeedbackAcceptanceState,
} from "../../src/feedback/acceptance.js";
import { collectInputs, compileFeedback } from "../../src/feedback/compile.js";
import { canonicalize, hashState } from "../../src/core/hash.js";
import {
  serializeReportManifest,
  sha256Bytes,
  sha256File,
  type ReportManifest,
} from "../../src/feedback/report_manifest.js";
import { HOTSPOTS_VERSION, type HotspotsFile } from "../../src/feedback/schema.js";
import { loadOverworldManifest } from "../../src/world/source.js";

const REPO_ROOT = process.cwd();
const CURRENT_WORLD = loadOverworldManifest(REPO_ROOT);
const CURRENT_WORLD_HASH = hashState(CURRENT_WORLD);
const RUN_ID = "2026-08-08T23-00-00-000Z";
const EMPTY_STATE: FeedbackAcceptanceState = {
  schema_version: 1,
  accepted_compile: null,
  pending_cycle_reports: [],
};
const TEMP_ROOTS: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
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

function cycleEvidence(
  expectedCommit: string,
  sessionId = "o-feedback-seal",
  runSeed = 17,
): {
  report: string;
  evidence: string;
  sidecar: string;
  reportId: string;
} {
  const decisionProofHash = "b".repeat(64);
  const receiptPayload = {
    contractVersion: 1,
    exitReason: "player_ended_at_choice",
    goalVersion: 1,
    goalId: "albany_local_lead",
    goalStatus: "active",
    acceptedDecisions: 40,
    exitReasons: ["checkpoint"],
    checkpoint: 40,
    decisionProofHash,
    retentionHistory: [
      {
        sequence: 1,
        atDecision: 40,
        reasons: ["checkpoint"],
        checkpoint: 40,
        choice: "end",
        decisionProofHash,
      },
    ],
  };
  const receipt = { ...receiptPayload, receiptHash: hashState(receiptPayload) };
  const interview = {
    schema_version: 2,
    issue_consistency_version: 1,
    play_mode: "pure",
    start_surface: "fresh_overworld",
    retention_eligible: true,
    journey_exit_receipt: receipt,
    clarity: 4,
    enjoyment: 4,
    goal_understood: true,
    got_stuck: false,
    confusions: [],
    bugs: [],
    best_moment: "Following the local lead.",
    worst_moment: "The opening was dense.",
    would_replay: true,
    verdict: "The journey was coherent and worth continuing.",
  };
  const report = `# Cycle playtest

## Playthrough log

I followed the fresh-overworld goal until the journey checkpoint, then chose to end.

Clarity: 4/5. Enjoyment: 4/5.

## Bugs or design flaws

None observed.

## Verdict

The journey was coherent and worth continuing.

\`\`\`json exit-interview
${JSON.stringify(interview, null, 2)}
\`\`\`
`;
  const build = {
    git_commit: expectedCommit,
    tracked_worktree_clean: true,
    world_id: CURRENT_WORLD.id,
    world_hash: CURRENT_WORLD_HASH,
  };
  const evidence = `${JSON.stringify({
    schema_version: 2,
    play_mode: "pure",
    event: "fresh_start",
    start_surface: "fresh_overworld",
    session_id: sessionId,
    run_seed: runSeed,
    build,
  })}\n${JSON.stringify({
    schema_version: 2,
    play_mode: "pure",
    event: "journey_exit",
    start_surface: "fresh_overworld",
    session_id: sessionId,
    run_seed: runSeed,
    build,
    quest_outcomes: [],
    receipt,
  })}\n`;
  const sidecarValue = {
    schema_version: 2 as const,
    report_schema_version: 2 as const,
    play_mode: "pure" as const,
    start_surface: "fresh_overworld" as const,
    retention_eligible: true,
    evidence_status: "verified" as const,
    session_id: sessionId,
    run_seed: runSeed,
    build,
    quest_outcomes: [],
    receipt,
  };
  return {
    report,
    evidence,
    sidecar: JSON.stringify(sidecarValue),
    reportId: `pure:${hashState(sidecarValue)}`,
  };
}

function emptyHotspots(
  commit: string,
  verified: number,
  actionable: number,
  recommendedId: string | null = null,
): HotspotsFile {
  const hotspot = recommendedId
    ? {
        id: recommendedId,
        title: "old issue @ overworld",
        location: {
          kind: "overworld" as const,
          questId: null,
          region: null,
          node: "albany_city",
          sceneId: null,
          raw: ["albany_city"],
        },
        severity_band: "moderate" as const,
        max_severity: "S2" as const,
        count: 1,
        sources: ["fleet" as const],
        personas: [],
        score: 4,
        fix_layer: "content" as const,
        evidence: [{ source: "fleet" as const, ref: "old.md", excerpt: "old issue" }],
        trend: "new" as const,
        prev_score: null,
      }
    : null;
  return {
    version: HOTSPOTS_VERSION,
    generated_at: "2026-08-08T22:00:00.000Z",
    commit,
    inputs: {
      report_dirs: [],
      crawl_files: [],
      verified_reports: verified,
      actionable_reports: actionable,
      excluded_mock_reports: verified - actionable,
      rejected_reports: 0,
      crawl_findings: 0,
    },
    metrics: [],
    sycophancy: {
      reports: actionable,
      zero_negative_rate: 0,
      clarity_histogram: [0, 0, 0, 0, 0],
      enjoyment_histogram: [0, 0, 0, 0, 0],
      by_persona_zero_negative: {},
    },
    hotspots: hotspot ? [hotspot] : [],
    recommended_next_fix: hotspot
      ? { hotspot_id: hotspot.id, rationale: "This is the accepted next improvement." }
      : null,
  };
}

function legacyFeedbackReport(note: string): { text: string; reportId: string } {
  const interview = {
    clarity: 4,
    enjoyment: 3,
    goal_understood: true,
    got_stuck: false,
    confusions: [],
    bugs: [{ where: "albany_city", severity: "S2", note }],
    best_moment: "Following the local lead.",
    worst_moment: note,
    would_replay: true,
    verdict: `The route worked, though ${note}.`,
  };
  return {
    text: `# Blind feedback fixture

## Playthrough log

I followed the opening lead and reached Albany.

## Verdict

${interview.verdict}

\`\`\`json exit-interview
${JSON.stringify(interview, null, 2)}
\`\`\`
`,
    reportId: `report:${hashState({ interview })}`,
  };
}

function writeBundle(
  root: string,
  stamp: string,
  params: {
    kind: ReportManifest["kind"];
    commit: string;
    previousDigest?: string;
    verifiedIds: string[];
    actionableIds: string[];
    seenIds: string[];
    cohortIds: string[];
    recommendationId?: string;
  },
): { manifest: ReportManifest; manifestRef: string; manifestDigest: string; hotspotsRef: string } {
  const dir = join(root, "ai-runs", "feedback", stamp);
  mkdirSync(dir, { recursive: true });
  const cohortActionable = params.cohortIds.filter((id) => params.actionableIds.includes(id));
  const cohortExcluded = params.cohortIds.filter((id) => !params.actionableIds.includes(id));
  const hotspots = emptyHotspots(
    params.commit,
    params.cohortIds.length,
    cohortActionable.length,
    params.recommendationId ?? null,
  );
  const hotspotsPath = join(dir, "hotspots.json");
  const retentionPath = join(dir, "retention.json");
  const markdownPath = join(dir, "hotspots.md");
  writeFileSync(hotspotsPath, `${JSON.stringify(hotspots)}\n`);
  writeFileSync(
    retentionPath,
    `${JSON.stringify({
      schema_version: 2,
      report_modes: { pure: 0, structural: 0, legacy_guided: params.seenIds.length },
      pure_retention: { eligible_reports: 0, contract_versions: [] },
    })}\n`,
  );
  writeFileSync(markdownPath, "# Feedback\n");
  const excludedIds = params.verifiedIds.filter((id) => !params.actionableIds.includes(id));
  const manifest: ReportManifest = {
    schema_version: 1,
    kind: params.kind,
    generated_at: "2026-08-08T22:00:00.000Z",
    commit: params.commit,
    previous_manifest_sha256: params.previousDigest ?? null,
    corpus: {
      verified_report_ids: [...params.verifiedIds].sort(),
      actionable_report_ids: [...params.actionableIds].sort(),
      excluded_mock_report_ids: [...excludedIds].sort(),
      seen_report_ids: [...params.seenIds].sort(),
    },
    cohort: {
      verified_report_ids: [...params.cohortIds].sort(),
      actionable_report_ids: [...cohortActionable].sort(),
      excluded_mock_report_ids: [...cohortExcluded].sort(),
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
    manifest,
    manifestRef: `ai-runs/feedback/${stamp}/report-manifest.json`,
    manifestDigest: sha256File(manifestPath),
    hotspotsRef: `ai-runs/feedback/${stamp}/hotspots.json`,
  };
}

function initCycle(
  state: FeedbackAcceptanceState,
  recommendationId: string | null,
  selectedRecommendationId: string | null = null,
  includeSelection = true,
  /**
   * False builds the shape a migrated dev cycle actually produces: no playtest.md, no
   * raw evidence, no sidecar. The evidence fixture is still returned so a caller can
   * assert on the identity that WOULD have been sealed had anything been published.
   */
  withPlaytest = true,
): {
  root: string;
  startRef: string;
  head: string;
  evidence: ReturnType<typeof cycleEvidence>;
} {
  const root = tempRoot("feedback-seal-");
  mkdirSync(join(root, "blind-tester", "reports"), { recursive: true });
  const selection = includeSelection
    ? `${formatFeedbackCycleSelectionMarker(RUN_ID, selectedRecommendationId)}\n`
    : "";
  writeFileSync(
    join(root, "AI_LOOP_STATE.md"),
    `${upsertFeedbackAcceptanceStateText("# AI Loop State\n", state)}\n`,
  );
  runGit(root, ["init", "-q"]);
  runGit(root, ["config", "user.email", "seal@example.invalid"]);
  runGit(root, ["config", "user.name", "feedback-seal-test"]);
  runGit(root, ["add", "AI_LOOP_STATE.md"]);
  runGit(root, ["commit", "-qm", "cycle start"]);
  const startRef = runGit(root, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(root, "AI_LOOP_STATE.md"),
    `${readFileSync(join(root, "AI_LOOP_STATE.md"), "utf8")}\n## Cycle scaffold\n${selection}`,
  );
  runGit(root, ["add", "AI_LOOP_STATE.md"]);
  runGit(root, ["commit", "-qm", "provisional"]);
  const head = runGit(root, ["rev-parse", "HEAD"]);
  const evidence = cycleEvidence(head);
  const runDir = join(root, "ai-runs", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  if (withPlaytest) {
    writeFileSync(join(runDir, "playtest.md"), evidence.report);
    writeFileSync(join(runDir, "playtest.evidence.jsonl"), evidence.evidence);
    writeFileSync(join(runDir, "playtest.run.json"), evidence.sidecar);
  }
  writeFileSync(
    join(root, "ai-runs", "latest-cycle.json"),
    JSON.stringify({
      runId: RUN_ID,
      playtestRecord: `ai-runs/${RUN_ID}/playtest.md`,
      recommendationId,
    }),
  );
  writeFileSync(
    join(root, "AI_LOOP_STATE.md"),
    `${readFileSync(join(root, "AI_LOOP_STATE.md"), "utf8")}\n- Gates: green.\n`,
  );
  return { root, startRef, head, evidence };
}

function initRotatingCycle(withPlaytest = true): {
  root: string;
  statePath: string;
  startRef: string;
  head: string;
  evidence: ReturnType<typeof cycleEvidence>;
  selection: string;
  committed: string;
  provisional: string;
} {
  const root = tempRoot("feedback-seal-rotation-");
  mkdirSync(join(root, "blind-tester", "reports"), { recursive: true });
  const selection = formatFeedbackCycleSelectionMarker(RUN_ID, null);
  const preface = upsertFeedbackAcceptanceStateText(
    "# AI Loop State\n\n<!-- historical_cycle_count: 700 -->\n\nEntry contract.\n",
    EMPTY_STATE,
  );
  const priorEntries = Array.from(
    { length: 15 },
    (_, index) => `### Cycle result - prior_${String(index).padStart(2, "0")}\n- Guard: green.`,
  ).join("\n\n");
  const initialText = `${preface.trimEnd()}\n\n${priorEntries}\n`;
  const statePath = join(root, "AI_LOOP_STATE.md");
  writeFileSync(statePath, initialText);
  runGit(root, ["init", "-q"]);
  runGit(root, ["config", "user.email", "seal@example.invalid"]);
  runGit(root, ["config", "user.name", "feedback-seal-test"]);
  runGit(root, ["add", "AI_LOOP_STATE.md"]);
  runGit(root, ["commit", "-qm", "cycle start"]);
  const startRef = runGit(root, ["rev-parse", "HEAD"]);

  writeFileSync(
    statePath,
    `${initialText.trimEnd()}\n\n## AFK Cycle ${RUN_ID}\n${selection}\n- Guard: blind report before finalization.\n`,
  );
  runGit(root, ["add", "AI_LOOP_STATE.md"]);
  runGit(root, ["commit", "-qm", "provisional"]);
  const head = runGit(root, ["rev-parse", "HEAD"]);
  const committed = runGit(root, ["show", "HEAD:AI_LOOP_STATE.md"]);

  const evidence = cycleEvidence(head, "o-feedback-seal-rotation", 23);
  const runDir = join(root, "ai-runs", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  if (withPlaytest) {
    writeFileSync(join(runDir, "playtest.md"), evidence.report);
    writeFileSync(join(runDir, "playtest.evidence.jsonl"), evidence.evidence);
    writeFileSync(join(runDir, "playtest.run.json"), evidence.sidecar);
  }
  writeFileSync(
    join(root, "ai-runs", "latest-cycle.json"),
    JSON.stringify({
      runId: RUN_ID,
      playtestRecord: `ai-runs/${RUN_ID}/playtest.md`,
      recommendationId: null,
    }),
  );
  return {
    root,
    statePath,
    startRef,
    head,
    evidence,
    selection,
    committed,
    provisional: readFileSync(statePath, "utf8"),
  };
}

function prependFinalCycleResult(provisional: string, slug: string): string {
  const firstPriorEntry = provisional.indexOf("### Cycle result");
  if (firstPriorEntry < 0) throw new Error("Expected a prior rich cycle result.");
  const finalEntry = `### Cycle result - ${slug}\n- Guard: green.\n\n`;
  return `${provisional.slice(0, firstPriorEntry)}${finalEntry}${provisional.slice(firstPriorEntry)}`;
}

function parseState(root: string) {
  const parsed = parseFeedbackAcceptanceStateText(
    readFileSync(join(root, "AI_LOOP_STATE.md"), "utf8"),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.state;
}

describe("--check-attestation, the seal's precondition on its own", () => {
  /**
   * The seal refuses a provisional commit whose ledger entry carries no actual-selection
   * marker. It runs at the END of a cycle, so a worker that forgets costs the whole bar:
   * one such cycle proved 4771 tests green over seventy minutes and was discarded at the
   * last step. loop.sh now asks this same precondition immediately after the commit.
   */
  /**
   * Spawn the checkout's OWN tsx, never `npx`. The point of this helper is to run the
   * script with `cwd` set to the cycle's temp root — outside the repo — and from there
   * `npx tsx` finds no local binary and consults the registry on EVERY call. That is a
   * network round trip inside a unit test: measured at ~70s from a temp cwd against ~1s
   * from the repo, which silently blew the 60s budget and failed the bar on a change that
   * touched nothing near it. Resolving the binary by path keeps the cwd honest and the
   * test hermetic.
   *
   * It is tsx's JS entry run under this node, never `node_modules/.bin/tsx` (bug_0629):
   * on Windows `.bin/tsx` is a POSIX shell shim beside a `tsx.cmd`, and spawnSync without
   * a shell cannot execute either, so the spawn failed ENOENT with a null status and the
   * bar went red on every Windows checkout. `process.execPath` + `dist/cli.mjs` is how
   * every other CLI-spawning test here invokes tsx, on every platform.
   */
  const TSX_CLI = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const check = (root: string): { status: number | null; output: string } => {
    const result = spawnSync(
      process.execPath,
      [TSX_CLI, join(REPO_ROOT, "scripts", "seal-feedback-acceptance.ts"), "--check-attestation"],
      { cwd: root, encoding: "utf8" },
    );
    // A spawn that never started (ENOENT) has no status and no output; say so instead of
    // letting it read as an unexplained `null !== 0`.
    if (result.error) throw result.error;
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };

  it("passes a commit that carries the attestation", () => {
    const { root } = initCycle(EMPTY_STATE, null, "some-candidate-id");
    const result = check(root);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("carries the actual-selection attestation");
  });

  it("rejects one that does not, with the message the seal itself would give", () => {
    // Byte-identical wording matters: an operator who sees this at second 5 and the same
    // text at minute 70 must be able to tell they are the same failure, not two.
    const { root } = initCycle(EMPTY_STATE, null, null, false);
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("has no actual-selection attestation for");
  });
});

describe("feedback acceptance cycle seal", () => {
  it("records the exact verified pure report bytes and provisional commit", () => {
    const { root, startRef, head, evidence } = initCycle(EMPTY_STATE, null);
    const result = sealFeedbackAcceptance({
      root,
      worldRoot: REPO_ROOT,
      expectedCommit: head,
      startRef,
    });
    const state = parseState(root);

    expect(result).toMatchObject({
      runId: RUN_ID,
      reportId: evidence.reportId,
      promotedManifestPath: null,
      consumedRecommendation: false,
      pendingReports: 1,
    });
    expect(state.accepted_compile).toBeNull();
    expect(state.pending_cycle_reports).toEqual([
      {
        run_id: RUN_ID,
        tested_commit: head,
        report_id: evidence.reportId,
        report_sha256: sha256Bytes(Buffer.from(evidence.report)),
        evidence_sha256: sha256Bytes(Buffer.from(evidence.evidence)),
        sidecar_sha256: sha256Bytes(Buffer.from(evidence.sidecar)),
      },
    ]);
    expect(readFileSync(join(root, "AI_LOOP_STATE.md"), "utf8")).not.toContain(
      "feedback_cycle_selection",
    );
  });

  it("keeps the frozen selection sealable when a full live ledger prepends and rotates", () => {
    const { root, statePath, startRef, head, evidence, selection, committed, provisional } =
      initRotatingCycle();
    expect(committed.match(/feedback_cycle_selection:/gu)).toHaveLength(1);
    expect(committed).toContain(selection);

    const frozenSelection = provisional.split(/\r?\n/u).find((line) => line === selection);
    expect(frozenSelection).toBe(selection);
    writeFileSync(statePath, prependFinalCycleResult(provisional, "rotated_selection"));
    const beforeRotation = readFileSync(statePath, "utf8");
    expect(countCycleEntries(beforeRotation)).toBe(16);
    expect(beforeRotation.match(/feedback_cycle_selection:/gu)).toHaveLength(1);
    expect(beforeRotation.indexOf(frozenSelection!)).toBeGreaterThan(
      beforeRotation.lastIndexOf("### Cycle result"),
    );

    expect(rotateLoopState(root)).toBe(1);
    const rotated = readFileSync(statePath, "utf8");
    const archive = readFileSync(join(root, LOOP_ARCHIVE_FILE), "utf8");
    expect(countCycleEntries(rotated)).toBe(15);
    expect(historicalCycleCount(rotated)).toBe(701);
    expect(rotated.match(/feedback_cycle_selection:/gu)).toHaveLength(1);
    expect(rotated).toContain(selection);
    expect(rotated.indexOf(selection)).toBeLessThan(rotated.indexOf("### Cycle result"));
    expect(rotated).not.toContain("### Cycle result - prior_14");
    expect(rotated).not.toContain(`## AFK Cycle ${RUN_ID}`);
    expect(archive).toContain("### Cycle result - prior_14");
    expect(archive).toContain(`## AFK Cycle ${RUN_ID}`);
    expect(archive).not.toContain("feedback_cycle_selection");

    const result = sealFeedbackAcceptance({
      root,
      worldRoot: REPO_ROOT,
      expectedCommit: head,
      startRef,
    });
    expect(result).toMatchObject({
      runId: RUN_ID,
      reportId: evidence.reportId,
      pendingReports: 1,
    });
    const sealed = readFileSync(statePath, "utf8");
    expect(sealed).toContain("### Cycle result - rotated_selection");
    expect(sealed).not.toContain("feedback_cycle_selection");
    expect(countCycleEntries(sealed)).toBe(15);
    expect(historicalCycleCount(sealed)).toBe(701);
  });

  it("keeps noncanonical tail selection material live so the real seal rejects it", () => {
    const { root, statePath, startRef, head, selection, committed, provisional } =
      initRotatingCycle();
    const noncanonicalSelection = `  ${selection}`;
    expect(committed.match(/feedback_cycle_selection:/gu)).toHaveLength(1);
    expect(committed).not.toContain(noncanonicalSelection);

    const dirtyProvisional = provisional.replace(
      `${selection}\n`,
      `${selection}\n${noncanonicalSelection}\n`,
    );
    writeFileSync(
      statePath,
      prependFinalCycleResult(dirtyProvisional, "rotated_selection_malformed"),
    );
    const beforeRotation = readFileSync(statePath, "utf8");
    expect(countCycleEntries(beforeRotation)).toBe(16);
    expect(
      beforeRotation.split(/\r?\n/u).filter((line) => line.includes("feedback_cycle_selection:")),
    ).toEqual([selection, noncanonicalSelection]);

    expect(rotateLoopState(root)).toBe(1);
    const rotated = readFileSync(statePath, "utf8");
    const archive = readFileSync(join(root, LOOP_ARCHIVE_FILE), "utf8");
    const liveSelectionLines = rotated
      .split(/\r?\n/u)
      .filter((line) => line.includes("feedback_cycle_selection:"));
    expect(liveSelectionLines).toEqual([selection, noncanonicalSelection]);
    for (const line of liveSelectionLines) {
      expect(rotated.indexOf(line)).toBeLessThan(rotated.indexOf("### Cycle result"));
    }
    expect(archive).not.toContain("feedback_cycle_selection:");

    const beforeSeal = readFileSync(statePath, "utf8");
    expect(() =>
      sealFeedbackAcceptance({
        root,
        worldRoot: REPO_ROOT,
        expectedCommit: head,
        startRef,
      }),
    ).toThrow(/malformed feedback cycle selection/u);
    expect(readFileSync(statePath, "utf8")).toBe(beforeSeal);
  });

  it("consumes an accepted recommendation only for the exact assessed hotspot", () => {
    const root = tempRoot("feedback-seal-prior-");
    const oldId = `report:${"a".repeat(64)}`;
    const prior = writeBundle(root, "20260808T210000Z", {
      kind: "initial",
      commit: "1".repeat(40),
      verifiedIds: [oldId],
      actionableIds: [oldId],
      seenIds: [oldId],
      cohortIds: [oldId],
      recommendationId: "accepted-hotspot",
    });
    const acceptedState = {
      schema_version: 1 as const,
      accepted_compile: {
        manifest_path: prior.manifestRef,
        manifest_sha256: prior.manifestDigest,
        hotspots_path: prior.hotspotsRef,
        hotspots_sha256: prior.manifest.outputs.hotspots_sha256,
        consumed_by_run_id: null,
      },
      pending_cycle_reports: [],
    };
    for (const [selectedRecommendationId, expectedConsumption] of [
      ["hotspot-accepted-hotspot", true],
      ["repo-different", false],
      [null, false],
    ] as const) {
      const initialized = initCycle(
        acceptedState,
        "hotspot-accepted-hotspot",
        selectedRecommendationId,
      );
      // initCycle creates its own root; copy the prior ignored compile into that repository.
      const acceptedDir = join(initialized.root, "ai-runs", "feedback", "20260808T210000Z");
      mkdirSync(acceptedDir, { recursive: true });
      for (const file of [
        "report-manifest.json",
        "hotspots.json",
        "retention.json",
        "hotspots.md",
      ]) {
        writeFileSync(
          join(acceptedDir, file),
          readFileSync(join(root, "ai-runs", "feedback", "20260808T210000Z", file)),
        );
      }

      const result = sealFeedbackAcceptance({
        root: initialized.root,
        worldRoot: REPO_ROOT,
        expectedCommit: initialized.head,
        startRef: initialized.startRef,
      });
      expect(result.consumedRecommendation).toBe(expectedConsumption);
      expect(parseState(initialized.root).accepted_compile?.consumed_by_run_id).toBe(
        expectedConsumption ? RUN_ID : null,
      );
    }
  });

  it("rebuilds and promotes a chained delta, then queues this cycle", () => {
    const fixtureRoot = tempRoot("feedback-seal-chain-source-");
    const oldSeen = `report:${"1".repeat(64)}`;
    const prior = writeBundle(fixtureRoot, "20260808T200000Z", {
      kind: "initial",
      commit: "1".repeat(40),
      verifiedIds: [oldSeen],
      actionableIds: [oldSeen],
      seenIds: [oldSeen],
      cohortIds: [oldSeen],
      recommendationId: "old-unselected",
    });
    const acceptedState = {
      schema_version: 1 as const,
      accepted_compile: {
        manifest_path: prior.manifestRef,
        manifest_sha256: prior.manifestDigest,
        hotspots_path: prior.hotspotsRef,
        hotspots_sha256: prior.manifest.outputs.hotspots_sha256,
        consumed_by_run_id: null,
      },
      pending_cycle_reports: [],
    };
    const initialized = initCycle(acceptedState, null);
    for (const stamp of ["20260808T200000Z"]) {
      const target = join(initialized.root, "ai-runs", "feedback", stamp);
      mkdirSync(target, { recursive: true });
      for (const file of [
        "report-manifest.json",
        "hotspots.json",
        "retention.json",
        "hotspots.md",
      ]) {
        writeFileSync(
          join(target, file),
          readFileSync(join(fixtureRoot, "ai-runs", "feedback", stamp, file)),
        );
      }
    }
    const ledger = join(initialized.root, "blind-tester", "reports");
    for (const [index, note] of [
      "the station sign omits its platform number",
      "the route prompt reverses the destination",
      "the board repeats a completed objective",
    ].entries()) {
      const report = legacyFeedbackReport(note);
      writeFileSync(
        join(ledger, `20260808T23000${index}Z_overworld_seed${index + 1}.md`),
        report.text,
      );
    }
    const priorBundle = loadAcceptedFeedbackBundle(initialized.root, acceptedState);
    expect(priorBundle).not.toBeNull();
    expect(collectInputs(initialized.root, ["blind-tester/reports"])).toMatchObject({
      verified: 3,
      rejected: 0,
    });
    const current = compileFeedback({
      root: initialized.root,
      worldRoot: REPO_ROOT,
      inputs: ["blind-tester/reports"],
      outDir: join(initialized.root, "ai-runs", "feedback", "20260808T230500Z"),
      topK: 10,
      llmLabels: false,
      prevDir: null,
      cohortPolicy: {
        kind: "delta",
        previousManifest: priorBundle!.manifest,
        previousManifestSha256: prior.manifestDigest,
        previousHotspots: priorBundle!.hotspots,
        previousEvidence: priorBundle!.evidence,
      },
      commit: initialized.head,
    });
    const pointer = FeedbackCompilePointerSchema.parse({
      schema_version: 1,
      run_id: RUN_ID,
      manifest_path: "ai-runs/feedback/20260808T230500Z/report-manifest.json",
      manifest_sha256: current.manifestSha256,
    });
    writeFileSync(
      join(initialized.root, "ai-runs", RUN_ID, "feedback-compile.json"),
      `${canonicalize(pointer)}\n`,
    );

    const result = sealFeedbackAcceptance({
      root: initialized.root,
      worldRoot: REPO_ROOT,
      expectedCommit: initialized.head,
      startRef: initialized.startRef,
    });
    const state = parseState(initialized.root);
    expect(result.consumedRecommendation).toBe(false);
    expect(result.promotedManifestPath).toBe(pointer.manifest_path);
    expect(state.accepted_compile).toMatchObject({
      manifest_path: pointer.manifest_path,
      manifest_sha256: current.manifestSha256,
      consumed_by_run_id: null,
    });
    expect(state.pending_cycle_reports).toHaveLength(1);
    expect(state.pending_cycle_reports[0]).toMatchObject({
      run_id: RUN_ID,
      report_id: initialized.evidence.reportId,
      tested_commit: initialized.head,
    });
  });

  it("rejects a dirty authority marker and hash-mismatched promoted output", () => {
    const dirty = initCycle(EMPTY_STATE, null);
    const dirtyState = {
      schema_version: 1 as const,
      accepted_compile: null,
      pending_cycle_reports: [
        {
          run_id: "2026-08-07T20-00-00-000Z",
          tested_commit: "a".repeat(40),
          report_id: `pure:${"a".repeat(64)}`,
          report_sha256: "a".repeat(64),
          evidence_sha256: "a".repeat(64),
          sidecar_sha256: "a".repeat(64),
        },
      ],
    };
    const dirtyPath = join(dirty.root, "AI_LOOP_STATE.md");
    writeFileSync(
      dirtyPath,
      upsertFeedbackAcceptanceStateText(readFileSync(dirtyPath, "utf8"), dirtyState),
    );
    expect(() =>
      sealFeedbackAcceptance({
        root: dirty.root,
        worldRoot: REPO_ROOT,
        expectedCommit: dirty.head,
        startRef: dirty.startRef,
      }),
    ).toThrow(/marker diverges from committed HEAD/u);

    const tampered = initCycle(EMPTY_STATE, null);
    const bundle = writeBundle(tampered.root, "20260808T231000Z", {
      kind: "bootstrap",
      commit: tampered.head,
      verifiedIds: [],
      actionableIds: [],
      seenIds: [],
      cohortIds: [],
    });
    const pointer = FeedbackCompilePointerSchema.parse({
      schema_version: 1,
      run_id: RUN_ID,
      manifest_path: bundle.manifestRef,
      manifest_sha256: bundle.manifestDigest,
    });
    writeFileSync(
      join(tampered.root, "ai-runs", RUN_ID, "feedback-compile.json"),
      `${canonicalize(pointer)}\n`,
    );
    writeFileSync(join(tampered.root, bundle.hotspotsRef), "{}\n");
    expect(() =>
      sealFeedbackAcceptance({
        root: tampered.root,
        worldRoot: REPO_ROOT,
        expectedCommit: tampered.head,
        startRef: tampered.startRef,
      }),
    ).toThrow(/deterministic output|hash-mismatched/u);
    expect(parseState(tampered.root).pending_cycle_reports).toEqual([]);
  });

  it("rejects authority changed inside the provisional commit or a non-HEAD expected commit", () => {
    const changed = initCycle(EMPTY_STATE, null);
    const changedState: FeedbackAcceptanceState = {
      schema_version: 1,
      accepted_compile: null,
      pending_cycle_reports: [
        {
          run_id: "2026-08-07T20-00-00-000Z",
          tested_commit: "a".repeat(40),
          report_id: `pure:${"a".repeat(64)}`,
          report_sha256: "a".repeat(64),
          evidence_sha256: "a".repeat(64),
          sidecar_sha256: "a".repeat(64),
        },
      ],
    };
    const statePath = join(changed.root, "AI_LOOP_STATE.md");
    writeFileSync(
      statePath,
      upsertFeedbackAcceptanceStateText(readFileSync(statePath, "utf8"), changedState),
    );
    runGit(changed.root, ["add", "AI_LOOP_STATE.md"]);
    runGit(changed.root, ["commit", "--amend", "-qm", "provisional with altered authority"]);
    const changedHead = runGit(changed.root, ["rev-parse", "HEAD"]);
    const evidence = cycleEvidence(changedHead);
    const runDir = join(changed.root, "ai-runs", RUN_ID);
    writeFileSync(join(runDir, "playtest.md"), evidence.report);
    writeFileSync(join(runDir, "playtest.evidence.jsonl"), evidence.evidence);
    writeFileSync(join(runDir, "playtest.run.json"), evidence.sidecar);

    expect(() =>
      sealFeedbackAcceptance({
        root: changed.root,
        worldRoot: REPO_ROOT,
        expectedCommit: changedHead,
        startRef: changed.startRef,
      }),
    ).toThrow(/changed feedback acceptance authority from the cycle start/u);

    const stale = initCycle(EMPTY_STATE, null);
    expect(() =>
      sealFeedbackAcceptance({
        root: stale.root,
        worldRoot: REPO_ROOT,
        expectedCommit: stale.startRef,
        startRef: stale.startRef,
      }),
    ).toThrow(/is not current HEAD/u);
  });

  it("rejects a digest-valid bundle whose report identities were invented", () => {
    const fabricated = initCycle(EMPTY_STATE, null);
    const inventedId = `report:${"f".repeat(64)}`;
    const bundle = writeBundle(fabricated.root, "20260808T231500Z", {
      kind: "bootstrap",
      commit: fabricated.head,
      verifiedIds: [inventedId],
      actionableIds: [inventedId],
      seenIds: [inventedId],
      cohortIds: [],
    });
    const pointer = FeedbackCompilePointerSchema.parse({
      schema_version: 1,
      run_id: RUN_ID,
      manifest_path: bundle.manifestRef,
      manifest_sha256: bundle.manifestDigest,
    });
    writeFileSync(
      join(fabricated.root, "ai-runs", RUN_ID, "feedback-compile.json"),
      `${canonicalize(pointer)}\n`,
    );

    expect(() =>
      sealFeedbackAcceptance({
        root: fabricated.root,
        worldRoot: REPO_ROOT,
        expectedCommit: fabricated.head,
        startRef: fabricated.startRef,
      }),
    ).toThrow(/deterministic output/u);
  });

  it("keeps cycles sealable with a missing predecessor and promotes only a rebuilt bootstrap", () => {
    const missingState: FeedbackAcceptanceState = {
      schema_version: 1,
      accepted_compile: {
        manifest_path: "ai-runs/feedback/20260808T190000Z/report-manifest.json",
        manifest_sha256: "a".repeat(64),
        hotspots_path: "ai-runs/feedback/20260808T190000Z/hotspots.json",
        hotspots_sha256: "b".repeat(64),
        consumed_by_run_id: null,
      },
      pending_cycle_reports: [],
    };
    const preserved = initCycle(missingState, null);
    const preservedResult = sealFeedbackAcceptance({
      root: preserved.root,
      worldRoot: REPO_ROOT,
      expectedCommit: preserved.head,
      startRef: preserved.startRef,
    });
    expect(preservedResult.promotedManifestPath).toBeNull();
    expect(parseState(preserved.root).accepted_compile).toEqual(missingState.accepted_compile);

    const recovered = initCycle(missingState, null);
    const bootstrap = compileFeedback({
      root: recovered.root,
      worldRoot: REPO_ROOT,
      inputs: ["blind-tester/reports"],
      outDir: join(recovered.root, "ai-runs", "feedback", "20260808T232000Z"),
      topK: 10,
      llmLabels: false,
      prevDir: null,
      cohortPolicy: { kind: "bootstrap" },
      commit: recovered.head,
    });
    const pointer = FeedbackCompilePointerSchema.parse({
      schema_version: 1,
      run_id: RUN_ID,
      manifest_path: "ai-runs/feedback/20260808T232000Z/report-manifest.json",
      manifest_sha256: bootstrap.manifestSha256,
    });
    writeFileSync(
      join(recovered.root, "ai-runs", RUN_ID, "feedback-compile.json"),
      `${canonicalize(pointer)}\n`,
    );
    const recoveredResult = sealFeedbackAcceptance({
      root: recovered.root,
      worldRoot: REPO_ROOT,
      expectedCommit: recovered.head,
      startRef: recovered.startRef,
    });
    expect(recoveredResult.promotedManifestPath).toBe(pointer.manifest_path);
    expect(parseState(recovered.root).accepted_compile).toMatchObject({
      manifest_path: pointer.manifest_path,
      manifest_sha256: bootstrap.manifestSha256,
    });
  });

  it("requires the committed selection marker to remain frozen in the worktree", () => {
    const missingCommitted = initCycle(EMPTY_STATE, null, null, false);
    expect(() =>
      sealFeedbackAcceptance({
        root: missingCommitted.root,
        worldRoot: REPO_ROOT,
        expectedCommit: missingCommitted.head,
        startRef: missingCommitted.startRef,
      }),
    ).toThrow(/no actual-selection attestation/u);

    const changed = initCycle(EMPTY_STATE, "hotspot-offered", "hotspot-offered");
    const statePath = join(changed.root, "AI_LOOP_STATE.md");
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf8").replace(
        formatFeedbackCycleSelectionMarker(RUN_ID, "hotspot-offered"),
        formatFeedbackCycleSelectionMarker(RUN_ID, null),
      ),
    );
    expect(() =>
      sealFeedbackAcceptance({
        root: changed.root,
        worldRoot: REPO_ROOT,
        expectedCommit: changed.head,
        startRef: changed.startRef,
      }),
    ).toThrow(/selection diverges from the provisional commit/u);

    const removed = initCycle(EMPTY_STATE, "hotspot-offered", "hotspot-offered");
    const removedPath = join(removed.root, "AI_LOOP_STATE.md");
    writeFileSync(
      removedPath,
      readFileSync(removedPath, "utf8").replace(
        `${formatFeedbackCycleSelectionMarker(RUN_ID, "hotspot-offered")}\n`,
        "",
      ),
    );
    expect(() =>
      sealFeedbackAcceptance({
        root: removed.root,
        worldRoot: REPO_ROOT,
        expectedCommit: removed.head,
        startRef: removed.startRef,
      }),
    ).toThrow(/no frozen actual-selection attestation/u);
  });
});

/**
 * The same seal, for the cycle shape the migrated dev loop actually produces.
 *
 * loop.sh dropped require_playtest_record when the two loops split, but this seal kept
 * demanding ai-runs/<runId>/playtest.{md,evidence.jsonl,run.json} plus a pure V2 sidecar
 * bound to the provisional commit — so a cycle that played nothing passed every gate and
 * was then hard-reset here, and only one vendor could mint that sidecar. Every case below
 * mirrors one above with the artifacts simply not written.
 *
 * What must NOT follow from that is a weaker accepting path. The artifacts-present suite
 * above is unchanged and still asserts the full verification; these cases only establish
 * that ABSENCE is permitted, and that absence is distinguishable from a broken or partial
 * publication.
 */
describe("feedback acceptance cycle seal without cycle playtest artifacts", () => {
  it("seals the acceptance marker alone and queues no report", () => {
    const { root, startRef, head } = initCycle(EMPTY_STATE, null, null, true, false);
    const result = sealFeedbackAcceptance({
      root,
      worldRoot: REPO_ROOT,
      expectedCommit: head,
      startRef,
    });
    const state = parseState(root);

    expect(result).toMatchObject({
      runId: RUN_ID,
      reportId: null,
      promotedManifestPath: null,
      consumedRecommendation: false,
      pendingReports: 0,
    });
    expect(state.accepted_compile).toBeNull();
    expect(state.pending_cycle_reports).toEqual([]);
    // The rest of the seal's job is untouched: the frozen selection marker still goes.
    expect(readFileSync(join(root, "AI_LOOP_STATE.md"), "utf8")).not.toContain(
      "feedback_cycle_selection",
    );
  });

  it("seals a cycle whose metadata omits playtestRecord altogether", () => {
    // The field is now a location, not an obligation, so a caller that stops emitting
    // it must not be rejected by the schema.
    const { root, startRef, head } = initCycle(EMPTY_STATE, null, null, true, false);
    writeFileSync(
      join(root, "ai-runs", "latest-cycle.json"),
      JSON.stringify({ runId: RUN_ID, recommendationId: null }),
    );

    expect(
      sealFeedbackAcceptance({ root, worldRoot: REPO_ROOT, expectedCommit: head, startRef }),
    ).toMatchObject({ runId: RUN_ID, reportId: null, pendingReports: 0 });
  });

  it("still rejects a playtestRecord that points somewhere other than this run", () => {
    const { root, startRef, head } = initCycle(EMPTY_STATE, null, null, true, false);
    writeFileSync(
      join(root, "ai-runs", "latest-cycle.json"),
      JSON.stringify({
        runId: RUN_ID,
        playtestRecord: "ai-runs/2026-01-01T00-00-00-000Z/playtest.md",
        recommendationId: null,
      }),
    );

    expect(() =>
      sealFeedbackAcceptance({ root, worldRoot: REPO_ROOT, expectedCommit: head, startRef }),
    ).toThrow(/playtestRecord must be/u);
  });

  it.each([
    ["playtest.evidence.jsonl", "raw run evidence"],
    ["playtest.run.json", "a sidecar"],
  ] as const)("refuses %s left behind with no report (%s)", (orphan, _label) => {
    // The runner publishes the report first, so this is a broken publication or a
    // report deleted after the fact — not the deliberate no-playtest cycle. Letting it
    // through would make orphaned, unverifiable evidence indistinguishable from none.
    const { root, startRef, head, evidence } = initCycle(EMPTY_STATE, null, null, true, false);
    writeFileSync(
      join(root, "ai-runs", RUN_ID, orphan),
      orphan.endsWith(".jsonl") ? evidence.evidence : evidence.sidecar,
    );

    expect(() =>
      sealFeedbackAcceptance({ root, worldRoot: REPO_ROOT, expectedCommit: head, startRef }),
    ).toThrow(/publication is incomplete/u);
    expect(parseState(root).pending_cycle_reports).toEqual([]);
  });

  it("keeps a full live ledger sealable through rotation with nothing played", () => {
    const { root, statePath, startRef, head, selection, provisional } = initRotatingCycle(false);
    writeFileSync(statePath, prependFinalCycleResult(provisional, "rotated_no_playtest"));
    expect(rotateLoopState(root)).toBe(1);
    expect(readFileSync(statePath, "utf8")).toContain(selection);

    const result = sealFeedbackAcceptance({
      root,
      worldRoot: REPO_ROOT,
      expectedCommit: head,
      startRef,
    });
    expect(result).toMatchObject({ runId: RUN_ID, reportId: null, pendingReports: 0 });
    const sealed = readFileSync(statePath, "utf8");
    expect(sealed).toContain("### Cycle result - rotated_no_playtest");
    expect(sealed).not.toContain("feedback_cycle_selection");
    expect(countCycleEntries(sealed)).toBe(15);
    expect(historicalCycleCount(sealed)).toBe(701);
  });

  it("keeps noncanonical tail selection material fatal", () => {
    const { root, statePath, startRef, head, selection, provisional } = initRotatingCycle(false);
    const noncanonicalSelection = `  ${selection}`;
    writeFileSync(
      statePath,
      prependFinalCycleResult(
        provisional.replace(`${selection}\n`, `${selection}\n${noncanonicalSelection}\n`),
        "rotated_no_playtest_malformed",
      ),
    );
    expect(rotateLoopState(root)).toBe(1);

    const beforeSeal = readFileSync(statePath, "utf8");
    expect(() =>
      sealFeedbackAcceptance({ root, worldRoot: REPO_ROOT, expectedCommit: head, startRef }),
    ).toThrow(/malformed feedback cycle selection/u);
    expect(readFileSync(statePath, "utf8")).toBe(beforeSeal);
  });

  it("consumes an accepted recommendation only for the exact assessed hotspot", () => {
    // Recommendation consumption is bookkeeping about what the cycle CHOSE, which has
    // never depended on whether the cycle also played the game.
    const root = tempRoot("feedback-seal-noplay-prior-");
    const oldId = `report:${"a".repeat(64)}`;
    const prior = writeBundle(root, "20260808T210000Z", {
      kind: "initial",
      commit: "1".repeat(40),
      verifiedIds: [oldId],
      actionableIds: [oldId],
      seenIds: [oldId],
      cohortIds: [oldId],
      recommendationId: "accepted-hotspot",
    });
    const acceptedState = {
      schema_version: 1 as const,
      accepted_compile: {
        manifest_path: prior.manifestRef,
        manifest_sha256: prior.manifestDigest,
        hotspots_path: prior.hotspotsRef,
        hotspots_sha256: prior.manifest.outputs.hotspots_sha256,
        consumed_by_run_id: null,
      },
      pending_cycle_reports: [],
    };
    for (const [selectedRecommendationId, expectedConsumption] of [
      ["hotspot-accepted-hotspot", true],
      ["repo-different", false],
      [null, false],
    ] as const) {
      const initialized = initCycle(
        acceptedState,
        "hotspot-accepted-hotspot",
        selectedRecommendationId,
        true,
        false,
      );
      const acceptedDir = join(initialized.root, "ai-runs", "feedback", "20260808T210000Z");
      mkdirSync(acceptedDir, { recursive: true });
      for (const file of [
        "report-manifest.json",
        "hotspots.json",
        "retention.json",
        "hotspots.md",
      ]) {
        writeFileSync(
          join(acceptedDir, file),
          readFileSync(join(root, "ai-runs", "feedback", "20260808T210000Z", file)),
        );
      }

      const result = sealFeedbackAcceptance({
        root: initialized.root,
        worldRoot: REPO_ROOT,
        expectedCommit: initialized.head,
        startRef: initialized.startRef,
      });
      expect(result.reportId).toBeNull();
      expect(result.consumedRecommendation).toBe(expectedConsumption);
      expect(parseState(initialized.root).accepted_compile?.consumed_by_run_id).toBe(
        expectedConsumption ? RUN_ID : null,
      );
    }
  });

  it("still promotes a rebuilt chained delta while queueing nothing", () => {
    const fixtureRoot = tempRoot("feedback-seal-noplay-chain-source-");
    const oldSeen = `report:${"1".repeat(64)}`;
    const prior = writeBundle(fixtureRoot, "20260808T200000Z", {
      kind: "initial",
      commit: "1".repeat(40),
      verifiedIds: [oldSeen],
      actionableIds: [oldSeen],
      seenIds: [oldSeen],
      cohortIds: [oldSeen],
      recommendationId: "old-unselected",
    });
    const acceptedState = {
      schema_version: 1 as const,
      accepted_compile: {
        manifest_path: prior.manifestRef,
        manifest_sha256: prior.manifestDigest,
        hotspots_path: prior.hotspotsRef,
        hotspots_sha256: prior.manifest.outputs.hotspots_sha256,
        consumed_by_run_id: null,
      },
      pending_cycle_reports: [],
    };
    const initialized = initCycle(acceptedState, null, null, true, false);
    const target = join(initialized.root, "ai-runs", "feedback", "20260808T200000Z");
    mkdirSync(target, { recursive: true });
    for (const file of ["report-manifest.json", "hotspots.json", "retention.json", "hotspots.md"]) {
      writeFileSync(
        join(target, file),
        readFileSync(join(fixtureRoot, "ai-runs", "feedback", "20260808T200000Z", file)),
      );
    }
    // The compiler is NOT starved by the missing cycle report: blind-tester/reports is
    // still its first-precedence input, and it is what the playtest loop's corroborated
    // ledger feeds. Three actionable reports there clear the threshold on their own.
    const ledger = join(initialized.root, "blind-tester", "reports");
    for (const [index, note] of [
      "the station sign omits its platform number",
      "the route prompt reverses the destination",
      "the board repeats a completed objective",
    ].entries()) {
      writeFileSync(
        join(ledger, `20260808T23000${index}Z_overworld_seed${index + 1}.md`),
        legacyFeedbackReport(note).text,
      );
    }
    const priorBundle = loadAcceptedFeedbackBundle(initialized.root, acceptedState);
    expect(priorBundle).not.toBeNull();
    expect(collectInputs(initialized.root, ["blind-tester/reports"])).toMatchObject({
      verified: 3,
      rejected: 0,
    });
    const current = compileFeedback({
      root: initialized.root,
      worldRoot: REPO_ROOT,
      inputs: ["blind-tester/reports"],
      outDir: join(initialized.root, "ai-runs", "feedback", "20260808T230500Z"),
      topK: 10,
      llmLabels: false,
      prevDir: null,
      cohortPolicy: {
        kind: "delta",
        previousManifest: priorBundle!.manifest,
        previousManifestSha256: prior.manifestDigest,
        previousHotspots: priorBundle!.hotspots,
        previousEvidence: priorBundle!.evidence,
      },
      commit: initialized.head,
    });
    const pointer = FeedbackCompilePointerSchema.parse({
      schema_version: 1,
      run_id: RUN_ID,
      manifest_path: "ai-runs/feedback/20260808T230500Z/report-manifest.json",
      manifest_sha256: current.manifestSha256,
    });
    writeFileSync(
      join(initialized.root, "ai-runs", RUN_ID, "feedback-compile.json"),
      `${canonicalize(pointer)}\n`,
    );

    const result = sealFeedbackAcceptance({
      root: initialized.root,
      worldRoot: REPO_ROOT,
      expectedCommit: initialized.head,
      startRef: initialized.startRef,
    });
    const state = parseState(initialized.root);
    expect(result.reportId).toBeNull();
    expect(result.promotedManifestPath).toBe(pointer.manifest_path);
    expect(state.accepted_compile).toMatchObject({
      manifest_path: pointer.manifest_path,
      manifest_sha256: current.manifestSha256,
      consumed_by_run_id: null,
    });
    expect(state.pending_cycle_reports).toEqual([]);
  });

  it("still rejects a dirty authority marker and hash-mismatched promoted output", () => {
    const dirty = initCycle(EMPTY_STATE, null, null, true, false);
    const dirtyState = {
      schema_version: 1 as const,
      accepted_compile: null,
      pending_cycle_reports: [
        {
          run_id: "2026-08-07T20-00-00-000Z",
          tested_commit: "a".repeat(40),
          report_id: `pure:${"a".repeat(64)}`,
          report_sha256: "a".repeat(64),
          evidence_sha256: "a".repeat(64),
          sidecar_sha256: "a".repeat(64),
        },
      ],
    };
    const dirtyPath = join(dirty.root, "AI_LOOP_STATE.md");
    writeFileSync(
      dirtyPath,
      upsertFeedbackAcceptanceStateText(readFileSync(dirtyPath, "utf8"), dirtyState),
    );
    expect(() =>
      sealFeedbackAcceptance({
        root: dirty.root,
        worldRoot: REPO_ROOT,
        expectedCommit: dirty.head,
        startRef: dirty.startRef,
      }),
    ).toThrow(/marker diverges from committed HEAD/u);

    const tampered = initCycle(EMPTY_STATE, null, null, true, false);
    const bundle = writeBundle(tampered.root, "20260808T231000Z", {
      kind: "bootstrap",
      commit: tampered.head,
      verifiedIds: [],
      actionableIds: [],
      seenIds: [],
      cohortIds: [],
    });
    const pointer = FeedbackCompilePointerSchema.parse({
      schema_version: 1,
      run_id: RUN_ID,
      manifest_path: bundle.manifestRef,
      manifest_sha256: bundle.manifestDigest,
    });
    writeFileSync(
      join(tampered.root, "ai-runs", RUN_ID, "feedback-compile.json"),
      `${canonicalize(pointer)}\n`,
    );
    writeFileSync(join(tampered.root, bundle.hotspotsRef), "{}\n");
    expect(() =>
      sealFeedbackAcceptance({
        root: tampered.root,
        worldRoot: REPO_ROOT,
        expectedCommit: tampered.head,
        startRef: tampered.startRef,
      }),
    ).toThrow(/deterministic output|hash-mismatched/u);
    expect(parseState(tampered.root).pending_cycle_reports).toEqual([]);
  });

  it("still rejects authority changed inside the provisional commit or a non-HEAD commit", () => {
    const changed = initCycle(EMPTY_STATE, null, null, true, false);
    const changedState: FeedbackAcceptanceState = {
      schema_version: 1,
      accepted_compile: null,
      pending_cycle_reports: [
        {
          run_id: "2026-08-07T20-00-00-000Z",
          tested_commit: "a".repeat(40),
          report_id: `pure:${"a".repeat(64)}`,
          report_sha256: "a".repeat(64),
          evidence_sha256: "a".repeat(64),
          sidecar_sha256: "a".repeat(64),
        },
      ],
    };
    const statePath = join(changed.root, "AI_LOOP_STATE.md");
    writeFileSync(
      statePath,
      upsertFeedbackAcceptanceStateText(readFileSync(statePath, "utf8"), changedState),
    );
    runGit(changed.root, ["add", "AI_LOOP_STATE.md"]);
    runGit(changed.root, ["commit", "--amend", "-qm", "provisional with altered authority"]);
    const changedHead = runGit(changed.root, ["rev-parse", "HEAD"]);

    expect(() =>
      sealFeedbackAcceptance({
        root: changed.root,
        worldRoot: REPO_ROOT,
        expectedCommit: changedHead,
        startRef: changed.startRef,
      }),
    ).toThrow(/changed feedback acceptance authority from the cycle start/u);

    const stale = initCycle(EMPTY_STATE, null, null, true, false);
    expect(() =>
      sealFeedbackAcceptance({
        root: stale.root,
        worldRoot: REPO_ROOT,
        expectedCommit: stale.startRef,
        startRef: stale.startRef,
      }),
    ).toThrow(/is not current HEAD/u);
  });

  it("still rejects a digest-valid bundle whose report identities were invented", () => {
    const fabricated = initCycle(EMPTY_STATE, null, null, true, false);
    const inventedId = `report:${"f".repeat(64)}`;
    const bundle = writeBundle(fabricated.root, "20260808T231500Z", {
      kind: "bootstrap",
      commit: fabricated.head,
      verifiedIds: [inventedId],
      actionableIds: [inventedId],
      seenIds: [inventedId],
      cohortIds: [],
    });
    writeFileSync(
      join(fabricated.root, "ai-runs", RUN_ID, "feedback-compile.json"),
      `${canonicalize(
        FeedbackCompilePointerSchema.parse({
          schema_version: 1,
          run_id: RUN_ID,
          manifest_path: bundle.manifestRef,
          manifest_sha256: bundle.manifestDigest,
        }),
      )}\n`,
    );

    expect(() =>
      sealFeedbackAcceptance({
        root: fabricated.root,
        worldRoot: REPO_ROOT,
        expectedCommit: fabricated.head,
        startRef: fabricated.startRef,
      }),
    ).toThrow(/deterministic output/u);
  });

  it("keeps cycles sealable with a missing predecessor and promotes only a rebuilt bootstrap", () => {
    const missingState: FeedbackAcceptanceState = {
      schema_version: 1,
      accepted_compile: {
        manifest_path: "ai-runs/feedback/20260808T190000Z/report-manifest.json",
        manifest_sha256: "a".repeat(64),
        hotspots_path: "ai-runs/feedback/20260808T190000Z/hotspots.json",
        hotspots_sha256: "b".repeat(64),
        consumed_by_run_id: null,
      },
      pending_cycle_reports: [],
    };
    const preserved = initCycle(missingState, null, null, true, false);
    const preservedResult = sealFeedbackAcceptance({
      root: preserved.root,
      worldRoot: REPO_ROOT,
      expectedCommit: preserved.head,
      startRef: preserved.startRef,
    });
    expect(preservedResult.promotedManifestPath).toBeNull();
    expect(parseState(preserved.root).accepted_compile).toEqual(missingState.accepted_compile);

    const recovered = initCycle(missingState, null, null, true, false);
    const bootstrap = compileFeedback({
      root: recovered.root,
      worldRoot: REPO_ROOT,
      inputs: ["blind-tester/reports"],
      outDir: join(recovered.root, "ai-runs", "feedback", "20260808T232000Z"),
      topK: 10,
      llmLabels: false,
      prevDir: null,
      cohortPolicy: { kind: "bootstrap" },
      commit: recovered.head,
    });
    const pointer = FeedbackCompilePointerSchema.parse({
      schema_version: 1,
      run_id: RUN_ID,
      manifest_path: "ai-runs/feedback/20260808T232000Z/report-manifest.json",
      manifest_sha256: bootstrap.manifestSha256,
    });
    writeFileSync(
      join(recovered.root, "ai-runs", RUN_ID, "feedback-compile.json"),
      `${canonicalize(pointer)}\n`,
    );
    const recoveredResult = sealFeedbackAcceptance({
      root: recovered.root,
      worldRoot: REPO_ROOT,
      expectedCommit: recovered.head,
      startRef: recovered.startRef,
    });
    expect(recoveredResult.promotedManifestPath).toBe(pointer.manifest_path);
    expect(parseState(recovered.root).accepted_compile).toMatchObject({
      manifest_path: pointer.manifest_path,
      manifest_sha256: bootstrap.manifestSha256,
    });
  });

  it("still requires the committed selection marker to remain frozen in the worktree", () => {
    const missingCommitted = initCycle(EMPTY_STATE, null, null, false, false);
    expect(() =>
      sealFeedbackAcceptance({
        root: missingCommitted.root,
        worldRoot: REPO_ROOT,
        expectedCommit: missingCommitted.head,
        startRef: missingCommitted.startRef,
      }),
    ).toThrow(/no actual-selection attestation/u);

    const changed = initCycle(EMPTY_STATE, "hotspot-offered", "hotspot-offered", true, false);
    const statePath = join(changed.root, "AI_LOOP_STATE.md");
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf8").replace(
        formatFeedbackCycleSelectionMarker(RUN_ID, "hotspot-offered"),
        formatFeedbackCycleSelectionMarker(RUN_ID, null),
      ),
    );
    expect(() =>
      sealFeedbackAcceptance({
        root: changed.root,
        worldRoot: REPO_ROOT,
        expectedCommit: changed.head,
        startRef: changed.startRef,
      }),
    ).toThrow(/selection diverges from the provisional commit/u);

    const removed = initCycle(EMPTY_STATE, "hotspot-offered", "hotspot-offered", true, false);
    const removedPath = join(removed.root, "AI_LOOP_STATE.md");
    writeFileSync(
      removedPath,
      readFileSync(removedPath, "utf8").replace(
        `${formatFeedbackCycleSelectionMarker(RUN_ID, "hotspot-offered")}\n`,
        "",
      ),
    );
    expect(() =>
      sealFeedbackAcceptance({
        root: removed.root,
        worldRoot: REPO_ROOT,
        expectedCommit: removed.head,
        startRef: removed.startRef,
      }),
    ).toThrow(/no frozen actual-selection attestation/u);
  });
});

/**
 * The crux of making the artifacts optional: a playtest that IS published is verified on
 * exactly the terms it always was. If any of these stopped failing, "optional" would have
 * quietly become "unchecked", which is the one outcome worse than requiring Codex.
 */
describe("a published cycle playtest is still verified in full", () => {
  it("rejects a sidecar bound to a commit other than the provisional one", () => {
    const { root, startRef, head } = initCycle(EMPTY_STATE, null);
    const stale = cycleEvidence("9".repeat(40));
    const runDir = join(root, "ai-runs", RUN_ID);
    writeFileSync(join(runDir, "playtest.md"), stale.report);
    writeFileSync(join(runDir, "playtest.evidence.jsonl"), stale.evidence);
    writeFileSync(join(runDir, "playtest.run.json"), stale.sidecar);

    expect(() =>
      sealFeedbackAcceptance({ root, worldRoot: REPO_ROOT, expectedCommit: head, startRef }),
    ).toThrow(/exercised 9{40}, expected/u);
    expect(parseState(root).pending_cycle_reports).toEqual([]);
  });

  it("rejects a report whose raw evidence does not reproduce the adjacent sidecar", () => {
    const { root, startRef, head, evidence } = initCycle(EMPTY_STATE, null);
    // Same run, different session identity: the sidecar no longer replays from the raw
    // evidence, which is the check that makes a hand-written sidecar worthless.
    writeFileSync(
      join(root, "ai-runs", RUN_ID, "playtest.run.json"),
      cycleEvidence(head, "o-somebody-elses-session", 99).sidecar,
    );
    expect(evidence.sidecar).not.toBe(
      readFileSync(join(root, "ai-runs", RUN_ID, "playtest.run.json"), "utf8"),
    );

    expect(() =>
      sealFeedbackAcceptance({ root, worldRoot: REPO_ROOT, expectedCommit: head, startRef }),
    ).toThrow(/does not reproduce the adjacent playtest sidecar/u);
    expect(parseState(root).pending_cycle_reports).toEqual([]);
  });
});
