import { z } from "zod";
import { PureRunBuildSchema } from "../blind/run_evidence.js";
import { parseJsonRejectingDuplicateKeys } from "../blind/strict_json.js";
import { CertifiedCodexModelSchema } from "./fleet_run_artifacts.js";
import { certifiedFleetModels } from "../blind/providers.js";
// @ts-expect-error -- frozen v9 profile set is intentionally plain ESM, read by the
// runner-side modules and this layer from ONE definition.
import { acceptedCodexProfiles } from "../../blind-tester/frozen-v9-codex-profiles.mjs";

/** One accepted (model, contract, version) shape for a current-generation attestation. */
interface AcceptedCodexProfile {
  model: string;
  kind: "direct_mcp" | "code_mode";
  contract: string;
  requiredCliVersion: string | null;
}

export const PURE_FLEET_ATTESTATION_SCHEMA_VERSION = 2;
export const HISTORICAL_PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION = 3;
export const HISTORICAL_RECEIPT_BOUND_CODEX_ATTESTATION_SCHEMA_VERSION = 4;
export const HISTORICAL_STRICT_CODEX_ATTESTATION_SCHEMA_VERSION = 5;
export const HISTORICAL_CODE_MODE_CODEX_ATTESTATION_SCHEMA_VERSION = 6;
export const HISTORICAL_CLIENT_BOUND_CODEX_ATTESTATION_SCHEMA_VERSION = 7;
export const HISTORICAL_TRANSPORT_CODEX_ATTESTATION_SCHEMA_VERSION = 8;
export const PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION = 9;
const HISTORICAL_PURE_FLEET_CODE_MODE_CONTRACT = "strict-code-mode-v1" as const;
export const PURE_FLEET_CODE_MODE_CONTRACT = "strict-code-mode-v2" as const;
export const PURE_FLEET_SPARK_DIRECT_MCP_TRANSPORT_CONTRACT = "spark-direct-mcp-v1" as const;
export const PURE_FLEET_GAME_DIRECT_MCP_TRANSPORT_CONTRACT = "game-direct-mcp-v1" as const;
export const PURE_FLEET_SPARK_DIRECT_MCP_CODEX_CLI_VERSION = "0.146.0" as const;
export const PURE_FLEET_GAME_DIRECT_MCP_CODEX_CLI_VERSION = "0.146.0" as const;

const PureFleetClaudeAttestationSchema = z
  .object({
    schema_version: z.literal(PURE_FLEET_ATTESTATION_SCHEMA_VERSION),
    run_seed: z.number().int().safe(),
    model: z.enum(["haiku", "sonnet", "opus"]),
    persona: z.literal("default"),
    target: z.literal("overworld"),
    play_mode: z.literal("pure"),
    start_surface: z.literal("fresh_overworld"),
    build: PureRunBuildSchema.extend({ tracked_worktree_clean: z.literal(true) }),
    game_session_id: z.string().min(1),
    claude_session_id: z.string().uuid(),
    actual_model: z.string().min(1),
    report_recovered: z.boolean(),
    receipt_hash: z.string().regex(/^[0-9a-f]{64}$/),
    report_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    run_sidecar_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    run_evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    primary_envelope_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    initial_report_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    recovery_metadata_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    recovery_envelope_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict();

const HistoricalPureFleetCodexAttestationSchema = z
  .object({
    schema_version: z.literal(HISTORICAL_PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION),
    provider: z.literal("codex"),
    run_seed: z.number().int().safe(),
    model: CertifiedCodexModelSchema,
    persona: z.literal("default"),
    target: z.literal("overworld"),
    play_mode: z.literal("pure"),
    start_surface: z.literal("fresh_overworld"),
    build: PureRunBuildSchema.extend({ tracked_worktree_clean: z.literal(true) }),
    game_session_id: z.string().min(1),
    provider_session_id: z.string().uuid(),
    actual_provider: z.literal("openai"),
    actual_model: CertifiedCodexModelSchema,
    reasoning_effort: z.literal("xhigh"),
    provider_turn_id: z.string().uuid(),
    provider_cwd: z.string().min(1),
    report_recovered: z.literal(false),
    receipt_hash: z.string().regex(/^[0-9a-f]{64}$/),
    report_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    run_sidecar_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    run_evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    primary_envelope_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    provider_events_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    provider_rollout_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    provider_capture_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    initial_report_sha256: z.null(),
    recovery_metadata_sha256: z.null(),
    recovery_envelope_sha256: z.null(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actual_model !== value.model) {
      context.addIssue({
        code: "custom",
        path: ["actual_model"],
        message: "actual Codex rollout model must equal the exact planned model",
      });
    }
  });

const HistoricalReceiptBoundPureFleetCodexAttestationSchema = z
  .object({
    schema_version: z.literal(HISTORICAL_RECEIPT_BOUND_CODEX_ATTESTATION_SCHEMA_VERSION),
    provider: z.literal("codex"),
    run_seed: z.number().int().safe(),
    model: CertifiedCodexModelSchema,
    persona: z.literal("default"),
    target: z.literal("overworld"),
    play_mode: z.literal("pure"),
    start_surface: z.literal("fresh_overworld"),
    build: PureRunBuildSchema.extend({ tracked_worktree_clean: z.literal(true) }),
    game_session_id: z.string().min(1),
    provider_session_id: z.string().uuid(),
    actual_provider: z.literal("openai"),
    actual_model: CertifiedCodexModelSchema,
    reasoning_effort: z.literal("xhigh"),
    provider_turn_id: z.string().uuid(),
    provider_cwd: z.string().min(1),
    report_recovered: z.literal(false),
    report_receipt_bound: z.boolean(),
    receipt_hash: z.string().regex(/^[0-9a-f]{64}$/),
    report_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    run_sidecar_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    run_evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    primary_envelope_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    provider_events_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    provider_rollout_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    provider_capture_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    initial_report_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    receipt_binding_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    recovery_metadata_sha256: z.null(),
    recovery_envelope_sha256: z.null(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actual_model !== value.model) {
      context.addIssue({
        code: "custom",
        path: ["actual_model"],
        message: "actual Codex rollout model must equal the exact planned model",
      });
    }
    if (
      value.report_receipt_bound !==
      (value.initial_report_sha256 !== null && value.receipt_binding_sha256 !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["report_receipt_bound"],
        message: "receipt-bound status must match its original report and binding metadata hashes",
      });
    }
    if ((value.initial_report_sha256 === null) !== (value.receipt_binding_sha256 === null)) {
      context.addIssue({
        code: "custom",
        path: ["receipt_binding_sha256"],
        message: "receipt-binding artifact hashes must be both present or both absent",
      });
    }
  });

const HistoricalStrictPureFleetCodexAttestationSchema = z
  .object({
    schema_version: z.literal(HISTORICAL_STRICT_CODEX_ATTESTATION_SCHEMA_VERSION),
    provider: z.literal("codex"),
    code_mode_contract: z.literal(HISTORICAL_PURE_FLEET_CODE_MODE_CONTRACT),
    run_seed: z.number().int().safe(),
    model: CertifiedCodexModelSchema,
    persona: z.literal("default"),
    target: z.literal("overworld"),
    play_mode: z.literal("pure"),
    start_surface: z.literal("fresh_overworld"),
    build: PureRunBuildSchema.extend({ tracked_worktree_clean: z.literal(true) }),
    game_session_id: z.string().min(1),
    provider_session_id: z.string().uuid(),
    actual_provider: z.literal("openai"),
    actual_model: CertifiedCodexModelSchema,
    reasoning_effort: z.literal("xhigh"),
    provider_turn_id: z.string().uuid(),
    provider_cwd: z.string().min(1),
    report_recovered: z.literal(false),
    report_receipt_bound: z.boolean(),
    receipt_hash: z.string().regex(/^[0-9a-f]{64}$/),
    report_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    run_sidecar_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    run_evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    primary_envelope_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    provider_events_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    provider_rollout_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    provider_capture_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    initial_report_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    receipt_binding_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    recovery_metadata_sha256: z.null(),
    recovery_envelope_sha256: z.null(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actual_model !== value.model) {
      context.addIssue({
        code: "custom",
        path: ["actual_model"],
        message: "actual Codex rollout model must equal the exact planned model",
      });
    }
    if (
      value.report_receipt_bound !==
      (value.initial_report_sha256 !== null && value.receipt_binding_sha256 !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["report_receipt_bound"],
        message: "receipt-bound status must match its original report and binding metadata hashes",
      });
    }
    if ((value.initial_report_sha256 === null) !== (value.receipt_binding_sha256 === null)) {
      context.addIssue({
        code: "custom",
        path: ["receipt_binding_sha256"],
        message: "receipt-binding artifact hashes must be both present or both absent",
      });
    }
  });

const HistoricalCodeModePureFleetCodexAttestationSchema = z
  .object({
    schema_version: z.literal(HISTORICAL_CODE_MODE_CODEX_ATTESTATION_SCHEMA_VERSION),
    provider: z.literal("codex"),
    code_mode_contract: z.literal(PURE_FLEET_CODE_MODE_CONTRACT),
    run_seed: z.number().int().safe(),
    model: CertifiedCodexModelSchema,
    persona: z.literal("default"),
    target: z.literal("overworld"),
    play_mode: z.literal("pure"),
    start_surface: z.literal("fresh_overworld"),
    build: PureRunBuildSchema.extend({ tracked_worktree_clean: z.literal(true) }),
    game_session_id: z.string().min(1),
    provider_session_id: z.string().uuid(),
    actual_provider: z.literal("openai"),
    actual_model: CertifiedCodexModelSchema,
    reasoning_effort: z.literal("xhigh"),
    provider_turn_id: z.string().uuid(),
    provider_cwd: z.string().min(1),
    report_recovered: z.literal(false),
    report_receipt_bound: z.boolean(),
    receipt_hash: z.string().regex(/^[0-9a-f]{64}$/),
    report_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    run_sidecar_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    run_evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    primary_envelope_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    provider_events_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    provider_rollout_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    provider_capture_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    initial_report_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    receipt_binding_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    recovery_metadata_sha256: z.null(),
    recovery_envelope_sha256: z.null(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actual_model !== value.model) {
      context.addIssue({
        code: "custom",
        path: ["actual_model"],
        message: "actual Codex rollout model must equal the exact planned model",
      });
    }
    if (
      value.report_receipt_bound !==
      (value.initial_report_sha256 !== null && value.receipt_binding_sha256 !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["report_receipt_bound"],
        message: "receipt-bound status must match its original report and binding metadata hashes",
      });
    }
    if ((value.initial_report_sha256 === null) !== (value.receipt_binding_sha256 === null)) {
      context.addIssue({
        code: "custom",
        path: ["receipt_binding_sha256"],
        message: "receipt-binding artifact hashes must be both present or both absent",
      });
    }
  });

const HistoricalClientBoundPureFleetCodexAttestationSchema = z
  .object({
    schema_version: z.literal(HISTORICAL_CLIENT_BOUND_CODEX_ATTESTATION_SCHEMA_VERSION),
    provider: z.literal("codex"),
    codex_cli_version: z
      .string()
      .regex(
        /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
      ),
    codex_client_authority_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    code_mode_contract: z.literal(PURE_FLEET_CODE_MODE_CONTRACT),
    run_seed: z.number().int().safe(),
    model: CertifiedCodexModelSchema,
    persona: z.literal("default"),
    target: z.literal("overworld"),
    play_mode: z.literal("pure"),
    start_surface: z.literal("fresh_overworld"),
    build: PureRunBuildSchema.extend({ tracked_worktree_clean: z.literal(true) }),
    game_session_id: z.string().min(1),
    provider_session_id: z.string().uuid(),
    actual_provider: z.literal("openai"),
    actual_model: CertifiedCodexModelSchema,
    reasoning_effort: z.literal("xhigh"),
    provider_turn_id: z.string().uuid(),
    provider_cwd: z.string().min(1),
    report_recovered: z.literal(false),
    report_receipt_bound: z.boolean(),
    receipt_hash: z.string().regex(/^[0-9a-f]{64}$/),
    report_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    run_sidecar_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    run_evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    primary_envelope_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    provider_events_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    provider_rollout_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    provider_capture_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    initial_report_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    receipt_binding_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    recovery_metadata_sha256: z.null(),
    recovery_envelope_sha256: z.null(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actual_model !== value.model) {
      context.addIssue({
        code: "custom",
        path: ["actual_model"],
        message: "actual Codex rollout model must equal the exact planned model",
      });
    }
    if (
      value.report_receipt_bound !==
      (value.initial_report_sha256 !== null && value.receipt_binding_sha256 !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["report_receipt_bound"],
        message: "receipt-bound status must match its original report and binding metadata hashes",
      });
    }
    if ((value.initial_report_sha256 === null) !== (value.receipt_binding_sha256 === null)) {
      context.addIssue({
        code: "custom",
        path: ["receipt_binding_sha256"],
        message: "receipt-binding artifact hashes must be both present or both absent",
      });
    }
  });

const CodexAttestationBaseFields = {
  provider: z.literal("codex"),
  codex_cli_version: z
    .string()
    .regex(
      /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    ),
  codex_client_authority_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  run_seed: z.number().int().safe(),
  persona: z.literal("default"),
  target: z.literal("overworld"),
  play_mode: z.literal("pure"),
  start_surface: z.literal("fresh_overworld"),
  build: PureRunBuildSchema.extend({ tracked_worktree_clean: z.literal(true) }),
  game_session_id: z.string().min(1),
  provider_session_id: z.string().uuid(),
  actual_provider: z.literal("openai"),
  reasoning_effort: z.literal("xhigh"),
  provider_turn_id: z.string().uuid(),
  provider_cwd: z.string().min(1),
  report_recovered: z.literal(false),
  report_receipt_bound: z.boolean(),
  receipt_hash: z.string().regex(/^[0-9a-f]{64}$/),
  report_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  run_sidecar_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  run_evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  primary_envelope_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  provider_events_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  provider_rollout_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  provider_capture_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  initial_report_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  receipt_binding_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  recovery_metadata_sha256: z.null(),
  recovery_envelope_sha256: z.null(),
} as const;

const HistoricalTransportCodexAttestationBaseFields = {
  schema_version: z.literal(HISTORICAL_TRANSPORT_CODEX_ATTESTATION_SCHEMA_VERSION),
  ...CodexAttestationBaseFields,
} as const;

const CurrentCodexAttestationBaseFields = {
  schema_version: z.literal(PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION),
  ...CodexAttestationBaseFields,
} as const;

function refineCurrentReceiptBinding(
  value: {
    report_receipt_bound: boolean;
    initial_report_sha256: string | null;
    receipt_binding_sha256: string | null;
  },
  context: z.RefinementCtx,
): void {
  if (
    value.report_receipt_bound !==
    (value.initial_report_sha256 !== null && value.receipt_binding_sha256 !== null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["report_receipt_bound"],
      message: "receipt-bound status must match its original report and binding metadata hashes",
    });
  }
  if ((value.initial_report_sha256 === null) !== (value.receipt_binding_sha256 === null)) {
    context.addIssue({
      code: "custom",
      path: ["receipt_binding_sha256"],
      message: "receipt-binding artifact hashes must be both present or both absent",
    });
  }
}

/**
 * Build the CURRENT attestation schema for one certified model, from its catalog entry.
 *
 * Replaces three hand-written literal schemas (`CurrentSparkDirectMcpAttestationSchema`
 * plus a game-direct-MCP and a strict-code-mode factory, each instantiated per model id).
 * Between them they hardcoded four model ids, two contract ids and a pinned client
 * version, so certifying a newly available model meant editing this file, the four-id
 * array in ./fleet_run_artifacts.ts, three z.enum lists in ./fleet_certifier.ts, a model
 * switch in blind-tester/fleet.mjs and an if-chain in blind-tester/run.sh — five files
 * that had to agree, with nothing enforcing that they did.
 *
 * Only the CURRENT schema is derived. Every `Historical*` schema below stays a frozen
 * literal on purpose: those describe attestations already written to sealed corpus
 * records, and a catalog edit must never retroactively change what an old record is
 * allowed to say. New evidence follows the catalog; recorded evidence keeps the contract
 * it was recorded under.
 */
function currentCodexAttestationSchemaFor(profile: AcceptedCodexProfile) {
  const identity = {
    ...CurrentCodexAttestationBaseFields,
    model: z.literal(profile.model),
    actual_model: z.literal(profile.model),
  } as const;
  if (profile.kind === "code_mode") {
    return z.object({ ...identity, code_mode_contract: z.literal(profile.contract) }).strict();
  }
  // A direct-MCP transport rides vendor config keys that move between client releases,
  // so where the profile pins a client version the attestation must match it exactly.
  // Where it pins none, the base field's semver check is the whole requirement.
  return z
    .object({
      ...identity,
      ...(profile.requiredCliVersion === null
        ? {}
        : { codex_cli_version: z.literal(profile.requiredCliVersion) }),
      transport_contract: z.literal(profile.contract),
    })
    .strict();
}

function historicalTransportStrictCodeModeAttestationSchema<
  const Model extends "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna",
>(model: Model) {
  return z
    .object({
      ...HistoricalTransportCodexAttestationBaseFields,
      model: z.literal(model),
      actual_model: z.literal(model),
      code_mode_contract: z.literal(PURE_FLEET_CODE_MODE_CONTRACT),
    })
    .strict();
}

const HistoricalTransportSparkDirectMcpAttestationSchema = z
  .object({
    ...HistoricalTransportCodexAttestationBaseFields,
    codex_cli_version: z.literal(PURE_FLEET_SPARK_DIRECT_MCP_CODEX_CLI_VERSION),
    model: z.literal("gpt-5.3-codex-spark"),
    actual_model: z.literal("gpt-5.3-codex-spark"),
    transport_contract: z.literal(PURE_FLEET_SPARK_DIRECT_MCP_TRANSPORT_CONTRACT),
  })
  .strict();

const HistoricalTransportPureFleetCodexAttestationSchema = z
  .discriminatedUnion("model", [
    HistoricalTransportSparkDirectMcpAttestationSchema,
    historicalTransportStrictCodeModeAttestationSchema("gpt-5.6-sol"),
    historicalTransportStrictCodeModeAttestationSchema("gpt-5.6-terra"),
    historicalTransportStrictCodeModeAttestationSchema("gpt-5.6-luna"),
  ])
  .superRefine(refineCurrentReceiptBinding);

/**
 * The current union, one option per certified Codex model in this checkout's catalog.
 *
 * Built lazily and cached. Lazily because the catalog is read from disk and this module
 * is imported by tools that never touch attestations; cached because the discriminated
 * union is rebuilt identically every call and parsing is on the hot path of certification.
 *
 * A checkout whose catalog certifies no Codex model at all yields no options, and
 * `z.discriminatedUnion` cannot express an empty union — so that case gets a schema that
 * rejects everything with a readable reason. Failing closed is the only correct answer:
 * "this checkout certifies no Codex model" must never read as "anything goes".
 */
let currentPureFleetCodexAttestationSchemaCache: z.ZodTypeAny | null = null;

function currentPureFleetCodexAttestationSchema(): z.ZodTypeAny {
  if (currentPureFleetCodexAttestationSchemaCache !== null) {
    return currentPureFleetCodexAttestationSchemaCache;
  }
  // FROZEN ∪ LIVE. The frozen half is what v9 meant when it was cut; the live half is
  // what the catalogs declare now. Their union is what a v9 record may look like, so a
  // catalog edit only ever ADDS an accepted shape — a record sealed under the old pin
  // keeps parsing. See blind-tester/frozen-v9-codex-profiles.mjs for why that matters.
  const live: AcceptedCodexProfile[] = certifiedFleetModels()
    .filter((entry) => entry.provider === "codex")
    .map((entry) => ({
      model: entry.certifiedAs,
      kind: entry.transport.kind,
      contract: entry.transport.contract,
      requiredCliVersion: entry.transport.requiredCliVersion,
    }));
  const profiles = acceptedCodexProfiles(live) as AcceptedCodexProfile[];
  const options = profiles.map((profile) => currentCodexAttestationSchemaFor(profile));
  const schema =
    options.length === 0
      ? z.never({
          errorMap: () => ({
            message:
              "this checkout's catalogs certify no codex model, so no current codex " +
              "attestation can be accepted",
          }),
        })
      : // A plain union, not discriminatedUnion: one model may legitimately have two
        // accepted shapes (its frozen profile and a changed catalog profile), which
        // means the `model` discriminator is no longer unique across options.
        z
          .union(
            options as unknown as [
              (typeof options)[number],
              (typeof options)[number],
              ...(typeof options)[number][],
            ],
          )
          .superRefine(refineCurrentReceiptBinding);
  currentPureFleetCodexAttestationSchemaCache = schema;
  return schema;
}

const CurrentPureFleetCodexAttestationSchema = z.lazy(() =>
  currentPureFleetCodexAttestationSchema(),
);

const PureFleetCodexAttestationSchema = z.union([
  HistoricalPureFleetCodexAttestationSchema,
  HistoricalReceiptBoundPureFleetCodexAttestationSchema,
  HistoricalStrictPureFleetCodexAttestationSchema,
  HistoricalCodeModePureFleetCodexAttestationSchema,
  HistoricalClientBoundPureFleetCodexAttestationSchema,
  HistoricalTransportPureFleetCodexAttestationSchema,
  CurrentPureFleetCodexAttestationSchema,
]);

export const PureFleetAttestationSchema = z.union([
  PureFleetClaudeAttestationSchema,
  PureFleetCodexAttestationSchema,
]);

type PureFleetAttestation = z.infer<typeof PureFleetAttestationSchema>;

export function pureFleetAttestationPathFor(reportMarkdownPath: string): string {
  return reportMarkdownPath.endsWith(".md")
    ? `${reportMarkdownPath.slice(0, -".md".length)}.fleet.json`
    : `${reportMarkdownPath}.fleet.json`;
}

export function parsePureFleetAttestation(
  text: string,
): { ok: true; attestation: PureFleetAttestation } | { ok: false; reason: string } {
  const raw = parseJsonRejectingDuplicateKeys(text, "pure fleet attestation");
  if (!raw.ok) return raw;
  const parsed = PureFleetAttestationSchema.safeParse(raw.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `pure fleet attestation invalid: ${issue?.path.join(".") ?? "?"} — ${issue?.message ?? "schema mismatch"}`,
    };
  }
  return { ok: true, attestation: parsed.data };
}
