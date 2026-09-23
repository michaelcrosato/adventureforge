/**
 * QA tickets — the only thing the dev loop reads from the playtest side.
 *
 * This is the seam that lets the two loops run at completely different speeds. The
 * playtest fleet produces a flood of raw, unequal, partly-contradictory opinion; the
 * dev loop needs a short ordered list of things worth building. A ticket is the
 * boundary object between those, and it is modelled on how a real QA organization
 * works rather than on how a benchmark works:
 *
 *   - A tester does not get to file a P1. They file a REPORT.
 *   - Triage decides what is a bug, what is one person's taste, and what is a
 *     duplicate of something already open.
 *   - A report becomes actionable through CORROBORATION or through REPRODUCTION —
 *     several independent testers hitting it, or one engineer confirming it.
 *   - Everything filed is kept, whether or not it is ever actioned.
 *
 * The last point is why `PromotionState` exists rather than a boolean. A report that
 * has been seen once is not rejected; it is `accumulating`, and it sits in the corpus
 * waiting to see whether anyone else ever hits it. Most never do — and that silence is
 * itself the answer, delivered for free.
 *
 * Ticket identity is deliberately content-addressed on the STABLE part only (kind,
 * location, cluster fingerprint) and not on the evidence, which grows every cohort. A
 * ticket therefore keeps its id from the first report through to the fix, which is what
 * makes "has this been seen before?" answerable without fuzzy matching.
 */
import { z } from "zod";
import { hashState } from "../core/hash.js";

export const QA_TICKET_SCHEMA_VERSION = 2 as const;

/** Where tickets live. Tracked in git on purpose: this is the dev loop's inbox. */
export const DEFAULT_TICKET_DIR = "qa/tickets";

export const TicketSeveritySchema = z.enum(["S0", "S1", "S2", "S3", "S4"]);
export type TicketSeverity = z.infer<typeof TicketSeveritySchema>;

/**
 * What kind of work the ticket implies. Kept separate from severity because they route
 * differently: a `bug` is a defect against the engine's own rules and can often be
 * confirmed mechanically, whereas an `experience` ticket is a judgement about how the
 * game reads and can only ever be corroborated by more players.
 */
export const TicketKindSchema = z.enum(["bug", "experience"]);
export type TicketKind = z.infer<typeof TicketKindSchema>;

/**
 * How much independent support the ticket has. This is the promotion ladder, and only
 * the top two rungs are visible to the dev loop.
 */
const PromotionStateSchema = z.enum([
  /**
   * Confirmed by something that does not have an opinion — the deterministic crawler
   * reproduced it, or a maintainer did. One verified report outranks any amount of
   * agreement, because agreement can be correlated and a reproduction cannot.
   */
  "verified",
  /**
   * Independently corroborated: distinct model lineages agree, or the reference cohort
   * confirmed what the volume cohort saw. Actionable.
   */
  "corroborated",
  /**
   * Seen, recorded, and not yet independently supported. NOT a rejection — this is the
   * resting state of most feedback, and a ticket can sit here indefinitely without
   * anyone deciding anything about it.
   */
  "accumulating",
]);
type PromotionState = z.infer<typeof PromotionStateSchema>;

/**
 * Workflow status, owned by whoever is acting on the ticket.
 *
 * `stale` is the state the split between the loops makes necessary. When playtests
 * floated free of the dev commit, findings acquired an age: a ticket last seen twelve
 * builds ago may describe something already fixed. It is marked stale and drops out of
 * the dev loop's view until a fresh report revives it; a stale ticket nobody decided
 * anything about later retires (`isRetireable`, qa/tickets/README.md "Retention").
 */
const TicketStatusSchema = z.enum([
  "open",
  "in_progress",
  "fixed",
  "verified_fixed",
  "wont_fix",
  "stale",
]);

export const TicketEvidenceSchema = z
  .object({
    /** Total reports folded into this ticket across every cohort. */
    report_count: z.number().int().positive(),
    /** Distinct model lineages that reported it, sorted. The independence measure. */
    families: z.array(z.string().min(1)),
    /** Distinct providers, sorted. Finer-grained than families for diagnosis. */
    providers: z.array(z.string().min(1)),
    /** Cost tiers that reported it. Reference-tier presence is meaningful on its own. */
    tiers: z.array(z.enum(["volume", "reference"])),
    /**
     * Whether any contributing report came from a session whose isolation the runner
     * proved. Operator-attested reports still count toward corroboration — a human
     * driving a desktop client is a real player — but a ticket supported ONLY by
     * unattestable sessions says so, so nobody later mistakes it for proven evidence.
     */
    has_runner_enforced_report: z.boolean(),
    /** Session record ids, sorted. The full trail back to every raw playthrough. */
    session_ids: z.array(z.string().min(1)).min(1),
    first_seen_build: z.string().min(1),
    last_seen_build: z.string().min(1),
    first_seen_at: z.string().datetime(),
    last_seen_at: z.string().datetime(),
  })
  .strict();
export type TicketEvidence = z.infer<typeof TicketEvidenceSchema>;

export const QaTicketSchema = z
  .object({
    // Keep v1 history readable. Supersession is v2 so an old reader fails closed
    // instead of treating a replaced corroboration as actionable work.
    schema_version: z.union([z.literal(1), z.literal(QA_TICKET_SCHEMA_VERSION)]),
    ticket_id: z.string().regex(/^[0-9a-f]{16}$/),
    title: z.string().min(1),
    kind: TicketKindSchema,
    severity: TicketSeveritySchema,
    status: TicketStatusSchema,
    promotion: PromotionStateSchema,
    /** Where in the game, as canonicalized by the feedback clusterer. */
    location: z.string().min(1),
    /** Representative quotes, capped — the full text is always in the session records. */
    excerpts: z.array(z.string().min(1)).max(5),
    evidence: TicketEvidenceSchema,
    /** Ranking score at last triage. Higher is more urgent. */
    priority: z.number().nonnegative(),
    notes: z.string().optional(),
    /**
     * What reproduced this ticket DETERMINISTICALLY — a regression test path or a crawler
     * probe. Its presence is what earns the `verified` rung, and it is durable: triage
     * carries it forward by identity, so a lead proved once stays proved without anyone
     * re-passing a flag on every later run. Optional, so every ticket file written before
     * this field keeps parsing.
     */
    verified_by: z.string().min(1).optional(),
    /** Corrected identities replacing this ticket; its authored history stays here. */
    superseded_by: z
      .array(z.string().regex(/^[0-9a-f]{16}$/))
      .min(1)
      .optional(),
  })
  .strict()
  .superRefine((ticket, ctx) => {
    if (!ticket.superseded_by) return;
    if (
      ticket.schema_version !== QA_TICKET_SCHEMA_VERSION ||
      ticket.superseded_by.includes(ticket.ticket_id) ||
      new Set(ticket.superseded_by).size !== ticket.superseded_by.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["superseded_by"],
        message: "supersession requires v2 and distinct successor ids other than this ticket",
      });
    }
  });
export type QaTicket = z.infer<typeof QaTicketSchema>;

/**
 * Stable identity: everything that makes this "the same problem", and nothing that
 * accumulates. Sixteen hex chars is plenty for a human-readable id at this corpus size
 * and keeps filenames and log lines short.
 */
export function ticketId(identity: {
  kind: TicketKind;
  location: string;
  fingerprint: string;
}): string {
  return hashState(identity).slice(0, 16);
}

/**
 * Decide the promotion rung from the evidence.
 *
 * The asymmetry between the two cohorts is the whole point, and it mirrors
 * `scoreCluster`'s tier factors:
 *
 *   - reference-tier presence corroborates on its own, because that cohort exists
 *     precisely to be the independent check on the cheap one;
 *   - volume-only needs a SECOND LINEAGE, because forty agreeing runs of one cheap
 *     model is one instrument's blind spot, not a consensus.
 */
export function derivePromotion(
  evidence: Pick<TicketEvidence, "families" | "tiers">,
  opts: { verified: boolean },
): PromotionState {
  if (opts.verified) return "verified";
  if (evidence.tiers.includes("reference")) return "corroborated";
  if (evidence.families.length >= 2) return "corroborated";
  return "accumulating";
}

/**
 * Tickets the dev loop is allowed to pick up: supported enough to be worth building,
 * and not already handled or aged out.
 */
export function isActionable(ticket: QaTicket): boolean {
  if (ticket.superseded_by) return false;
  if (ticket.status !== "open" && ticket.status !== "in_progress") return false;
  return ticket.promotion === "verified" || ticket.promotion === "corroborated";
}

/** Highest priority first; ties break on id so the ordering is total and stable. */
export function compareTickets(a: QaTicket, b: QaTicket): number {
  const byPriority = b.priority - a.priority;
  if (byPriority !== 0) return byPriority;
  return a.ticket_id.localeCompare(b.ticket_id);
}

/** Filename for a ticket. Severity-prefixed so a directory listing is already triaged. */
export function ticketFileName(ticket: QaTicket): string {
  return `${ticket.severity}-${ticket.kind}-${ticket.ticket_id}.json`;
}
