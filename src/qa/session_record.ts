/**
 * The playtest session record — one immutable document per playthrough.
 *
 * The rule this module exists to enforce is simple and absolute: EVERY playthrough is
 * documented and kept. Not just the clean ones, not just the ones that reached an
 * ending, not just the ones whose isolation the runner could prove. A player who
 * crashed out at turn 6, a desktop session a human drove by hand, a run that produced
 * a malformed interview — all of them get a record. Discarding the messy ones is how a
 * QA corpus quietly becomes a survivorship-biased advertisement for itself.
 *
 * That rule is in tension with the project's other rule — that unverifiable evidence
 * must never be laundered into retention metrics — and the resolution is the same one
 * real QA organizations use: KEEP EVERYTHING, LABEL EVERYTHING, and let the consumer
 * decide what it is entitled to conclude. So a record carries its provider's isolation
 * class and its own outcome verbatim, and downstream code filters on those rather than
 * on the record's existence.
 *
 * A record is content-addressed: `record_id` is the SHA-256 of the canonical record
 * minus the id itself. Two loops writing concurrently from different machines can
 * therefore never collide (identical content is the same file; different content is a
 * different file), which is what lets the playtest fleet be mass-parallel without a
 * lock, a queue, or a coordinating service.
 */
import { z } from "zod";
import { hashState } from "../core/hash.js";
import {
  SubjectiveExitInterviewSchema,
  JourneyExitReceiptSchema,
} from "../blind/exit_interview.js";
import { PureRunBuildSchema } from "../blind/run_evidence.js";
import { PlaytestIsolationSchema, PlaytestTierSchema } from "../blind/providers.js";

const PLAYTEST_SESSION_SCHEMA_VERSION = 1 as const;

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * How the session ended, from the harness's point of view.
 *
 * Only `completed` can ever be retention evidence, but every other value is still a
 * kept, queryable record — `abandoned` and `timed_out` runs in particular are among
 * the most informative things the corpus holds, because a player who gave up is
 * telling you something a finished playthrough cannot.
 */
export const PlaytestOutcomeSchema = z.enum([
  /** Reached a game-confirmed journey exit and produced an interview. */
  "completed",
  /** The player stopped without the game confirming an exit. */
  "abandoned",
  /** The harness's time budget ran out first. */
  "timed_out",
  /** The client errored, crashed, or was rejected before play finished. */
  "failed",
  /** Play finished but the interview did not parse against the schema. */
  "malformed_report",
]);
export type PlaytestOutcome = z.infer<typeof PlaytestOutcomeSchema>;

const PlaytestTranscriptFilenameSchema = z
  .string()
  .min(1)
  .superRefine((filename, ctx) => {
    if (
      filename === "." ||
      filename === ".." ||
      /[\\/]/u.test(filename) ||
      filename.toLowerCase() === "session.json"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "transcript_filename must be a plain filename distinct from the reserved session.json record",
      });
    }
  });

/**
 * The play-style overlay the session ran under — "the role".
 *
 * Recorded as id + title + the exact SHA-256 of the persona file's contents, because a
 * persona is prose that gets edited. Without the content hash, a six-month-old session
 * saying `persona: "cynical_veteran"` is uninterpretable: you cannot tell whether it
 * ran the persona you can read today. With it, drift is detectable.
 */
const PlaytestPersonaSchema = z
  .object({
    id: z.string().min(1),
    /** Human-readable role, e.g. "20-year cynical gaming veteran". */
    title: z.string().min(1),
    source_sha256: SHA256,
  })
  .strict();

const PlaytestProviderStampSchema = z
  .object({
    id: z.string().min(1),
    vendor: z.string().min(1),
    family: z.string().min(1),
    isolation: PlaytestIsolationSchema,
    transport_contract: z.string().min(1),
    /**
     * For `runner_enforced` sessions: what the runner actually observed of the client
     * (resolved binary path, reported version, session id). Absent for
     * `operator_attested` sessions, where there is no accepted client-capture proof.
     */
    client_evidence: z.record(z.string()).optional(),
    /**
     * For `operator_attested` sessions: who or which dedicated harness asserted the
     * intended tool boundary, and how.
     * Required there, forbidden elsewhere — an attestation on a runner-enforced run
     * would duplicate something the accepted capture reader already proved.
     */
    operator_attestation: z
      .object({
        attested_by: z.string().min(1),
        method: z.string().min(1),
        attested_at: z.string().datetime(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((stamp, ctx) => {
    if (stamp.isolation === "operator_attested" && stamp.operator_attestation === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operator_attestation"],
        message: "operator_attested sessions must record who attested the tool boundary and how",
      });
    }
    if (stamp.isolation === "runner_enforced" && stamp.operator_attestation !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operator_attestation"],
        message:
          "runner_enforced sessions are proven by the runner and take no operator attestation",
      });
    }
  });

const PlaytestModelStampSchema = z
  .object({
    id: z.string().min(1),
    tier: PlaytestTierSchema,
    /** Provider settings verbatim (reasoning effort, thinking budget, verbosity…). */
    settings: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  })
  .strict();

/**
 * The playthrough log.
 *
 * The transcript lives beside the record as `transcript.jsonl` rather than inline: a
 * long session is megabytes, and inlining it would make the record itself expensive to
 * scan when the triage pass only needs the header. The hash keeps them bound — a
 * record whose transcript has been edited or truncated no longer verifies.
 */
const PlaytestLogSchema = z
  .object({
    /** Game tool calls the player made. */
    turns: z.number().int().nonnegative(),
    /** Meaningful decisions the journey contract accepted, when the run reached an exit. */
    accepted_decisions: z.number().int().nonnegative().nullable(),
    // Kept beside session.json. Reject paths and the record's own filename so a
    // hand-ingested transcript cannot escape the staging directory or overwrite the
    // immutable record before its atomic rename.
    transcript_filename: PlaytestTranscriptFilenameSchema,
    transcript_sha256: SHA256,
    transcript_bytes: z.number().int().nonnegative(),
  })
  .strict();

/**
 * The body's field set, kept as a bare strict object so the sealed record can EXTEND
 * it with `record_id`. Composing the two with an intersection instead would hand the
 * strict body a key it has never heard of and reject every sealed record.
 */
const PlaytestSessionBodyObject = z
  .object({
    schema_version: z.literal(PLAYTEST_SESSION_SCHEMA_VERSION),
    /** UTC ISO-8601, to the second. Date and time of the run. */
    recorded_at: z.string().datetime(),
    /** The game's own session id, so a record can be tied back to server-side evidence. */
    game_session_id: z.string().min(1),
    run_seed: z.number().int().safe(),
    /** Which build was played. This is what lets findings age out as the dev loop moves. */
    build: PureRunBuildSchema,
    provider: PlaytestProviderStampSchema,
    model: PlaytestModelStampSchema,
    persona: PlaytestPersonaSchema,
    outcome: PlaytestOutcomeSchema,
    log: PlaytestLogSchema,
    /** Present when the run produced a schema-valid interview. */
    exit_interview: SubjectiveExitInterviewSchema.nullable(),
    /** Present when the game confirmed a journey exit. */
    journey_receipt: JourneyExitReceiptSchema.nullable(),
    /** Why a non-`completed` run ended as it did. Kept so failures stay diagnosable. */
    failure_note: z.string().min(1).nullable(),
    /**
     * Set when the runner had to substitute the server's exit receipt for the player's.
     *
     * A repaired session is still honest evidence — the substituted value is server-authored
     * and the unchanged verifier had to accept the result — but it is NOT the same thing as a
     * player who transcribed its own receipt correctly, and an evidence reader deserves to
     * see the difference rather than infer it. Optional so every record written before this
     * field existed stays readable.
     */
    receipt_repair: z
      .object({
        replaced_field: z.string().min(1),
        count: z.number().int().positive(),
        initial_failure: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Cross-field rules, applied identically to a bare body and to a sealed record. Shared
 * rather than duplicated so a record can never be valid where its own body would not be.
 */
function refinePlaytestSessionBody(
  body: z.infer<typeof PlaytestSessionBodyObject>,
  ctx: z.RefinementCtx,
): void {
  {
    if (body.outcome === "completed" && body.exit_interview === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exit_interview"],
        message: "a completed session must carry its exit interview",
      });
    }
    if (body.outcome === "completed" && body.journey_receipt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["journey_receipt"],
        message: "a completed session must carry the game-returned journey receipt",
      });
    }
    if (body.outcome !== "completed" && body.failure_note === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failure_note"],
        message: `outcome "${body.outcome}" must explain itself in failure_note`,
      });
    }
  }
}

const PlaytestSessionBodySchema = PlaytestSessionBodyObject.superRefine(refinePlaytestSessionBody);
export type PlaytestSessionBody = z.infer<typeof PlaytestSessionBodyObject>;

const PlaytestSessionRecordSchema = PlaytestSessionBodyObject.extend({
  record_id: SHA256,
}).superRefine(refinePlaytestSessionBody);
export type PlaytestSessionRecord = PlaytestSessionBody & { record_id: string };

/**
 * Derive the content address. Deliberately hashes the body ONLY, so the id is a pure
 * function of the session's content and recomputing it is a verification, not a
 * restatement.
 */
function playtestRecordId(body: PlaytestSessionBody): string {
  return hashState(body);
}

/** Seal a body into a record by attaching its content address. */
export function sealPlaytestSession(body: PlaytestSessionBody): PlaytestSessionRecord {
  const parsed = PlaytestSessionBodySchema.parse(body);
  return { ...parsed, record_id: playtestRecordId(parsed) };
}

/**
 * Parse a record and re-derive its id. A record whose stored id does not match its
 * content has been edited since it was written, which for an append-only corpus is
 * corruption, not an update.
 */
export function parsePlaytestSession(raw: unknown): PlaytestSessionRecord {
  const record = PlaytestSessionRecordSchema.parse(raw) as PlaytestSessionRecord;
  const { record_id: storedId, ...body } = record;
  const expected = playtestRecordId(body as PlaytestSessionBody);
  if (storedId !== expected) {
    throw new Error(
      `playtest session ${storedId} does not match its content (recomputed ${expected}); the record was modified after it was written`,
    );
  }
  return record;
}

/**
 * Whether a record may contribute to retention/experience METRICS.
 *
 * Deliberately strict and deliberately narrow: only a runner-proven, completed run on
 * a clean tracked build counts. Everything else remains a first-class, kept, readable
 * record that feeds bug triage and frequency counting — it simply cannot move a
 * headline quality number. Keeping these two questions separate is what allows the
 * corpus to be maximally inclusive without the metrics becoming meaningless.
 */
export function countsTowardExperienceMetrics(record: PlaytestSessionRecord): boolean {
  return (
    record.outcome === "completed" &&
    record.provider.isolation === "runner_enforced" &&
    record.build.tracked_worktree_clean
  );
}

/** Directory name for a record: sortable by time, unique by content. */
export function playtestSessionDirName(record: PlaytestSessionRecord): string {
  const stamp = record.recorded_at.replace(/[-:]/g, "").replace(/\.\d+/, "");
  return `${stamp}__${record.provider.id}__${record.model.id}__${record.record_id.slice(0, 12)}`;
}

/**
 * Split a parsed exit interview into the two halves a record stores separately.
 *
 * One half is the player's OPINION (clarity, bugs, confusions, verdict); the other is
 * the game's own server-authored EXIT RECEIPT. They are kept apart because the pipeline
 * treats them differently — opinion is clustered and corroborated, the receipt is
 * evidence — and letting a client's prose sit in a field the pipeline trusts is exactly
 * the confusion that would make retention numbers meaningless.
 *
 * Shared by every ingest path (the runner's own recorder and the manual desktop ingest)
 * so a session recorded one way is byte-identical to the same session recorded the
 * other way.
 */
export function splitExitInterview(parsed: unknown): {
  interview: PlaytestSessionBody["exit_interview"];
  receipt: PlaytestSessionBody["journey_receipt"];
} {
  const record = parsed as Record<string, unknown>;
  const subjective: Record<string, unknown> = {};
  for (const key of Object.keys(SubjectiveExitInterviewSchema.shape)) {
    if (key in record) subjective[key] = record[key];
  }
  const carried = record.journey_exit_receipt;
  return {
    interview: SubjectiveExitInterviewSchema.parse(subjective),
    receipt: carried === undefined ? null : JourneyExitReceiptSchema.parse(carried),
  };
}
