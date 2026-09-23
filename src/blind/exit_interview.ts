/**
 * Structured blind-playtest exit interviews.
 *
 * Historical reports shipped before the session contract are deliberately
 * still accepted as an unversioned legacy shape. They remain useful experience
 * evidence, but they are never retention evidence. New reports use schema V2
 * and discriminate pure human-equivalent runs from structural mock runs; the
 * current game receipt independently carries journey contract v3.
 */
import { z } from "zod";
import { hashState } from "../core/hash.js";
import {
  INITIAL_JOURNEY_GOAL,
  JOURNEY_BASELINE_DECISIONS,
  JOURNEY_CONTRACT_VERSION,
  JOURNEY_EXIT_REASON,
} from "../world/journey_contract.js";

/**
 * Upper bounds on model-authored free text (bug_0610). Triage copies interview text
 * into tracked ticket and queue files, so an unbounded field is a way for one runaway
 * or adversarial report to commit megabytes through the dev loop's own ledger commit.
 * The bounds sit far above anything the corpus has produced (longest verdict on disk:
 * 879 characters; longest list: 5 entries) and below anything a person would read.
 */
export const EXIT_INTERVIEW_MAX_TEXT = 2_000;
export const EXIT_INTERVIEW_MAX_VERDICT = 4_000;
export const EXIT_INTERVIEW_MAX_ITEMS = 25;

const BoundedText = z.string().min(1).max(EXIT_INTERVIEW_MAX_TEXT);

const ExitInterviewFields = {
  clarity: z.number().int().min(1).max(5),
  enjoyment: z.number().int().min(1).max(5),
  goal_understood: z.boolean(),
  got_stuck: z.boolean(),
  confusions: z.array(BoundedText).max(EXIT_INTERVIEW_MAX_ITEMS).default([]),
  bugs: z
    .array(
      z
        .object({
          where: BoundedText,
          /**
           * ASCENDING: S0 is the mildest and S4 the most severe.
           *
           * Spelled out because this runs OPPOSITE to the common convention, where S1 is
           * the critical one and S4 cosmetic, and an undocumented enum leaves a reporter
           * to assume the convention they already know. They then invert the scale, and
           * because `SEVERITY_WEIGHT` doubles at every step (S0 1 → S4 16) a cosmetic nit
           * filed as S4 outranks a real defect filed as S2 by four times — so the dev
           * queue comes out backwards while every individual report looks reasonable.
           */
          severity: z
            .enum(["S0", "S1", "S2", "S3", "S4"])
            .describe(
              "Ascending severity: S0 trivial, S1 minor, S2 moderate, S3 serious, " +
                "S4 most severe. Note this is the reverse of the usual S1-is-critical scale.",
            ),
          note: BoundedText,
        })
        .strict(),
    )
    .max(EXIT_INTERVIEW_MAX_ITEMS)
    .default([]),
  best_moment: BoundedText,
  worst_moment: BoundedText,
  would_replay: z.boolean(),
  verdict: z.string().min(20).max(EXIT_INTERVIEW_MAX_VERDICT),
} as const;

const ISSUE_CONSISTENCY_VERSION = 1 as const;
const IssueConsistencyVersionField = {
  issue_consistency_version: z.literal(ISSUE_CONSISTENCY_VERSION).optional(),
} as const;

/** Pre-contract reports. Absence of schema_version is the durable legacy tag. */
export const SubjectiveExitInterviewSchema = z.object(ExitInterviewFields).strict();
const LegacyExitInterviewSchema = SubjectiveExitInterviewSchema;

const HistoricalJourneyChoiceReasonSchema = z.enum(["checkpoint", "goal_completed"]);
const CurrentJourneyChoiceReasonSchema = z.enum(["checkpoint", "goal_completed", "character_died"]);
const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const JourneyCheckpointSchema = z
  .number()
  .int()
  .min(JOURNEY_BASELINE_DECISIONS)
  .refine(
    (value) => value % JOURNEY_BASELINE_DECISIONS === 0,
    `checkpoints must be positive multiples of ${JOURNEY_BASELINE_DECISIONS}`,
  );

const JourneyRetentionEventCommonFields = {
  sequence: z.number().int().positive(),
  atDecision: z.number().int().nonnegative(),
  checkpoint: JourneyCheckpointSchema.nullable(),
  choice: z.enum(["continue", "end"]),
  decisionProofHash: HashSchema,
} as const;

type JourneyRetentionEventBase = {
  sequence: number;
  atDecision: number;
  reasons: ("checkpoint" | "goal_completed" | "character_died")[];
  checkpoint: number | null;
  choice: "continue" | "end";
  decisionProofHash: string;
};

function validateRetentionEventShape(
  event: JourneyRetentionEventBase,
  ctx: z.RefinementCtx,
  allowCharacterDeath: boolean,
  allowDeferredCheckpoint: boolean,
): void {
  if (
    event.reasons.length === 2 &&
    (event.reasons[0] !== "checkpoint" ||
      (event.reasons[1] !== "goal_completed" &&
        (!allowCharacterDeath || event.reasons[1] !== "character_died")))
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["reasons"],
      message: allowCharacterDeath
        ? "combined reasons must be checkpoint then goal_completed or character_died"
        : "combined reasons must be checkpoint then goal_completed",
    });
  }
  const hasCheckpoint = event.reasons.includes("checkpoint");
  if (
    hasCheckpoint &&
    (event.checkpoint === null ||
      (allowDeferredCheckpoint
        ? event.checkpoint > event.atDecision
        : event.checkpoint !== event.atDecision))
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["checkpoint"],
      message: allowDeferredCheckpoint
        ? "checkpoint retention events cannot precede their fixed checkpoint"
        : "historical checkpoint retention events must occur at that checkpoint",
    });
  }
  if (!hasCheckpoint && event.checkpoint !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["checkpoint"],
      message: "retention events without a checkpoint reason must carry a null checkpoint",
    });
  }
}

const HistoricalJourneyRetentionEventSchema = z
  .object({
    ...JourneyRetentionEventCommonFields,
    reasons: z.array(HistoricalJourneyChoiceReasonSchema).min(1).max(2),
  })
  .strict()
  .superRefine((event, ctx) => validateRetentionEventShape(event, ctx, false, false));

export const CurrentJourneyRetentionEventSchema = z
  .object({
    ...JourneyRetentionEventCommonFields,
    reasons: z.array(CurrentJourneyChoiceReasonSchema).min(1).max(2),
    goalVersion: z.number().int().positive().nullable(),
    goalId: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((event, ctx) => {
    validateRetentionEventShape(event, ctx, true, true);
    if (event.reasons.includes("character_died") && event.choice !== "end") {
      ctx.addIssue({
        code: "custom",
        path: ["choice"],
        message: "character death is an end-only retention event",
      });
    }
    const hasGoal = event.reasons.includes("goal_completed");
    if (
      (hasGoal && (event.goalVersion === null || event.goalId === null)) ||
      (!hasGoal && (event.goalVersion !== null || event.goalId !== null))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["goalId"],
        message:
          "goal-completion events require both goalVersion and goalId; other events forbid them",
      });
    }
  });

type ReceiptTimeline = {
  acceptedDecisions: number;
  exitReasons: ("checkpoint" | "goal_completed" | "character_died")[];
  checkpoint: number | null;
  decisionProofHash: string;
  retentionHistory: JourneyRetentionEventBase[];
};

function validateReceiptTimeline(
  receipt: ReceiptTimeline,
  ctx: z.RefinementCtx,
  requireDeferredCheckpointMerge: boolean,
): boolean {
  let previousDecision = -1;
  let expectedCheckpoint: number = JOURNEY_BASELINE_DECISIONS;
  let sawGoalCompletionChoice = false;
  for (const [index, event] of receipt.retentionHistory.entries()) {
    if (event.sequence !== index + 1) {
      ctx.addIssue({
        code: "custom",
        path: ["retentionHistory", index, "sequence"],
        message: "retention event sequences must be contiguous and one-based",
      });
    }
    if (event.atDecision < previousDecision || event.atDecision > receipt.acceptedDecisions) {
      ctx.addIssue({
        code: "custom",
        path: ["retentionHistory", index, "atDecision"],
        message: "retention event decision counts must be ordered and within the receipt total",
      });
    }
    if (index < receipt.retentionHistory.length - 1 && event.choice !== "continue") {
      ctx.addIssue({
        code: "custom",
        path: ["retentionHistory", index, "choice"],
        message: "only the final retention event may end the journey",
      });
    }
    if (
      event.reasons.includes("character_died") &&
      (index !== receipt.retentionHistory.length - 1 || event.choice !== "end")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["retentionHistory", index, "reasons"],
        message: "character death must be the final end-only retention event",
      });
    }
    const hasCheckpoint = event.reasons.includes("checkpoint");
    if (
      requireDeferredCheckpointMerge &&
      !hasCheckpoint &&
      event.atDecision >= expectedCheckpoint &&
      (event.reasons.includes("goal_completed") || event.reasons.includes("character_died"))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["retentionHistory", index, "reasons"],
        message: `a mandatory choice at or after fixed checkpoint ${expectedCheckpoint} must merge that checkpoint`,
      });
    }
    if (hasCheckpoint) {
      if (event.checkpoint !== expectedCheckpoint) {
        ctx.addIssue({
          code: "custom",
          path: ["retentionHistory", index, "checkpoint"],
          message: `expected fixed journey checkpoint ${expectedCheckpoint}`,
        });
      }
      if (event.choice === "continue") {
        const nextCheckpoint =
          Math.floor(event.atDecision / JOURNEY_BASELINE_DECISIONS + 1) *
          JOURNEY_BASELINE_DECISIONS;
        if (!Number.isSafeInteger(nextCheckpoint)) {
          ctx.addIssue({
            code: "custom",
            path: ["retentionHistory", index, "atDecision"],
            message: "continued checkpoint has no next safe fixed checkpoint",
          });
        } else {
          expectedCheckpoint = nextCheckpoint;
        }
      }
    }
    if (event.reasons.includes("goal_completed")) sawGoalCompletionChoice = true;
    previousDecision = event.atDecision;
  }

  const finalEvent = receipt.retentionHistory.at(-1);
  if (finalEvent?.choice !== "end") {
    ctx.addIssue({
      code: "custom",
      path: ["retentionHistory"],
      message: "an exit receipt must end with the player's end choice",
    });
  }
  if (finalEvent?.atDecision !== receipt.acceptedDecisions) {
    ctx.addIssue({
      code: "custom",
      path: ["acceptedDecisions"],
      message: "acceptedDecisions must equal the final retention event decision count",
    });
  }
  if (finalEvent?.decisionProofHash !== receipt.decisionProofHash) {
    ctx.addIssue({
      code: "custom",
      path: ["decisionProofHash"],
      message: "decision proof must match the final retention event",
    });
  }
  if (finalEvent?.checkpoint !== receipt.checkpoint) {
    ctx.addIssue({
      code: "custom",
      path: ["checkpoint"],
      message: "receipt checkpoint must match the final retention event",
    });
  }
  if (
    finalEvent !== undefined &&
    (finalEvent.reasons.length !== receipt.exitReasons.length ||
      finalEvent.reasons.some((reason, index) => receipt.exitReasons[index] !== reason))
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["exitReasons"],
      message: "exit reasons must match the final retention event",
    });
  }
  return sawGoalCompletionChoice;
}

function validateReceiptHash<T extends { receiptHash: string }>(
  receipt: T,
  ctx: z.RefinementCtx,
): void {
  const { receiptHash, ...payload } = receipt;
  if (hashState(payload) !== receiptHash) {
    ctx.addIssue({
      code: "custom",
      path: ["receiptHash"],
      message: "receipt hash does not match the canonical journey receipt payload",
    });
  }
}

/**
 * Runtime validator for the core engine's JourneyExitReceipt. The report must
 * copy this object verbatim from the game; run-evidence verification below then
 * compares it with the server-side receipt rather than trusting prose.
 */
export const HistoricalJourneyExitReceiptSchema = z
  .object({
    contractVersion: z.union([z.literal(1), z.literal(2)]),
    exitReason: z.literal(JOURNEY_EXIT_REASON),
    goalVersion: z.literal(INITIAL_JOURNEY_GOAL.version),
    goalId: z.literal(INITIAL_JOURNEY_GOAL.id),
    goalStatus: z.enum(["active", "completed"]),
    acceptedDecisions: z.number().int().nonnegative(),
    exitReasons: z.array(HistoricalJourneyChoiceReasonSchema).min(1).max(2),
    checkpoint: JourneyCheckpointSchema.nullable(),
    decisionProofHash: HashSchema,
    retentionHistory: z.array(HistoricalJourneyRetentionEventSchema).min(1),
    receiptHash: HashSchema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    validateReceiptHash(receipt, ctx);
    const sawGoalCompletionChoice = validateReceiptTimeline(receipt, ctx, false);
    if (sawGoalCompletionChoice && receipt.goalStatus !== "completed") {
      ctx.addIssue({
        code: "custom",
        path: ["goalStatus"],
        message: "a goal-completion retention choice requires completed goal status",
      });
    }
  });

const CompletedJourneyGoalSchema = z
  .object({
    version: z.number().int().positive(),
    id: z.string().min(1),
    text: z.string().min(1),
    status: z.literal("completed"),
    completedAtDecision: z.number().int().nonnegative(),
  })
  .strict();

export const CurrentJourneyExitReceiptSchema = z
  .object({
    contractVersion: z.literal(JOURNEY_CONTRACT_VERSION),
    exitReason: z.literal(JOURNEY_EXIT_REASON),
    goalVersion: z.number().int().positive(),
    goalId: z.string().min(1),
    goalText: z.string().min(1),
    goalStatus: z.enum(["active", "completed"]),
    goalCompletedAtDecision: z.number().int().nonnegative().nullable(),
    completedGoals: z.array(CompletedJourneyGoalSchema),
    acceptedDecisions: z.number().int().nonnegative(),
    exitReasons: z.array(CurrentJourneyChoiceReasonSchema).min(1).max(2),
    checkpoint: JourneyCheckpointSchema.nullable(),
    decisionProofHash: HashSchema,
    retentionHistory: z.array(CurrentJourneyRetentionEventSchema).min(1),
    receiptHash: HashSchema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    validateReceiptHash(receipt, ctx);
    validateReceiptTimeline(receipt, ctx, true);

    if (receipt.exitReasons.includes("character_died") && receipt.goalStatus !== "active") {
      ctx.addIssue({
        code: "custom",
        path: ["goalStatus"],
        message: "character death requires an unfinished active current goal",
      });
    }

    let previousGoalCompletion = -1;
    for (const [index, goal] of receipt.completedGoals.entries()) {
      if (goal.version !== index + 1) {
        ctx.addIssue({
          code: "custom",
          path: ["completedGoals", index, "version"],
          message: "completed goal versions must be contiguous and one-based",
        });
      }
      if (goal.completedAtDecision > receipt.acceptedDecisions) {
        ctx.addIssue({
          code: "custom",
          path: ["completedGoals", index, "completedAtDecision"],
          message: "completed goal cannot follow the receipt decision total",
        });
      }
      if (goal.completedAtDecision < previousGoalCompletion) {
        ctx.addIssue({
          code: "custom",
          path: ["completedGoals", index, "completedAtDecision"],
          message: "completed goal decisions must be nondecreasing",
        });
      }
      previousGoalCompletion = goal.completedAtDecision;
      const bindings = receipt.retentionHistory.filter(
        (event) =>
          event.reasons.includes("goal_completed") &&
          event.goalVersion === goal.version &&
          event.goalId === goal.id &&
          event.atDecision === goal.completedAtDecision,
      );
      if (bindings.length !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["completedGoals", index],
          message: "every completed goal requires exactly one matching retention event",
        });
      }
      if (goal.version < receipt.goalVersion && bindings[0]?.choice !== "continue") {
        ctx.addIssue({
          code: "custom",
          path: ["retentionHistory"],
          message: "activating a later goal requires continuing from every earlier goal",
        });
      }
    }

    for (const [index, event] of receipt.retentionHistory.entries()) {
      if (!event.reasons.includes("goal_completed")) continue;
      const goal = receipt.completedGoals.find(
        (candidate) =>
          candidate.version === event.goalVersion &&
          candidate.id === event.goalId &&
          candidate.completedAtDecision === event.atDecision,
      );
      if (!goal) {
        ctx.addIssue({
          code: "custom",
          path: ["retentionHistory", index],
          message: "goal-completion retention event is not bound to a completed goal",
        });
      }
    }

    if (receipt.goalStatus === "active") {
      if (receipt.goalCompletedAtDecision !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["goalCompletedAtDecision"],
          message: "an active current goal cannot have a completion decision",
        });
      }
      if (receipt.goalVersion !== receipt.completedGoals.length + 1) {
        ctx.addIssue({
          code: "custom",
          path: ["goalVersion"],
          message: "active current goal must follow the completed goal history",
        });
      }
    } else {
      const current = receipt.completedGoals.at(-1);
      if (
        !current ||
        current.version !== receipt.goalVersion ||
        current.id !== receipt.goalId ||
        current.text !== receipt.goalText ||
        current.completedAtDecision !== receipt.goalCompletedAtDecision
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["completedGoals"],
          message: "completed current goal must be the final completed goal",
        });
      }
    }
  });

export const JourneyExitReceiptSchema = z.union([
  HistoricalJourneyExitReceiptSchema,
  CurrentJourneyExitReceiptSchema,
]);

export const PureExitInterviewV2Schema = z
  .object({
    schema_version: z.literal(2),
    ...IssueConsistencyVersionField,
    play_mode: z.literal("pure"),
    start_surface: z.literal("fresh_overworld"),
    retention_eligible: z.literal(true),
    journey_exit_receipt: JourneyExitReceiptSchema,
    ...ExitInterviewFields,
  })
  .strict();

const StructuralExitInterviewV2Schema = z
  .object({
    schema_version: z.literal(2),
    ...IssueConsistencyVersionField,
    play_mode: z.literal("structural"),
    start_surface: z.enum(["fresh_overworld", "direct_quest"]),
    retention_eligible: z.literal(false),
    structural_kind: z.enum(["mock", "smoke"]),
    ...ExitInterviewFields,
  })
  .strict();

export const ExitInterviewSchema = z.union([
  PureExitInterviewV2Schema,
  StructuralExitInterviewV2Schema,
  LegacyExitInterviewSchema,
]);

export type PureExitInterviewV2 = z.infer<typeof PureExitInterviewV2Schema>;
type StructuralExitInterviewV2 = z.infer<typeof StructuralExitInterviewV2Schema>;
export type ExitInterview = z.infer<typeof ExitInterviewSchema>;

export function isPureExitInterviewV2(interview: ExitInterview): interview is PureExitInterviewV2 {
  return "schema_version" in interview && interview.play_mode === "pure";
}

export function isStructuralExitInterviewV2(
  interview: ExitInterview,
): interview is StructuralExitInterviewV2 {
  return "schema_version" in interview && interview.play_mode === "structural";
}

export function exitInterviewPlayMode(
  interview: ExitInterview,
): "pure" | "structural" | "legacy_guided" {
  if (isPureExitInterviewV2(interview)) return "pure";
  if (isStructuralExitInterviewV2(interview)) return "structural";
  return "legacy_guided";
}

const BLOCK = /```json exit-interview[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```[^\S\r\n]*(?=\r?\n|$)/gu;
const TERMINAL_OPENING = /^```json exit-interview[^\S\r\n]*(?:\r?\n|$)/gmu;

export const MISSING_EXIT_INTERVIEW_REASON =
  "missing exit interview (a ```json exit-interview fenced block is mandatory)";

export type ExitInterviewExtraction =
  | { ok: true; interview: ExitInterview }
  | { ok: false; reason: string };

function schemaForParsedInterview(parsed: unknown): typeof ExitInterviewSchema | z.ZodTypeAny {
  if (typeof parsed !== "object" || parsed === null || !("schema_version" in parsed)) {
    return LegacyExitInterviewSchema;
  }
  const candidate = parsed as { schema_version?: unknown; play_mode?: unknown };
  if (candidate.schema_version !== 2) return ExitInterviewSchema;
  if (candidate.play_mode === "pure") return PureExitInterviewV2Schema;
  if (candidate.play_mode === "structural") return StructuralExitInterviewV2Schema;
  return ExitInterviewSchema;
}

export function extractExitInterview(text: string): ExitInterviewExtraction {
  const matches = [...text.matchAll(BLOCK)];
  if (matches.length === 0) {
    return { ok: false, reason: MISSING_EXIT_INTERVIEW_REASON };
  }
  if (matches.length !== 1) {
    return { ok: false, reason: "report must contain exactly one exit interview block" };
  }
  const match = matches[0]!;
  if (text.slice((match.index ?? 0) + match[0].length).trim().length !== 0) {
    return { ok: false, reason: "exit interview must be the final report block" };
  }
  const body = match[1];
  if (body === undefined) {
    return { ok: false, reason: "exit interview block is empty" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "exit interview block is not valid JSON" };
  }
  const res = schemaForParsedInterview(parsed).safeParse(parsed);
  if (!res.success) {
    const first = res.error.issues[0];
    return {
      ok: false,
      reason: `exit interview invalid: ${first?.path.join(".") ?? "?"} — ${first?.message ?? "schema mismatch"}`,
    };
  }
  return { ok: true, interview: res.data as ExitInterview };
}

/**
 * Parse the two complete terminal shapes occasionally emitted by streaming
 * pure players: JSON through EOF, or JSON followed immediately by an inline
 * closing fence. Callers must still bind the receipt to private run evidence;
 * generic and structural report parsing deliberately remain strict.
 */
export function extractTerminalPureExitInterview(text: string): ExitInterviewExtraction {
  const openings = [...text.matchAll(TERMINAL_OPENING)];
  if (openings.length === 0) {
    return { ok: false, reason: MISSING_EXIT_INTERVIEW_REASON };
  }
  if (openings.length > 1) {
    return {
      ok: false,
      reason: "terminal pure report must contain exactly one exit interview opening marker",
    };
  }

  const opening = openings[0]!;
  let body = text.slice((opening.index ?? 0) + opening[0].length).trimEnd();
  if (body.length === 0) {
    return { ok: false, reason: "terminal pure exit interview block is empty" };
  }

  const fences = [...body.matchAll(/```/gu)];
  if (fences.length === 1 && body.endsWith("```")) {
    const withoutFence = body.slice(0, -3);
    if (!withoutFence.endsWith("}")) {
      return {
        ok: false,
        reason: "terminal pure exit interview closing fence must immediately follow its JSON",
      };
    }
    body = withoutFence;
  } else if (fences.length !== 0) {
    return {
      ok: false,
      reason: "terminal pure exit interview has unsupported fence or trailing content",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "terminal pure exit interview is not valid JSON through EOF" };
  }
  const res = PureExitInterviewV2Schema.safeParse(parsed);
  if (!res.success) {
    const first = res.error.issues[0];
    return {
      ok: false,
      reason: `terminal pure exit interview invalid: ${first?.path.join(".") ?? "?"} — ${first?.message ?? "schema mismatch"}`,
    };
  }
  return { ok: true, interview: res.data };
}
