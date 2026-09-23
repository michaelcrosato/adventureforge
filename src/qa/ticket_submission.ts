/**
 * Promote a QA ticket into an intake submission.
 *
 * This is the seam between the rich, playtest-specific evidence model and the flat,
 * source-agnostic queue. Triage keeps reasoning in its own terms — corroboration across
 * model lineages, cost tiers, session trails, staleness — and only what survives that
 * reasoning crosses into the queue, flattened to a priority and a body a dev agent can
 * act on without knowing anything about playtesting.
 *
 * Only ACTIONABLE tickets cross. An `accumulating` ticket is real, kept, and readable in
 * `qa/tickets/`, but it is not yet work, and putting it in the dev loop's queue would
 * hand the loop a pile of single-report opinions to chase. The queue is for things
 * somebody should build; the ticket bucket is the whole picture.
 *
 * The submission's identity key is the TICKET id, which is itself content-addressed on
 * the problem's stable identity. So a finding that keeps recurring across cohorts
 * updates one queue item and one tracker issue for its entire life, rather than filing a
 * fresh one every wave — which is the single most important property for a queue fed by
 * a loop that runs continuously.
 */
import {
  DEFAULT_QUEUE_DIR,
  SUBMISSION_SCHEMA_VERSION,
  submissionId,
  type Submission,
  type SubmissionPriority,
} from "../intake/submission.js";
import { canonicalize } from "../core/hash.js";
import {
  QA_SUPERSESSION_RESOLVER,
  readQueue,
  supersedePlaytestSubmission,
  upsertSubmission,
} from "../intake/queue.js";
import { isActionable, type QaTicket } from "./ticket.js";

/**
 * Map severity and promotion onto a priority.
 *
 * Severity alone is not enough: a reproduced S2 is more urgent than a corroborated S2,
 * because a reproduction is a fact and corroboration is still an inference. Promotion
 * therefore lifts a ticket by one band, and nothing lifts above P0.
 */
export function ticketPriority(ticket: QaTicket): SubmissionPriority {
  const bySeverity: Record<QaTicket["severity"], SubmissionPriority> = {
    S4: "P0",
    S3: "P1",
    S2: "P2",
    S1: "P3",
    S0: "P3",
  };
  const base = bySeverity[ticket.severity];
  if (ticket.promotion !== "verified") return base;
  const lifted: Record<SubmissionPriority, SubmissionPriority> = {
    P0: "P0",
    P1: "P0",
    P2: "P1",
    P3: "P2",
  };
  return lifted[base];
}

function ticketBody(ticket: QaTicket): string {
  const excerpts =
    ticket.excerpts.length > 0
      ? `\n\n**What players said**\n${ticket.excerpts.map((e) => `- ${e}`).join("\n")}`
      : "";
  const tiers = ticket.evidence.tiers.join(" + ") || "unknown";
  const attested = ticket.evidence.has_runner_enforced_report
    ? ""
    : "\n\n> Every supporting session is operator-attested; no runner-proven run backs this yet.";
  return (
    `Promoted from playtest triage (\`${ticket.promotion}\`).\n\n` +
    `**Where** \`${ticket.location}\`\n` +
    `**Severity** \`${ticket.severity}\` · **Reports** ${ticket.evidence.report_count} · ` +
    `**Lineages** ${ticket.evidence.families.join(", ") || "none"} · **Tiers** ${tiers}\n` +
    `**First seen** build \`${ticket.evidence.first_seen_build.slice(0, 12)}\` · ` +
    `**Last seen** build \`${ticket.evidence.last_seen_build.slice(0, 12)}\`` +
    excerpts +
    attested
  );
}

export function submissionFromTicket(ticket: QaTicket): Submission {
  const now = new Date().toISOString();
  const kind = ticket.kind === "bug" ? "bug" : "experience";
  return {
    schema_version: SUBMISSION_SCHEMA_VERSION,
    id: submissionId({ source: "playtest", kind, key: ticket.ticket_id }),
    title: ticket.title,
    body: ticketBody(ticket),
    source: "playtest",
    kind,
    priority: ticketPriority(ticket),
    status: "open",
    labels: [ticket.promotion],
    area: ticket.location,
    evidence: {
      summary:
        `${ticket.evidence.report_count} report(s) across ` +
        `${ticket.evidence.families.length} independent lineage(s), ` +
        `tiers ${ticket.evidence.tiers.join("+") || "unknown"}.`,
      refs: ticket.evidence.session_ids.slice(0, 20),
      lineages: ticket.evidence.families,
      observations: ticket.evidence.report_count,
    },
    created_at: now,
    updated_at: now,
  };
}

/** Only what triage judged actionable becomes queued work. */
export function submissionsFromTickets(tickets: readonly QaTicket[]): Submission[] {
  return tickets.filter(isActionable).map(submissionFromTicket);
}

/**
 * Reconcile persisted supersessions as well as newly actionable evidence. Merely
 * omitting a replaced ticket from the next upsert leaves its old intake item open.
 * Create successors before retiring predecessors so an interrupted run can retry
 * without losing a one-to-one claim. Mirrors always stay on their original identity.
 */
export function reconcileTicketSubmissions(
  tickets: readonly QaTicket[],
  dir: string = DEFAULT_QUEUE_DIR,
  options: { supersededOnly?: boolean } = {},
): { promoted: number; superseded: number } {
  const queued = new Map(
    readQueue(dir).submissions.map((submission) => [submission.id, submission]),
  );
  const predecessors = new Map<string, QaTicket[]>();
  const ticketIds = new Set(tickets.map((ticket) => ticket.ticket_id));
  for (const ticket of tickets) {
    for (const successor of ticket.superseded_by ?? []) {
      const priors = predecessors.get(successor) ?? [];
      priors.push(ticket);
      predecessors.set(successor, priors);
    }
  }
  const priorSubmission = (ticket: QaTicket): Submission | undefined => {
    const prior = queued.get(
      submissionId({ source: "playtest", kind: ticket.kind, key: ticket.ticket_id }),
    );
    return prior?.source === "playtest" && prior.kind === ticket.kind ? prior : undefined;
  };
  const promoted = tickets.filter(
    (ticket) =>
      isActionable(ticket) && (!options.supersededOnly || predecessors.has(ticket.ticket_id)),
  );
  for (const ticket of promoted) {
    let submission = submissionFromTicket(ticket);
    const current = queued.get(submission.id);
    // Current triage emits v2. An unchanged v1 ticket was carried from history,
    // possibly because this machine only has part of its evidence. Do not re-file
    // that old evidence over an investigator's edited intake body.
    if (ticket.schema_version === 1 && current) continue;
    const candidates = predecessors.get(ticket.ticket_id) ?? [];
    const priorTicket =
      candidates.length === 1 && candidates[0]!.superseded_by?.length === 1
        ? candidates[0]
        : undefined;
    const predecessor = priorTicket ? priorSubmission(priorTicket) : undefined;
    const inheritedEvidence =
      priorTicket !== undefined &&
      canonicalize(ticket.evidence) === canonicalize(priorTicket.evidence);
    // Ordinary re-filing revives stale work. A retry of a transferred stale decision
    // has no new evidence; compare the full immutable QA history, since the intake
    // payload caps session refs and does not retain build/time boundaries.
    if (predecessor?.status === "stale" && current?.status === "stale" && inheritedEvidence)
      continue;
    if (!current && predecessor && predecessor.resolved_by !== QA_SUPERSESSION_RESOLVER) {
      submission = {
        ...submission,
        status: predecessor.status === "stale" && !inheritedEvidence ? "open" : predecessor.status,
        claimed_by: predecessor.claimed_by,
        claimed_at: predecessor.claimed_at,
        resolved_by: predecessor.resolved_by,
      };
    }
    upsertSubmission(submission, dir);
  }
  let superseded = 0;
  for (const ticket of tickets) {
    if (!ticket.superseded_by) continue;
    // An interrupted ticket write can leave a marker without all its successors.
    // Keep the old claim until the replacement records are available to reconcile.
    if (!ticket.superseded_by.every((id) => ticketIds.has(id))) continue;
    const prior = priorSubmission(ticket);
    if (!prior) continue;
    const next = supersedePlaytestSubmission(prior.id, ticket.kind, ticket.superseded_by, dir);
    if (next && next.status !== prior.status) superseded += 1;
  }
  return { promoted: promoted.length, superseded };
}

/** Kept for callers that want the default without a ticket in hand. */
