import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { JourneyExitReceiptSchema } from "./exit_interview.js";
import { parseJsonRejectingDuplicateKeys } from "./strict_json.js";

const FreshStartRunEvidenceSchema = z
  .object({
    schema_version: z.literal(1),
    play_mode: z.literal("pure"),
    event: z.literal("fresh_start"),
    start_surface: z.literal("fresh_overworld"),
    session_id: z.string().min(1),
  })
  .strict();

const JourneyExitRunEvidenceSchema = z
  .object({
    schema_version: z.literal(1),
    play_mode: z.literal("pure"),
    event: z.literal("journey_exit"),
    start_surface: z.literal("fresh_overworld"),
    session_id: z.string().min(1),
    receipt: JourneyExitReceiptSchema,
  })
  .strict();

export const PureRunBuildSchema = z
  .object({
    git_commit: z.string().regex(/^[0-9a-f]{40}$/),
    tracked_worktree_clean: z.boolean(),
    world_id: z.string().min(1),
    world_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type PureRunBuild = z.infer<typeof PureRunBuildSchema>;

export const CanonicalQuestOutcomesSchema = z
  .array(z.tuple([z.string().min(1), z.string().min(1)]))
  .superRefine((outcomes, ctx) => {
    for (let index = 1; index < outcomes.length; index += 1) {
      if (outcomes[index - 1]![0].localeCompare(outcomes[index]![0]) >= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: "quest outcomes must be strictly sorted and unique by quest id",
        });
      }
    }
  });

export const FreshStartRunEvidenceV2Schema = z
  .object({
    schema_version: z.literal(2),
    play_mode: z.literal("pure"),
    event: z.literal("fresh_start"),
    start_surface: z.literal("fresh_overworld"),
    session_id: z.string().min(1),
    run_seed: z.number().int().safe(),
    build: PureRunBuildSchema,
  })
  .strict();

export const JourneyExitRunEvidenceV2Schema = z
  .object({
    schema_version: z.literal(2),
    play_mode: z.literal("pure"),
    event: z.literal("journey_exit"),
    start_surface: z.literal("fresh_overworld"),
    session_id: z.string().min(1),
    run_seed: z.number().int().safe(),
    build: PureRunBuildSchema,
    quest_outcomes: CanonicalQuestOutcomesSchema,
    receipt: JourneyExitReceiptSchema,
  })
  .strict();

// A flat union is required because v1 and v2 deliberately share event names.
export const RunEvidenceEventSchema = z.union([
  FreshStartRunEvidenceSchema,
  JourneyExitRunEvidenceSchema,
  FreshStartRunEvidenceV2Schema,
  JourneyExitRunEvidenceV2Schema,
]);

const PureBlindRunSidecarV1Schema = z
  .object({
    schema_version: z.literal(1),
    report_schema_version: z.literal(2),
    play_mode: z.literal("pure"),
    start_surface: z.literal("fresh_overworld"),
    retention_eligible: z.literal(true),
    evidence_status: z.literal("verified"),
    session_id: z.string().min(1),
    receipt: JourneyExitReceiptSchema,
  })
  .strict();

const PureBlindRunSidecarV2Schema = z
  .object({
    schema_version: z.literal(2),
    report_schema_version: z.literal(2),
    play_mode: z.literal("pure"),
    start_surface: z.literal("fresh_overworld"),
    retention_eligible: z.literal(true),
    evidence_status: z.literal("verified"),
    session_id: z.string().min(1),
    run_seed: z.number().int().safe(),
    build: PureRunBuildSchema,
    quest_outcomes: CanonicalQuestOutcomesSchema,
    receipt: JourneyExitReceiptSchema,
  })
  .strict();

export const PureBlindRunSidecarSchema = z.union([
  PureBlindRunSidecarV1Schema,
  PureBlindRunSidecarV2Schema,
]);

export const StructuralBlindRunSidecarSchema = z
  .object({
    schema_version: z.literal(1),
    report_schema_version: z.literal(2),
    play_mode: z.literal("structural"),
    start_surface: z.enum(["fresh_overworld", "direct_quest"]),
    retention_eligible: z.literal(false),
    evidence_status: z.literal("not_applicable"),
    structural_kind: z.enum(["mock", "smoke"]),
  })
  .strict();

// Pure evidence has two versions with the same play_mode discriminator.
export const BlindRunSidecarSchema = z.union([
  PureBlindRunSidecarSchema,
  StructuralBlindRunSidecarSchema,
]);

export type PureBlindRunSidecar = z.infer<typeof PureBlindRunSidecarSchema>;
export type StructuralBlindRunSidecar = z.infer<typeof StructuralBlindRunSidecarSchema>;
export type BlindRunSidecar = z.infer<typeof BlindRunSidecarSchema>;

type RunEvidenceParseResult =
  | { ok: true; sidecar: PureBlindRunSidecar }
  | { ok: false; reason: string };

/**
 * Parse the private server JSONL audit. Pure evidence is intentionally tiny:
 * exactly one fresh start followed by exactly one journey exit for the same
 * session. The exit must be last, so a report cannot hide later gameplay.
 */
export function parseRunEvidenceJsonl(text: string): RunEvidenceParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const events: Array<z.infer<typeof RunEvidenceEventSchema>> = [];
  for (const [index, line] of lines.entries()) {
    const raw = parseJsonRejectingDuplicateKeys(line, `run evidence line ${index + 1}`);
    if (!raw.ok) return raw;
    const parsed = RunEvidenceEventSchema.safeParse(raw.value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        reason: `run evidence line ${index + 1} invalid: ${issue?.path.join(".") ?? "?"} — ${issue?.message ?? "schema mismatch"}`,
      };
    }
    events.push(parsed.data);
  }

  const starts = events.filter((event) => event.event === "fresh_start");
  const exits = events.filter((event) => event.event === "journey_exit");
  if (starts.length !== 1) {
    return {
      ok: false,
      reason: `run evidence requires exactly one fresh_start (found ${starts.length})`,
    };
  }
  if (exits.length !== 1) {
    return {
      ok: false,
      reason: `run evidence requires exactly one journey_exit (found ${exits.length})`,
    };
  }
  if (events.at(-1)?.event !== "journey_exit") {
    return { ok: false, reason: "run evidence journey_exit must be the final event" };
  }
  if (events.length !== 2 || events[0]?.event !== "fresh_start") {
    return {
      ok: false,
      reason: "run evidence may contain only fresh_start followed by journey_exit",
    };
  }

  const start = starts[0]!;
  const exit = exits[0]!;
  if (start.session_id !== exit.session_id) {
    return { ok: false, reason: "run evidence fresh_start and journey_exit session ids differ" };
  }

  if (start.schema_version !== exit.schema_version) {
    return {
      ok: false,
      reason: "run evidence fresh_start and journey_exit schema versions differ",
    };
  }

  if (start.schema_version === 1) {
    if (exit.schema_version !== 1) {
      return {
        ok: false,
        reason: "run evidence fresh_start and journey_exit schema versions differ",
      };
    }
    return {
      ok: true,
      sidecar: {
        schema_version: 1,
        report_schema_version: 2,
        play_mode: "pure",
        start_surface: "fresh_overworld",
        retention_eligible: true,
        evidence_status: "verified",
        session_id: start.session_id,
        receipt: exit.receipt,
      },
    };
  }

  if (exit.schema_version !== 2) {
    return {
      ok: false,
      reason: "run evidence fresh_start and journey_exit schema versions differ",
    };
  }
  if (start.run_seed !== exit.run_seed) {
    return { ok: false, reason: "run evidence fresh_start and journey_exit seeds differ" };
  }
  if (!isDeepStrictEqual(start.build, exit.build)) {
    return { ok: false, reason: "run evidence fresh_start and journey_exit builds differ" };
  }

  return {
    ok: true,
    sidecar: {
      schema_version: 2,
      report_schema_version: 2,
      play_mode: "pure",
      start_surface: "fresh_overworld",
      retention_eligible: true,
      evidence_status: "verified",
      session_id: start.session_id,
      run_seed: start.run_seed,
      build: start.build,
      quest_outcomes: exit.quest_outcomes,
      receipt: exit.receipt,
    },
  };
}

export function parseBlindRunSidecar(
  text: string,
): { ok: true; sidecar: BlindRunSidecar } | { ok: false; reason: string } {
  const raw = parseJsonRejectingDuplicateKeys(text, "run sidecar");
  if (!raw.ok) return raw;
  const parsed = BlindRunSidecarSchema.safeParse(raw.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `run sidecar invalid: ${issue?.path.join(".") ?? "?"} — ${issue?.message ?? "schema mismatch"}`,
    };
  }
  return { ok: true, sidecar: parsed.data };
}
