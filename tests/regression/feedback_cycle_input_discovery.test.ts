import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashState } from "../../src/core/hash.js";
import {
  EMPTY_FEEDBACK_ACCEPTANCE_STATE,
  type FeedbackAcceptanceState,
} from "../../src/feedback/acceptance.js";
import {
  canonicalCycleReportRef,
  isCycleStamp,
  resolveFeedbackInputs,
} from "../../src/feedback/inputs.js";
import { sha256File } from "../../src/feedback/report_manifest.js";

function pureSidecarV2(sessionId = "o-cycle-1"): Record<string, unknown> {
  const decisionProofHash = "a".repeat(64);
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
  return {
    schema_version: 2,
    report_schema_version: 2,
    play_mode: "pure",
    start_surface: "fresh_overworld",
    retention_eligible: true,
    evidence_status: "verified",
    session_id: sessionId,
    run_seed: 7,
    build: {
      git_commit: "b".repeat(40),
      tracked_worktree_clean: true,
      world_id: "new_york_overworld",
      world_hash: "c".repeat(64),
    },
    quest_outcomes: [],
    receipt: { ...receiptPayload, receiptHash: hashState(receiptPayload) },
  };
}

function writeCandidate(root: string, stamp: string, sidecar: unknown = pureSidecarV2()): string {
  const dir = join(root, "ai-runs", stamp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "playtest.md"), "verified later by collectInputs\n");
  writeFileSync(join(dir, "playtest.run.json"), `${JSON.stringify(sidecar)}\n`);
  return dir;
}

describe("feedback cycle input discovery regression", () => {
  it("round-trips cycle stamps and canonical refs instead of accepting lookalikes", () => {
    const root = mkdtempSync(join(tmpdir(), "feedback-refs-"));
    const report = join(root, "ai-runs", "2026-08-08T20-00-00-001Z", "playtest.md");
    expect(isCycleStamp("2026-08-08T20-00-00-001Z")).toBe(true);
    expect(isCycleStamp("2026-02-30T20-00-00-001Z")).toBe(false);
    expect(isCycleStamp("20260808T200000Z")).toBe(false);
    expect(canonicalCycleReportRef(root, report)).toBe(
      "ai-runs/2026-08-08T20-00-00-001Z/playtest.md",
    );
    expect(
      canonicalCycleReportRef(root, report.replace("playtest.md", "postchange-playtest.md")),
    ).toBe(null);
  });

  it("keeps explicit inputs isolated and admits only hash-bound pending cycle defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "feedback-defaults-"));
    const runId = "2026-08-08T20-00-00-001Z";
    const cycleDir = writeCandidate(root, runId);
    writeFileSync(join(cycleDir, "playtest.evidence.jsonl"), "evidence\n");
    for (const stamp of ["20260808T190000Z", "20260808T200000Z"]) {
      const crawl = join(root, "ai-runs", "crawl", stamp);
      mkdirSync(crawl, { recursive: true });
      writeFileSync(join(crawl, "findings.jsonl"), "\n");
    }

    expect(resolveFeedbackInputs(root, [], EMPTY_FEEDBACK_ACCEPTANCE_STATE)).toEqual([
      "blind-tester/reports",
    ]);
    const accepted: FeedbackAcceptanceState = {
      schema_version: 1,
      accepted_compile: null,
      pending_cycle_reports: [
        {
          run_id: runId,
          tested_commit: "b".repeat(40),
          report_id: `pure:${"a".repeat(64)}`,
          report_sha256: sha256File(join(cycleDir, "playtest.md")),
          evidence_sha256: sha256File(join(cycleDir, "playtest.evidence.jsonl")),
          sidecar_sha256: sha256File(join(cycleDir, "playtest.run.json")),
        },
      ],
    };
    expect(resolveFeedbackInputs(root, [], accepted)).toEqual([
      "blind-tester/reports",
      `ai-runs/${runId}/playtest.md`,
    ]);
    expect(resolveFeedbackInputs(root, ["only-this.md"], accepted)).toEqual(["only-this.md"]);
  });
});
