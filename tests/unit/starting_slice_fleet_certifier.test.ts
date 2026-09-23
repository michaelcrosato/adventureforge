import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindPureCodexReceipt } from "../../src/blind/receipt_binding.js";
import { extractRecoveredReport } from "../../src/blind/report_recovery.js";
import { hashState } from "../../src/core/hash.js";
import { writeCertificationArtifactSafely } from "../../bin/starting-slice.js";
import {
  PURE_FLEET_SPARK_DIRECT_MCP_CODEX_CLI_VERSION,
  PURE_FLEET_SPARK_DIRECT_MCP_TRANSPORT_CONTRACT,
} from "../../src/starting_slice/fleet_attestation.js";
import {
  certifyStartingSliceAuthority as certifyStartingSliceAuthorityOnCurrentBuild,
  evaluateStartingSlicePilotRuns,
  evaluateStartingSliceRuns,
  startingSliceFleetDisplayName,
  validateStartingSlicePilot as validateStartingSlicePilotOnCurrentBuild,
  WOLF_WINTER_STRATEGY_BY_ENDING,
  wolfStrategyMappingDrift,
  type StartingSliceEvaluationRun,
  type WolfStrategy,
} from "../../src/starting_slice/fleet_certifier.js";
import { INITIAL_JOURNEY_GOAL } from "../../src/world/journey_contract.js";
// @ts-expect-error -- hardened rollout verifier is intentionally plain ESM.
import * as codexPureEnvelope from "../../blind-tester/codex-pure-envelope.mjs";

const { CODEX_SPARK_PLAYER_BASE_INSTRUCTIONS } = codexPureEnvelope;

const { fixtureBuild } = vi.hoisted(() => ({
  fixtureBuild: {
    git_commit: "c".repeat(40),
    tracked_worktree_clean: true as const,
    world_id: "new_york_overworld",
    world_hash: "d".repeat(64),
  },
}));

vi.mock("../../src/starting_slice/fleet_build.js", () => ({
  capturePureFleetBuild: () => fixtureBuild,
}));

type SyntheticBuildOptions = {
  root: string;
  fleetDir: string;
  expectedBuild?: typeof fixtureBuild;
};

function validateStartingSlicePilot(options: SyntheticBuildOptions) {
  return validateStartingSlicePilotOnCurrentBuild({
    root: options.root,
    fleetDir: options.fleetDir,
  });
}

function certifyStartingSliceAuthority(options: SyntheticBuildOptions) {
  return certifyStartingSliceAuthorityOnCurrentBuild({
    root: options.root,
    fleetDir: options.fleetDir,
  });
}

const ROOT = process.cwd();
const tempDirs: string[] = [];
const GLOBAL_AGENTS_BLOCK = [
  "# AGENTS.md instructions",
  "",
  "<INSTRUCTIONS>",
  "# Global Codex Guidance",
  "",
  "- Read the repository's own instructions, scripts, and existing patterns before changing code.",
  "- Prefer the repo-local toolchain and package manager over global installs.",
  "- Use `rg`/`rg --files` for code search when available.",
  "- Check the worktree before editing, and do not overwrite unrelated user changes.",
  "- Keep changes scoped to the requested task unless a broader fix is necessary.",
  "- Run the most relevant tests, type checks, linters, builds, or browser smoke checks before finishing when the repo provides them.",
  "- Do not print, commit, or move secrets. Use local env files such as `.env.local` only when a task explicitly needs credentials.",
  "- For web apps, start the dev server and verify the local page when the app needs a server to run.",
  "</INSTRUCTIONS>",
].join("\n");

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const OUTCOME_FOR_STRATEGY: Record<WolfStrategy, string> = {
  hunt_and_hold: "ending_held",
  lure_and_divert: "ending_pack_diverted",
  drive_and_evacuate: "ending_drive_reserve_spent",
  fortify_and_outlast: "ending_fortified_cade_terms",
};

function run(index: number): StartingSliceEvaluationRun {
  const strategies: WolfStrategy[] = [
    "hunt_and_hold",
    "lure_and_divert",
    "drive_and_evacuate",
    "fortify_and_outlast",
  ];
  const strategy = strategies[index % strategies.length]!;
  return {
    ref: `report-${String(index).padStart(3, "0")}.md`,
    wolf_outcome: OUTCOME_FOR_STRATEGY[strategy],
    initial_goal_completion: {
      version: 1,
      id: "albany_local_lead",
      completed_at_decision: 45,
    },
    initial_goal_retention: {
      goal_version: 1,
      goal_id: "albany_local_lead",
      at_decision: 45,
      reasons: ["goal_completed"],
      choice: index < 70 ? "continue" : "end",
    },
    // Twenty 5s and eighty 4s produce an exact integer total of 420.
    clarity: index < 20 ? 5 : 4,
    enjoyment: index < 20 ? 5 : 4,
    got_stuck: false,
    issues: [],
  };
}

function passingRuns(): StartingSliceEvaluationRun[] {
  return Array.from({ length: 100 }, (_, index) => run(index));
}

function evaluate(runs: StartingSliceEvaluationRun[]) {
  return evaluateStartingSliceRuns({ root: ROOT, runs, expectedCount: 100 });
}

function withCompletedCount(count: number): StartingSliceEvaluationRun[] {
  const runs = passingRuns();
  const neededContinuations = Math.ceil((count * 70) / 100);
  return runs.map((candidate, index) => {
    if (index >= count) {
      return {
        ...candidate,
        wolf_outcome: null,
        initial_goal_completion: null,
        initial_goal_retention: null,
      };
    }
    return {
      ...candidate,
      initial_goal_retention: {
        ...candidate.initial_goal_retention!,
        choice: index < neededContinuations ? "continue" : "end",
      },
    };
  });
}

function withStrategyCounts(counts: Record<WolfStrategy, number>): StartingSliceEvaluationRun[] {
  const outcomes = (Object.keys(counts) as WolfStrategy[]).flatMap((strategy) =>
    Array.from({ length: counts[strategy] }, () => OUTCOME_FOR_STRATEGY[strategy]),
  );
  expect(outcomes).toHaveLength(100);
  return passingRuns().map((candidate, index) => ({
    ...candidate,
    wolf_outcome: outcomes[index]!,
  }));
}

describe("Wolf-Winter strategy taxonomy", () => {
  it("exhaustively classifies all twelve non-death outcomes", () => {
    expect(WOLF_WINTER_STRATEGY_BY_ENDING).toEqual({
      ending_pack_diverted: {
        strategy: "lure_and_divert",
        variant: "clean_diversion",
      },
      ending_pack_diverted_cattle_scattered: {
        strategy: "lure_and_divert",
        variant: "cattle_scattered",
      },
      ending_pack_diverted_after_blood: {
        strategy: "lure_and_divert",
        variant: "hybrid_recovery",
      },
      ending_bloodied_byre_evacuated: {
        strategy: "hunt_and_hold",
        variant: "bloodied_evacuation",
      },
      ending_bloodied_byre_evacuated_june_released: {
        strategy: "hunt_and_hold",
        variant: "bloodied_evacuation",
      },
      ending_drive_cattle_wounded: {
        strategy: "drive_and_evacuate",
        variant: "cattle_wounded",
      },
      ending_drive_person_cattle_lost: {
        strategy: "drive_and_evacuate",
        variant: "people_saved_cattle_lost",
      },
      ending_drive_reserve_spent: {
        strategy: "drive_and_evacuate",
        variant: "reserve_spent",
      },
      ending_fortified_cade_terms: {
        strategy: "fortify_and_outlast",
        variant: "cade_terms",
      },
      ending_fortified_albany_authority: {
        strategy: "fortify_and_outlast",
        variant: "albany_authority",
      },
      ending_held_gate_barred: { strategy: "hunt_and_hold", variant: "gate_barred" },
      ending_held_gate_barred_june_released: {
        strategy: "hunt_and_hold",
        variant: "gate_barred",
      },
      ending_held_timber_saved: { strategy: "hunt_and_hold", variant: "timber_saved" },
      ending_held_timber_saved_june_released: {
        strategy: "hunt_and_hold",
        variant: "timber_saved",
      },
      ending_held: { strategy: "hunt_and_hold", variant: "line_held" },
      ending_held_june_released: { strategy: "hunt_and_hold", variant: "line_held" },
    });
    expect(wolfStrategyMappingDrift(ROOT)).toEqual([]);
  });
});

describe("starting-slice certification thresholds", () => {
  it("passes exactly 90% completion and fails at 89%", () => {
    const ninety = evaluate(withCompletedCount(90));
    const eightyNine = evaluate(withCompletedCount(89));

    expect(ninety.gates.completion_at_least_90_percent).toBe(true);
    expect(ninety.metrics.completed_runs).toBe(90);
    expect(eightyNine.gates.completion_at_least_90_percent).toBe(false);
    expect(eightyNine.metrics.completed_runs).toBe(89);
  });

  it("passes exactly 5% stuck and fails at 6%", () => {
    const five = passingRuns().map((candidate, index) => ({
      ...candidate,
      got_stuck: index < 5,
    }));
    const six = passingRuns().map((candidate, index) => ({
      ...candidate,
      got_stuck: index < 6,
    }));

    expect(evaluate(five).gates.got_stuck_at_most_5_percent).toBe(true);
    expect(evaluate(six).gates.got_stuck_at_most_5_percent).toBe(false);
  });

  it("uses exact rating totals: 420 passes and 419 fails", () => {
    const exact = passingRuns();
    const lowClarity = exact.map((candidate, index) => ({
      ...candidate,
      clarity: index === 0 ? 4 : candidate.clarity,
    }));
    const lowEnjoyment = exact.map((candidate, index) => ({
      ...candidate,
      enjoyment: index === 0 ? 4 : candidate.enjoyment,
    }));

    const exactResult = evaluate(exact);
    expect(exactResult.metrics.clarity_total).toBe(420);
    expect(exactResult.metrics.enjoyment_total).toBe(420);
    expect(exactResult.gates.clarity_average_at_least_4_2).toBe(true);
    expect(exactResult.gates.enjoyment_average_at_least_4_2).toBe(true);
    expect(evaluate(lowClarity).metrics.clarity_total).toBe(419);
    expect(evaluate(lowClarity).gates.clarity_average_at_least_4_2).toBe(false);
    expect(evaluate(lowEnjoyment).metrics.enjoyment_total).toBe(419);
    expect(evaluate(lowEnjoyment).gates.enjoyment_average_at_least_4_2).toBe(false);
  });

  it("binds the continuation gate to the initial goal event at exactly 70%", () => {
    const seventy = passingRuns();
    const sixtyNine = seventy.map((candidate, index) => ({
      ...candidate,
      initial_goal_retention: {
        ...candidate.initial_goal_retention!,
        choice: index < 69 ? ("continue" as const) : ("end" as const),
      },
    }));

    expect(evaluate(seventy).gates.initial_goal_continuation_at_least_70_percent).toBe(true);
    expect(evaluate(sixtyNine).gates.initial_goal_continuation_at_least_70_percent).toBe(false);
  });

  it("passes 75% strategy dominance, fails 76%, and requires three strategies", () => {
    const seventyFive = withStrategyCounts({
      hunt_and_hold: 75,
      lure_and_divert: 24,
      drive_and_evacuate: 1,
      fortify_and_outlast: 0,
    });
    const seventySix = withStrategyCounts({
      hunt_and_hold: 76,
      lure_and_divert: 23,
      drive_and_evacuate: 1,
      fortify_and_outlast: 0,
    });
    const onlyTwo = withStrategyCounts({
      hunt_and_hold: 50,
      lure_and_divert: 50,
      drive_and_evacuate: 0,
      fortify_and_outlast: 0,
    });

    const atBoundary = evaluate(seventyFive);
    expect(atBoundary.gates.at_least_3_top_level_strategies).toBe(true);
    expect(atBoundary.gates.no_strategy_above_75_percent).toBe(true);
    expect(evaluate(seventySix).gates.no_strategy_above_75_percent).toBe(false);
    expect(evaluate(onlyTwo).gates.at_least_3_top_level_strategies).toBe(false);
    expect(evaluate(onlyTwo).gates.no_strategy_above_75_percent).toBe(true);
  });

  it("uses nearest-rank p50, passing 45 and failing 46", () => {
    const p50At45 = passingRuns().map((candidate, index) => ({
      ...candidate,
      initial_goal_completion: {
        ...candidate.initial_goal_completion!,
        completed_at_decision: index < 50 ? 45 : 46,
      },
      initial_goal_retention: {
        ...candidate.initial_goal_retention!,
        at_decision: index < 50 ? 45 : 46,
      },
    }));
    const p50At46 = passingRuns().map((candidate, index) => ({
      ...candidate,
      initial_goal_completion: {
        ...candidate.initial_goal_completion!,
        completed_at_decision: index < 49 ? 45 : 46,
      },
      initial_goal_retention: {
        ...candidate.initial_goal_retention!,
        at_decision: index < 49 ? 45 : 46,
      },
    }));

    expect(evaluate(p50At45).metrics.completion_decision_p50).toBe(45);
    expect(evaluate(p50At45).gates.completion_p50_at_most_45_decisions).toBe(true);
    expect(evaluate(p50At46).metrics.completion_decision_p50).toBe(46);
    expect(evaluate(p50At46).gates.completion_p50_at_most_45_decisions).toBe(false);
  });

  it("blocks an S2 cluster at five distinct reports, not duplicate mentions or four reports", () => {
    const withAffectedReports = (count: number) =>
      passingRuns().map((candidate, index) => ({
        ...candidate,
        issues:
          index < count
            ? [
                {
                  where: "wolf_winter",
                  severity: "S2" as const,
                  note: "The same relief choice failed to explain its tactical consequence.",
                },
                ...(index === 0
                  ? [
                      {
                        where: "wolf_winter",
                        severity: "S2" as const,
                        note: "The same relief choice failed to explain its tactical consequence.",
                      },
                    ]
                  : []),
              ]
            : [],
      }));

    const four = evaluate(withAffectedReports(4));
    const five = evaluate(withAffectedReports(5));
    expect(four.gates.no_in_scope_s2_cluster_at_or_above_5_percent).toBe(true);
    expect(four.blocking_issue_clusters).toEqual([]);
    expect(five.gates.no_in_scope_s2_cluster_at_or_above_5_percent).toBe(false);
    expect(five.blocking_issue_clusters).toHaveLength(1);
    expect(five.blocking_issue_clusters[0]).toMatchObject({
      max_severity: "S2",
      affected_reports: 5,
      issue_mentions: 6,
    });
  });

  it("blocks one in-scope S3 while excluding an unambiguous other quest", () => {
    const severeWolf = passingRuns();
    severeWolf[0] = {
      ...severeWolf[0]!,
      issues: [
        { where: "albany_city", severity: "S3", note: "The starting state became unusable." },
      ],
    };
    const severeElsewhere = passingRuns();
    severeElsewhere[0] = {
      ...severeElsewhere[0]!,
      issues: [{ where: "gallowmere", severity: "S4", note: "The later quest became unusable." }],
    };
    const severeRegionOnly = passingRuns();
    severeRegionOnly[0] = {
      ...severeRegionOnly[0]!,
      issues: [
        {
          where: "capital_mohawk",
          severity: "S3",
          note: "A cross-system regional transition became unusable.",
        },
      ],
    };

    expect(evaluate(severeWolf).gates.no_in_scope_s3_or_s4).toBe(false);
    expect(evaluate(severeWolf).blocking_issue_clusters[0]?.max_severity).toBe("S3");
    expect(evaluate(severeRegionOnly).gates.no_in_scope_s3_or_s4).toBe(false);
    expect(evaluate(severeElsewhere).gates.no_in_scope_s3_or_s4).toBe(true);
  });
});

describe("starting-slice evidence validity", () => {
  it("accepts absence of both completion signals as incomplete but rejects disagreement", () => {
    const incomplete = withCompletedCount(99);
    const incompleteResult = evaluate(incomplete);
    expect(incompleteResult.valid).toBe(true);
    expect(incompleteResult.metrics.completed_runs).toBe(99);

    const outcomeOnly = passingRuns();
    outcomeOnly[0] = {
      ...outcomeOnly[0]!,
      initial_goal_completion: null,
      initial_goal_retention: null,
    };
    const goalOnly = passingRuns();
    goalOnly[0] = { ...goalOnly[0]!, wolf_outcome: null };
    expect(evaluate(outcomeOnly).validity_errors.join("\n")).toContain(
      "outcome exists without exact initial-goal completion",
    );
    expect(evaluate(goalOnly).validity_errors.join("\n")).toContain(
      "completion exists without a Wolf-Winter outcome",
    );
  });

  it("rejects the death ending and every unknown Wolf ending", () => {
    const death = passingRuns();
    death[0] = { ...death[0]!, wolf_outcome: "ending_pulled_down" };
    const unknown = passingRuns();
    unknown[0] = { ...unknown[0]!, wolf_outcome: "ending_future_unmapped" };

    expect(evaluate(death).validity_errors.join("\n")).toContain(
      "death Wolf-Winter outcome ending_pulled_down",
    );
    expect(evaluate(unknown).validity_errors.join("\n")).toContain(
      "unknown Wolf-Winter outcome ending_future_unmapped",
    );
  });

  it("rejects an impossible decision-zero initial-goal completion", () => {
    const zero = passingRuns();
    zero[0] = {
      ...zero[0]!,
      initial_goal_completion: {
        ...zero[0]!.initial_goal_completion!,
        completed_at_decision: 0,
      },
      initial_goal_retention: {
        ...zero[0]!.initial_goal_retention!,
        at_decision: 0,
      },
    };
    expect(evaluate(zero).validity_errors.join("\n")).toContain(
      "initial goal retention event is not exactly bound to completion",
    );
  });

  it("is independent of input order", () => {
    const runs = passingRuns();
    runs[2] = {
      ...runs[2]!,
      issues: [
        {
          where: "wolf_winter",
          severity: "S1",
          note: "The tactical consequence was described after it mattered.",
        },
      ],
    };
    expect(evaluate([...runs].reverse())).toEqual(evaluate(runs));
  });
});

describe("ten-player Sonnet pilot thresholds", () => {
  function pilotRuns(counts: readonly [WolfStrategy, number][]): StartingSliceEvaluationRun[] {
    const outcomes = counts.flatMap(([strategy, count]) =>
      Array.from({ length: count }, () => OUTCOME_FOR_STRATEGY[strategy]),
    );
    expect(outcomes).toHaveLength(10);
    return Array.from({ length: 10 }, (_, index) => ({
      ...run(index),
      wolf_outcome: outcomes[index]!,
      clarity: 5,
      enjoyment: 5,
    }));
  }

  it("passes seven-of-ten concentration but fails eight-of-ten", () => {
    const seven = evaluateStartingSlicePilotRuns({
      root: ROOT,
      runs: pilotRuns([
        ["hunt_and_hold", 7],
        ["lure_and_divert", 2],
        ["drive_and_evacuate", 1],
      ]),
    });
    const eight = evaluateStartingSlicePilotRuns({
      root: ROOT,
      runs: pilotRuns([
        ["hunt_and_hold", 8],
        ["lure_and_divert", 1],
        ["drive_and_evacuate", 1],
      ]),
    });

    expect(seven.pilot_passed).toBe(true);
    expect(seven.pilot_gates.no_strategy_above_7_of_10).toBe(true);
    expect(eight.pilot_passed).toBe(false);
    expect(eight.pilot_gate_failures).toEqual(["no_strategy_above_7_of_10"]);
  });

  it("rejects nine recognized outcomes even though the ordinary 90% completion gate passes", () => {
    const runs = pilotRuns([
      ["hunt_and_hold", 4],
      ["lure_and_divert", 3],
      ["drive_and_evacuate", 3],
    ]);
    runs[9] = {
      ...runs[9]!,
      wolf_outcome: null,
      initial_goal_completion: null,
      initial_goal_retention: null,
    };
    const result = evaluateStartingSlicePilotRuns({ root: ROOT, runs });

    expect(result.evaluation.gates.completion_at_least_90_percent).toBe(true);
    expect(result.evaluation.metrics.completed_runs).toBe(9);
    expect(result.pilot_gates.all_10_recognized_wolf_outcomes).toBe(false);
    expect(result.pilot_passed).toBe(false);
  });

  it("cannot pass when an ordinary quality gate misses", () => {
    const runs = pilotRuns([
      ["hunt_and_hold", 4],
      ["lure_and_divert", 3],
      ["drive_and_evacuate", 3],
    ]).map((candidate) => ({ ...candidate, clarity: 4 }));
    const result = evaluateStartingSlicePilotRuns({ root: ROOT, runs });

    expect(Object.values(result.pilot_gates).every(Boolean)).toBe(true);
    expect(result.evaluation.gates.clarity_average_at_least_4_2).toBe(false);
    expect(result.pilot_passed).toBe(false);
  });
});

function currentReceipt() {
  const goalProof = "a".repeat(64);
  const exitProof = "b".repeat(64);
  const payload = {
    contractVersion: 3 as const,
    exitReason: "player_ended_at_choice" as const,
    goalVersion: 2,
    goalId: "carry_test_packet_north",
    goalText: "Carry the test packet north and see the next lead through.",
    goalStatus: "active" as const,
    goalCompletedAtDecision: null,
    completedGoals: [
      {
        version: INITIAL_JOURNEY_GOAL.version,
        id: INITIAL_JOURNEY_GOAL.id,
        text: INITIAL_JOURNEY_GOAL.text,
        status: "completed" as const,
        completedAtDecision: 29,
      },
    ],
    acceptedDecisions: 40,
    exitReasons: ["checkpoint" as const],
    checkpoint: 40,
    decisionProofHash: exitProof,
    retentionHistory: [
      {
        sequence: 1,
        atDecision: 29,
        reasons: ["goal_completed" as const],
        checkpoint: null,
        goalVersion: INITIAL_JOURNEY_GOAL.version,
        goalId: INITIAL_JOURNEY_GOAL.id,
        choice: "continue" as const,
        decisionProofHash: goalProof,
      },
      {
        sequence: 2,
        atDecision: 40,
        reasons: ["checkpoint" as const],
        checkpoint: 40,
        goalVersion: null,
        goalId: null,
        choice: "end" as const,
        decisionProofHash: exitProof,
      },
    ],
  };
  return { ...payload, receiptHash: hashState(payload) };
}

function currentDeathReceipt() {
  const { receiptHash: _receiptHash, ...payload } = currentReceipt();
  const deathPayload = {
    ...payload,
    exitReasons: ["checkpoint", "character_died"] as const,
    retentionHistory: payload.retentionHistory.map((event, index) =>
      index === payload.retentionHistory.length - 1
        ? { ...event, reasons: ["checkpoint", "character_died"] as const }
        : event,
    ),
  };
  return { ...deathPayload, receiptHash: hashState(deathPayload) };
}

function reportText(receipt: unknown): string {
  const interview = {
    schema_version: 2,
    issue_consistency_version: 1,
    play_mode: "pure",
    start_surface: "fresh_overworld",
    retention_eligible: true,
    journey_exit_receipt: receipt,
    clarity: 5,
    enjoyment: 5,
    goal_understood: true,
    got_stuck: false,
    confusions: [],
    bugs: [],
    best_moment: "The first crisis exposed a meaningful strategy choice.",
    worst_moment: "One transition carried more text than expected.",
    would_replay: true,
    verdict: "The bounded opening was coherent and I would continue into another lead.",
  };
  return `# Blind report

## Playthrough log

Played the opening naturally to its checkpoint.

## Understandable & fun?

Clarity 5/5 and enjoyment 5/5.

## Bugs or design flaws

None found.

## Verdict

The opening worked and invited continuation.

\`\`\`json exit-interview
${JSON.stringify(interview, null, 2)}
\`\`\`
`;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

describe("closed fleet filesystem integrity", () => {
  it("accepts client-pinned v9 Terra-direct and Spark pilots, then rejects historical and lifecycle tamper", () => {
    const base = mkdtempSync(join(tmpdir(), "af-codex-slice-certifier-"));
    tempDirs.push(base);
    const fleetDir = join(base, "fleet", "codex-pilot");
    const reportsDir = join(base, "reports");
    mkdirSync(fleetDir, { recursive: true });
    mkdirSync(reportsDir, { recursive: true });
    const build = fixtureBuild;
    const receipt = currentReceipt();
    const model = "gpt-5.6-terra" as const;
    const authorityIdentity = {
      device_id: "1",
      file_id: "2",
      size: "3",
      mtime_ns: "4",
      ctime_ns: "5",
    };
    const authorityToken = Buffer.from(
      JSON.stringify({
        schema_version: 2,
        launcher_kind: "direct",
        selected: { canonical_path: "/opt/codex", identity: authorityIdentity },
        selected_symlink: null,
        package_manifest: null,
        javascript_entrypoint: null,
        executable: { canonical_path: "/opt/codex", identity: authorityIdentity },
        declared_cli_version: null,
        test_script: false,
      }),
      "utf8",
    ).toString("base64url");
    const codexClient = {
      schema_version: 2,
      launcher_kind: "direct",
      selected_binary: "/opt/codex",
      executable_binary: "/opt/codex",
      authority_token: authorityToken,
      authority_sha256: sha256Text(authorityToken),
      cli_version: PURE_FLEET_SPARK_DIRECT_MCP_CODEX_CLI_VERSION,
      test_script: false,
    } as const;
    const sparkCodexClient = {
      ...codexClient,
      cli_version: PURE_FLEET_SPARK_DIRECT_MCP_CODEX_CLI_VERSION,
    } as const;
    const authorityProofBody = (client: unknown) => `${JSON.stringify(client, null, 2)}\n`;
    const authorityProofIndex = (client: unknown) => {
      const bytes = Buffer.from(authorityProofBody(client), "utf8");
      return {
        name: "codex-client-authority.private.json",
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    };
    const outcomes = [
      "ending_held",
      "ending_pack_diverted",
      "ending_drive_reserve_spent",
      "ending_fortified_cade_terms",
    ];
    const rows = Array.from({ length: 10 }, (_, index) => {
      const seed = 700 + index;
      const outcome = outcomes[index % outcomes.length]!;
      const prefix = join(reportsDir, `20260102T000000Z_overworld_seed${seed}`);
      const reportPath = `${prefix}.md`;
      const reportBody = reportText(receipt);
      const providerSessionId = `10000000-0000-4000-8000-${String(seed).padStart(12, "0")}`;
      const providerTurnId = `20000000-0000-4000-8000-${String(seed).padStart(12, "0")}`;
      const providerCwd = `C:\\isolated\\seed-${seed}\\player`;
      const sidecar = {
        schema_version: 2,
        report_schema_version: 2,
        play_mode: "pure",
        start_surface: "fresh_overworld",
        retention_eligible: true,
        evidence_status: "verified",
        session_id: `codex-session-${seed}`,
        run_seed: seed,
        build,
        quest_outcomes: [["wolf_winter", outcome]],
        receipt,
      };
      const sidecarBody = `${JSON.stringify(sidecar, null, 2)}\n`;
      const evidenceBody = `${[
        {
          schema_version: 2,
          play_mode: "pure",
          event: "fresh_start",
          start_surface: "fresh_overworld",
          session_id: sidecar.session_id,
          run_seed: seed,
          build,
        },
        {
          schema_version: 2,
          play_mode: "pure",
          event: "journey_exit",
          start_surface: "fresh_overworld",
          session_id: sidecar.session_id,
          run_seed: seed,
          build,
          quest_outcomes: sidecar.quest_outcomes,
          receipt,
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`;
      const call = {
        id: "item_1",
        type: "mcp_tool_call",
        server: "adventureforge",
        tool: "start_overworld",
        arguments: {},
      };
      const providerEventsBody = `${[
        { type: "thread.started", thread_id: providerSessionId },
        { type: "turn.started" },
        {
          type: "item.started",
          item: { ...call, result: null, error: null, status: "in_progress" },
        },
        {
          type: "item.completed",
          item: {
            ...call,
            result: { content: [], structured_content: null },
            error: null,
            status: "completed",
          },
        },
        { type: "item.completed", item: { id: "item_2", type: "agent_message", text: reportBody } },
        {
          type: "turn.completed",
          usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`;
      let providerInputOrdinal = 0;
      const providerInputMessage = (role: "developer" | "user", ...texts: string[]) => ({
        type: "response_item",
        payload: {
          type: "message",
          id: `input-${(providerInputOrdinal += 1)}`,
          role,
          content: texts.map((text) => ({ type: "input_text", text })),
          internal_chat_message_metadata_passthrough: { turn_id: providerTurnId },
        },
      });
      const providerRolloutBody = `${[
        {
          timestamp: "2026-07-19T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: providerSessionId,
            cwd: providerCwd,
            cli_version: codexClient.cli_version,
            model_provider: "openai",
            base_instructions: { text: CODEX_SPARK_PLAYER_BASE_INSTRUCTIONS },
          },
        },
        {
          timestamp: "2026-07-19T00:00:00.001Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: providerTurnId },
        },
        providerInputMessage("user", GLOBAL_AGENTS_BLOCK),
        { type: "world_state", payload: { full: true } },
        {
          timestamp: "2026-07-19T00:00:00.002Z",
          type: "turn_context",
          payload: {
            turn_id: providerTurnId,
            cwd: providerCwd,
            approval_policy: "never",
            sandbox_policy: { type: "read-only" },
            model,
            collaboration_mode: {
              mode: "default",
              settings: {
                model,
                reasoning_effort: "xhigh",
                developer_instructions: null,
              },
            },
            multi_agent_version: "disabled",
            comp_hash: "3000",
            effort: "xhigh",
            summary: "auto",
          },
        },
        providerInputMessage("user", "blind prompt"),
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "blind prompt",
            images: [],
            local_images: [],
            text_elements: [],
          },
        },
        {
          timestamp: "2026-07-19T00:00:00.100Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "function-call-1",
            call_id: "function-call-1",
            name: "start_overworld",
            namespace: "mcp__adventureforge",
            arguments: "{}",
            internal_chat_message_metadata_passthrough: { turn_id: providerTurnId },
          },
        },
        {
          timestamp: "2026-07-19T00:00:00.200Z",
          type: "event_msg",
          payload: {
            type: "mcp_tool_call_end",
            call_id: "function-call-1",
            invocation: { server: "adventureforge", tool: "start_overworld", arguments: {} },
            result: { Ok: { content: [] } },
          },
        },
        {
          timestamp: "2026-07-19T00:00:00.300Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            id: "function-output-1",
            call_id: "function-call-1",
            internal_chat_message_metadata_passthrough: { turn_id: providerTurnId },
            output: "Wall time: 0.0 seconds\nOutput:\n[]",
          },
        },
        {
          timestamp: "2026-07-19T00:00:00.999Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: reportBody,
            phase: "final_answer",
            memory_citation: null,
          },
        },
        {
          timestamp: "2026-07-19T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "final-message",
            role: "assistant",
            content: [{ type: "output_text", text: reportBody }],
            phase: "final_answer",
            internal_chat_message_metadata_passthrough: { turn_id: providerTurnId },
          },
        },
        {
          timestamp: "2026-07-19T00:00:01.001Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: providerTurnId,
            last_agent_message: reportBody,
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`;
      const providerCaptureBody = `${JSON.stringify(
        {
          schema_version: 5,
          binding: "runner_work_player",
          transport_contract: "game-direct-mcp-v1",
          recorded_session_cwd: providerCwd,
          recorded_turn_cwd: providerCwd,
          canonical_expected_cwd: providerCwd,
          canonical_session_cwd: providerCwd,
          canonical_turn_cwd: providerCwd,
          expected_directory_identity: { device_id: "1", file_id: String(seed) },
          session_directory_identity: { device_id: "1", file_id: String(seed) },
          turn_directory_identity: { device_id: "1", file_id: String(seed) },
          copied_rollout_sha256: sha256Text(providerRolloutBody),
        },
        null,
        2,
      )}\n`;
      const primaryEnvelopeBody = `${JSON.stringify({
        type: "result",
        subtype: "success",
        provider: "codex",
        is_error: false,
        session_id: providerSessionId,
        result: reportBody,
        terminal_reason: "completed",
        num_turns: 1,
        requested_model: model,
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 0,
        },
        modelUsage: {
          [model]: {
            inputTokens: 10,
            cacheReadInputTokens: 0,
            outputTokens: 10,
            reasoningOutputTokens: 0,
          },
        },
      })}\n`;
      const modelAttestation = {
        schema_version: 9,
        provider: "codex",
        codex_cli_version: codexClient.cli_version,
        codex_client_authority_sha256: codexClient.authority_sha256,
        transport_contract: "game-direct-mcp-v1",
        run_seed: seed,
        model,
        persona: "default",
        target: "overworld",
        play_mode: "pure",
        start_surface: "fresh_overworld",
        build,
        game_session_id: sidecar.session_id,
        provider_session_id: providerSessionId,
        actual_provider: "openai",
        actual_model: model,
        reasoning_effort: "xhigh",
        provider_turn_id: providerTurnId,
        provider_cwd: providerCwd,
        report_recovered: false,
        report_receipt_bound: false,
        receipt_hash: receipt.receiptHash,
        report_sha256: sha256Text(reportBody),
        run_sidecar_sha256: sha256Text(sidecarBody),
        run_evidence_sha256: sha256Text(evidenceBody),
        primary_envelope_sha256: sha256Text(primaryEnvelopeBody),
        provider_events_sha256: sha256Text(providerEventsBody),
        provider_rollout_sha256: sha256Text(providerRolloutBody),
        provider_capture_sha256: sha256Text(providerCaptureBody),
        initial_report_sha256: null,
        receipt_binding_sha256: null,
        recovery_metadata_sha256: null,
        recovery_envelope_sha256: null,
      };
      writeFileSync(reportPath, reportBody);
      writeFileSync(`${prefix}.run.json`, sidecarBody);
      writeFileSync(`${prefix}.evidence.jsonl`, evidenceBody);
      writeFileSync(`${prefix}.json`, primaryEnvelopeBody);
      writeFileSync(`${prefix}.codex.jsonl`, providerEventsBody);
      writeFileSync(`${prefix}.codex-rollout.jsonl`, providerRolloutBody);
      writeFileSync(`${prefix}.codex-capture.json`, providerCaptureBody);
      writeFileSync(`${prefix}.fleet.json`, `${JSON.stringify(modelAttestation, null, 2)}\n`);
      return {
        planned_index: index,
        seed,
        persona: "default",
        provider: "codex",
        model,
        target: "overworld",
        report: reportPath,
        status: "verified",
        attempts: 1,
        attempt_history: [
          {
            attempt: 1,
            exit: 0,
            classification: "verified",
            report_recovered: false,
            archive: null,
            usage: {
              source: "primary_envelope",
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 10,
              reasoning_output_tokens: 0,
            },
          },
        ],
        resume_usage: null,
        report_recovered: false,
        exit: 0,
        log: null,
        report_schema_version: 2,
        play_mode: "pure",
        start_surface: "fresh_overworld",
        retention_eligible: true,
        evidence_status: "verified",
        session_contract_version: 3,
        baseline_decisions: 40,
        accepted_decisions: receipt.acceptedDecisions,
        retention_choices: receipt.retentionHistory,
        checkpoint: receipt.checkpoint,
        exit_reason: receipt.exitReason,
        exit_reasons: receipt.exitReasons,
        receipt_hash: receipt.receiptHash,
        failure_reason: null,
        evidence_schema_version: 2,
        model_attestation: modelAttestation,
        run_seed: seed,
        build,
        quest_outcomes: sidecar.quest_outcomes,
      };
    });
    const summary = {
      schema_version: 9,
      label: "codex-pilot",
      stamp: "20260102T000000Z",
      count: 10,
      concurrency: 4,
      reportsDir,
      report_schema_version: 2,
      play_mode: "pure",
      start_surface: "fresh_overworld",
      retention_contract_eligible: true,
      retention_eligible_verified_runs: 10,
      retention_ineligible_or_unverified_runs: 0,
      session_contract_version: 3,
      baseline_decisions: 40,
      verified: 10,
      "skipped-resume": 0,
      failed: 0,
      total_attempts: 10,
      failed_attempts: 0,
      technical_timeouts: 0,
      report_recovered_runs: 0,
      seed_base: 700,
      provider: "codex",
      model,
      personas: "default",
      target: "overworld",
      resume_enabled: false,
      evidence_schema_version: 2,
      model_attestation_schema_version: 9,
      build,
      codex_client: {
        schema_version: 2,
        launcher_kind: codexClient.launcher_kind,
        authority_sha256: codexClient.authority_sha256,
        cli_version: codexClient.cli_version,
      },
      codex_client_proof: authorityProofIndex(codexClient),
      usage: {
        attempt_count: 10,
        launched_attempt_count: 10,
        measured_attempt_count: 10,
        skipped_resume_count: 0,
        unrecoverable_attempt_count: 0,
        complete: true,
        observed_input_tokens: 100,
        observed_cached_input_tokens: 0,
        observed_uncached_input_tokens: 100,
        observed_output_tokens: 100,
        observed_reasoning_output_tokens: 0,
        useful_tokens: 200,
      },
    };
    const manifestPath = join(fleetDir, "manifest.jsonl");
    const authorityProofPath = join(fleetDir, "codex-client-authority.private.json");
    const writeAuthorityProof = (client: unknown) =>
      writeFileSync(authorityProofPath, authorityProofBody(client));
    writeFileSync(join(fleetDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(manifestPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    writeAuthorityProof(codexClient);

    const accepted = validateStartingSlicePilot({ root: ROOT, fleetDir, expectedBuild: build });
    expect(accepted.validity_errors).toEqual([]);
    expect(accepted.pilot_passed).toBe(true);
    expect(accepted.authenticated_actual_model).toBe(model);

    const firstTerraPrefix = join(reportsDir, "20260102T000000Z_overworld_seed700");
    const originalTerraRolloutBody = readFileSync(
      `${firstTerraPrefix}.codex-rollout.jsonl`,
      "utf8",
    );
    const originalTerraCaptureBody = readFileSync(`${firstTerraPrefix}.codex-capture.json`, "utf8");
    const originalTerraAttestationBody = readFileSync(`${firstTerraPrefix}.fleet.json`, "utf8");
    const originalTerraManifestBody = readFileSync(manifestPath, "utf8");
    const tamperedTerraRollout = originalTerraRolloutBody
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> });
    const tamperedTerraContext = tamperedTerraRollout.find(
      (entry) => entry.type === "turn_context",
    )?.payload;
    if (!tamperedTerraContext) throw new Error("missing Terra turn context fixture");
    tamperedTerraContext.comp_hash = "3001";
    const tamperedTerraRolloutBody = `${tamperedTerraRollout
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    const tamperedTerraCapture = JSON.parse(originalTerraCaptureBody) as Record<string, unknown>;
    tamperedTerraCapture.copied_rollout_sha256 = sha256Text(tamperedTerraRolloutBody);
    const tamperedTerraCaptureBody = `${JSON.stringify(tamperedTerraCapture, null, 2)}\n`;
    const tamperedTerraAttestation = JSON.parse(originalTerraAttestationBody) as Record<
      string,
      unknown
    >;
    tamperedTerraAttestation.provider_rollout_sha256 = sha256Text(tamperedTerraRolloutBody);
    tamperedTerraAttestation.provider_capture_sha256 = sha256Text(tamperedTerraCaptureBody);
    const tamperedTerraRows = structuredClone(rows) as Array<Record<string, unknown>>;
    tamperedTerraRows[0] = {
      ...tamperedTerraRows[0],
      model_attestation: tamperedTerraAttestation,
    };
    writeFileSync(`${firstTerraPrefix}.codex-rollout.jsonl`, tamperedTerraRolloutBody);
    writeFileSync(`${firstTerraPrefix}.codex-capture.json`, tamperedTerraCaptureBody);
    writeFileSync(
      `${firstTerraPrefix}.fleet.json`,
      `${JSON.stringify(tamperedTerraAttestation, null, 2)}\n`,
    );
    writeFileSync(
      manifestPath,
      `${tamperedTerraRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    expect(
      validateStartingSlicePilot({
        root: ROOT,
        fleetDir,
        expectedBuild: build,
      }).validity_errors.join("\n"),
    ).toContain("Codex provider evidence rejected");
    writeFileSync(`${firstTerraPrefix}.codex-rollout.jsonl`, originalTerraRolloutBody);
    writeFileSync(`${firstTerraPrefix}.codex-capture.json`, originalTerraCaptureBody);
    writeFileSync(`${firstTerraPrefix}.fleet.json`, originalTerraAttestationBody);
    writeFileSync(manifestPath, originalTerraManifestBody);

    const historicalV8Rows = rows.map((row) => {
      const { transport_contract: _transportContract, ...attestationBase } = row.model_attestation;
      const historicalAttestation = {
        ...attestationBase,
        schema_version: 8,
        code_mode_contract: "strict-code-mode-v2",
      };
      const prefix = join(reportsDir, `20260102T000000Z_overworld_seed${row.seed}`);
      writeFileSync(`${prefix}.fleet.json`, `${JSON.stringify(historicalAttestation, null, 2)}\n`);
      return { ...row, model_attestation: historicalAttestation };
    });
    const historicalV8Summary = {
      ...summary,
      schema_version: 8,
      model_attestation_schema_version: 8,
    };
    writeFileSync(
      join(fleetDir, "summary.json"),
      `${JSON.stringify(historicalV8Summary, null, 2)}\n`,
    );
    writeFileSync(
      manifestPath,
      `${historicalV8Rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const historicalRejected = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    }).validity_errors.join("\n");
    expect(historicalRejected).toContain(
      "current Codex pilot certification requires attestation v9",
    );
    expect(historicalRejected).toContain(
      "current Codex pilot certification requires fleet summary v9",
    );
    expect(historicalRejected).toContain(
      "historical v8 gpt-5.6-terra attestation lacks exact strict-code-mode-v2 evidence",
    );
    for (const row of rows) {
      const prefix = join(reportsDir, `20260102T000000Z_overworld_seed${row.seed}`);
      writeFileSync(`${prefix}.fleet.json`, `${JSON.stringify(row.model_attestation, null, 2)}\n`);
    }
    writeFileSync(join(fleetDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(manifestPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const sparkModel = "gpt-5.3-codex-spark" as const;
    const sparkTransportContract = PURE_FLEET_SPARK_DIRECT_MCP_TRANSPORT_CONTRACT;
    const sparkFleetDir = join(base, "fleet", "codex-spark-pilot");
    const sparkReportsDir = join(base, "spark-reports");
    mkdirSync(sparkFleetDir, { recursive: true });
    mkdirSync(sparkReportsDir, { recursive: true });
    const parseJsonl = (body: string) =>
      body
        .trim()
        .split(/\r?\n/u)
        .map(
          (line) =>
            JSON.parse(line) as {
              timestamp?: string;
              type?: string;
              item?: Record<string, unknown>;
              payload?: Record<string, unknown>;
            },
        );
    const renderJsonl = (values: readonly unknown[]) =>
      `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
    const sparkRows = rows.map((row) => {
      const strictPrefix = join(reportsDir, `20260102T000000Z_overworld_seed${row.seed}`);
      const sparkPrefix = join(sparkReportsDir, `20260102T000000Z_overworld_seed${row.seed}`);
      for (const suffix of [".md", ".run.json", ".evidence.jsonl"] as const) {
        writeFileSync(`${sparkPrefix}${suffix}`, readFileSync(`${strictPrefix}${suffix}`));
      }

      const sparkEvents = parseJsonl(readFileSync(`${strictPrefix}.codex.jsonl`, "utf8")).filter(
        (event) => {
          const item = event.item;
          return !(event.type === "item.completed" && item?.type === "error");
        },
      );
      const sparkEventsBody = renderJsonl(sparkEvents);

      const sparkRollout = parseJsonl(readFileSync(`${strictPrefix}.codex-rollout.jsonl`, "utf8"));
      const sessionMeta = sparkRollout.find((entry) => entry.type === "session_meta")?.payload;
      if (!sessionMeta) throw new Error("missing Spark session fixture");
      sessionMeta.cli_version = sparkCodexClient.cli_version;
      sessionMeta.base_instructions = { text: CODEX_SPARK_PLAYER_BASE_INSTRUCTIONS };
      const turnContext = sparkRollout.find((entry) => entry.type === "turn_context")?.payload;
      if (!turnContext) throw new Error("missing Spark turn context fixture");
      turnContext.model = sparkModel;
      turnContext.multi_agent_version = "disabled";
      turnContext.comp_hash = "2911";
      delete turnContext.multi_agent_mode;
      const collaborationMode = turnContext.collaboration_mode as Record<string, unknown>;
      const collaborationSettings = collaborationMode.settings as Record<string, unknown>;
      collaborationSettings.model = sparkModel;

      const taskStartIndex = sparkRollout.findIndex(
        (entry) => entry.type === "event_msg" && entry.payload?.type === "task_started",
      );
      const worldStateIndex = sparkRollout.findIndex((entry) => entry.type === "world_state");
      if (taskStartIndex < 0 || worldStateIndex <= taskStartIndex) {
        throw new Error("missing Spark prelude boundary fixture");
      }
      sparkRollout.splice(taskStartIndex + 1, worldStateIndex - taskStartIndex - 1, {
        type: "response_item",
        payload: {
          type: "message",
          id: "spark-global-agents",
          role: "user",
          content: [{ type: "input_text", text: GLOBAL_AGENTS_BLOCK }],
          internal_chat_message_metadata_passthrough: {
            turn_id: row.model_attestation.provider_turn_id,
          },
        },
      });

      const directCallIndex = sparkRollout.findIndex(
        (entry) => entry.type === "response_item" && entry.payload?.type === "function_call",
      );
      if (directCallIndex < 0) throw new Error("missing Terra direct-call fixture");
      let responseItemOrdinal = 0;
      for (const entry of sparkRollout) {
        if (entry.type !== "response_item" || !entry.payload) continue;
        responseItemOrdinal += 1;
        entry.payload.id = `spark-item-${responseItemOrdinal}`;
      }
      const sparkRolloutBody = renderJsonl(sparkRollout);

      const strictCapture = JSON.parse(
        readFileSync(`${strictPrefix}.codex-capture.json`, "utf8"),
      ) as Record<string, unknown>;
      const {
        schema_version: _strictCaptureSchema,
        transport_contract: _strictCaptureContract,
        ...captureBase
      } = strictCapture;
      const sparkCapture = {
        ...captureBase,
        schema_version: 4,
        transport_contract: sparkTransportContract,
        copied_rollout_sha256: sha256Text(sparkRolloutBody),
      };
      const sparkCaptureBody = `${JSON.stringify(sparkCapture, null, 2)}\n`;

      const sparkPrimary = JSON.parse(readFileSync(`${strictPrefix}.json`, "utf8")) as Record<
        string,
        unknown
      >;
      const strictModelUsage = (sparkPrimary.modelUsage as Record<string, unknown>)[model];
      sparkPrimary.requested_model = sparkModel;
      sparkPrimary.modelUsage = { [sparkModel]: strictModelUsage };
      const sparkPrimaryBody = `${JSON.stringify(sparkPrimary)}\n`;

      const { transport_contract: _strictAttestationContract, ...sparkAttestationBase } =
        row.model_attestation;
      const sparkAttestation = {
        ...sparkAttestationBase,
        codex_cli_version: sparkCodexClient.cli_version,
        codex_client_authority_sha256: sparkCodexClient.authority_sha256,
        model: sparkModel,
        actual_model: sparkModel,
        transport_contract: sparkTransportContract,
        primary_envelope_sha256: sha256Text(sparkPrimaryBody),
        provider_events_sha256: sha256Text(sparkEventsBody),
        provider_rollout_sha256: sha256Text(sparkRolloutBody),
        provider_capture_sha256: sha256Text(sparkCaptureBody),
      };
      writeFileSync(`${sparkPrefix}.json`, sparkPrimaryBody);
      writeFileSync(`${sparkPrefix}.codex.jsonl`, sparkEventsBody);
      writeFileSync(`${sparkPrefix}.codex-rollout.jsonl`, sparkRolloutBody);
      writeFileSync(`${sparkPrefix}.codex-capture.json`, sparkCaptureBody);
      writeFileSync(`${sparkPrefix}.fleet.json`, `${JSON.stringify(sparkAttestation, null, 2)}\n`);
      return {
        ...row,
        model: sparkModel,
        report: `${sparkPrefix}.md`,
        model_attestation: sparkAttestation,
      };
    });
    const sparkSummary = {
      ...summary,
      label: "codex-spark-pilot",
      reportsDir: sparkReportsDir,
      model: sparkModel,
      codex_client: {
        schema_version: 2,
        launcher_kind: sparkCodexClient.launcher_kind,
        authority_sha256: sparkCodexClient.authority_sha256,
        cli_version: sparkCodexClient.cli_version,
      },
      codex_client_proof: authorityProofIndex(sparkCodexClient),
    };
    const sparkManifestPath = join(sparkFleetDir, "manifest.jsonl");
    writeFileSync(
      join(sparkFleetDir, "summary.json"),
      `${JSON.stringify(sparkSummary, null, 2)}\n`,
    );
    writeFileSync(sparkManifestPath, renderJsonl(sparkRows));
    writeFileSync(
      join(sparkFleetDir, "codex-client-authority.private.json"),
      authorityProofBody(sparkCodexClient),
    );

    const acceptedSpark = validateStartingSlicePilot({
      root: ROOT,
      fleetDir: sparkFleetDir,
      expectedBuild: build,
    });
    expect(acceptedSpark.validity_errors).toEqual([]);
    expect(acceptedSpark.pilot_passed).toBe(true);
    expect(acceptedSpark.authenticated_actual_model).toBe(sparkModel);

    const historicalV8SparkRows = sparkRows.map((row) => {
      const historicalAttestation = { ...row.model_attestation, schema_version: 8 };
      const prefix = join(sparkReportsDir, `20260102T000000Z_overworld_seed${row.seed}`);
      writeFileSync(`${prefix}.fleet.json`, `${JSON.stringify(historicalAttestation, null, 2)}\n`);
      return { ...row, model_attestation: historicalAttestation };
    });
    const historicalV8SparkSummary = {
      ...sparkSummary,
      schema_version: 8,
      model_attestation_schema_version: 8,
    };
    writeFileSync(
      join(sparkFleetDir, "summary.json"),
      `${JSON.stringify(historicalV8SparkSummary, null, 2)}\n`,
    );
    writeFileSync(sparkManifestPath, renderJsonl(historicalV8SparkRows));
    const historicalV8SparkErrors = validateStartingSlicePilot({
      root: ROOT,
      fleetDir: sparkFleetDir,
      expectedBuild: build,
    }).validity_errors;
    expect(historicalV8SparkErrors).toContain(
      "current Codex pilot certification requires attestation v9",
    );
    expect(historicalV8SparkErrors).toContain(
      "current Codex pilot certification requires fleet summary v9",
    );
    expect(historicalV8SparkErrors.join("\n")).not.toMatch(
      /direct-MCP evidence requires|historical v8 Spark attestation lacks/iu,
    );
    const receiptMarkedHistoricalV8SparkRows = historicalV8SparkRows.map((row, index) => ({
      ...row,
      report_receipt_bound: index === 0,
      attempt_history: row.attempt_history.map((attempt) => ({
        ...attempt,
        report_receipt_bound: index === 0,
      })),
    }));
    writeFileSync(
      join(sparkFleetDir, "summary.json"),
      `${JSON.stringify({ ...historicalV8SparkSummary, receipt_bound_runs: 1 }, null, 2)}\n`,
    );
    writeFileSync(sparkManifestPath, renderJsonl(receiptMarkedHistoricalV8SparkRows));
    expect(
      validateStartingSlicePilot({
        root: ROOT,
        fleetDir: sparkFleetDir,
        expectedBuild: build,
      }).validity_errors.join("\n"),
    ).not.toContain("receipt-bound row requires a receipt-aware Codex attestation schema");
    writeFileSync(
      join(sparkFleetDir, "summary.json"),
      `${JSON.stringify(historicalV8SparkSummary, null, 2)}\n`,
    );
    writeFileSync(sparkManifestPath, renderJsonl(historicalV8SparkRows));
    const driftedHistoricalV8SparkAttestation = {
      ...historicalV8SparkRows[0]!.model_attestation,
      codex_client_authority_sha256: "f".repeat(64),
    };
    const firstHistoricalV8SparkPrefix = join(
      sparkReportsDir,
      `20260102T000000Z_overworld_seed${historicalV8SparkRows[0]!.seed}`,
    );
    writeFileSync(
      `${firstHistoricalV8SparkPrefix}.fleet.json`,
      `${JSON.stringify(driftedHistoricalV8SparkAttestation, null, 2)}\n`,
    );
    writeFileSync(
      sparkManifestPath,
      renderJsonl(
        historicalV8SparkRows.map((row, index) =>
          index === 0 ? { ...row, model_attestation: driftedHistoricalV8SparkAttestation } : row,
        ),
      ),
    );
    expect(
      validateStartingSlicePilot({
        root: ROOT,
        fleetDir: sparkFleetDir,
        expectedBuild: build,
      }).validity_errors.join("\n"),
    ).toContain("seed 700: model attestation Codex client authority differs");
    for (const row of sparkRows) {
      const prefix = join(sparkReportsDir, `20260102T000000Z_overworld_seed${row.seed}`);
      writeFileSync(`${prefix}.fleet.json`, `${JSON.stringify(row.model_attestation, null, 2)}\n`);
    }
    writeFileSync(
      join(sparkFleetDir, "summary.json"),
      `${JSON.stringify(sparkSummary, null, 2)}\n`,
    );
    writeFileSync(sparkManifestPath, renderJsonl(sparkRows));

    const outdatedSparkClient = { ...sparkCodexClient, cli_version: "0.145.0" } as const;
    const outdatedSparkSummary = {
      ...sparkSummary,
      codex_client: {
        ...sparkSummary.codex_client,
        cli_version: outdatedSparkClient.cli_version,
      },
      codex_client_proof: authorityProofIndex(outdatedSparkClient),
    };
    writeFileSync(
      join(sparkFleetDir, "summary.json"),
      `${JSON.stringify(outdatedSparkSummary, null, 2)}\n`,
    );
    writeFileSync(
      join(sparkFleetDir, "codex-client-authority.private.json"),
      authorityProofBody(outdatedSparkClient),
    );
    expect(
      validateStartingSlicePilot({
        root: ROOT,
        fleetDir: sparkFleetDir,
        expectedBuild: build,
      }).validity_errors.join("\n"),
    ).toContain("current direct-MCP certification requires exact Codex CLI 0.146.0");
    writeFileSync(
      join(sparkFleetDir, "summary.json"),
      `${JSON.stringify(sparkSummary, null, 2)}\n`,
    );
    writeFileSync(
      join(sparkFleetDir, "codex-client-authority.private.json"),
      authorityProofBody(sparkCodexClient),
    );

    const firstSparkPrefix = join(sparkReportsDir, "20260102T000000Z_overworld_seed700");
    const directCapture = JSON.parse(
      readFileSync(`${firstSparkPrefix}.codex-capture.json`, "utf8"),
    ) as Record<string, unknown>;
    const {
      schema_version: _directCaptureSchema,
      transport_contract: _directCaptureContract,
      ...directCaptureBase
    } = directCapture;
    const crossContractCapture = {
      ...directCaptureBase,
      schema_version: 3,
      code_mode_contract: "strict-code-mode-v2",
    };
    const crossContractCaptureBody = `${JSON.stringify(crossContractCapture, null, 2)}\n`;
    writeFileSync(`${firstSparkPrefix}.codex-capture.json`, crossContractCaptureBody);
    const crossContractAttestation = {
      ...sparkRows[0]!.model_attestation,
      provider_capture_sha256: sha256Text(crossContractCaptureBody),
    };
    writeFileSync(
      `${firstSparkPrefix}.fleet.json`,
      `${JSON.stringify(crossContractAttestation, null, 2)}\n`,
    );
    writeFileSync(
      sparkManifestPath,
      renderJsonl(
        sparkRows.map((row, index) =>
          index === 0 ? { ...row, model_attestation: crossContractAttestation } : row,
        ),
      ),
    );
    expect(
      validateStartingSlicePilot({
        root: ROOT,
        fleetDir: sparkFleetDir,
        expectedBuild: build,
      }).validity_errors.join("\n"),
    ).toContain("Codex strict-current run is missing its exact code-mode prelude");

    const summaryPath = join(fleetDir, "summary.json");
    const writeFleet = (nextRows: readonly Record<string, unknown>[], nextSummary: unknown) => {
      writeFileSync(summaryPath, `${JSON.stringify(nextSummary, null, 2)}\n`);
      writeFileSync(manifestPath, `${nextRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    };
    const failedUsage = {
      source: "unrecoverable",
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      reasoning_output_tokens: null,
    } as const;
    const terminalUsage = {
      source: "terminal_turn_completed",
      input_tokens: 3,
      cached_input_tokens: 1,
      output_tokens: 2,
      reasoning_output_tokens: 0,
    } as const;
    const failedSummary = (usage: Record<string, unknown>) => ({
      ...summary,
      verified: 9,
      failed: 1,
      retention_eligible_verified_runs: 9,
      retention_ineligible_or_unverified_runs: 1,
      failed_attempts: 1,
      technical_timeouts: 1,
      usage,
    });
    const writeFailedArchive = (files: Record<string, string>) => {
      const seed = rows[0]!.seed;
      const directory = join(fleetDir, "attempts", `seed_${seed}`, "attempt_1");
      rmSync(join(fleetDir, "attempts"), { recursive: true, force: true });
      mkdirSync(directory, { recursive: true });
      for (const [name, body] of Object.entries(files)) writeFileSync(join(directory, name), body);
      return Object.entries(files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, body]) => ({
          name,
          bytes: Buffer.byteLength(body, "utf8"),
          sha256: sha256Text(body),
        }));
    };
    const failedRow = (archive: Record<string, unknown>, usage: Record<string, unknown>) => ({
      ...rows[0]!,
      status: "failed",
      exit: 124,
      log: join(fleetDir, "attempts", `seed_${rows[0]!.seed}`, "attempt_1", "fleet-diagnostic.log"),
      model_attestation: null,
      evidence_schema_version: null,
      run_seed: null,
      build: null,
      quest_outcomes: null,
      report_schema_version: null,
      retention_eligible: false,
      evidence_status: "unverified",
      session_contract_version: null,
      baseline_decisions: null,
      accepted_decisions: null,
      retention_choices: [],
      checkpoint: null,
      exit_reason: null,
      exit_reasons: [],
      receipt_hash: null,
      report_recovered: false,
      report_receipt_bound: false,
      resume_usage: null,
      failure_reason: "technical_timeout",
      attempt_history: [
        {
          attempt: 1,
          exit: 124,
          classification: "technical_timeout",
          report_recovered: false,
          archive,
          usage,
        },
      ],
    });

    const tamperedAttemptUsage = rows.map((row, index) =>
      index === 0
        ? {
            ...row,
            attempt_history: row.attempt_history.map((attempt) => ({
              ...attempt,
              usage: { ...attempt.usage!, output_tokens: 11 },
            })),
          }
        : row,
    );
    writeFleet(tamperedAttemptUsage, summary);
    expect(
      validateStartingSlicePilot({
        root: ROOT,
        fleetDir,
        expectedBuild: build,
      }).validity_errors.join("\n"),
    ).toContain("verified attempt usage differs from authenticated primary envelope");

    writeFleet(rows, { ...summary, usage: { ...summary.usage, useful_tokens: 201 } });
    expect(
      validateStartingSlicePilot({
        root: ROOT,
        fleetDir,
        expectedBuild: build,
      }).validity_errors.join("\n"),
    ).toContain("summary usage differs from independently recomputed attempt usage");

    for (const unsafeField of [
      "authority_token",
      "selected_binary",
      "executable_binary",
      "test_script",
    ] as const) {
      writeFleet(rows, {
        ...summary,
        codex_client: { ...summary.codex_client, [unsafeField]: "test-only-value" },
      });
      expect(
        validateStartingSlicePilot({
          root: ROOT,
          fleetDir,
          expectedBuild: build,
        }).validity_errors.join("\n"),
      ).toMatch(new RegExp(`summary\\.json invalid:.*${unsafeField}`, "i"));
    }

    writeFleet(rows, summary);
    writeFileSync(authorityProofPath, `${authorityProofBody(codexClient)} `);
    expect(
      validateStartingSlicePilot({
        root: ROOT,
        fleetDir,
        expectedBuild: build,
      }).validity_errors.join("\n"),
    ).toContain("private Codex client authority proof bytes differ from summary digest index");

    const launcherTamperedClient = {
      ...codexClient,
      launcher_kind: "official_npm_shim",
    } as const;
    writeAuthorityProof(launcherTamperedClient);
    writeFleet(rows, {
      ...summary,
      codex_client_proof: authorityProofIndex(launcherTamperedClient),
    });
    expect(
      validateStartingSlicePilot({
        root: ROOT,
        fleetDir,
        expectedBuild: build,
      }).validity_errors.join("\n"),
    ).toMatch(/private Codex client authority proof invalid/i);

    writeAuthorityProof(codexClient);
    writeFleet(rows, {
      ...summary,
      codex_client: {
        ...summary.codex_client,
        authority_sha256: "e".repeat(64),
      },
    });
    expect(
      validateStartingSlicePilot({
        root: ROOT,
        fleetDir,
        expectedBuild: build,
      }).validity_errors.join("\n"),
    ).toContain(
      "summary Codex client projection differs from authenticated private authority proof",
    );

    writeFleet(rows, summary);
    unlinkSync(authorityProofPath);
    expect(
      validateStartingSlicePilot({
        root: ROOT,
        fleetDir,
        expectedBuild: build,
      }).validity_errors.join("\n"),
    ).toMatch(/private Codex client authority proof unsafe or unreadable/i);
    writeAuthorityProof(codexClient);

    const noUsageArtifacts = writeFailedArchive({
      "fleet-diagnostic.log": "attempt=1\nclassification=technical_timeout\n",
    });
    const archivedFailedRow = failedRow(
      {
        directory: `attempts/seed_${rows[0]!.seed}/attempt_1`,
        artifacts: noUsageArtifacts,
        usage_artifacts: { primary_envelope: null, provider_events: null },
      },
      failedUsage,
    );
    writeFleet(
      [archivedFailedRow, ...rows.slice(1)],
      failedSummary({
        attempt_count: 10,
        launched_attempt_count: 10,
        measured_attempt_count: 9,
        skipped_resume_count: 0,
        unrecoverable_attempt_count: 1,
        complete: false,
        observed_input_tokens: 90,
        observed_cached_input_tokens: 0,
        observed_uncached_input_tokens: 90,
        observed_output_tokens: 90,
        observed_reasoning_output_tokens: 0,
        useful_tokens: 180,
      }),
    );
    expect(
      validateStartingSlicePilot({
        root: ROOT,
        fleetDir,
        expectedBuild: build,
      }).validity_errors.join("\n"),
    ).toContain("pilot cohort contains a failed slot");

    const prefix = `20260102T000000Z_overworld_seed${rows[0]!.seed}`;
    const malformedPrimaryArtifacts = writeFailedArchive({
      [`${prefix}.codex.jsonl`]: `${JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: terminalUsage.input_tokens,
          cached_input_tokens: terminalUsage.cached_input_tokens,
          output_tokens: terminalUsage.output_tokens,
        },
      })}\n`,
      [`${prefix}.json`]: "{not valid JSON\n",
    });
    writeFleet(
      [
        failedRow(
          {
            directory: `attempts/seed_${rows[0]!.seed}/attempt_1`,
            artifacts: malformedPrimaryArtifacts,
            usage_artifacts: {
              primary_envelope: `${prefix}.json`,
              provider_events: `${prefix}.codex.jsonl`,
            },
          },
          terminalUsage,
        ),
        ...rows.slice(1),
      ],
      failedSummary({
        attempt_count: 10,
        launched_attempt_count: 10,
        measured_attempt_count: 9,
        skipped_resume_count: 0,
        unrecoverable_attempt_count: 1,
        complete: false,
        observed_input_tokens: 90,
        observed_cached_input_tokens: 0,
        observed_uncached_input_tokens: 90,
        observed_output_tokens: 90,
        observed_reasoning_output_tokens: 0,
        useful_tokens: 180,
      }),
    );
    expect(
      validateStartingSlicePilot({
        root: ROOT,
        fleetDir,
        expectedBuild: build,
      }).validity_errors.join("\n"),
    ).toContain("usage differs from archived evidence");

    const eventsOnlyArtifacts = writeFailedArchive({
      [`${prefix}.codex.jsonl`]: `${JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: terminalUsage.input_tokens,
          cached_input_tokens: terminalUsage.cached_input_tokens,
          output_tokens: terminalUsage.output_tokens,
        },
      })}\n`,
    });
    writeFleet(
      [
        failedRow(
          {
            directory: `attempts/seed_${rows[0]!.seed}/attempt_1`,
            artifacts: eventsOnlyArtifacts,
            usage_artifacts: {
              primary_envelope: null,
              provider_events: `${prefix}.codex.jsonl`,
            },
          },
          terminalUsage,
        ),
        ...rows.slice(1),
      ],
      failedSummary({
        attempt_count: 10,
        launched_attempt_count: 10,
        measured_attempt_count: 10,
        skipped_resume_count: 0,
        unrecoverable_attempt_count: 0,
        complete: true,
        observed_input_tokens: 93,
        observed_cached_input_tokens: 1,
        observed_uncached_input_tokens: 92,
        observed_output_tokens: 92,
        observed_reasoning_output_tokens: 0,
        useful_tokens: 184,
      }),
    );
    const eventsOnlyErrors = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    }).validity_errors;
    expect(eventsOnlyErrors.join("\n")).toContain("pilot cohort contains a failed slot");
    expect(eventsOnlyErrors.join("\n")).toContain("summary contains 1 failed runs");
    expect(eventsOnlyErrors.join("\n")).not.toContain("usage differs from archived evidence");

    rmSync(join(fleetDir, "attempts"), { recursive: true, force: true });
    writeFleet(rows, summary);
    const testScriptAuthority = {
      ...(JSON.parse(Buffer.from(authorityToken, "base64url").toString("utf8")) as Record<
        string,
        unknown
      >),
      test_script: true,
    };
    const testScriptToken = Buffer.from(JSON.stringify(testScriptAuthority), "utf8").toString(
      "base64url",
    );
    writeFileSync(
      summaryPath,
      `${JSON.stringify(
        {
          ...summary,
          codex_client: {
            ...codexClient,
            authority_token: testScriptToken,
            authority_sha256: sha256Text(testScriptToken),
            test_script: true,
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(
      validateStartingSlicePilot({
        root: ROOT,
        fleetDir,
        expectedBuild: build,
      }).validity_errors.join("\n"),
    ).toMatch(/authority_token/i);

    const fabricatedShellAuthority = {
      schema_version: 2,
      launcher_kind: "official_npm_shim",
      selected: { canonical_path: "/opt/bin/codex", identity: authorityIdentity },
      selected_symlink: null,
      package_manifest: {
        canonical_path: "/foreign/node_modules/@openai/codex/package.json",
        identity: authorityIdentity,
      },
      javascript_entrypoint: {
        canonical_path: "/foreign/node_modules/@openai/codex/bin/codex.js",
        identity: authorityIdentity,
      },
      executable: { canonical_path: "/foreign/codex", identity: authorityIdentity },
      declared_cli_version: "0.144.1",
      test_script: false,
    } as const;
    const fabricatedShellToken = Buffer.from(
      JSON.stringify(fabricatedShellAuthority),
      "utf8",
    ).toString("base64url");
    writeFileSync(
      summaryPath,
      `${JSON.stringify(
        {
          ...summary,
          codex_client: {
            schema_version: 2,
            launcher_kind: "official_npm_shim",
            selected_binary: "/opt/bin/codex",
            executable_binary: "/foreign/codex",
            authority_token: fabricatedShellToken,
            authority_sha256: sha256Text(fabricatedShellToken),
            cli_version: "0.144.1",
            test_script: false,
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(
      validateStartingSlicePilot({
        root: ROOT,
        fleetDir,
        expectedBuild: build,
      }).validity_errors.join("\n"),
    ).toMatch(/summary/i);

    writeFileSync(
      summaryPath,
      `${JSON.stringify(
        { ...summary, codex_client: { ...codexClient, cli_version: "0.145.0" } },
        null,
        2,
      )}\n`,
    );
    expect(
      validateStartingSlicePilot({
        root: ROOT,
        fleetDir,
        expectedBuild: build,
      }).validity_errors.join("\n"),
    ).toMatch(/summary\.json invalid: codex_client/i);
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

    const { codex_client: _clientAuthority, ...historicalSummary } = summary;
    writeFileSync(
      summaryPath,
      `${JSON.stringify({ ...historicalSummary, model_attestation_schema_version: 5 }, null, 2)}\n`,
    );
    const rejectedHistoricalPilot = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedHistoricalPilot.validity_errors.join("\n")).toMatch(
      /summary\.json invalid: model_attestation_schema_version: Invalid literal value, expected 9/i,
    );
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

    writeFileSync(
      summaryPath,
      `${JSON.stringify({ ...summary, receipt_bound_runs: 1 }, null, 2)}\n`,
    );
    const rejectedUnbackedBindingCount = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedUnbackedBindingCount.validity_errors.join("\n")).toMatch(
      /manifest receipt-bound runs 0 != summary 1/i,
    );
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

    const firstPrefix = join(reportsDir, "20260102T000000Z_overworld_seed700");
    const originalFinalReportBody = readFileSync(`${firstPrefix}.md`, "utf8");
    const initialReportBody = reportText({
      acceptedDecisions: receipt.acceptedDecisions,
      decisionProofHash: "forged",
      receiptHash: "forged",
    });
    const providerSessionId = "10000000-0000-4000-8000-000000000700";
    const firstEvidenceBody = readFileSync(`${firstPrefix}.evidence.jsonl`, "utf8");
    const boundPrimaryEnvelopeBody = `${JSON.stringify({
      type: "result",
      subtype: "success",
      provider: "codex",
      is_error: false,
      duration_ms: 1000,
      num_turns: 1,
      result: initialReportBody,
      session_id: providerSessionId,
      requested_model: model,
      terminal_reason: "completed",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 0,
        output_tokens: 10,
        reasoning_output_tokens: 0,
      },
      modelUsage: {
        [model]: {
          inputTokens: 10,
          cacheReadInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 0,
        },
      },
    })}\n`;
    const binding = bindPureCodexReceipt({
      playMode: "pure",
      provider: "codex",
      agentExitStatus: 0,
      verifierExitStatus: 5,
      attempt: 0,
      requestedModel: model,
      expectedRunSeed: 700,
      expectedGitCommit: build.git_commit,
      expectedTrackedWorktreeClean: true,
      primaryEnvelopeBytes: Buffer.from(boundPrimaryEnvelopeBody),
      runEvidenceBytes: Buffer.from(firstEvidenceBody),
      reportBytes: Buffer.from(initialReportBody),
    });
    expect(binding.ok, binding.ok ? undefined : binding.reason).toBe(true);
    if (!binding.ok) throw new Error(binding.reason);
    const boundReportBody = Buffer.from(binding.reportBytes).toString("utf8");
    const bindingBody = `${JSON.stringify(binding.metadata, null, 2)}\n`;

    const encodedFinalReport = JSON.stringify(originalFinalReportBody);
    const encodedInitialReport = JSON.stringify(initialReportBody);
    const providerEventsPath = `${firstPrefix}.codex.jsonl`;
    const providerEventsBody = readFileSync(providerEventsPath, "utf8").replaceAll(
      encodedFinalReport,
      encodedInitialReport,
    );
    writeFileSync(providerEventsPath, providerEventsBody);
    const rolloutPath = `${firstPrefix}.codex-rollout.jsonl`;
    const boundRolloutBody = readFileSync(rolloutPath, "utf8").replaceAll(
      encodedFinalReport,
      encodedInitialReport,
    );
    writeFileSync(rolloutPath, boundRolloutBody);
    const capturePath = `${firstPrefix}.codex-capture.json`;
    const boundCapture = JSON.parse(readFileSync(capturePath, "utf8")) as Record<string, unknown>;
    boundCapture.copied_rollout_sha256 = sha256Text(boundRolloutBody);
    const boundCaptureBody = `${JSON.stringify(boundCapture, null, 2)}\n`;
    writeFileSync(capturePath, boundCaptureBody);
    writeFileSync(`${firstPrefix}.json`, boundPrimaryEnvelopeBody);
    writeFileSync(`${firstPrefix}.initial-report.txt`, initialReportBody);
    writeFileSync(`${firstPrefix}.receipt-bind.json`, bindingBody);
    writeFileSync(`${firstPrefix}.md`, boundReportBody);

    const boundRows = rows.map((row, index) => {
      const receiptBound = index === 0;
      const modelAttestation = {
        ...row.model_attestation,
        schema_version: 9,
        report_receipt_bound: receiptBound,
        report_sha256: receiptBound
          ? sha256Text(boundReportBody)
          : row.model_attestation.report_sha256,
        primary_envelope_sha256: receiptBound
          ? sha256Text(boundPrimaryEnvelopeBody)
          : row.model_attestation.primary_envelope_sha256,
        provider_events_sha256: receiptBound
          ? sha256Text(providerEventsBody)
          : row.model_attestation.provider_events_sha256,
        provider_rollout_sha256: receiptBound
          ? sha256Text(boundRolloutBody)
          : row.model_attestation.provider_rollout_sha256,
        provider_capture_sha256: receiptBound
          ? sha256Text(boundCaptureBody)
          : row.model_attestation.provider_capture_sha256,
        initial_report_sha256: receiptBound ? sha256Text(initialReportBody) : null,
        receipt_binding_sha256: receiptBound ? sha256Text(bindingBody) : null,
      };
      const upgraded = {
        ...row,
        report_receipt_bound: receiptBound,
        attempt_history: row.attempt_history.map((attempt) => ({
          ...attempt,
          report_receipt_bound: receiptBound,
        })),
        model_attestation: modelAttestation,
      };
      const prefix = join(reportsDir, `20260102T000000Z_overworld_seed${row.seed}`);
      writeFileSync(`${prefix}.fleet.json`, `${JSON.stringify(modelAttestation, null, 2)}\n`);
      return upgraded;
    });
    const boundSummary = {
      ...summary,
      receipt_bound_runs: 1,
      model_attestation_schema_version: 9,
    };
    writeFileSync(summaryPath, `${JSON.stringify(boundSummary, null, 2)}\n`);
    writeFileSync(manifestPath, `${boundRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const acceptedBoundV5 = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(acceptedBoundV5.validity_errors).toEqual([]);
    expect(acceptedBoundV5.pilot_passed).toBe(true);
    writeFileSync(
      summaryPath,
      `${JSON.stringify(
        {
          ...historicalSummary,
          receipt_bound_runs: 1,
          model_attestation_schema_version: 4,
        },
        null,
        2,
      )}\n`,
    );
    const rejectedCurrentAuthority = certifyStartingSliceAuthority({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedCurrentAuthority.validity_errors.join("\n")).toMatch(
      /summary\.json invalid: model_attestation_schema_version: Invalid literal value, expected 9/i,
    );
    writeFileSync(summaryPath, `${JSON.stringify(boundSummary, null, 2)}\n`);

    const tamperedRollout = readFileSync(rolloutPath, "utf8")
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const completion = tamperedRollout.at(-1)!.payload as Record<string, unknown>;
    completion.last_agent_message = "coherently re-hashed substitution";
    const tamperedRolloutBody = `${tamperedRollout.map((row) => JSON.stringify(row)).join("\n")}\n`;
    writeFileSync(rolloutPath, tamperedRolloutBody);
    const tamperedCapture = JSON.parse(readFileSync(capturePath, "utf8")) as Record<
      string,
      unknown
    >;
    tamperedCapture.copied_rollout_sha256 = sha256Text(tamperedRolloutBody);
    const tamperedCaptureBody = `${JSON.stringify(tamperedCapture, null, 2)}\n`;
    writeFileSync(capturePath, tamperedCaptureBody);
    const tamperedAttestation = {
      ...boundRows[0]!.model_attestation,
      provider_rollout_sha256: sha256Text(tamperedRolloutBody),
      provider_capture_sha256: sha256Text(tamperedCaptureBody),
    };
    writeFileSync(`${firstPrefix}.fleet.json`, `${JSON.stringify(tamperedAttestation, null, 2)}\n`);
    writeFileSync(
      manifestPath,
      `${boundRows
        .map((row, index) =>
          index === 0 ? { ...row, model_attestation: tamperedAttestation } : row,
        )
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    const rejected = validateStartingSlicePilot({ root: ROOT, fleetDir, expectedBuild: build });
    expect(rejected.validity_errors.join("\n")).toMatch(/task_complete message bytes/i);
  });

  it("reopens every sidecar, model attestation, and report instead of trusting the manifest", () => {
    const base = mkdtempSync(join(tmpdir(), "af-slice-certifier-"));
    tempDirs.push(base);
    const fleetDir = join(base, "fleet", "fixed-fleet");
    const reportsDir = join(base, "reports");
    mkdirSync(fleetDir, { recursive: true });
    mkdirSync(reportsDir, { recursive: true });
    const build = fixtureBuild;
    const receipt = currentReceipt();
    const outcomes = Array.from(
      { length: 10 },
      (_, index) =>
        [
          "ending_held",
          "ending_pack_diverted",
          "ending_drive_reserve_spent",
          "ending_fortified_cade_terms",
        ][index % 4]!,
    );
    const rows = outcomes.map((outcome, index) => {
      const seed = 500 + index;
      const model = "sonnet" as const;
      const prefix = join(reportsDir, `20260101T000000Z_overworld_seed${seed}`);
      const report = `${prefix}.md`;
      const sidecar = {
        schema_version: 2,
        report_schema_version: 2,
        play_mode: "pure",
        start_surface: "fresh_overworld",
        retention_eligible: true,
        evidence_status: "verified",
        session_id: `session-${seed}`,
        run_seed: seed,
        build,
        quest_outcomes: [["wolf_winter", outcome]],
        receipt,
      };
      const reportBody = reportText(receipt);
      const sidecarBody = `${JSON.stringify(sidecar, null, 2)}\n`;
      const claudeSessionId = `00000000-0000-4000-8000-${String(seed).padStart(12, "0")}`;
      const actualModel = "claude-sonnet-4-5-20260716";
      const evidenceBody = `${[
        {
          schema_version: 2,
          play_mode: "pure",
          event: "fresh_start",
          start_surface: "fresh_overworld",
          session_id: sidecar.session_id,
          run_seed: seed,
          build,
        },
        {
          schema_version: 2,
          play_mode: "pure",
          event: "journey_exit",
          start_surface: "fresh_overworld",
          session_id: sidecar.session_id,
          run_seed: seed,
          build,
          quest_outcomes: sidecar.quest_outcomes,
          receipt,
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`;
      const primaryEnvelopeBody = `${JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: claudeSessionId,
        result: reportBody,
        stop_reason: "end_turn",
        terminal_reason: "completed",
        permission_denials: [],
        modelUsage: { [actualModel]: {} },
      })}\n`;
      const modelAttestation = {
        schema_version: 2,
        run_seed: seed,
        model,
        persona: "default",
        target: "overworld",
        play_mode: "pure",
        start_surface: "fresh_overworld",
        build,
        game_session_id: sidecar.session_id,
        claude_session_id: claudeSessionId,
        actual_model: actualModel,
        report_recovered: false,
        receipt_hash: receipt.receiptHash,
        report_sha256: sha256Text(reportBody),
        run_sidecar_sha256: sha256Text(sidecarBody),
        run_evidence_sha256: sha256Text(evidenceBody),
        primary_envelope_sha256: sha256Text(primaryEnvelopeBody),
        initial_report_sha256: null,
        recovery_metadata_sha256: null,
        recovery_envelope_sha256: null,
      };
      writeFileSync(report, reportBody);
      writeFileSync(`${prefix}.run.json`, sidecarBody);
      writeFileSync(`${prefix}.evidence.jsonl`, evidenceBody);
      writeFileSync(`${prefix}.json`, primaryEnvelopeBody);
      writeFileSync(`${prefix}.fleet.json`, `${JSON.stringify(modelAttestation, null, 2)}\n`);
      return {
        planned_index: index,
        seed,
        persona: "default",
        model,
        target: "overworld",
        report,
        status: "verified",
        attempts: 1,
        attempt_history: [
          {
            attempt: 1,
            exit: 0,
            classification: "verified",
            report_recovered: false,
            archive: null,
          },
        ],
        report_recovered: false,
        exit: 0,
        log: null,
        report_schema_version: 2,
        play_mode: "pure",
        start_surface: "fresh_overworld",
        retention_eligible: true,
        evidence_status: "verified",
        session_contract_version: 3,
        baseline_decisions: 40,
        accepted_decisions: receipt.acceptedDecisions,
        retention_choices: receipt.retentionHistory,
        checkpoint: receipt.checkpoint,
        exit_reason: receipt.exitReason,
        exit_reasons: receipt.exitReasons,
        receipt_hash: receipt.receiptHash,
        failure_reason: null,
        evidence_schema_version: 2,
        model_attestation: modelAttestation,
        run_seed: seed,
        build,
        quest_outcomes: sidecar.quest_outcomes,
      };
    });
    const summary = {
      label: "fixed-fleet",
      stamp: "20260101T000000Z",
      count: 10,
      concurrency: 4,
      reportsDir,
      report_schema_version: 2,
      play_mode: "pure",
      start_surface: "fresh_overworld",
      retention_contract_eligible: true,
      retention_eligible_verified_runs: 10,
      retention_ineligible_or_unverified_runs: 0,
      session_contract_version: 3,
      baseline_decisions: 40,
      verified: 10,
      "skipped-resume": 0,
      failed: 0,
      total_attempts: 10,
      failed_attempts: 0,
      technical_timeouts: 0,
      report_recovered_runs: 0,
      seed_base: 500,
      model: "sonnet",
      personas: "default",
      target: "overworld",
      resume_enabled: false,
      evidence_schema_version: 2,
      model_attestation_schema_version: 2,
      build,
    };
    writeFileSync(join(fleetDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    // The fleet closes its concurrent results into canonical planned order.
    writeFileSync(
      join(fleetDir, "manifest.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const summaryPath = join(fleetDir, "summary.json");
    const manifestPath = join(fleetDir, "manifest.jsonl");
    const firstPrefix = join(reportsDir, "20260101T000000Z_overworld_seed500");
    const firstReportPath = `${firstPrefix}.md`;
    const firstSidecarPath = `${firstPrefix}.run.json`;
    const firstEvidencePath = `${firstPrefix}.evidence.jsonl`;
    const firstPrimaryEnvelopePath = `${firstPrefix}.json`;
    const firstAttestationPath = `${firstPrefix}.fleet.json`;
    const canonicalSummaryBody = readFileSync(summaryPath, "utf8");
    const canonicalManifestBody = readFileSync(manifestPath, "utf8");
    const canonicalReportBody = readFileSync(firstReportPath, "utf8");
    const canonicalSidecarBody = readFileSync(firstSidecarPath, "utf8");
    const canonicalEvidenceBody = readFileSync(firstEvidencePath, "utf8");
    const canonicalPrimaryEnvelopeBody = readFileSync(firstPrimaryEnvelopePath, "utf8");
    const canonicalAttestationBody = readFileSync(firstAttestationPath, "utf8");

    const rewriteFirstIdentity = (changes: { actualModel?: string; gameSessionId?: string }) => {
      const sidecar = JSON.parse(canonicalSidecarBody) as Record<string, unknown>;
      const evidence = canonicalEvidenceBody
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const primaryEnvelope = JSON.parse(canonicalPrimaryEnvelopeBody) as Record<string, unknown>;
      if (changes.gameSessionId !== undefined) {
        sidecar.session_id = changes.gameSessionId;
        for (const event of evidence) event.session_id = changes.gameSessionId;
      }
      if (changes.actualModel !== undefined) {
        primaryEnvelope.modelUsage = { [changes.actualModel]: {} };
      }
      const sidecarBody = `${JSON.stringify(sidecar, null, 2)}\n`;
      const evidenceBody = `${evidence.map((event) => JSON.stringify(event)).join("\n")}\n`;
      const primaryEnvelopeBody = `${JSON.stringify(primaryEnvelope)}\n`;
      const attestation = {
        ...rows[0]!.model_attestation,
        game_session_id: changes.gameSessionId ?? rows[0]!.model_attestation.game_session_id,
        actual_model: changes.actualModel ?? rows[0]!.model_attestation.actual_model,
        run_sidecar_sha256: sha256Text(sidecarBody),
        run_evidence_sha256: sha256Text(evidenceBody),
        primary_envelope_sha256: sha256Text(primaryEnvelopeBody),
      };
      writeFileSync(firstSidecarPath, sidecarBody);
      writeFileSync(firstEvidencePath, evidenceBody);
      writeFileSync(firstPrimaryEnvelopePath, primaryEnvelopeBody);
      writeFileSync(firstAttestationPath, `${JSON.stringify(attestation, null, 2)}\n`);
      writeFileSync(
        manifestPath,
        `${rows
          .map((row, index) => (index === 0 ? { ...row, model_attestation: attestation } : row))
          .map((row) => JSON.stringify(row))
          .join("\n")}\n`,
      );
    };
    const restoreFirstIdentity = () => {
      writeFileSync(firstSidecarPath, canonicalSidecarBody);
      writeFileSync(firstEvidencePath, canonicalEvidenceBody);
      writeFileSync(firstPrimaryEnvelopePath, canonicalPrimaryEnvelopeBody);
      writeFileSync(firstAttestationPath, canonicalAttestationBody);
      writeFileSync(manifestPath, canonicalManifestBody);
    };
    const rewriteFirstReceipt = (
      nextReceipt: ReturnType<typeof currentReceipt> | ReturnType<typeof currentDeathReceipt>,
    ) => {
      const reportBody = reportText(nextReceipt);
      const sidecar = {
        ...(JSON.parse(canonicalSidecarBody) as Record<string, unknown>),
        receipt: nextReceipt,
      };
      const evidence = canonicalEvidenceBody
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      evidence[1]!.receipt = nextReceipt;
      const primaryEnvelope = {
        ...(JSON.parse(canonicalPrimaryEnvelopeBody) as Record<string, unknown>),
        result: reportBody,
      };
      const sidecarBody = `${JSON.stringify(sidecar, null, 2)}\n`;
      const evidenceBody = `${evidence.map((event) => JSON.stringify(event)).join("\n")}\n`;
      const primaryEnvelopeBody = `${JSON.stringify(primaryEnvelope)}\n`;
      const attestation = {
        ...rows[0]!.model_attestation,
        receipt_hash: nextReceipt.receiptHash,
        report_sha256: sha256Text(reportBody),
        run_sidecar_sha256: sha256Text(sidecarBody),
        run_evidence_sha256: sha256Text(evidenceBody),
        primary_envelope_sha256: sha256Text(primaryEnvelopeBody),
      };
      const firstRow = {
        ...rows[0]!,
        accepted_decisions: nextReceipt.acceptedDecisions,
        retention_choices: nextReceipt.retentionHistory,
        checkpoint: nextReceipt.checkpoint,
        exit_reason: nextReceipt.exitReason,
        exit_reasons: nextReceipt.exitReasons,
        receipt_hash: nextReceipt.receiptHash,
        model_attestation: attestation,
      };
      writeFileSync(firstReportPath, reportBody);
      writeFileSync(firstSidecarPath, sidecarBody);
      writeFileSync(firstEvidencePath, evidenceBody);
      writeFileSync(firstPrimaryEnvelopePath, primaryEnvelopeBody);
      writeFileSync(firstAttestationPath, `${JSON.stringify(attestation, null, 2)}\n`);
      writeFileSync(
        manifestPath,
        `${rows
          .map((row, index) => (index === 0 ? firstRow : row))
          .map((row) => JSON.stringify(row))
          .join("\n")}\n`,
      );
    };

    const certified = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(certified.validity_errors).toEqual([]);
    expect(certified.schema_version).toBe(2);
    expect(certified.valid).toBe(true);
    expect(certified.metrics).toMatchObject({
      total_runs: 10,
      evaluated_runs: 10,
      completed_runs: 10,
    });
    expect(certified.pilot_passed).toBe(true);
    expect(certified.authority_certified).toBe(false);
    expect(certified.cohort_kind).toBe("pilot");
    expect(certified.authenticated_actual_model).toBe("claude-sonnet-4-5-20260716");
    expect(certified.certified_build).toEqual(build);

    const duplicateSummaryBody = canonicalSummaryBody.replace(
      "{\n",
      '{\n  "receipt_bound_runs": 1,\n  "receipt_bound_runs": 0,\n',
    );
    writeFileSync(summaryPath, duplicateSummaryBody);
    const rejectedDuplicateSummary = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedDuplicateSummary.validity_errors.join("\n")).toMatch(
      /duplicate JSON object key "receipt_bound_runs"/i,
    );
    writeFileSync(summaryPath, canonicalSummaryBody);

    const manifestLines = canonicalManifestBody.trimEnd().split(/\r?\n/u);
    manifestLines[0] = manifestLines[0]!.replace(
      "{",
      '{"report_receipt_bound":true,"report_receipt_bound":false,',
    );
    writeFileSync(manifestPath, `${manifestLines.join("\n")}\n`);
    const rejectedDuplicateManifest = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedDuplicateManifest.validity_errors.join("\n")).toMatch(
      /manifest row 1.*duplicate JSON object key "report_receipt_bound"/i,
    );
    writeFileSync(manifestPath, canonicalManifestBody);

    rewriteFirstReceipt(currentDeathReceipt());
    const rejectedCharacterDeath = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    const deathErrors = rejectedCharacterDeath.validity_errors.join("\n");
    expect(deathErrors).toContain(
      "character-death receipt is valid blind evidence but cannot certify the starting slice",
    );
    expect(deathErrors).not.toContain("authenticated run artifacts invalid");
    expect(deathErrors).not.toContain("report verification failed");
    restoreFirstIdentity();
    writeFileSync(firstReportPath, canonicalReportBody);

    const authorityIsolation = certifyStartingSliceAuthority({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(authorityIsolation.authority_certified).toBe(false);
    expect(authorityIsolation.expected_count).toBe(100);
    expect(authorityIsolation.validity_errors.join("\n")).toContain(
      "summary count 10 != expected 100",
    );

    writeFileSync(summaryPath, `${JSON.stringify({ ...summary, model: "mix" }, null, 2)}\n`);
    writeFileSync(
      manifestPath,
      `${rows
        .map((row, index) => (index < 9 ? { ...row, model: "haiku" } : row))
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    const rejectedLegacyMix = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedLegacyMix.valid).toBe(false);
    expect(rejectedLegacyMix.validity_errors.join("\n")).toContain("summary.json invalid: model");
    writeFileSync(summaryPath, canonicalSummaryBody);
    writeFileSync(manifestPath, canonicalManifestBody);

    const oneHaikuRow = rows.map((row, index) => (index === 0 ? { ...row, model: "haiku" } : row));
    writeFileSync(manifestPath, `${oneHaikuRow.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const rejectedHaikuRow = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedHaikuRow.validity_errors.join("\n")).toContain(
      "requested model haiku != summary model sonnet",
    );
    writeFileSync(manifestPath, canonicalManifestBody);

    rewriteFirstIdentity({ actualModel: "claude-sonnet-4-5-20260717" });
    const rejectedActualModelMix = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedActualModelMix.authenticated_actual_model).toBeNull();
    expect(rejectedActualModelMix.validity_errors.join("\n")).toContain(
      "must use one exact actual_model string",
    );
    restoreFirstIdentity();

    rewriteFirstIdentity({
      gameSessionId: rows[1]!.model_attestation.game_session_id,
    });
    const rejectedDuplicateGameSession = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedDuplicateGameSession.validity_errors.join("\n")).toContain(
      "game session ID session-501 is reused by another fleet slot",
    );
    restoreFirstIdentity();

    const failedAttemptLog = "attempt=1\nclassification=technical_timeout\nrun.sh exit=124\n";
    const failedAttemptDir = join(fleetDir, "attempts", "seed_500", "attempt_1");
    mkdirSync(failedAttemptDir, { recursive: true });
    writeFileSync(join(failedAttemptDir, "fleet-diagnostic.log"), failedAttemptLog);
    const retryRows = rows.map((row, index) =>
      index === 0
        ? {
            ...row,
            attempts: 2,
            attempt_history: [
              {
                attempt: 1,
                exit: 124,
                classification: "technical_timeout",
                report_recovered: false,
                archive: {
                  directory: "attempts/seed_500/attempt_1",
                  artifacts: [
                    {
                      name: "fleet-diagnostic.log",
                      bytes: Buffer.byteLength(failedAttemptLog),
                      sha256: sha256Text(failedAttemptLog),
                    },
                  ],
                },
              },
              {
                attempt: 2,
                exit: 0,
                classification: "verified",
                report_recovered: false,
                archive: null,
              },
            ],
          }
        : row,
    );
    writeFileSync(manifestPath, `${retryRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    writeFileSync(
      summaryPath,
      `${JSON.stringify(
        {
          ...summary,
          total_attempts: 11,
          failed_attempts: 1,
          technical_timeouts: 1,
        },
        null,
        2,
      )}\n`,
    );
    const rejectedRetryHistory = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedRetryHistory.valid).toBe(false);
    expect(rejectedRetryHistory.validity_errors.join("\n")).toContain(
      "summary contains 1 failed attempts",
    );
    expect(rejectedRetryHistory.validity_errors.join("\n")).toContain(
      "pilot row must contain exactly one launcher attempt",
    );

    writeFileSync(summaryPath, canonicalSummaryBody);
    const rejectedHiddenRetry = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedHiddenRetry.validity_errors.join("\n")).toContain(
      "manifest failed attempts 1 != summary 0",
    );
    rmSync(join(fleetDir, "attempts"), { recursive: true, force: true });
    writeFileSync(manifestPath, canonicalManifestBody);

    const recoveryMarkerPath = `${firstPrefix}.initial-report.txt`;
    writeFileSync(recoveryMarkerPath, "Rejected initial response retained byte-for-byte.\n");
    const rejectedUndeclaredRecovery = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedUndeclaredRecovery.validity_errors.join("\n")).toContain(
      "report recovery artifacts must be all present or all absent",
    );
    const recoveredRows = rows.map((row, index) =>
      index === 0
        ? {
            ...row,
            report_recovered: true,
            attempt_history: row.attempt_history.map((attempt) => ({
              ...attempt,
              report_recovered: true,
            })),
          }
        : row,
    );
    writeFileSync(manifestPath, `${recoveredRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    writeFileSync(
      summaryPath,
      `${JSON.stringify({ ...summary, report_recovered_runs: 1 }, null, 2)}\n`,
    );
    const rejectedMarkerOnlyRecovery = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedMarkerOnlyRecovery.validity_errors.join("\n")).toContain(
      "report recovery artifacts must be all present or all absent",
    );
    unlinkSync(recoveryMarkerPath);
    writeFileSync(summaryPath, canonicalSummaryBody);
    writeFileSync(manifestPath, canonicalManifestBody);

    const originalRecoveredReportBody = `# Blind report

## Playthrough log

I played naturally until the game offered its checkpoint and then ended.

## Did it work mechanically?

Yes. The game tools and state transitions worked throughout.

## Understandable & fun?

Clarity 5/5 and enjoyment 5/5.

## Confusion / friction points

None.

## Bugs or design flaws

None found.

## Verdict

The opening worked and invited continuation.
`;
    const recoverySubjective = {
      clarity: 5,
      enjoyment: 5,
      goal_understood: true,
      got_stuck: false,
      confusions: [],
      bugs: [],
      best_moment: "The first crisis exposed a meaningful strategy choice.",
      worst_moment: "One transition carried more text than expected.",
      would_replay: true,
      verdict: "The bounded opening was coherent and I would continue into another lead.",
    };
    const primaryForRecovery = {
      ...(JSON.parse(canonicalPrimaryEnvelopeBody) as Record<string, unknown>),
      result: originalRecoveredReportBody,
    };
    const recoveredPrimaryEnvelopeBody = `${JSON.stringify(primaryForRecovery)}\n`;
    const recoveryMetadata = {
      schema_version: 1,
      recovery_count: 1,
      claude_session_id: rows[0]!.model_attestation.claude_session_id,
      requested_model: rows[0]!.model,
      model_usage_key: rows[0]!.model_attestation.actual_model,
      run_seed: rows[0]!.seed,
      build,
      ratings: { clarity: 5, enjoyment: 5 },
      initial_report_sha256: sha256Text(originalRecoveredReportBody),
      primary_envelope_sha256: sha256Text(recoveredPrimaryEnvelopeBody),
      run_evidence_sha256: sha256Text(canonicalEvidenceBody),
    } as const;
    const recoveryMetadataBody = `${JSON.stringify(recoveryMetadata, null, 2)}\n`;
    const recoveryEnvelopeBody = `${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: rows[0]!.model_attestation.claude_session_id,
      result: JSON.stringify(recoverySubjective),
      structured_output: recoverySubjective,
      stop_reason: "tool_use",
      terminal_reason: "completed",
      permission_denials: [],
      modelUsage: { [rows[0]!.model_attestation.actual_model]: {} },
    })}\n`;
    const recoveredReport = extractRecoveredReport({
      recoveryEnvelopeBytes: Buffer.from(recoveryEnvelopeBody, "utf8"),
      primaryEnvelopeBytes: Buffer.from(recoveredPrimaryEnvelopeBody, "utf8"),
      originalReportBytes: Buffer.from(originalRecoveredReportBody, "utf8"),
      runEvidenceBytes: Buffer.from(canonicalEvidenceBody, "utf8"),
      metadata: recoveryMetadata,
    });
    expect(recoveredReport.ok).toBe(true);
    if (!recoveredReport.ok) throw new Error(recoveredReport.reason);
    const recoveredReportBody = Buffer.from(recoveredReport.reportBytes).toString("utf8");
    const recoveredAttestation = {
      ...rows[0]!.model_attestation,
      report_recovered: true,
      report_sha256: sha256Text(recoveredReportBody),
      primary_envelope_sha256: sha256Text(recoveredPrimaryEnvelopeBody),
      initial_report_sha256: sha256Text(originalRecoveredReportBody),
      recovery_metadata_sha256: sha256Text(recoveryMetadataBody),
      recovery_envelope_sha256: sha256Text(recoveryEnvelopeBody),
    };
    const authenticatedRecoveredRows = rows.map((row, index) =>
      index === 0
        ? {
            ...row,
            report_recovered: true,
            attempt_history: row.attempt_history.map((attempt) => ({
              ...attempt,
              report_recovered: true,
            })),
            model_attestation: recoveredAttestation,
          }
        : row,
    );
    const recoveryMetadataPath = `${firstPrefix}.repair.meta.json`;
    const recoveryEnvelopePath = `${firstPrefix}.repair.json`;
    writeFileSync(firstReportPath, recoveredReportBody);
    writeFileSync(firstPrimaryEnvelopePath, recoveredPrimaryEnvelopeBody);
    writeFileSync(recoveryMarkerPath, originalRecoveredReportBody);
    writeFileSync(recoveryMetadataPath, recoveryMetadataBody);
    writeFileSync(recoveryEnvelopePath, recoveryEnvelopeBody);
    writeFileSync(firstAttestationPath, `${JSON.stringify(recoveredAttestation, null, 2)}\n`);
    writeFileSync(
      manifestPath,
      `${authenticatedRecoveredRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    writeFileSync(
      summaryPath,
      `${JSON.stringify({ ...summary, report_recovered_runs: 1 }, null, 2)}\n`,
    );
    const rejectedAuthenticatedRecovery = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    const recoveredErrors = rejectedAuthenticatedRecovery.validity_errors.join("\n");
    expect(rejectedAuthenticatedRecovery.valid).toBe(false);
    expect(recoveredErrors).toContain("pilot cohort requires primary reports");
    expect(recoveredErrors).toContain("does not accept a report-recovered row");
    expect(recoveredErrors).toContain("does not accept report-recovery artifacts");
    expect(recoveredErrors).toContain("does not accept a report-recovered attestation");
    expect(recoveredErrors).toContain("does not accept authenticated report-recovery facts");
    expect(recoveredErrors).not.toContain("authenticated run artifacts invalid");
    writeFileSync(firstReportPath, canonicalReportBody);
    writeFileSync(firstPrimaryEnvelopePath, canonicalPrimaryEnvelopeBody);
    writeFileSync(firstAttestationPath, canonicalAttestationBody);
    unlinkSync(recoveryMarkerPath);
    unlinkSync(recoveryMetadataPath);
    unlinkSync(recoveryEnvelopePath);
    writeFileSync(summaryPath, canonicalSummaryBody);
    writeFileSync(manifestPath, canonicalManifestBody);

    writeFileSync(
      summaryPath,
      `${JSON.stringify({ ...summary, resume_enabled: true }, null, 2)}\n`,
    );
    const rejectedResumableCohort = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedResumableCohort.validity_errors.join("\n")).toContain(
      "pilot cohort requires --no-resume",
    );
    writeFileSync(summaryPath, canonicalSummaryBody);

    const relabeledRows = rows.map((row, index) =>
      index === 0
        ? { ...row, report: join(reportsDir, "20251231T235959Z_overworld_seed500.md") }
        : row,
    );
    writeFileSync(manifestPath, `${relabeledRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const rejectedHistoricalBasename = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedHistoricalBasename.validity_errors.join("\n")).toContain(
      "fresh cohort basename",
    );
    writeFileSync(manifestPath, canonicalManifestBody);

    const canonicalPrimaryEnvelope = JSON.parse(canonicalPrimaryEnvelopeBody) as Record<
      string,
      unknown
    >;
    const actualModel = rows[0]!.model_attestation.actual_model;
    const rejectedPrimaryEnvelopes = [
      {
        envelope: {
          ...canonicalPrimaryEnvelope,
          modelUsage: { "claude-haiku-4-5-20260716": {} },
        },
        reason: "does not match planned model",
      },
      {
        envelope: {
          ...canonicalPrimaryEnvelope,
          modelUsage: { [actualModel]: {}, "claude-haiku-second": {} },
        },
        reason: "must contain exactly one model",
      },
      {
        envelope: {
          ...canonicalPrimaryEnvelope,
          permission_denials: [{ tool_name: "AdventureForge" }],
        },
        reason: "completed clean turn",
      },
    ];
    for (const candidate of rejectedPrimaryEnvelopes) {
      writeFileSync(firstPrimaryEnvelopePath, `${JSON.stringify(candidate.envelope)}\n`);
      const rejectedEnvelope = validateStartingSlicePilot({
        root: ROOT,
        fleetDir,
        expectedBuild: build,
      });
      expect(rejectedEnvelope.validity_errors.join("\n")).toContain(candidate.reason);
    }
    writeFileSync(firstPrimaryEnvelopePath, canonicalPrimaryEnvelopeBody);

    writeFileSync(
      firstEvidencePath,
      canonicalEvidenceBody.replace('"run_seed":500', '"run_seed":999'),
    );
    const rejectedEvidenceTamper = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedEvidenceTamper.validity_errors.join("\n")).toContain(
      "run evidence fresh_start and journey_exit seeds differ",
    );
    writeFileSync(firstEvidencePath, canonicalEvidenceBody);

    const secondPrefix = join(reportsDir, "20260101T000000Z_overworld_seed501");
    const secondPrimaryEnvelopePath = `${secondPrefix}.json`;
    const secondAttestationPath = `${secondPrefix}.fleet.json`;
    const canonicalSecondPrimaryEnvelopeBody = readFileSync(secondPrimaryEnvelopePath, "utf8");
    const canonicalSecondAttestationBody = readFileSync(secondAttestationPath, "utf8");
    const duplicatedPrimaryEnvelopeBody = `${JSON.stringify({
      ...(JSON.parse(canonicalSecondPrimaryEnvelopeBody) as Record<string, unknown>),
      session_id: rows[0]!.model_attestation.claude_session_id,
    })}\n`;
    const duplicatedAttestation = {
      ...rows[1]!.model_attestation,
      claude_session_id: rows[0]!.model_attestation.claude_session_id,
      primary_envelope_sha256: sha256Text(duplicatedPrimaryEnvelopeBody),
    };
    writeFileSync(secondPrimaryEnvelopePath, duplicatedPrimaryEnvelopeBody);
    writeFileSync(secondAttestationPath, `${JSON.stringify(duplicatedAttestation, null, 2)}\n`);
    const duplicatedSessionRows = rows.map((row, index) =>
      index === 1 ? { ...row, model_attestation: duplicatedAttestation } : row,
    );
    writeFileSync(
      manifestPath,
      `${duplicatedSessionRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const rejectedDuplicateClaudeSession = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedDuplicateClaudeSession.validity_errors.join("\n")).toContain(
      "is reused by another fleet slot",
    );
    writeFileSync(secondPrimaryEnvelopePath, canonicalSecondPrimaryEnvelopeBody);
    writeFileSync(secondAttestationPath, canonicalSecondAttestationBody);
    writeFileSync(manifestPath, canonicalManifestBody);

    const tamperedReportBody = canonicalReportBody
      .replace('"clarity": 5', '"clarity": 4')
      .replace(
        '"bugs": []',
        '"bugs": [{"where":"wolf_winter","severity":"S0","note":"Digest test."}]',
      );
    writeFileSync(firstReportPath, tamperedReportBody);
    const rejectedReportDigest = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedReportDigest.valid).toBe(false);
    expect(rejectedReportDigest.validity_errors.join("\n")).toContain(
      "primary Claude result bytes do not equal the final report",
    );
    expect(rejectedReportDigest.validity_errors.join("\n")).not.toContain(
      "report verification failed",
    );
    writeFileSync(firstReportPath, canonicalReportBody);

    const changedOutcomes = [["wolf_winter", "ending_held_timber_saved"]];
    const changedSidecar = {
      ...(JSON.parse(canonicalSidecarBody) as Record<string, unknown>),
      quest_outcomes: changedOutcomes,
    };
    const changedRows = rows.map((row, index) =>
      index === 0 ? { ...row, quest_outcomes: changedOutcomes } : row,
    );
    writeFileSync(firstSidecarPath, `${JSON.stringify(changedSidecar, null, 2)}\n`);
    writeFileSync(manifestPath, `${changedRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const rejectedSidecarDigest = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedSidecarDigest.valid).toBe(false);
    expect(rejectedSidecarDigest.validity_errors.join("\n")).toContain(
      "raw run evidence does not reproduce the adjacent run sidecar",
    );
    expect(rejectedSidecarDigest.validity_errors.join("\n")).not.toContain(
      "sidecar quest outcomes differ from manifest row",
    );
    writeFileSync(firstSidecarPath, canonicalSidecarBody);
    writeFileSync(manifestPath, canonicalManifestBody);

    const tampered = {
      ...JSON.parse(
        // Deliberately reopen the first adjacent sidecar, then break its private seed.
        JSON.stringify({
          schema_version: 2,
          report_schema_version: 2,
          play_mode: "pure",
          start_surface: "fresh_overworld",
          retention_eligible: true,
          evidence_status: "verified",
          session_id: "session-500",
          run_seed: 999,
          build,
          quest_outcomes: [["wolf_winter", outcomes[0]]],
          receipt,
        }),
      ),
    };
    writeFileSync(firstSidecarPath, `${JSON.stringify(tampered, null, 2)}\n`);
    const rejected = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejected.valid).toBe(false);
    expect(rejected.validity_errors.join("\n")).toContain(
      "raw run evidence does not reproduce the adjacent run sidecar",
    );

    writeFileSync(firstSidecarPath, `${JSON.stringify({ ...tampered, run_seed: 500 }, null, 2)}\n`);
    writeFileSync(
      firstAttestationPath,
      `${JSON.stringify({ ...rows[0]!.model_attestation, model: "haiku" }, null, 2)}\n`,
    );
    const rejectedModel = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedModel.valid).toBe(false);
    expect(rejectedModel.validity_errors.join("\n")).toContain(
      "adjacent model attestation differs from manifest row",
    );
    expect(rejectedModel.validity_errors.join("\n")).toContain(
      "model attestation model differs from planned row model",
    );

    writeFileSync(firstReportPath, canonicalReportBody);
    writeFileSync(firstSidecarPath, canonicalSidecarBody);
    writeFileSync(firstAttestationPath, canonicalAttestationBody);
    writeFileSync(manifestPath, canonicalManifestBody);
    for (const unsafeLabel of ["../escape", "CON", "line\nbreak", "ansi\u001bname"]) {
      writeFileSync(
        summaryPath,
        `${JSON.stringify({ ...summary, label: unsafeLabel }, null, 2)}\n`,
      );
      const rejectedLabel = validateStartingSlicePilot({
        root: ROOT,
        fleetDir,
        expectedBuild: build,
      });
      expect(rejectedLabel.valid).toBe(false);
      expect(rejectedLabel.validity_errors.join("\n")).toContain("unsafe or reserved fleet label");
    }
    writeFileSync(summaryPath, `${JSON.stringify({ ...summary, label: "other-safe" }, null, 2)}\n`);
    const rejectedUnboundLabel = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedUnboundLabel.validity_errors.join("\n")).toContain(
      "does not exactly match fleet directory",
    );
    expect(rejectedUnboundLabel.fleet?.label).toBe("invalid-fleet-label");
    expect(startingSliceFleetDisplayName(rejectedUnboundLabel)).toBe("invalid-fleet-label");
    writeFileSync(summaryPath, canonicalSummaryBody);

    const outsideReport = join(base, "outside-report.md");
    writeFileSync(outsideReport, canonicalReportBody);
    unlinkSync(firstReportPath);
    let symlinkSupported = true;
    try {
      symlinkSync(outsideReport, firstReportPath, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") symlinkSupported = false;
      else throw error;
    }
    if (symlinkSupported) {
      const rejectedSymlink = validateStartingSlicePilot({
        root: ROOT,
        fleetDir,
        expectedBuild: build,
      });
      expect(rejectedSymlink.validity_errors.join("\n")).toContain(
        "report must not be a symbolic link",
      );
      unlinkSync(firstReportPath);
    }
    linkSync(outsideReport, firstReportPath);
    const rejectedHardlink = validateStartingSlicePilot({
      root: ROOT,
      fleetDir,
      expectedBuild: build,
    });
    expect(rejectedHardlink.validity_errors.join("\n")).toContain(
      "report must not have multiple hard links",
    );
  });
});

describe("certification artifact publication", () => {
  it("never follows symlink or hardlink outputs and atomically replaces a regular file", () => {
    const base = mkdtempSync(join(tmpdir(), "af-slice-output-"));
    tempDirs.push(base);
    const fleetDir = join(base, "fleet");
    mkdirSync(fleetDir);
    const victim = join(base, "victim.json");
    const output = join(fleetDir, "starting-slice-certification.json");
    writeFileSync(victim, "do not truncate\n");

    let symlinkSupported = true;
    try {
      symlinkSync(victim, output, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") symlinkSupported = false;
      else throw error;
    }
    if (symlinkSupported) {
      expect(() => writeCertificationArtifactSafely(fleetDir, { valid: false })).toThrow(
        /must not be a symbolic link/i,
      );
      expect(readFileSync(victim, "utf8")).toBe("do not truncate\n");
      unlinkSync(output);
    }

    linkSync(victim, output);
    expect(() => writeCertificationArtifactSafely(fleetDir, { valid: false })).toThrow(
      /must not have multiple hard links/i,
    );
    expect(readFileSync(victim, "utf8")).toBe("do not truncate\n");
    unlinkSync(output);

    writeFileSync(output, "old result\n");
    expect(writeCertificationArtifactSafely(fleetDir, { valid: true })).toBe(output);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ valid: true });
    expect(readdirSync(fleetDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(victim, "utf8")).toBe("do not truncate\n");
  });
});
