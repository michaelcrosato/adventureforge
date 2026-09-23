import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { isPureExitInterviewV2, type PureExitInterviewV2 } from "../blind/exit_interview.js";
import { verifyBlindReportText } from "../blind/report_verifier.js";
import { parseJsonRejectingDuplicateKeys } from "../blind/strict_json.js";
import {
  CanonicalQuestOutcomesSchema,
  parseBlindRunSidecar,
  PureRunBuildSchema,
} from "../blind/run_evidence.js";
import { prepareShippedQuest } from "../crawl/prepare.js";
import { clusterIssues, type IssueRecord, type IssueSeverity } from "../feedback/cluster.js";
import {
  buildLocationIndex,
  canonicalizeLocation,
  type LocationIndex,
} from "../feedback/normalize.js";
import type { CanonicalLocation } from "../feedback/schema.js";
import {
  HISTORICAL_CLIENT_BOUND_CODEX_ATTESTATION_SCHEMA_VERSION,
  HISTORICAL_TRANSPORT_CODEX_ATTESTATION_SCHEMA_VERSION,
  PURE_FLEET_CODE_MODE_CONTRACT,
  PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION,
  parsePureFleetAttestation,
  PureFleetAttestationSchema,
  pureFleetAttestationPathFor,
} from "./fleet_attestation.js";
import { capturePureFleetBuild } from "./fleet_build.js";
import {
  pureFleetRunArtifactPaths,
  SPARK_DIRECT_MCP_MODEL,
  SPARK_DIRECT_MCP_TRANSPORT_CONTRACT,
  validatePureFleetRunArtifactBytes,
} from "./fleet_run_artifacts.js";
import { certifiedFleetModels, certifiedModelTransport } from "../blind/providers.js";
import { WOLF_WINTER_CAMPAIGN_OUTCOMES } from "../world/journey_campaign.js";
import { INITIAL_JOURNEY_GOAL } from "../world/journey_contract.js";
import { loadOverworldManifest } from "../world/source.js";
// @ts-expect-error -- hardened runner accounting module is intentionally plain ESM.
import * as fleetUsage from "../../blind-tester/fleet-usage.mjs";
const {
  skippedResumeUsageRecord,
  summarizeFleetUsage,
  usageRecordFromFailedAttempt,
  usageRecordFromVerifiedPrimaryEnvelope,
} = fleetUsage;

const STARTING_SLICE_CERTIFICATION_SCHEMA_VERSION = 2 as const;
const STARTING_SLICE_AUTHORITY_COUNT = 100 as const;
const STARTING_SLICE_PILOT_COUNT = 10 as const;
const STARTING_SLICE_INITIAL_GOAL = Object.freeze({
  version: INITIAL_JOURNEY_GOAL.version,
  id: INITIAL_JOURNEY_GOAL.id,
});

export type WolfStrategy =
  | "hunt_and_hold"
  | "lure_and_divert"
  | "drive_and_evacuate"
  | "fortify_and_outlast";
type WolfStrategyVariant =
  | "clean_diversion"
  | "cattle_scattered"
  | "hybrid_recovery"
  | "bloodied_evacuation"
  | "cattle_wounded"
  | "people_saved_cattle_lost"
  | "reserve_spent"
  | "cade_terms"
  | "albany_authority"
  | "gate_barred"
  | "timber_saved"
  | "line_held";

type WolfEndingId = keyof typeof WOLF_WINTER_CAMPAIGN_OUTCOMES;

/**
 * The certification taxonomy is deliberately explicit. Adding a campaign
 * outcome to the world contract is a compile error here until its strategy is
 * classified; removing one is an excess-property error. The mixed
 * after-blood recovery remains a lure result for top-level diversity while
 * retaining its distinct diagnostic tag.
 */
export const WOLF_WINTER_STRATEGY_BY_ENDING = Object.freeze({
  ending_pack_diverted: { strategy: "lure_and_divert", variant: "clean_diversion" },
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
} as const satisfies Record<
  WolfEndingId,
  Readonly<{ strategy: WolfStrategy; variant: WolfStrategyVariant }>
>);

type PureRunBuild = z.infer<typeof PureRunBuildSchema>;
type CanonicalQuestOutcomes = z.infer<typeof CanonicalQuestOutcomesSchema>;

export interface StartingSliceIssueInput {
  where: string;
  severity: IssueSeverity;
  note: string;
}

export interface StartingSliceGoalCompletionInput {
  version: number;
  id: string;
  completed_at_decision: number;
}

export interface StartingSliceGoalRetentionInput {
  goal_version: number | null;
  goal_id: string | null;
  at_decision: number;
  reasons: readonly ("checkpoint" | "goal_completed")[];
  choice: "continue" | "end";
}

/** A server-authored report after evidence authentication and schema re-verification. */
export interface StartingSliceEvaluationRun {
  ref: string;
  wolf_outcome: string | null;
  initial_goal_completion: StartingSliceGoalCompletionInput | null;
  initial_goal_retention: StartingSliceGoalRetentionInput | null;
  clarity: number;
  enjoyment: number;
  got_stuck: boolean;
  issues: readonly StartingSliceIssueInput[];
}

interface StartingSliceEvaluationOptions {
  root: string;
  runs: readonly StartingSliceEvaluationRun[];
  /** Defaults to runs.length. The filesystem path fixes this to the planned fleet count. */
  expectedCount?: number;
}

interface StartingSliceMetrics {
  total_runs: number;
  evaluated_runs: number;
  completed_runs: number;
  incomplete_runs: number;
  completion_decision_p50: number | null;
  stuck_runs: number;
  clarity_total: number;
  enjoyment_total: number;
  continued_after_initial_goal: number;
  completed_runs_with_continuation_choice: number;
  strategies_represented: number;
  largest_strategy_count: number;
  in_scope_issue_reports: number;
}

/**
 * The typical-first-goal decision budget the completion p50 must clear.
 *
 * This threshold is DECLARED in docs/starting_slice_causal_matrix.json as
 * `contract.maximum_typical_first_goal_decisions`, and the certifier used to carry an
 * unlinked copy of it as a bare `45` in the gate expression below. Two numbers, one
 * contract, no cross-check: tightening the matrix's budget left the gate at 45 and the
 * slice would still certify against the looser bar it no longer declared. Naming it
 * gives the drift somewhere to be caught — tests/unit/starting_slice_causal_matrix.test.ts
 * pins this constant against the matrix, so the two can no longer disagree quietly.
 * (Note the gate KEY, `completion_p50_at_most_45_decisions`, is part of the published
 * certification JSON shape; changing the budget means renaming it too, deliberately.)
 */
export const STARTING_SLICE_MAX_TYPICAL_FIRST_GOAL_DECISIONS = 45;

interface StartingSliceGates {
  completion_at_least_90_percent: boolean;
  completion_p50_at_most_45_decisions: boolean;
  got_stuck_at_most_5_percent: boolean;
  clarity_average_at_least_4_2: boolean;
  enjoyment_average_at_least_4_2: boolean;
  initial_goal_continuation_at_least_70_percent: boolean;
  at_least_3_top_level_strategies: boolean;
  no_strategy_above_75_percent: boolean;
  no_in_scope_s3_or_s4: boolean;
  no_in_scope_s2_cluster_at_or_above_5_percent: boolean;
}

interface StartingSliceBlockingCluster {
  key: string;
  max_severity: IssueSeverity;
  affected_reports: number;
  report_refs: string[];
  issue_mentions: number;
  location: CanonicalLocation;
  tokens: string[];
}

interface StartingSliceFleetIdentity {
  label: string;
  stamp: string;
  fleet_dir: string;
  reports_dir: string;
  manifest_rows: number;
}

interface StartingSliceCertificationResult {
  schema_version: typeof STARTING_SLICE_CERTIFICATION_SCHEMA_VERSION;
  valid: boolean;
  passed: boolean;
  fleet: StartingSliceFleetIdentity | null;
  certified_build: PureRunBuild | null;
  /** Exact primary-envelope model id when all authenticated rows agree. */
  authenticated_actual_model: string | null;
  validity_errors: string[];
  gate_failures: (keyof StartingSliceGates)[];
  metrics: StartingSliceMetrics;
  gates: StartingSliceGates;
  strategy_counts: Record<WolfStrategy, number>;
  blocking_issue_clusters: StartingSliceBlockingCluster[];
}

interface StartingSliceFleetPathOptions {
  root: string;
  fleetDir: string;
}

type CertifyStartingSliceAuthorityOptions = StartingSliceFleetPathOptions;

type ValidateStartingSlicePilotOptions = StartingSliceFleetPathOptions;

interface StartingSlicePilotGates {
  all_10_recognized_wolf_outcomes: boolean;
  at_least_3_top_level_strategies: boolean;
  no_strategy_above_7_of_10: boolean;
}

interface StartingSlicePilotEvaluation {
  evaluation: StartingSliceCertificationResult;
  pilot_passed: boolean;
  pilot_gate_failures: (keyof StartingSlicePilotGates)[];
  pilot_gates: StartingSlicePilotGates;
}

interface StartingSliceAuthorityResult extends StartingSliceCertificationResult {
  cohort_kind: "authority";
  expected_count: typeof STARTING_SLICE_AUTHORITY_COUNT;
  authority_certified: boolean;
}

interface StartingSlicePilotResult extends StartingSliceCertificationResult {
  cohort_kind: "pilot";
  expected_count: typeof STARTING_SLICE_PILOT_COUNT;
  authority_certified: false;
  pilot_passed: boolean;
  pilot_gate_failures: (keyof StartingSlicePilotGates)[];
  pilot_gates: StartingSlicePilotGates;
}

const CodexClientStableIdentitySchema = z
  .object({
    device_id: z.string().regex(/^[0-9]+$/),
    file_id: z.string().regex(/^[0-9]+$/),
    size: z.string().regex(/^[0-9]+$/),
    mtime_ns: z.string().regex(/^[0-9]+$/),
    ctime_ns: z.string().regex(/^[0-9]+$/),
  })
  .strict();

const CodexClientFileIdentitySchema = z
  .object({
    canonical_path: z
      .string()
      .min(1)
      .refine((path) => !/[\r\n]/u.test(path), "canonical path must occupy one line"),
    identity: CodexClientStableIdentitySchema,
  })
  .strict();

const CodexClientSymlinkIdentitySchema = z
  .object({
    path: z
      .string()
      .min(1)
      .refine((path) => !/[\r\n]/u.test(path), "symlink path must occupy one line"),
    link_target: z
      .string()
      .min(1)
      .refine((target) => !/[\r\n]/u.test(target), "symlink target must occupy one line"),
    identity: CodexClientStableIdentitySchema,
  })
  .strict();

const CodexClientAuthorityTokenSchema = z
  .object({
    schema_version: z.literal(2),
    launcher_kind: z.enum(["direct", "official_npm_shim"]),
    selected: CodexClientFileIdentitySchema,
    selected_symlink: CodexClientSymlinkIdentitySchema.nullable(),
    package_manifest: CodexClientFileIdentitySchema.nullable(),
    javascript_entrypoint: CodexClientFileIdentitySchema.nullable(),
    executable: CodexClientFileIdentitySchema,
    declared_cli_version: z
      .string()
      .regex(
        /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
      )
      .nullable(),
    test_script: z.literal(false),
  })
  .strict();

const CodexClientAuthoritySchema = z
  .object({
    schema_version: z.literal(2),
    launcher_kind: z.enum(["direct", "official_npm_shim"]),
    selected_binary: z.string().min(1),
    executable_binary: z.string().min(1),
    authority_token: z.string().regex(/^[0-9A-Za-z_-]{1,65536}$/),
    authority_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    cli_version: z
      .string()
      .regex(
        /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
      ),
    test_script: z.literal(false),
  })
  .strict()
  .superRefine((client, context) => {
    const digest = createHash("sha256").update(client.authority_token, "utf8").digest("hex");
    if (digest !== client.authority_sha256) {
      context.addIssue({
        code: "custom",
        path: ["authority_sha256"],
        message: "Codex client authority digest must bind the exact authority token",
      });
    }
    let decoded: unknown;
    try {
      const bytes = Buffer.from(client.authority_token, "base64url");
      if (bytes.toString("base64url") !== client.authority_token) throw new Error("non-canonical");
      const parsed = parseJsonRejectingDuplicateKeys(
        bytes.toString("utf8"),
        "Codex client authority token",
      );
      if (!parsed.ok) throw new Error(parsed.reason);
      decoded = parsed.value;
    } catch {
      context.addIssue({
        code: "custom",
        path: ["authority_token"],
        message: "Codex client authority token must be canonical base64url JSON",
      });
      return;
    }
    const authority = CodexClientAuthorityTokenSchema.safeParse(decoded);
    if (!authority.success) {
      context.addIssue({
        code: "custom",
        path: ["authority_token"],
        message: "Codex client authority token does not match its strict schema",
      });
      return;
    }
    const value = authority.data;
    const selectedBinary = value.selected_symlink?.path ?? value.selected.canonical_path;
    const portablePath = (path: string): string => path.replaceAll("\\", "/").replace(/\/+$/u, "");
    const selected = portablePath(value.selected.canonical_path);
    const manifest =
      value.package_manifest === null ? "" : portablePath(value.package_manifest.canonical_path);
    const entrypoint =
      value.javascript_entrypoint === null
        ? ""
        : portablePath(value.javascript_entrypoint.canonical_path);
    const manifestSuffix = "/package.json";
    const packageRoot = manifest.endsWith(manifestSuffix)
      ? manifest.slice(0, -manifestSuffix.length)
      : "";
    const linkPath =
      value.selected_symlink === null ? "" : portablePath(value.selected_symlink.path);
    const linkTarget =
      value.selected_symlink === null ? "" : portablePath(value.selected_symlink.link_target);
    const globalSuffix = "/bin/codex";
    const localSuffix = "/.bin/codex";
    const shellSuffix = "/codex";
    const officialLayout =
      packageRoot.endsWith("/node_modules/@openai/codex") &&
      entrypoint === `${packageRoot}/bin/codex.js` &&
      (value.selected_symlink === null
        ? selected === entrypoint ||
          (selected.endsWith(shellSuffix) &&
            packageRoot === `${selected.slice(0, -shellSuffix.length)}/node_modules/@openai/codex`)
        : selected === entrypoint &&
          linkTarget.endsWith("/@openai/codex/bin/codex.js") &&
          ((linkPath.endsWith(globalSuffix) &&
            packageRoot ===
              `${linkPath.slice(0, -globalSuffix.length)}/lib/node_modules/@openai/codex`) ||
            (linkPath.endsWith(localSuffix) &&
              packageRoot === `${linkPath.slice(0, -localSuffix.length)}/@openai/codex`)));
    if (
      selectedBinary !== client.selected_binary ||
      value.executable.canonical_path !== client.executable_binary ||
      value.launcher_kind !== client.launcher_kind ||
      (value.declared_cli_version !== null && value.declared_cli_version !== client.cli_version) ||
      (value.launcher_kind === "direct" &&
        (value.package_manifest !== null ||
          value.javascript_entrypoint !== null ||
          value.declared_cli_version !== null ||
          !isDeepStrictEqual(value.selected, value.executable))) ||
      (value.launcher_kind === "official_npm_shim" &&
        (value.package_manifest === null ||
          value.javascript_entrypoint === null ||
          value.declared_cli_version === null ||
          !officialLayout))
    ) {
      context.addIssue({
        code: "custom",
        path: ["authority_token"],
        message: "Codex client authority token differs from its fleet summary",
      });
    }
  });

/** V8 summaries deliberately retain only a non-sensitive client fingerprint. */
const CodexClientSummarySchema = z
  .object({
    schema_version: z.literal(2),
    launcher_kind: z.enum(["direct", "official_npm_shim"]),
    authority_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    cli_version: z
      .string()
      .regex(
        /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
      ),
  })
  .strict();

const CODEX_CLIENT_AUTHORITY_PROOF_NAME = "codex-client-authority.private.json";

function codexClientSummaryProjection(
  client: z.infer<typeof CodexClientAuthoritySchema>,
): z.infer<typeof CodexClientSummarySchema> {
  return {
    schema_version: client.schema_version,
    launcher_kind: client.launcher_kind,
    authority_sha256: client.authority_sha256,
    cli_version: client.cli_version,
  };
}

const CodexClientAuthorityProofSchema = z
  .object({
    name: z.literal(CODEX_CLIENT_AUTHORITY_PROOF_NAME),
    bytes: z.number().int().positive().safe(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/**
 * Any model identity this checkout will certify — derived, not listed.
 *
 * This replaces three hand-written `z.enum([...])` lists in this file, and the state
 * they were found in is the argument for deriving them: the three had already drifted
 * out of step with each other. Two omitted `haiku` and the third omitted `opus`, so
 * whether a given certified model was accepted depended on which of three schemas
 * happened to parse the record — a difference nothing in the type system could catch,
 * because each list was independently well-formed.
 *
 * The set now comes from `certifiedFleetModels()`, which answers from the catalogs plus
 * the derived `runner_enforced` label, so all three sites agree by construction and a
 * newly certified model needs no edit here at all.
 *
 * `HISTORICAL_FLEET_MODEL_IDS` keeps identities that appear in already-sealed records but
 * are no longer in any catalog. Accepting them is not a loophole: certification still
 * demands a matching attestation, receipt chain and build, and this schema only decides
 * whether the identity STRING is one the certifier recognizes. Dropping them would make
 * historical evidence unreadable, which the corpus rules forbid.
 */
const HISTORICAL_FLEET_MODEL_IDS = ["haiku", "sonnet", "opus"] as const;

const CertifiedFleetModelIdSchema = z
  .string()
  .min(1)
  .refine(
    (id) =>
      (HISTORICAL_FLEET_MODEL_IDS as readonly string[]).includes(id) ||
      certifiedFleetModels().some((entry) => entry.certifiedAs === id || entry.model === id),
    { message: "model is not a certified or historical fleet model identity" },
  );

const FleetUsageRecordSchema = z
  .object({
    source: z.enum([
      "primary_envelope",
      "terminal_turn_completed",
      "unrecoverable",
      "skipped_resume",
    ]),
    input_tokens: z.number().int().safe().nonnegative().nullable(),
    cached_input_tokens: z.number().int().safe().nonnegative().nullable(),
    output_tokens: z.number().int().safe().nonnegative().nullable(),
    reasoning_output_tokens: z.number().int().safe().nonnegative().nullable(),
  })
  .strict()
  .superRefine((usage, context) => {
    const values = [
      usage.input_tokens,
      usage.cached_input_tokens,
      usage.output_tokens,
      usage.reasoning_output_tokens,
    ];
    if (usage.source === "unrecoverable") {
      if (!values.every((value) => value === null))
        context.addIssue({ code: "custom", message: "unrecoverable usage must use null counts" });
      return;
    }
    if (!values.every((value) => value !== null)) {
      context.addIssue({ code: "custom", message: "observed usage must use integer counts" });
      return;
    }
    if (usage.cached_input_tokens! > usage.input_tokens!)
      context.addIssue({ code: "custom", message: "cached input cannot exceed input" });
    if (usage.source === "skipped_resume" && !values.every((value) => value === 0))
      context.addIssue({ code: "custom", message: "skipped-resume usage must be zero" });
  });

const FleetUsageSummarySchema = z
  .object({
    attempt_count: z.number().int().nonnegative().safe(),
    launched_attempt_count: z.number().int().nonnegative().safe(),
    measured_attempt_count: z.number().int().nonnegative().safe(),
    skipped_resume_count: z.number().int().nonnegative().safe(),
    unrecoverable_attempt_count: z.number().int().nonnegative().safe(),
    complete: z.boolean(),
    observed_input_tokens: z.number().int().nonnegative().safe(),
    observed_cached_input_tokens: z.number().int().nonnegative().safe(),
    observed_uncached_input_tokens: z.number().int().nonnegative().safe(),
    observed_output_tokens: z.number().int().nonnegative().safe(),
    observed_reasoning_output_tokens: z.number().int().nonnegative().safe(),
    useful_tokens: z.number().int().nonnegative().safe(),
  })
  .strict();

const FleetSummarySchema = z
  .object({
    label: z.string().refine(isSafeFleetLabel, "unsafe or reserved fleet label"),
    stamp: z.string().regex(/^\d{8}T\d{6}Z$/),
    count: z.number().int().positive(),
    concurrency: z.number().int().positive(),
    reportsDir: z.string().min(1),
    report_schema_version: z.literal(2),
    play_mode: z.literal("pure"),
    start_surface: z.literal("fresh_overworld"),
    retention_contract_eligible: z.literal(true),
    retention_eligible_verified_runs: z.number().int().nonnegative(),
    retention_ineligible_or_unverified_runs: z.number().int().nonnegative(),
    session_contract_version: z.literal(3),
    baseline_decisions: z.literal(40),
    verified: z.number().int().nonnegative(),
    "skipped-resume": z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    total_attempts: z.number().int().nonnegative(),
    failed_attempts: z.number().int().nonnegative(),
    technical_timeouts: z.number().int().nonnegative(),
    report_recovered_runs: z.number().int().nonnegative(),
    receipt_bound_runs: z.number().int().nonnegative().optional(),
    seed_base: z.number().int().safe(),
    provider: z.enum(["claude", "codex"]).optional(),
    model: CertifiedFleetModelIdSchema,
    personas: z.literal("default"),
    target: z.literal("overworld"),
    resume_enabled: z.boolean(),
    evidence_schema_version: z.literal(2),
    model_attestation_schema_version: z.union([
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
      z.literal(7),
    ]),
    build: PureRunBuildSchema,
    codex_client: CodexClientAuthoritySchema.optional(),
  })
  .strict()
  .superRefine((summary, context) => {
    const provider = summary.provider ?? "claude";
    if (
      provider === "claude" &&
      (summary.model !== "sonnet" || summary.model_attestation_schema_version !== 2)
    ) {
      context.addIssue({
        code: "custom",
        path: ["model"],
        message: "historical Claude certification requires Sonnet attestation v2",
      });
    }
    if (
      provider === "codex" &&
      (!summary.model.startsWith("gpt-") ||
        ![3, 4, 5, 6, 7].includes(summary.model_attestation_schema_version))
    ) {
      context.addIssue({
        code: "custom",
        path: ["model"],
        message:
          "Codex certification requires one exact Codex model and attestation v3, v4, v5, v6, or v7",
      });
    }
    if (
      (summary.model_attestation_schema_version ===
        HISTORICAL_CLIENT_BOUND_CODEX_ATTESTATION_SCHEMA_VERSION) !==
      (summary.codex_client !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["codex_client"],
        message:
          "historical client-bound Codex attestation v7 requires exactly one fleet-wide client authority",
      });
    }
    if (
      (summary.receipt_bound_runs ?? 0) > 0 &&
      ![4, 5, 6, 7].includes(summary.model_attestation_schema_version)
    ) {
      context.addIssue({
        code: "custom",
        path: ["model_attestation_schema_version"],
        message: "receipt-bound runs require Codex attestation v4, v5, v6, or v7",
      });
    }
  });

function auditedFleetSummarySchema<
  const SummaryVersion extends 8 | 9,
  const AttestationVersion extends 8 | 9,
>(summaryVersion: SummaryVersion, attestationVersion: AttestationVersion) {
  return z
    .object({
      schema_version: z.literal(summaryVersion),
      label: z.string().refine(isSafeFleetLabel, "unsafe or reserved fleet label"),
      stamp: z.string().regex(/^\d{8}T\d{6}Z$/),
      count: z.number().int().positive(),
      concurrency: z.number().int().positive(),
      reportsDir: z.string().min(1),
      report_schema_version: z.literal(2),
      play_mode: z.literal("pure"),
      start_surface: z.literal("fresh_overworld"),
      retention_contract_eligible: z.literal(true),
      retention_eligible_verified_runs: z.number().int().nonnegative(),
      retention_ineligible_or_unverified_runs: z.number().int().nonnegative(),
      session_contract_version: z.literal(3),
      baseline_decisions: z.literal(40),
      verified: z.number().int().nonnegative(),
      "skipped-resume": z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      total_attempts: z.number().int().nonnegative(),
      failed_attempts: z.number().int().nonnegative(),
      technical_timeouts: z.number().int().nonnegative(),
      report_recovered_runs: z.number().int().nonnegative(),
      receipt_bound_runs: z.number().int().nonnegative().optional(),
      seed_base: z.number().int().safe(),
      provider: z.enum(["claude", "codex"]).optional(),
      model: CertifiedFleetModelIdSchema,
      personas: z.literal("default"),
      target: z.literal("overworld"),
      resume_enabled: z.boolean(),
      evidence_schema_version: z.literal(2),
      model_attestation_schema_version: z.literal(attestationVersion),
      build: PureRunBuildSchema,
      codex_client: CodexClientSummarySchema.optional(),
      codex_client_proof: CodexClientAuthorityProofSchema,
      usage: FleetUsageSummarySchema,
    })
    .strict()
    .superRefine((summary, context) => {
      const provider = summary.provider ?? "claude";
      if (provider !== "codex") {
        context.addIssue({
          code: "custom",
          path: ["model_attestation_schema_version"],
          message: `v${summaryVersion} live certification requires Codex attestation v${attestationVersion}`,
        });
      }
      if (summary.codex_client === undefined)
        context.addIssue({
          code: "custom",
          path: ["codex_client"],
          message: `v${summaryVersion} requires one safe Codex client projection`,
        });
    });
}

/** Historical v8 cohorts remain readable with their immutable strict/Spark authority contract. */
const FleetSummaryV8Schema = auditedFleetSummarySchema(
  8,
  HISTORICAL_TRANSPORT_CODEX_ATTESTATION_SCHEMA_VERSION,
);

/** Current v9 cohorts audit usage and require the exact model-specific transport contract. */
const FleetSummaryV9Schema = auditedFleetSummarySchema(
  9,
  PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION,
);

const FleetAttemptArtifactSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .refine(
        (name) => name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\"),
        "artifact name must be one path segment",
      ),
    bytes: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const FleetAttemptArchiveSchema = z
  .object({
    directory: z.string().min(1),
    artifacts: z.array(FleetAttemptArtifactSchema).min(1),
    usage_artifacts: z
      .object({
        primary_envelope: z.string().min(1).nullable(),
        provider_events: z.string().min(1).nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

const FleetAttemptSchema = z
  .object({
    attempt: z.number().int().positive().safe(),
    exit: z.number().int().nonnegative().safe(),
    classification: z.enum([
      "technical_timeout",
      "strict_stream_rejected",
      "launcher_or_run_failure",
      "verifier_failure",
      "verified",
    ]),
    report_recovered: z.boolean(),
    report_receipt_bound: z.boolean().optional(),
    archive: FleetAttemptArchiveSchema.nullable(),
    usage: FleetUsageRecordSchema.optional(),
  })
  .strict();

const FleetManifestRowSchema = z
  .object({
    planned_index: z.number().int().nonnegative(),
    seed: z.number().int().safe(),
    persona: z.literal("default"),
    provider: z.enum(["claude", "codex"]).optional(),
    model: CertifiedFleetModelIdSchema,
    target: z.literal("overworld"),
    report: z.string().min(1),
    status: z.enum(["verified", "skipped-resume"]),
    attempts: z.number().int().nonnegative(),
    attempt_history: z.array(FleetAttemptSchema),
    resume_usage: FleetUsageRecordSchema.nullable().optional(),
    report_recovered: z.boolean(),
    report_receipt_bound: z.boolean().optional(),
    exit: z.literal(0),
    log: z.null(),
    report_schema_version: z.literal(2),
    play_mode: z.literal("pure"),
    start_surface: z.literal("fresh_overworld"),
    retention_eligible: z.literal(true),
    evidence_status: z.literal("verified"),
    session_contract_version: z.literal(3),
    baseline_decisions: z.literal(40),
    accepted_decisions: z.number().int().nonnegative(),
    retention_choices: z.array(z.unknown()),
    checkpoint: z.number().int().nonnegative().nullable(),
    exit_reason: z.literal("player_ended_at_choice"),
    exit_reasons: z
      .array(z.enum(["checkpoint", "goal_completed", "character_died"]))
      .min(1)
      .max(2),
    receipt_hash: z.string().regex(/^[0-9a-f]{64}$/),
    failure_reason: z.null(),
    evidence_schema_version: z.literal(2),
    model_attestation: PureFleetAttestationSchema,
    run_seed: z.number().int().safe(),
    build: PureRunBuildSchema,
    quest_outcomes: CanonicalQuestOutcomesSchema,
  })
  .strict();

/** Audited v8/v9 summaries preserve failed slots instead of erasing them. */
const FleetManifestRowV8Schema = FleetManifestRowSchema.extend({
  status: z.enum(["verified", "skipped-resume", "failed"]),
  resume_usage: FleetUsageRecordSchema.nullable(),
  exit: z.number().int().nonnegative().safe(),
  log: z.string().nullable(),
  model_attestation: PureFleetAttestationSchema.nullable(),
  evidence_schema_version: z.literal(2).nullable(),
  run_seed: z.number().int().safe().nullable(),
  build: PureRunBuildSchema.nullable(),
  quest_outcomes: CanonicalQuestOutcomesSchema.nullable(),
  report_schema_version: z.literal(2).nullable(),
  retention_eligible: z.boolean(),
  evidence_status: z.string(),
  session_contract_version: z.literal(3).nullable(),
  baseline_decisions: z.literal(40).nullable(),
  accepted_decisions: z.number().int().nonnegative().nullable(),
  checkpoint: z.number().int().nonnegative().nullable(),
  exit_reason: z.literal("player_ended_at_choice").nullable(),
  exit_reasons: z.array(z.enum(["checkpoint", "goal_completed", "character_died"])),
  receipt_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  failure_reason: z.string().nullable(),
});

type FleetSummary =
  | z.infer<typeof FleetSummarySchema>
  | z.infer<typeof FleetSummaryV8Schema>
  | z.infer<typeof FleetSummaryV9Schema>;
type FleetManifestRow = z.infer<typeof FleetManifestRowSchema>;
type FleetAttempt = z.infer<typeof FleetAttemptSchema>;

function isFleetSummaryV8(summary: FleetSummary): summary is z.infer<typeof FleetSummaryV8Schema> {
  return "schema_version" in summary && summary.schema_version === 8;
}

function isFleetSummaryV9(summary: FleetSummary): summary is z.infer<typeof FleetSummaryV9Schema> {
  return "schema_version" in summary && summary.schema_version === 9;
}

function isAuditedFleetSummary(
  summary: FleetSummary,
): summary is z.infer<typeof FleetSummaryV8Schema> | z.infer<typeof FleetSummaryV9Schema> {
  return isFleetSummaryV8(summary) || isFleetSummaryV9(summary);
}

const STRATEGIES: readonly WolfStrategy[] = [
  "hunt_and_hold",
  "lure_and_divert",
  "drive_and_evacuate",
  "fortify_and_outlast",
];
const SEVERE: ReadonlySet<IssueSeverity> = new Set(["S3", "S4"]);
const LOCATION_INDEX_CACHE = new Map<string, LocationIndex>();

interface CertifiedArtifactTracker {
  identities: Set<string>;
  real_paths: Set<string>;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function isSafeFleetLabel(label: string): boolean {
  const windowsBase = label.split(".", 1)[0]!.toUpperCase();
  return (
    label !== "." &&
    label !== ".." &&
    !label.endsWith(".") &&
    !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(windowsBase) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(label)
  );
}

function canonicalRealpath(path: string): string {
  return realpathSync.native(path);
}

function pathIdentity(path: string): string {
  // Inputs are canonical realpaths. Exact comparison preserves distinct files
  // on case-sensitive Windows directories while canonicalization still folds
  // alternate spellings of the same entry.
  return path;
}

function containedPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function requireRealDirectory(path: string, label: string): string {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!stats.isDirectory()) throw new Error(`${label} must be a directory`);
  return canonicalRealpath(path);
}

function statsIdentity(stats: Stats, realPath: string): string {
  // Some Windows filesystems report inode 0 or an unsigned 64-bit value that
  // loses precision in Node's numeric Stats shape. Canonical path plus the
  // mandatory nlink===1 check remains reliable there; safe inode values add a
  // second hard-link identity defense on normal filesystems.
  return stats.ino === 0 || !Number.isSafeInteger(stats.ino)
    ? `path:${pathIdentity(realPath)}`
    : `${stats.dev}:${stats.ino}`;
}

function requireContainedRegularFile(
  path: string,
  rootRealPath: string,
  label: string,
  tracker: CertifiedArtifactTracker,
): string {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!stats.isFile()) throw new Error(`${label} must be a regular file`);
  if (stats.nlink !== 1) throw new Error(`${label} must not have multiple hard links`);
  const realPath = canonicalRealpath(path);
  if (!containedPath(rootRealPath, realPath)) {
    throw new Error(`${label} escapes its declared artifact root`);
  }
  const realKey = pathIdentity(realPath);
  const identity = statsIdentity(stats, realPath);
  if (tracker.real_paths.has(realKey) || tracker.identities.has(identity)) {
    throw new Error(`${label} aliases another certified artifact`);
  }
  tracker.real_paths.add(realKey);
  tracker.identities.add(identity);
  return realPath;
}

function fleetRelativePath(fleetDir: string, path: string): string {
  return relative(fleetDir, path).split(sep).join("/");
}

function validateAttemptArchive(
  fleetDir: string,
  fleetRootReal: string,
  seed: number,
  attempt: FleetAttempt,
  tracker: CertifiedArtifactTracker,
  errors: string[],
  referencedDirectories: Set<string>,
): Map<string, Buffer> | null {
  if (attempt.archive === null) return null;
  const expectedDirectory = `attempts/seed_${seed}/attempt_${attempt.attempt}`;
  if (attempt.archive.directory !== expectedDirectory) {
    errors.push(
      `seed ${seed} attempt ${attempt.attempt}: archive directory ${JSON.stringify(attempt.archive.directory)} != ${JSON.stringify(expectedDirectory)}`,
    );
    return null;
  }
  if (referencedDirectories.has(expectedDirectory)) {
    errors.push(`seed ${seed} attempt ${attempt.attempt}: duplicate archive directory`);
    return null;
  }
  referencedDirectories.add(expectedDirectory);

  const attemptDir = resolve(fleetDir, ...expectedDirectory.split("/"));
  let attemptRootReal: string;
  try {
    attemptRootReal = requireRealDirectory(
      attemptDir,
      `seed ${seed} attempt ${attempt.attempt} archive`,
    );
    if (!containedPath(fleetRootReal, attemptRootReal)) {
      throw new Error("archive directory escapes the fleet bundle");
    }
  } catch (error) {
    errors.push(
      `seed ${seed} attempt ${attempt.attempt}: archive unsafe or unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  const indexedNames = attempt.archive.artifacts.map((artifact) => artifact.name);
  const canonicalNames = [...indexedNames].sort(compareStrings);
  if (
    !isDeepStrictEqual(indexedNames, canonicalNames) ||
    new Set(indexedNames).size !== indexedNames.length
  ) {
    errors.push(
      `seed ${seed} attempt ${attempt.attempt}: archive artifact index is not unique canonical order`,
    );
  }
  let physicalNames: string[];
  try {
    physicalNames = readdirSync(attemptRootReal).slice().sort(compareStrings);
  } catch (error) {
    errors.push(
      `seed ${seed} attempt ${attempt.attempt}: archive entries unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  if (!isDeepStrictEqual(physicalNames, canonicalNames)) {
    errors.push(
      `seed ${seed} attempt ${attempt.attempt}: archived files differ from manifest index`,
    );
  }
  const bytesByName = new Map<string, Buffer>();
  for (const artifact of attempt.archive.artifacts) {
    try {
      const artifactPath = requireContainedRegularFile(
        resolve(attemptDir, artifact.name),
        fleetRootReal,
        `seed ${seed} attempt ${attempt.attempt} artifact ${artifact.name}`,
        tracker,
      );
      const bytes = readFileSync(artifactPath);
      if (bytes.byteLength !== artifact.bytes) {
        errors.push(
          `seed ${seed} attempt ${attempt.attempt}: artifact ${artifact.name} byte count differs`,
        );
      }
      if (sha256(bytes) !== artifact.sha256) {
        errors.push(
          `seed ${seed} attempt ${attempt.attempt}: artifact ${artifact.name} digest differs`,
        );
      }
      bytesByName.set(artifact.name, bytes);
    } catch (error) {
      errors.push(
        `seed ${seed} attempt ${attempt.attempt}: artifact ${artifact.name} unsafe or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return bytesByName;
}

function discoverAttemptArchiveDirectories(fleetDir: string, fleetRootReal: string): string[] {
  const attemptsDir = resolve(fleetDir, "attempts");
  if (!existsSync(attemptsDir)) return [];
  const attemptsRootReal = requireRealDirectory(attemptsDir, "attempt archive root");
  if (!containedPath(fleetRootReal, attemptsRootReal)) {
    throw new Error("attempt archive root escapes the fleet bundle");
  }
  const found: string[] = [];
  for (const seedEntry of readdirSync(attemptsRootReal, { withFileTypes: true })) {
    if (seedEntry.isSymbolicLink() || !seedEntry.isDirectory()) {
      throw new Error(`attempt archive root contains non-directory ${seedEntry.name}`);
    }
    const seedDir = resolve(attemptsRootReal, seedEntry.name);
    const seedRootReal = requireRealDirectory(seedDir, `attempt archive seed ${seedEntry.name}`);
    if (!containedPath(attemptsRootReal, seedRootReal)) {
      throw new Error(`attempt archive seed ${seedEntry.name} escapes its root`);
    }
    for (const attemptEntry of readdirSync(seedRootReal, { withFileTypes: true })) {
      if (attemptEntry.isSymbolicLink() || !attemptEntry.isDirectory()) {
        throw new Error(
          `attempt archive seed ${seedEntry.name} contains non-directory ${attemptEntry.name}`,
        );
      }
      const attemptDir = resolve(seedRootReal, attemptEntry.name);
      const attemptRootReal = requireRealDirectory(
        attemptDir,
        `attempt archive ${seedEntry.name}/${attemptEntry.name}`,
      );
      if (!containedPath(seedRootReal, attemptRootReal)) {
        throw new Error(`attempt archive ${seedEntry.name}/${attemptEntry.name} escapes its root`);
      }
      found.push(fleetRelativePath(fleetDir, attemptDir));
    }
  }
  return found.sort(compareStrings);
}

function firstSchemaIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue?.path.join(".") || "<root>"}: ${issue?.message ?? "schema mismatch"}`;
}

function ownWolfMapping(
  ending: string,
): (typeof WOLF_WINTER_STRATEGY_BY_ENDING)[WolfEndingId] | null {
  if (!Object.prototype.hasOwnProperty.call(WOLF_WINTER_STRATEGY_BY_ENDING, ending)) return null;
  return WOLF_WINTER_STRATEGY_BY_ENDING[ending as WolfEndingId];
}

function locationIndex(root: string): LocationIndex {
  const canonicalRoot = resolve(root);
  const cached = LOCATION_INDEX_CACHE.get(canonicalRoot);
  if (cached) return cached;
  const built = buildLocationIndex(canonicalRoot);
  LOCATION_INDEX_CACHE.set(canonicalRoot, built);
  return built;
}

function isStartingSliceLocation(location: CanonicalLocation, albanyNode: string): boolean {
  if (location.kind === "unmapped") return true;
  if (location.kind === "quest") {
    return location.questId === null || location.questId === "wolf_winter";
  }
  return location.node === null || location.node === albanyNode;
}

/**
 * Runtime counterpart to the compile-time exhaustive map. It protects against
 * drift in both authored sources: compiled non-death endings and overworld
 * campaign exports must equal the eleven mapped identities.
 */
export function wolfStrategyMappingDrift(root: string): string[] {
  try {
    const mapped = Object.keys(WOLF_WINTER_STRATEGY_BY_ENDING).sort(compareStrings);
    const campaign = Object.entries(WOLF_WINTER_CAMPAIGN_OUTCOMES);
    const declared = campaign.map(([key]) => key).sort(compareStrings);
    const contextEndingIds = campaign.map(([, value]) => value.endingId).sort(compareStrings);
    const compiled = prepareShippedQuest(resolve(root), "wolf_winter")
      .index.pack.endings.filter((ending) => !ending.death)
      .map((ending) => ending.id)
      .sort(compareStrings);
    const worldQuest = loadOverworldManifest(resolve(root)).quests.find(
      (quest) => quest.id === "wolf_winter",
    );
    const world = (worldQuest?.campaign_exports ?? [])
      .map((entry) => entry.ending_id)
      .sort(compareStrings);

    const errors: string[] = [];
    for (const [label, actual] of [
      ["campaign outcome keys", declared],
      ["campaign outcome ending ids", contextEndingIds],
      ["compiled non-death endings", compiled],
      ["overworld campaign exports", world],
    ] as const) {
      if (!isDeepStrictEqual(actual, mapped)) {
        errors.push(
          `Wolf strategy map drift: ${label} ${JSON.stringify(actual)} != mapped ${JSON.stringify(mapped)}`,
        );
      }
    }
    return errors.sort(compareStrings);
  } catch (error) {
    return [
      `Wolf strategy map drift check failed: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

function canonicalIssueRecords(
  root: string,
  runs: readonly StartingSliceEvaluationRun[],
  validityErrors: string[],
): IssueRecord[] {
  const issueInputs = runs.flatMap((run) => run.issues.map((issue) => ({ run, issue })));
  if (issueInputs.length === 0) return [];

  let index: LocationIndex;
  let albanyNode: string;
  try {
    index = locationIndex(root);
    albanyNode = loadOverworldManifest(resolve(root)).start;
  } catch (error) {
    validityErrors.push(
      `Issue location index failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }

  const records: IssueRecord[] = [];
  for (const { run, issue } of issueInputs) {
    if (issue.where.trim().length === 0 || issue.note.trim().length === 0) {
      validityErrors.push(`${run.ref}: issue location and note must be non-empty`);
      continue;
    }
    if (!["S0", "S1", "S2", "S3", "S4"].includes(issue.severity)) {
      validityErrors.push(`${run.ref}: issue has invalid severity ${String(issue.severity)}`);
      continue;
    }
    const location = canonicalizeLocation(issue.where, index);
    if (!isStartingSliceLocation(location, albanyNode)) continue;
    records.push({
      source: "fleet",
      ref: run.ref,
      location,
      severity: issue.severity,
      text: issue.note,
      persona: "default",
      target: "overworld",
    });
  }
  return records;
}

function emptyStrategyCounts(): Record<WolfStrategy, number> {
  return {
    hunt_and_hold: 0,
    lure_and_divert: 0,
    drive_and_evacuate: 0,
    fortify_and_outlast: 0,
  };
}

/** Deterministic threshold evaluator; it performs no filesystem I/O. */
export function evaluateStartingSliceRuns(
  options: StartingSliceEvaluationOptions,
): StartingSliceCertificationResult {
  const runs = [...options.runs].sort((left, right) => compareStrings(left.ref, right.ref));
  const requestedCount = options.expectedCount ?? runs.length;
  const validExpectedCount = Number.isSafeInteger(requestedCount) && requestedCount > 0;
  const expectedCount = validExpectedCount ? requestedCount : Math.max(1, runs.length);
  const validityErrors: string[] = [];
  if (!validExpectedCount) {
    validityErrors.push(`expectedCount must be a positive safe integer (got ${requestedCount})`);
  }
  if (runs.length !== expectedCount) {
    validityErrors.push(`Expected ${expectedCount} evaluated runs, found ${runs.length}`);
  }
  const refs = runs.map((run) => run.ref);
  if (new Set(refs).size !== refs.length) validityErrors.push("Evaluation run refs must be unique");

  const strategyCounts = emptyStrategyCounts();
  const completionDecisions: number[] = [];
  let continued = 0;
  let stuck = 0;
  let clarityTotal = 0;
  let enjoymentTotal = 0;

  for (const run of runs) {
    if (run.ref.trim().length === 0) validityErrors.push("Evaluation run ref must be non-empty");
    if (!Number.isInteger(run.clarity) || run.clarity < 1 || run.clarity > 5) {
      validityErrors.push(`${run.ref}: clarity must be an integer from 1 to 5`);
    } else {
      clarityTotal += run.clarity;
    }
    if (!Number.isInteger(run.enjoyment) || run.enjoyment < 1 || run.enjoyment > 5) {
      validityErrors.push(`${run.ref}: enjoyment must be an integer from 1 to 5`);
    } else {
      enjoymentTotal += run.enjoyment;
    }
    if (typeof run.got_stuck !== "boolean") {
      validityErrors.push(`${run.ref}: got_stuck must be boolean`);
    } else if (run.got_stuck) {
      stuck += 1;
    }

    let mapping: (typeof WOLF_WINTER_STRATEGY_BY_ENDING)[WolfEndingId] | null = null;
    if (run.wolf_outcome !== null) {
      mapping = ownWolfMapping(run.wolf_outcome);
      if (mapping === null) {
        const kind = run.wolf_outcome === "ending_pulled_down" ? "death" : "unknown";
        validityErrors.push(`${run.ref}: ${kind} Wolf-Winter outcome ${run.wolf_outcome}`);
      }
    }

    const completion = run.initial_goal_completion;
    const retention = run.initial_goal_retention;
    const hasAnyGoalEvidence = completion !== null || retention !== null;
    let hasExactGoalEvidence = false;
    if ((completion === null) !== (retention === null)) {
      validityErrors.push(`${run.ref}: initial goal completion and retention evidence disagree`);
    } else if (completion !== null && retention !== null) {
      const completionValid =
        completion.version === STARTING_SLICE_INITIAL_GOAL.version &&
        completion.id === STARTING_SLICE_INITIAL_GOAL.id &&
        Number.isSafeInteger(completion.completed_at_decision) &&
        completion.completed_at_decision >= 1;
      const retentionValid =
        retention.goal_version === STARTING_SLICE_INITIAL_GOAL.version &&
        retention.goal_id === STARTING_SLICE_INITIAL_GOAL.id &&
        retention.reasons.includes("goal_completed") &&
        Number.isSafeInteger(retention.at_decision) &&
        retention.at_decision === completion.completed_at_decision;
      if (!completionValid || !retentionValid) {
        validityErrors.push(
          `${run.ref}: initial goal retention event is not exactly bound to completion`,
        );
      } else {
        hasExactGoalEvidence = true;
      }
    }

    if (mapping !== null && !hasExactGoalEvidence) {
      validityErrors.push(
        `${run.ref}: Wolf-Winter outcome exists without exact initial-goal completion`,
      );
    } else if (run.wolf_outcome === null && hasAnyGoalEvidence) {
      validityErrors.push(
        `${run.ref}: initial-goal completion exists without a Wolf-Winter outcome`,
      );
    }

    if (mapping !== null && hasExactGoalEvidence && completion !== null && retention !== null) {
      strategyCounts[mapping.strategy] += 1;
      completionDecisions.push(completion.completed_at_decision);
      if (retention.choice === "continue") continued += 1;
    }
  }

  const issueRecords = canonicalIssueRecords(resolve(options.root), runs, validityErrors);
  const clusters = clusterIssues(issueRecords);
  const blockingClusters: StartingSliceBlockingCluster[] = [];
  for (const cluster of clusters) {
    const reportRefs = uniqueSorted(cluster.issues.map((issue) => issue.ref));
    const severe = SEVERE.has(cluster.maxSeverity);
    const repeatedS2 = cluster.maxSeverity === "S2" && reportRefs.length * 100 >= expectedCount * 5;
    if (!severe && !repeatedS2) continue;
    blockingClusters.push({
      key: cluster.key,
      max_severity: cluster.maxSeverity,
      affected_reports: reportRefs.length,
      report_refs: reportRefs,
      issue_mentions: cluster.issues.length,
      location: cluster.location,
      tokens: cluster.tokens,
    });
  }
  blockingClusters.sort((left, right) => compareStrings(left.key, right.key));

  completionDecisions.sort((left, right) => left - right);
  const completed = completionDecisions.length;
  const p50 = completed === 0 ? null : (completionDecisions[Math.ceil(completed / 2) - 1] ?? null);
  const represented = STRATEGIES.filter((strategy) => strategyCounts[strategy] > 0).length;
  const largestStrategy = Math.max(...STRATEGIES.map((strategy) => strategyCounts[strategy]));
  const severeBlocked = blockingClusters.some((cluster) => SEVERE.has(cluster.max_severity));
  const s2Blocked = blockingClusters.some((cluster) => cluster.max_severity === "S2");

  // Every ratio is decided through integer cross-multiplication. No rounded
  // averages or binary floating-point values can move a boundary run.
  const gates: StartingSliceGates = {
    completion_at_least_90_percent: completed * 100 >= expectedCount * 90,
    completion_p50_at_most_45_decisions:
      p50 !== null && p50 <= STARTING_SLICE_MAX_TYPICAL_FIRST_GOAL_DECISIONS,
    got_stuck_at_most_5_percent: stuck * 100 <= expectedCount * 5,
    clarity_average_at_least_4_2: clarityTotal * 10 >= expectedCount * 42,
    enjoyment_average_at_least_4_2: enjoymentTotal * 10 >= expectedCount * 42,
    initial_goal_continuation_at_least_70_percent:
      completed > 0 && continued * 100 >= completed * 70,
    at_least_3_top_level_strategies: represented >= 3,
    no_strategy_above_75_percent: completed > 0 && largestStrategy * 100 <= completed * 75,
    no_in_scope_s3_or_s4: !severeBlocked,
    no_in_scope_s2_cluster_at_or_above_5_percent: !s2Blocked,
  };
  const gateFailures = (Object.keys(gates) as (keyof StartingSliceGates)[]).filter(
    (gate) => !gates[gate],
  );
  const finalValidityErrors = uniqueSorted(validityErrors);

  return {
    schema_version: STARTING_SLICE_CERTIFICATION_SCHEMA_VERSION,
    valid: finalValidityErrors.length === 0,
    passed: finalValidityErrors.length === 0 && gateFailures.length === 0,
    fleet: null,
    certified_build: null,
    authenticated_actual_model: null,
    validity_errors: finalValidityErrors,
    gate_failures: gateFailures,
    metrics: {
      total_runs: expectedCount,
      evaluated_runs: runs.length,
      completed_runs: completed,
      incomplete_runs: Math.max(0, expectedCount - completed),
      completion_decision_p50: p50,
      stuck_runs: stuck,
      clarity_total: clarityTotal,
      enjoyment_total: enjoymentTotal,
      continued_after_initial_goal: continued,
      completed_runs_with_continuation_choice: completed,
      strategies_represented: represented,
      largest_strategy_count: largestStrategy,
      in_scope_issue_reports: new Set(issueRecords.map((issue) => issue.ref)).size,
    },
    gates,
    strategy_counts: strategyCounts,
    blocking_issue_clusters: blockingClusters,
  };
}

/**
 * Deterministic ten-run readiness check. This evaluates gameplay evidence only;
 * `validateStartingSlicePilot` additionally authenticates every durable fleet
 * artifact before `pilot_passed` can be true.
 */
function pilotEvaluationFor(
  evaluation: StartingSliceCertificationResult,
): StartingSlicePilotEvaluation {
  const pilotGates: StartingSlicePilotGates = {
    all_10_recognized_wolf_outcomes:
      evaluation.metrics.completed_runs === STARTING_SLICE_PILOT_COUNT,
    at_least_3_top_level_strategies: evaluation.metrics.strategies_represented >= 3,
    no_strategy_above_7_of_10:
      evaluation.metrics.completed_runs === STARTING_SLICE_PILOT_COUNT &&
      evaluation.metrics.largest_strategy_count <= 7,
  };
  const pilotGateFailures = (Object.keys(pilotGates) as (keyof StartingSlicePilotGates)[]).filter(
    (gate) => !pilotGates[gate],
  );
  return {
    evaluation,
    pilot_passed: evaluation.passed && pilotGateFailures.length === 0,
    pilot_gate_failures: pilotGateFailures,
    pilot_gates: pilotGates,
  };
}

export function evaluateStartingSlicePilotRuns(
  options: Omit<StartingSliceEvaluationOptions, "expectedCount">,
): StartingSlicePilotEvaluation {
  return pilotEvaluationFor(
    evaluateStartingSliceRuns({
      ...options,
      expectedCount: STARTING_SLICE_PILOT_COUNT,
    }),
  );
}

function parseJsonFile(path: string, label: string): unknown {
  const parsed = parseJsonRejectingDuplicateKeys(readFileSync(path, "utf8"), label);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function reportPathInside(reportsDir: string, report: string): string | null {
  const candidate = resolve(report);
  const rel = relative(reportsDir, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return candidate;
}

function relativeReportRef(reportsDir: string, reportPath: string): string {
  return relative(reportsDir, reportPath).split(sep).join("/");
}

function normalizeVerifiedRun(
  ref: string,
  interview: PureExitInterviewV2,
  questOutcomes: CanonicalQuestOutcomes,
): StartingSliceEvaluationRun {
  if (interview.journey_exit_receipt.contractVersion !== 3) {
    throw new Error("current journey receipt required");
  }
  const receipt = interview.journey_exit_receipt;
  if (receipt.exitReasons.includes("character_died")) {
    throw new Error(
      "character-death receipt is valid blind evidence but cannot certify the starting slice",
    );
  }
  const completion = receipt.completedGoals.find(
    (goal) =>
      goal.version === STARTING_SLICE_INITIAL_GOAL.version &&
      goal.id === STARTING_SLICE_INITIAL_GOAL.id,
  );
  const retention = receipt.retentionHistory.find(
    (event) =>
      event.goalVersion === STARTING_SLICE_INITIAL_GOAL.version &&
      event.goalId === STARTING_SLICE_INITIAL_GOAL.id &&
      event.reasons.includes("goal_completed"),
  );
  const wolfOutcome = questOutcomes.find(([questId]) => questId === "wolf_winter")?.[1] ?? null;
  return {
    ref,
    wolf_outcome: wolfOutcome,
    initial_goal_completion:
      completion === undefined
        ? null
        : {
            version: completion.version,
            id: completion.id,
            completed_at_decision: completion.completedAtDecision,
          },
    initial_goal_retention:
      retention === undefined
        ? null
        : {
            goal_version: retention.goalVersion,
            goal_id: retention.goalId,
            at_decision: retention.atDecision,
            reasons: retention.reasons.filter((reason) => reason !== "character_died"),
            choice: retention.choice,
          },
    clarity: interview.clarity,
    enjoyment: interview.enjoyment,
    got_stuck: interview.got_stuck,
    issues: interview.bugs,
  };
}

function attachFleetValidity(
  result: StartingSliceCertificationResult,
  validityErrors: readonly string[],
  fleet: StartingSliceFleetIdentity,
  build: PureRunBuild,
): StartingSliceCertificationResult {
  const combined = uniqueSorted([...result.validity_errors, ...validityErrors]);
  return {
    ...result,
    valid: combined.length === 0,
    passed: combined.length === 0 && result.gate_failures.length === 0,
    fleet,
    certified_build: build,
    validity_errors: combined,
  };
}

function invalidFilesystemResult(
  root: string,
  expectedCount: number,
  errors: readonly string[],
): StartingSliceCertificationResult {
  const evaluated = evaluateStartingSliceRuns({
    root,
    runs: [],
    expectedCount: Number.isSafeInteger(expectedCount) && expectedCount > 0 ? expectedCount : 1,
  });
  const combined = uniqueSorted([...evaluated.validity_errors, ...errors]);
  return {
    ...evaluated,
    valid: false,
    passed: false,
    validity_errors: combined,
  };
}

type StartingSliceCohortKind = "authority" | "pilot";

interface ValidateAuthenticatedCohortOptions extends StartingSliceFleetPathOptions {
  cohortKind: StartingSliceCohortKind;
  expectedCount: number;
}

/**
 * Validate one already-closed fleet directory. The manifest is only an index:
 * each row is rebound to its adjacent private sidecar and the markdown is
 * independently re-verified before it contributes to any metric.
 */
function validateAuthenticatedStartingSliceCohort(
  options: ValidateAuthenticatedCohortOptions,
): StartingSliceCertificationResult {
  const root = resolve(options.root);
  const fleetDir = resolve(options.fleetDir);
  if (!Number.isSafeInteger(options.expectedCount) || options.expectedCount <= 0) {
    return invalidFilesystemResult(root, options.expectedCount, [
      `expectedCount must be a positive safe integer (got ${options.expectedCount})`,
    ]);
  }

  const artifacts: CertifiedArtifactTracker = {
    identities: new Set<string>(),
    real_paths: new Set<string>(),
  };
  let fleetRootReal: string;
  let summaryPath: string;
  try {
    fleetRootReal = requireRealDirectory(fleetDir, "fleet directory");
    summaryPath = requireContainedRegularFile(
      resolve(fleetDir, "summary.json"),
      fleetRootReal,
      "summary.json",
      artifacts,
    );
  } catch (error) {
    return invalidFilesystemResult(root, options.expectedCount, [
      `fleet bundle unsafe: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  let summary: FleetSummary;
  try {
    const rawSummary = parseJsonFile(summaryPath, "summary.json") as unknown;
    const rawSummaryVersion =
      rawSummary !== null && typeof rawSummary === "object" && !Array.isArray(rawSummary)
        ? (rawSummary as Record<string, unknown>).schema_version
        : undefined;
    const parsed =
      rawSummaryVersion === 9
        ? FleetSummaryV9Schema.safeParse(rawSummary)
        : rawSummaryVersion === 8
          ? FleetSummaryV8Schema.safeParse(rawSummary)
          : FleetSummarySchema.safeParse(rawSummary);
    if (!parsed.success) {
      return invalidFilesystemResult(root, options.expectedCount, [
        `summary.json invalid: ${firstSchemaIssue(parsed.error)}`,
      ]);
    }
    summary = parsed.data;
  } catch (error) {
    return invalidFilesystemResult(root, options.expectedCount, [
      `summary.json unreadable: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const reportsDir = isAbsolute(summary.reportsDir)
    ? resolve(summary.reportsDir)
    : resolve(root, summary.reportsDir);
  const expectedProvider = summary.provider ?? "claude";
  const errors = wolfStrategyMappingDrift(root);
  const auditedSummary = isAuditedFleetSummary(summary) ? summary : null;
  const isAudited = auditedSummary !== null;
  const isV9 = isFleetSummaryV9(summary);
  let authenticatedCodexClient: z.infer<typeof CodexClientAuthoritySchema> | null = null;
  if (auditedSummary !== null) {
    try {
      const proofPath = requireContainedRegularFile(
        resolve(fleetDir, auditedSummary.codex_client_proof.name),
        fleetRootReal,
        "private Codex client authority proof",
        artifacts,
      );
      const proofBytes = readFileSync(proofPath);
      if (
        proofBytes.byteLength !== auditedSummary.codex_client_proof.bytes ||
        sha256(proofBytes) !== auditedSummary.codex_client_proof.sha256
      ) {
        errors.push("private Codex client authority proof bytes differ from summary digest index");
      } else {
        const rawProof = parseJsonRejectingDuplicateKeys(
          proofBytes.toString("utf8"),
          "private Codex client authority proof",
        );
        if (!rawProof.ok) {
          errors.push(`private Codex client authority proof invalid: ${rawProof.reason}`);
        } else {
          const parsedProof = CodexClientAuthoritySchema.safeParse(rawProof.value);
          if (!parsedProof.success) {
            errors.push(
              `private Codex client authority proof invalid: ${firstSchemaIssue(parsedProof.error)}`,
            );
          } else {
            authenticatedCodexClient = parsedProof.data;
            if (
              auditedSummary.codex_client === undefined ||
              !isDeepStrictEqual(
                auditedSummary.codex_client,
                codexClientSummaryProjection(authenticatedCodexClient),
              )
            ) {
              errors.push(
                "summary Codex client projection differs from authenticated private authority proof",
              );
            }
          }
        }
      }
    } catch (error) {
      errors.push(
        `private Codex client authority proof unsafe or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (
    expectedProvider === "codex" &&
    summary.model_attestation_schema_version !== PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION
  ) {
    errors.push(
      `current Codex ${options.cohortKind} certification requires attestation v${PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION}`,
    );
  }
  if (expectedProvider === "codex" && !isV9) {
    errors.push(`current Codex ${options.cohortKind} certification requires fleet summary v9`);
  }
  // A direct-MCP model must have been played by the exact client version its CATALOG
  // pins. This was two model ids and two identical version constants spelled out here;
  // the pin now travels with the model that needs it, so a client upgrade is a catalog
  // edit rather than a hunt through five files for every copy of "0.146.0". Models whose
  // catalog pins no version (strict-code-mode) are unaffected, exactly as before.
  if (expectedProvider === "codex" && authenticatedCodexClient !== null) {
    const requiredCliVersion =
      certifiedModelTransport("codex", summary.model)?.requiredCliVersion ?? null;
    if (
      requiredCliVersion !== null &&
      authenticatedCodexClient.cli_version !== requiredCliVersion
    ) {
      errors.push(
        `current direct-MCP certification requires exact Codex CLI ${requiredCliVersion} ` +
          `for model ${summary.model}`,
      );
    }
  }
  const fleetBasename = basename(fleetDir);
  const labelBoundToDirectory = summary.label === fleetBasename;
  const displayLabel = labelBoundToDirectory ? summary.label : "invalid-fleet-label";
  if (!labelBoundToDirectory) {
    errors.push(
      `summary label ${JSON.stringify(summary.label)} does not exactly match fleet directory ${JSON.stringify(fleetBasename)}`,
    );
  }
  let reportsRootReal: string;
  try {
    reportsRootReal = requireRealDirectory(reportsDir, "summary reportsDir");
  } catch (error) {
    return attachFleetValidity(
      invalidFilesystemResult(root, options.expectedCount, [
        `reports directory unsafe: ${error instanceof Error ? error.message : String(error)}`,
      ]),
      errors,
      {
        label: displayLabel,
        stamp: summary.stamp,
        fleet_dir: fleetDir,
        reports_dir: reportsDir,
        manifest_rows: 0,
      },
      summary.build,
    );
  }
  if (summary.count !== options.expectedCount) {
    errors.push(`summary count ${summary.count} != expected ${options.expectedCount}`);
  }
  if (summary.retention_eligible_verified_runs !== options.expectedCount) {
    errors.push(
      `summary retention-eligible runs ${summary.retention_eligible_verified_runs} != expected ${options.expectedCount}`,
    );
  }
  if (summary.retention_ineligible_or_unverified_runs !== 0) {
    errors.push("summary contains retention-ineligible or unverified runs");
  }
  if (summary.resume_enabled) errors.push(`${options.cohortKind} cohort requires --no-resume`);
  if (summary.verified !== options.expectedCount) {
    errors.push(`summary verified runs ${summary.verified} != expected ${options.expectedCount}`);
  }
  if (summary["skipped-resume"] !== 0) {
    errors.push(`summary contains ${summary["skipped-resume"]} skipped-resume runs`);
  }
  if (summary.failed !== 0) errors.push(`summary contains ${summary.failed} failed runs`);
  if (summary.total_attempts !== options.expectedCount) {
    errors.push(
      `summary total attempts ${summary.total_attempts} != expected ${options.expectedCount}`,
    );
  }
  if (summary.failed_attempts !== 0) {
    errors.push(`summary contains ${summary.failed_attempts} failed attempts`);
  }
  if (summary.technical_timeouts !== 0) {
    errors.push(`summary contains ${summary.technical_timeouts} technical timeouts`);
  }
  if (summary.report_recovered_runs !== 0) {
    errors.push(
      `summary contains ${summary.report_recovered_runs} report-recovered runs; ${options.cohortKind} cohort requires primary reports`,
    );
  }
  if (!summary.build.tracked_worktree_clean) {
    errors.push("summary build was captured from a dirty tracked worktree");
  }
  if (summary.build.world_id !== "new_york_overworld") {
    errors.push(
      `summary build world_id ${JSON.stringify(summary.build.world_id)} != "new_york_overworld"`,
    );
  }
  let expectedBuild: PureRunBuild | null = null;
  try {
    expectedBuild = capturePureFleetBuild(root);
  } catch (error) {
    errors.push(
      `could not capture current clean certification build: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (expectedBuild !== null && !isDeepStrictEqual(summary.build, expectedBuild)) {
    errors.push("summary build does not match the current certification build");
  }
  if (!Number.isSafeInteger(summary.seed_base + options.expectedCount - 1)) {
    errors.push("planned seed range exceeds safe integers");
  }

  let rawLines: string[];
  try {
    const manifestPath = requireContainedRegularFile(
      resolve(fleetDir, "manifest.jsonl"),
      fleetRootReal,
      "manifest.jsonl",
      artifacts,
    );
    rawLines = readFileSync(manifestPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (error) {
    return attachFleetValidity(
      invalidFilesystemResult(root, options.expectedCount, [
        `manifest.jsonl unreadable: ${error instanceof Error ? error.message : String(error)}`,
      ]),
      errors,
      {
        label: displayLabel,
        stamp: summary.stamp,
        fleet_dir: fleetDir,
        reports_dir: reportsDir,
        manifest_rows: 0,
      },
      summary.build,
    );
  }
  if (rawLines.length !== options.expectedCount) {
    errors.push(`manifest rows ${rawLines.length} != expected ${options.expectedCount}`);
  }

  const rowsBySeed = new Map<number, FleetManifestRow>();
  const reportPaths = new Set<string>();
  for (const [index, line] of rawLines.entries()) {
    const raw = parseJsonRejectingDuplicateKeys(line, `manifest row ${index + 1}`);
    if (!raw.ok) {
      errors.push(raw.reason);
      continue;
    }
    const parsed = (isAudited ? FleetManifestRowV8Schema : FleetManifestRowSchema).safeParse(
      raw.value,
    );
    if (!parsed.success) {
      errors.push(`manifest row ${index + 1} invalid: ${firstSchemaIssue(parsed.error)}`);
      continue;
    }
    const row = parsed.data as FleetManifestRow;
    if (isAudited) {
      if (!("resume_usage" in row)) {
        errors.push(`manifest row ${index + 1} invalid: audited row is missing resume_usage`);
        continue;
      }
      if (row.attempt_history.some((attempt) => !("usage" in attempt))) {
        errors.push(`manifest row ${index + 1} invalid: audited attempt is missing usage`);
        continue;
      }
    }
    if (row.planned_index !== index) {
      errors.push(
        `manifest row ${index + 1}: physical order does not match planned_index ${row.planned_index}`,
      );
    }
    if (rowsBySeed.has(row.seed)) errors.push(`manifest duplicate seed ${row.seed}`);
    else rowsBySeed.set(row.seed, row);
    const reportPath = resolve(row.report);
    const reportKey = reportPath;
    if (reportPaths.has(reportKey)) errors.push(`manifest duplicate report path ${row.report}`);
    reportPaths.add(reportKey);
  }

  for (const seed of rowsBySeed.keys()) {
    if (seed < summary.seed_base || seed >= summary.seed_base + options.expectedCount) {
      errors.push(`manifest contains unplanned seed ${seed}`);
    }
  }

  const normalizedRuns: StartingSliceEvaluationRun[] = [];
  let verifiedRows = 0;
  let resumedRows = 0;
  let failedRows = 0;
  let manifestTotalAttempts = 0;
  let manifestFailedAttempts = 0;
  let manifestTechnicalTimeouts = 0;
  let manifestReportRecoveredRuns = 0;
  let manifestReceiptBoundRuns = 0;
  const recomputedUsageRecords: unknown[] = [];
  const providerSessionIds = new Set<string>();
  const gameSessionIds = new Set<string>();
  const actualModels = new Set<string>();
  const referencedArchiveDirectories = new Set<string>();
  for (let plannedIndex = 0; plannedIndex < options.expectedCount; plannedIndex += 1) {
    const seed = summary.seed_base + plannedIndex;
    const row = rowsBySeed.get(seed);
    if (!row) {
      errors.push(`manifest missing planned seed ${seed}`);
      continue;
    }
    const rowErrorStart = errors.length;
    if (row.planned_index !== plannedIndex) {
      errors.push(
        `seed ${seed}: planned_index ${row.planned_index} != sorted seed index ${plannedIndex}`,
      );
    }
    const rowProvider = row.provider ?? "claude";
    if (rowProvider !== expectedProvider) {
      errors.push(`seed ${seed}: provider ${rowProvider} != summary provider ${expectedProvider}`);
    }
    if (row.model !== summary.model) {
      errors.push(`seed ${seed}: requested model ${row.model} != summary model ${summary.model}`);
    }
    if (row.run_seed !== seed) errors.push(`seed ${seed}: row run_seed differs`);
    if (!isDeepStrictEqual(row.build, summary.build)) {
      errors.push(`seed ${seed}: row build differs from summary build`);
    }
    if (row.report_recovered) {
      manifestReportRecoveredRuns += 1;
      errors.push(
        `seed ${seed}: ${options.cohortKind} cohort does not accept a report-recovered row`,
      );
    }
    if (row.report_receipt_bound === true) {
      manifestReceiptBoundRuns += 1;
      if (
        ![
          4,
          5,
          6,
          7,
          HISTORICAL_TRANSPORT_CODEX_ATTESTATION_SCHEMA_VERSION,
          PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION,
        ].includes(summary.model_attestation_schema_version)
      ) {
        errors.push(
          `seed ${seed}: receipt-bound row requires a receipt-aware Codex attestation schema`,
        );
      }
    }
    if (row.attempts !== row.attempt_history.length) {
      errors.push(
        `seed ${seed}: attempts ${row.attempts} != attempt_history length ${row.attempt_history.length}`,
      );
    }
    if (isAudited) {
      if (row.status === "skipped-resume") {
        if (row.resume_usage === undefined || row.resume_usage === null) {
          errors.push(`seed ${seed}: audited skipped-resume row is missing resume_usage`);
        } else {
          const expectedUsage = skippedResumeUsageRecord();
          if (!isDeepStrictEqual(row.resume_usage, expectedUsage)) {
            errors.push(`seed ${seed}: resume_usage differs from the explicit zero bucket`);
          }
          recomputedUsageRecords.push(expectedUsage);
        }
      } else if (row.resume_usage !== null) {
        errors.push(`seed ${seed}: audited launched row must use null resume_usage`);
      }
    }
    if (row.status === "skipped-resume") {
      errors.push(`seed ${seed}: ${options.cohortKind} row must be freshly verified, not resumed`);
    }
    if (row.attempts !== 1 || row.attempt_history.length !== 1) {
      errors.push(
        `seed ${seed}: ${options.cohortKind} row must contain exactly one launcher attempt`,
      );
    }
    for (const [attemptIndex, attempt] of row.attempt_history.entries()) {
      manifestTotalAttempts += 1;
      const expectedAttempt = attemptIndex + 1;
      const isTerminal = attemptIndex === row.attempt_history.length - 1;
      if (attempt.report_recovered) {
        errors.push(
          `seed ${seed} attempt ${attempt.attempt}: ${options.cohortKind} cohort does not accept report recovery`,
        );
      }
      if (attempt.report_receipt_bound === true && attempt.classification !== "verified") {
        errors.push(
          `seed ${seed} attempt ${attempt.attempt}: failed attempt cannot report receipt binding`,
        );
      }
      if (attempt.attempt !== expectedAttempt) {
        errors.push(
          `seed ${seed}: attempt_history entry ${expectedAttempt} has attempt ${attempt.attempt}`,
        );
      }
      if (attempt.classification === "verified") {
        if (isAudited && attempt.usage === undefined) {
          errors.push(`seed ${seed} attempt ${attempt.attempt}: audited attempt is missing usage`);
        }
        if (attempt.exit !== 0) {
          errors.push(`seed ${seed} attempt ${attempt.attempt}: verified attempt must exit 0`);
        }
        if (attempt.archive !== null) {
          errors.push(
            `seed ${seed} attempt ${attempt.attempt}: verified attempt must not be archived`,
          );
        }
        if (!isTerminal) {
          errors.push(`seed ${seed} attempt ${attempt.attempt}: verified attempt must be terminal`);
        }
      } else {
        manifestFailedAttempts += 1;
        if (attempt.classification === "technical_timeout") manifestTechnicalTimeouts += 1;
        if (attempt.exit === 0) {
          errors.push(`seed ${seed} attempt ${attempt.attempt}: failed attempt cannot exit 0`);
        }
        if (
          attempt.classification === "technical_timeout" &&
          attempt.exit !== 124 &&
          attempt.exit !== 137
        ) {
          errors.push(
            `seed ${seed} attempt ${attempt.attempt}: technical timeout must exit 124 or 137`,
          );
        }
        if (
          attempt.classification !== "technical_timeout" &&
          (attempt.exit === 124 || attempt.exit === 137)
        ) {
          errors.push(
            `seed ${seed} attempt ${attempt.attempt}: timeout exit must be classified technical_timeout`,
          );
        }
        if ((attempt.classification === "strict_stream_rejected") !== (attempt.exit === 43)) {
          errors.push(
            `seed ${seed} attempt ${attempt.attempt}: strict-stream rejection must use exit 43 and its exact classification`,
          );
        }
        if (attempt.report_recovered) {
          errors.push(
            `seed ${seed} attempt ${attempt.attempt}: failed attempt cannot report recovery`,
          );
        }
        if (attempt.archive === null) {
          errors.push(`seed ${seed} attempt ${attempt.attempt}: failed attempt archive is missing`);
        } else {
          const archiveBytes = validateAttemptArchive(
            fleetDir,
            fleetRootReal,
            seed,
            attempt,
            artifacts,
            errors,
            referencedArchiveDirectories,
          );
          if (isAudited) {
            if (attempt.usage === undefined) {
              errors.push(
                `seed ${seed} attempt ${attempt.attempt}: audited attempt is missing usage`,
              );
            }
            const names = attempt.archive.usage_artifacts;
            const prefix = basename(row.report, ".md");
            if (names === undefined) {
              errors.push(
                `seed ${seed} attempt ${attempt.attempt}: audited archive is missing usage_artifacts`,
              );
            } else if (
              (names.primary_envelope !== null && names.primary_envelope !== `${prefix}.json`) ||
              (names.provider_events !== null &&
                names.provider_events !== `${prefix}.codex.jsonl`) ||
              (names.primary_envelope !== null &&
                names.primary_envelope === names.provider_events) ||
              (names.primary_envelope !== null &&
                !attempt.archive.artifacts.some(
                  (artifact) => artifact.name === names.primary_envelope,
                )) ||
              (names.provider_events !== null &&
                !attempt.archive.artifacts.some(
                  (artifact) => artifact.name === names.provider_events,
                ))
            ) {
              errors.push(
                `seed ${seed} attempt ${attempt.attempt}: audited usage_artifacts do not bind canonical archived evidence`,
              );
            } else {
              const expectedUsage = usageRecordFromFailedAttempt({
                archivedPrimaryEnvelopeText:
                  names.primary_envelope === null
                    ? null
                    : (archiveBytes?.get(names.primary_envelope)?.toString("utf8") ?? ""),
                providerEventsText:
                  names.provider_events === null || archiveBytes === null
                    ? null
                    : (archiveBytes.get(names.provider_events)?.toString("utf8") ?? null),
              });
              if (!isDeepStrictEqual(attempt.usage, expectedUsage)) {
                errors.push(
                  `seed ${seed} attempt ${attempt.attempt}: usage differs from archived evidence`,
                );
              }
              recomputedUsageRecords.push(expectedUsage);
            }
          }
        }
      }
    }
    const rowStatus = (row as unknown as { status: "verified" | "skipped-resume" | "failed" })
      .status;
    if (isAudited && rowStatus === "failed") {
      failedRows += 1;
      errors.push(`seed ${seed}: ${options.cohortKind} cohort contains a failed slot`);
      continue;
    }
    if (row.status === "verified") {
      verifiedRows += 1;
      if (row.attempts < 1) errors.push(`seed ${seed}: verified row must have attempts >= 1`);
      const terminalAttempt = row.attempt_history.at(-1);
      if (terminalAttempt?.classification !== "verified") {
        errors.push(`seed ${seed}: verified row must end in a verified attempt`);
      } else if (terminalAttempt.report_recovered !== row.report_recovered) {
        errors.push(`seed ${seed}: terminal attempt report_recovered differs from row`);
      } else if (
        (terminalAttempt.report_receipt_bound ?? false) !== (row.report_receipt_bound ?? false)
      ) {
        errors.push(`seed ${seed}: terminal attempt report_receipt_bound differs from row`);
      }
    } else {
      resumedRows += 1;
      if (row.attempts !== 0) errors.push(`seed ${seed}: skipped-resume row must have 0 attempts`);
      if (row.attempt_history.length !== 0) {
        errors.push(`seed ${seed}: skipped-resume row must have empty attempt_history`);
      }
    }

    const reportPath = reportPathInside(reportsDir, row.report);
    if (reportPath === null) {
      errors.push(`seed ${seed}: report is not inside summary reportsDir`);
      continue;
    }
    if (extname(reportPath) !== ".md") {
      errors.push(`seed ${seed}: report path must end in .md`);
      continue;
    }
    const expectedReportBasename = `${summary.stamp}_overworld_seed${seed}.md`;
    if (basename(reportPath) !== expectedReportBasename) {
      errors.push(
        `seed ${seed}: report basename ${JSON.stringify(basename(reportPath))} != fresh cohort basename ${JSON.stringify(expectedReportBasename)}`,
      );
    }
    const runArtifactPaths = pureFleetRunArtifactPaths(reportPath);
    const sidecarPath = runArtifactPaths.runSidecar;
    const attestationPath = pureFleetAttestationPathFor(reportPath);
    let safeReportPath: string;
    let safeSidecarPath: string;
    let safeAttestationPath: string;
    let reportBytes: Buffer;
    let sidecarBytes: Buffer;
    let runEvidenceBytes: Buffer;
    let primaryEnvelopeBytes: Buffer;
    let initialReportBytes: Buffer | null = null;
    let receiptBindingBytes: Buffer | null = null;
    let recoveryMetadataBytes: Buffer | null = null;
    let recoveryEnvelopeBytes: Buffer | null = null;
    let providerEventsBytes: Buffer | null = null;
    let providerRolloutBytes: Buffer | null = null;
    let providerCaptureBytes: Buffer | null = null;
    let reportText: string;
    let sidecarText: string;
    let attestationText: string;
    try {
      safeReportPath = requireContainedRegularFile(
        reportPath,
        reportsRootReal,
        `seed ${seed} report`,
        artifacts,
      );
      safeSidecarPath = requireContainedRegularFile(
        sidecarPath,
        reportsRootReal,
        `seed ${seed} run sidecar`,
        artifacts,
      );
      safeAttestationPath = requireContainedRegularFile(
        attestationPath,
        reportsRootReal,
        `seed ${seed} model attestation`,
        artifacts,
      );
      const safeRunEvidencePath = requireContainedRegularFile(
        runArtifactPaths.runEvidence,
        reportsRootReal,
        `seed ${seed} raw run evidence`,
        artifacts,
      );
      const safePrimaryEnvelopePath = requireContainedRegularFile(
        runArtifactPaths.primaryEnvelope,
        reportsRootReal,
        `seed ${seed} primary Claude envelope`,
        artifacts,
      );
      reportBytes = readFileSync(safeReportPath);
      sidecarBytes = readFileSync(safeSidecarPath);
      runEvidenceBytes = readFileSync(safeRunEvidencePath);
      primaryEnvelopeBytes = readFileSync(safePrimaryEnvelopePath);
      const providerEntries = [
        ["Codex provider events", runArtifactPaths.providerEvents],
        ["Codex rollout", runArtifactPaths.providerRollout],
        ["Codex capture receipt", runArtifactPaths.providerCapture],
      ] as const;
      if (rowProvider === "codex") {
        providerEventsBytes = readFileSync(
          requireContainedRegularFile(
            runArtifactPaths.providerEvents,
            reportsRootReal,
            `seed ${seed} Codex provider events`,
            artifacts,
          ),
        );
        providerRolloutBytes = readFileSync(
          requireContainedRegularFile(
            runArtifactPaths.providerRollout,
            reportsRootReal,
            `seed ${seed} Codex rollout`,
            artifacts,
          ),
        );
        providerCaptureBytes = readFileSync(
          requireContainedRegularFile(
            runArtifactPaths.providerCapture,
            reportsRootReal,
            `seed ${seed} Codex capture receipt`,
            artifacts,
          ),
        );
      } else if (providerEntries.some(([, path]) => pathEntryExists(path))) {
        throw new Error("Claude fleet slot contains unexpected Codex provider artifacts");
      }
      reportText = reportBytes.toString("utf8");
      sidecarText = sidecarBytes.toString("utf8");
      attestationText = readFileSync(safeAttestationPath, "utf8");
      if (rowProvider === "codex") {
        const bindingPresence = [
          pathEntryExists(runArtifactPaths.initialReport),
          pathEntryExists(runArtifactPaths.receiptBinding),
        ];
        if (bindingPresence.some(Boolean) && !bindingPresence.every(Boolean)) {
          throw new Error("Codex receipt-binding artifacts must be all present or all absent");
        }
        if ((row.report_receipt_bound ?? false) !== bindingPresence.every(Boolean)) {
          errors.push(
            `seed ${seed}: manifest receipt-binding status differs from durable artifacts`,
          );
        }
        if (
          pathEntryExists(runArtifactPaths.recoveryMetadata) ||
          pathEntryExists(runArtifactPaths.recoveryEnvelope)
        ) {
          throw new Error("Codex fleet slot contains report recovery artifacts");
        }
        if (bindingPresence.every(Boolean)) {
          initialReportBytes = readFileSync(
            requireContainedRegularFile(
              runArtifactPaths.initialReport,
              reportsRootReal,
              `seed ${seed} initial Codex report`,
              artifacts,
            ),
          );
          receiptBindingBytes = readFileSync(
            requireContainedRegularFile(
              runArtifactPaths.receiptBinding,
              reportsRootReal,
              `seed ${seed} receipt binding metadata`,
              artifacts,
            ),
          );
        }
      } else {
        const recoveryEntries = [
          ["initial report", runArtifactPaths.initialReport],
          ["recovery metadata", runArtifactPaths.recoveryMetadata],
          ["recovery Claude envelope", runArtifactPaths.recoveryEnvelope],
        ] as const;
        const recoveryPresence = recoveryEntries.map(([, path]) => pathEntryExists(path));
        if (recoveryPresence.some(Boolean) && !recoveryPresence.every(Boolean)) {
          throw new Error("report recovery artifacts must be all present or all absent");
        }
        if (row.report_recovered !== recoveryPresence.every(Boolean)) {
          errors.push(`seed ${seed}: manifest recovery status differs from durable artifacts`);
        }
        if (pathEntryExists(runArtifactPaths.receiptBinding)) {
          throw new Error("Claude fleet slot contains receipt binding metadata");
        }
        if (recoveryPresence.every(Boolean)) {
          errors.push(
            `seed ${seed}: ${options.cohortKind} cohort does not accept report-recovery artifacts`,
          );
          const safeInitialReportPath = requireContainedRegularFile(
            runArtifactPaths.initialReport,
            reportsRootReal,
            `seed ${seed} initial report`,
            artifacts,
          );
          const safeRecoveryMetadataPath = requireContainedRegularFile(
            runArtifactPaths.recoveryMetadata,
            reportsRootReal,
            `seed ${seed} recovery metadata`,
            artifacts,
          );
          const safeRecoveryEnvelopePath = requireContainedRegularFile(
            runArtifactPaths.recoveryEnvelope,
            reportsRootReal,
            `seed ${seed} recovery Claude envelope`,
            artifacts,
          );
          initialReportBytes = readFileSync(safeInitialReportPath);
          recoveryMetadataBytes = readFileSync(safeRecoveryMetadataPath);
          recoveryEnvelopeBytes = readFileSync(safeRecoveryEnvelopePath);
        }
      }
    } catch (error) {
      errors.push(
        `seed ${seed}: authenticated run artifact unsafe or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const parsedSidecar = parseBlindRunSidecar(sidecarText);
    if (!parsedSidecar.ok) {
      errors.push(`seed ${seed}: ${parsedSidecar.reason}`);
      continue;
    }
    const sidecar = parsedSidecar.sidecar;
    if (sidecar.play_mode !== "pure" || sidecar.schema_version !== 2) {
      errors.push(`seed ${seed}: sidecar is not pure evidence schema v2`);
      continue;
    }
    if (
      sidecar.receipt.contractVersion === 3 &&
      sidecar.receipt.exitReasons.includes("character_died")
    ) {
      errors.push(
        `seed ${seed}: character-death receipt is valid blind evidence but cannot certify the starting slice`,
      );
    }
    const artifactValidation = validatePureFleetRunArtifactBytes(
      {
        report: reportBytes,
        runSidecar: sidecarBytes,
        runEvidence: runEvidenceBytes,
        primaryEnvelope: primaryEnvelopeBytes,
        initialReport: initialReportBytes,
        receiptBinding: receiptBindingBytes,
        recoveryMetadata: recoveryMetadataBytes,
        recoveryEnvelope: recoveryEnvelopeBytes,
        providerEvents: providerEventsBytes,
        providerRollout: providerRolloutBytes,
        providerCapture: providerCaptureBytes,
      },
      {
        seed,
        provider: rowProvider,
        model: row.model,
        build: { ...summary.build, tracked_worktree_clean: true },
        // Recovery is independently forbidden for pilot/authority cohorts. Let
        // the artifact path authenticate it fully so the certifier reports that
        // stronger existing rejection instead of short-circuiting on a marker
        // that historical recovery could not have emitted.
        requireStructuredIssueConsistency: row.report_recovered !== true,
      },
    );
    if (!artifactValidation.ok) {
      errors.push(
        `seed ${seed}: authenticated run artifacts invalid: ${artifactValidation.reason}`,
      );
      continue;
    }
    const artifactFacts = artifactValidation.facts;
    if (isAudited && row.status === "verified") {
      const terminalAttempt = row.attempt_history.at(-1);
      const expectedUsage = usageRecordFromVerifiedPrimaryEnvelope(
        primaryEnvelopeBytes.toString("utf8"),
      );
      if (!isDeepStrictEqual(terminalAttempt?.usage, expectedUsage)) {
        errors.push(
          `seed ${seed}: verified attempt usage differs from authenticated primary envelope`,
        );
      }
      recomputedUsageRecords.push(expectedUsage);
    }
    const normalizedProviderSessionId = artifactFacts.provider_session_id.toLowerCase();
    if (providerSessionIds.has(normalizedProviderSessionId)) {
      errors.push(
        `seed ${seed}: provider session UUID ${artifactFacts.provider_session_id} is reused by another fleet slot`,
      );
    } else {
      providerSessionIds.add(normalizedProviderSessionId);
    }
    if (gameSessionIds.has(artifactFacts.game_session_id)) {
      errors.push(
        `seed ${seed}: game session ID ${artifactFacts.game_session_id} is reused by another fleet slot`,
      );
    } else {
      gameSessionIds.add(artifactFacts.game_session_id);
    }
    actualModels.add(artifactFacts.actual_model);
    const parsedAttestation = parsePureFleetAttestation(attestationText);
    if (!parsedAttestation.ok) {
      errors.push(`seed ${seed}: ${parsedAttestation.reason}`);
      continue;
    }
    const attestation = parsedAttestation.attestation;
    const attestationRecord = attestation as unknown as Record<string, unknown>;
    if (summary.model_attestation_schema_version === PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION) {
      // Current (v9) evidence must carry exactly the transport its model's CATALOG
      // declares, recorded under the field that transport's `kind` dictates.
      //
      // This was an if/else chain naming Spark and Terra, with everything else falling
      // through to the code-mode branch. That fall-through is what made it a forward
      // gate rather than a check: a newly certified direct-MCP model would have been
      // required to produce strict-code-mode evidence it never generates, and the
      // failure would have read "attestation lacks exact strict-code-mode-v2 evidence"
      // for a run that was correct.
      //
      // A model with no declared transport is treated as code mode, exactly as the old
      // final `else` did.
      const declaredTransport = certifiedModelTransport("codex", row.model);
      if (declaredTransport !== null && declaredTransport.kind === "direct_mcp") {
        if (
          artifactFacts.transport_contract !== declaredTransport.contract ||
          artifactFacts.code_mode_contract !== null ||
          attestationRecord.transport_contract !== declaredTransport.contract ||
          Object.hasOwn(attestationRecord, "code_mode_contract")
        ) {
          errors.push(
            `seed ${seed}: current ${row.model} attestation lacks exact ${declaredTransport.contract} evidence`,
          );
        }
      } else if (
        artifactFacts.code_mode_contract !== PURE_FLEET_CODE_MODE_CONTRACT ||
        artifactFacts.transport_contract !== null ||
        attestationRecord.code_mode_contract !== PURE_FLEET_CODE_MODE_CONTRACT ||
        Object.hasOwn(attestationRecord, "transport_contract")
      ) {
        errors.push(
          `seed ${seed}: current ${row.model} attestation lacks exact ${PURE_FLEET_CODE_MODE_CONTRACT} evidence`,
        );
      }
    } else if (
      summary.model_attestation_schema_version ===
      HISTORICAL_TRANSPORT_CODEX_ATTESTATION_SCHEMA_VERSION
    ) {
      if (row.model === SPARK_DIRECT_MCP_MODEL) {
        if (
          artifactFacts.transport_contract !== SPARK_DIRECT_MCP_TRANSPORT_CONTRACT ||
          artifactFacts.code_mode_contract !== null ||
          attestationRecord.transport_contract !== SPARK_DIRECT_MCP_TRANSPORT_CONTRACT ||
          Object.hasOwn(attestationRecord, "code_mode_contract")
        ) {
          errors.push(
            `seed ${seed}: historical v8 Spark attestation lacks exact ${SPARK_DIRECT_MCP_TRANSPORT_CONTRACT} evidence`,
          );
        }
      } else if (
        artifactFacts.code_mode_contract !== PURE_FLEET_CODE_MODE_CONTRACT ||
        artifactFacts.transport_contract !== null ||
        attestationRecord.code_mode_contract !== PURE_FLEET_CODE_MODE_CONTRACT ||
        Object.hasOwn(attestationRecord, "transport_contract")
      ) {
        errors.push(
          `seed ${seed}: historical v8 ${row.model} attestation lacks exact ${PURE_FLEET_CODE_MODE_CONTRACT} evidence`,
        );
      }
    } else if (artifactFacts.transport_contract !== null) {
      errors.push(`seed ${seed}: direct-MCP evidence requires attestation v8 or current v9`);
    }
    if (attestation.schema_version !== summary.model_attestation_schema_version) {
      errors.push(
        `seed ${seed}: model attestation schema v${attestation.schema_version} differs from summary v${summary.model_attestation_schema_version}`,
      );
    }
    if (!isDeepStrictEqual(attestation, row.model_attestation)) {
      errors.push(`seed ${seed}: adjacent model attestation differs from manifest row`);
    }
    if (attestation.run_seed !== seed) {
      errors.push(`seed ${seed}: model attestation run_seed differs`);
    }
    if (attestation.model !== row.model) {
      errors.push(`seed ${seed}: model attestation model differs from planned row model`);
    }
    if (!isDeepStrictEqual(attestation.build, summary.build)) {
      errors.push(`seed ${seed}: model attestation build differs from summary build`);
    }
    if (attestation.game_session_id !== artifactFacts.game_session_id) {
      errors.push(`seed ${seed}: model attestation game_session_id differs from run evidence`);
    }
    const attestedProvider = attestation.schema_version === 2 ? "claude" : attestation.provider;
    const attestedProviderSession =
      attestation.schema_version === 2
        ? attestation.claude_session_id
        : attestation.provider_session_id;
    if (attestedProvider !== artifactFacts.provider) {
      errors.push(`seed ${seed}: model attestation provider differs from authenticated artifacts`);
    }
    if (attestedProviderSession !== artifactFacts.provider_session_id) {
      errors.push(
        `seed ${seed}: model attestation provider session differs from authenticated artifacts`,
      );
    }
    if (attestation.actual_model !== artifactFacts.actual_model) {
      errors.push(`seed ${seed}: model attestation actual_model differs from primary envelope`);
    }
    if (
      rowProvider === "codex" &&
      attestation.schema_version !== 2 &&
      (attestation.actual_provider !== artifactFacts.actual_provider ||
        attestation.reasoning_effort !== artifactFacts.reasoning_effort ||
        attestation.provider_turn_id !== artifactFacts.provider_turn_id ||
        attestation.provider_cwd !== artifactFacts.provider_cwd)
    ) {
      errors.push(`seed ${seed}: model attestation Codex rollout facts differ`);
    }
    if (
      (attestation.schema_version === HISTORICAL_TRANSPORT_CODEX_ATTESTATION_SCHEMA_VERSION ||
        attestation.schema_version === PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION) &&
      (authenticatedCodexClient === null ||
        attestation.codex_cli_version !== authenticatedCodexClient.cli_version ||
        attestation.codex_client_authority_sha256 !== authenticatedCodexClient.authority_sha256)
    ) {
      errors.push(`seed ${seed}: model attestation Codex client authority differs`);
    }
    if (attestation.report_recovered !== artifactFacts.report_recovered) {
      errors.push(`seed ${seed}: model attestation recovery status differs from run artifacts`);
    }
    const attestationReceiptBound =
      attestation.schema_version >= 4 && "report_receipt_bound" in attestation
        ? attestation.report_receipt_bound
        : false;
    if (attestationReceiptBound !== artifactFacts.report_receipt_bound) {
      errors.push(
        `seed ${seed}: model attestation receipt-binding status differs from run artifacts`,
      );
    }
    if (attestation.report_recovered) {
      errors.push(
        `seed ${seed}: ${options.cohortKind} cohort does not accept a report-recovered attestation`,
      );
    }
    if (artifactFacts.report_recovered) {
      errors.push(
        `seed ${seed}: ${options.cohortKind} cohort does not accept authenticated report-recovery facts`,
      );
    }
    if (row.report_recovered !== artifactFacts.report_recovered) {
      errors.push(
        `seed ${seed}: manifest recovery status differs from authenticated run artifacts`,
      );
    }
    if ((row.report_receipt_bound ?? false) !== artifactFacts.report_receipt_bound) {
      errors.push(
        `seed ${seed}: manifest receipt-binding status differs from authenticated run artifacts`,
      );
    }
    for (const [field, digest] of Object.entries(artifactFacts.hashes)) {
      if (!(field in attestation)) {
        if (digest === null) continue;
        errors.push(`seed ${seed}: model attestation omits ${field}`);
      } else if ((attestation as Record<string, unknown>)[field] !== digest) {
        errors.push(`seed ${seed}: model attestation ${field} differs from artifact bytes`);
      }
    }
    if (sidecar.run_seed !== seed) errors.push(`seed ${seed}: sidecar run_seed differs`);
    if (!isDeepStrictEqual(sidecar.build, summary.build)) {
      errors.push(`seed ${seed}: sidecar build differs from summary build`);
    }
    if (!isDeepStrictEqual(sidecar.quest_outcomes, row.quest_outcomes)) {
      errors.push(`seed ${seed}: sidecar quest outcomes differ from manifest row`);
    }
    if (sidecar.receipt.contractVersion !== 3) {
      errors.push(`seed ${seed}: sidecar receipt is not journey contract v3`);
    }
    if (row.accepted_decisions !== sidecar.receipt.acceptedDecisions) {
      errors.push(`seed ${seed}: accepted decision metadata differs from sidecar`);
    }
    if (!isDeepStrictEqual(row.retention_choices, sidecar.receipt.retentionHistory)) {
      errors.push(`seed ${seed}: retention choice metadata differs from sidecar`);
    }
    if (row.checkpoint !== sidecar.receipt.checkpoint) {
      errors.push(`seed ${seed}: checkpoint metadata differs from sidecar`);
    }
    if (row.exit_reason !== sidecar.receipt.exitReason) {
      errors.push(`seed ${seed}: exit reason metadata differs from sidecar`);
    }
    if (!isDeepStrictEqual(row.exit_reasons, sidecar.receipt.exitReasons)) {
      errors.push(`seed ${seed}: exit reasons metadata differs from sidecar`);
    }
    if (row.receipt_hash !== sidecar.receipt.receiptHash) {
      errors.push(`seed ${seed}: receipt hash metadata differs from sidecar`);
    }
    if (attestation.game_session_id !== sidecar.session_id) {
      errors.push(`seed ${seed}: model attestation game_session_id differs from sidecar`);
    }
    if (attestation.receipt_hash !== sidecar.receipt.receiptHash) {
      errors.push(`seed ${seed}: model attestation receipt_hash differs from sidecar`);
    }

    const verification = verifyBlindReportText(reportText, {
      requiredPlayMode: "pure",
      requireStructuredIssueConsistency: row.report_recovered !== true,
      runSidecar: sidecar,
    });
    if (!verification.ok) {
      errors.push(`seed ${seed}: report verification failed: ${verification.reason}`);
      continue;
    }
    if (!isPureExitInterviewV2(verification.interview)) {
      errors.push(`seed ${seed}: verified report did not yield a pure v2 interview`);
      continue;
    }
    if (errors.length !== rowErrorStart) continue;
    try {
      normalizedRuns.push(
        normalizeVerifiedRun(
          relativeReportRef(reportsDir, reportPath),
          verification.interview,
          sidecar.quest_outcomes,
        ),
      );
    } catch (error) {
      errors.push(
        `seed ${seed}: could not normalize verified run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (verifiedRows !== summary.verified) {
    errors.push(`manifest verified rows ${verifiedRows} != summary ${summary.verified}`);
  }
  if (resumedRows !== summary["skipped-resume"]) {
    errors.push(
      `manifest skipped-resume rows ${resumedRows} != summary ${summary["skipped-resume"]}`,
    );
  }
  if (failedRows !== summary.failed) {
    errors.push(`manifest failed rows ${failedRows} != summary ${summary.failed}`);
  }
  if (manifestTotalAttempts !== summary.total_attempts) {
    errors.push(
      `manifest total attempts ${manifestTotalAttempts} != summary ${summary.total_attempts}`,
    );
  }
  if (manifestFailedAttempts !== summary.failed_attempts) {
    errors.push(
      `manifest failed attempts ${manifestFailedAttempts} != summary ${summary.failed_attempts}`,
    );
  }
  if (manifestTechnicalTimeouts !== summary.technical_timeouts) {
    errors.push(
      `manifest technical timeouts ${manifestTechnicalTimeouts} != summary ${summary.technical_timeouts}`,
    );
  }
  if (manifestReportRecoveredRuns !== summary.report_recovered_runs) {
    errors.push(
      `manifest report-recovered runs ${manifestReportRecoveredRuns} != summary ${summary.report_recovered_runs}`,
    );
  }
  if (manifestReceiptBoundRuns !== (summary.receipt_bound_runs ?? 0)) {
    errors.push(
      `manifest receipt-bound runs ${manifestReceiptBoundRuns} != summary ${summary.receipt_bound_runs ?? 0}`,
    );
  }
  if (isAudited) {
    const audited = summary as
      | z.infer<typeof FleetSummaryV8Schema>
      | z.infer<typeof FleetSummaryV9Schema>;
    let recomputedUsage: unknown;
    try {
      recomputedUsage = summarizeFleetUsage(recomputedUsageRecords);
      if (!isDeepStrictEqual(audited.usage, recomputedUsage)) {
        errors.push("summary usage differs from independently recomputed attempt usage");
      }
    } catch (error) {
      errors.push(
        `could not summarize audited usage: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      audited.usage.attempt_count !== audited.total_attempts + audited["skipped-resume"] ||
      audited.usage.launched_attempt_count !== audited.total_attempts ||
      audited.usage.skipped_resume_count !== audited["skipped-resume"] ||
      audited.usage.measured_attempt_count + audited.usage.unrecoverable_attempt_count !==
        audited.total_attempts ||
      audited.usage.complete !== (audited.usage.unrecoverable_attempt_count === 0)
    ) {
      errors.push("audited summary usage count arithmetic is inconsistent");
    }
    if (
      !audited.usage.complete ||
      audited.usage.measured_attempt_count !== options.expectedCount ||
      audited.usage.unrecoverable_attempt_count !== 0 ||
      audited.usage.skipped_resume_count !== 0
    ) {
      errors.push(
        `current ${options.cohortKind} cohort requires complete measured no-resume audited usage`,
      );
    }
  }
  if (actualModels.size !== 1) {
    errors.push(
      `authenticated ${options.cohortKind} cohort must use one exact actual_model string; found ${JSON.stringify([...actualModels].sort(compareStrings))}`,
    );
  }
  try {
    const physicalArchiveDirectories = discoverAttemptArchiveDirectories(fleetDir, fleetRootReal);
    const indexedArchiveDirectories = [...referencedArchiveDirectories].sort(compareStrings);
    if (!isDeepStrictEqual(physicalArchiveDirectories, indexedArchiveDirectories)) {
      errors.push("physical failed-attempt archive directories differ from manifest history");
    }
  } catch (error) {
    errors.push(
      `failed-attempt archive tree unsafe or unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = evaluateStartingSliceRuns({
    root,
    runs: normalizedRuns,
    expectedCount: options.expectedCount,
  });
  const attached = attachFleetValidity(
    result,
    errors,
    {
      label: displayLabel,
      stamp: summary.stamp,
      fleet_dir: fleetDir,
      reports_dir: reportsDir,
      manifest_rows: rawLines.length,
    },
    summary.build,
  );
  return {
    ...attached,
    authenticated_actual_model: actualModels.size === 1 ? ([...actualModels][0] ?? null) : null,
  };
}

/** Authenticate and certify the fixed 100-player authority cohort. */
export function certifyStartingSliceAuthority(
  options: CertifyStartingSliceAuthorityOptions,
): StartingSliceAuthorityResult {
  const result = validateAuthenticatedStartingSliceCohort({
    root: options.root,
    fleetDir: options.fleetDir,
    cohortKind: "authority",
    expectedCount: STARTING_SLICE_AUTHORITY_COUNT,
  });
  return {
    ...result,
    cohort_kind: "authority",
    expected_count: STARTING_SLICE_AUTHORITY_COUNT,
    authority_certified: result.passed,
  };
}

/** Authenticate the fixed 10-player homogeneous provider/model pilot without granting authority. */
export function validateStartingSlicePilot(
  options: ValidateStartingSlicePilotOptions,
): StartingSlicePilotResult {
  const result = validateAuthenticatedStartingSliceCohort({
    root: options.root,
    fleetDir: options.fleetDir,
    cohortKind: "pilot",
    expectedCount: STARTING_SLICE_PILOT_COUNT,
  });
  const pilot = pilotEvaluationFor(result);
  return {
    ...result,
    cohort_kind: "pilot",
    expected_count: STARTING_SLICE_PILOT_COUNT,
    authority_certified: false,
    pilot_passed: pilot.pilot_passed,
    pilot_gate_failures: pilot.pilot_gate_failures,
    pilot_gates: pilot.pilot_gates,
  };
}

/** Human-readable source identity used by thin CLI wrappers. */
export function startingSliceFleetDisplayName(result: StartingSliceCertificationResult): string {
  return result.fleet === null ? "starting-slice evaluation" : result.fleet.label;
}
