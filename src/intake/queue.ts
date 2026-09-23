/**
 * The intake queue on disk — one JSON file per submission, tracked in git.
 *
 * Tracked, not gitignored, and that is the point: the dev loop runs against a checkout,
 * so a submission that only exists on the machine that filed it is a submission the dev
 * loop cannot act on. Closed items are pruned from the tree once resolved; git history
 * keeps each one next to the commits that closed it.
 *
 * There is no external tracker; these files are the whole queue, so the loop keeps working
 * offline and never takes an outage dependency on an API.
 *
 * Upsert semantics rather than wholesale rewrite: submissions arrive from several
 * independent sources that know nothing about each other, so a writer must be able to
 * add its own without stepping on anyone else's.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { writeFileAtomic } from "./atomic_file.js";
import { hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { canonicalize } from "../core/hash.js";
import {
  compareSubmissions,
  DEFAULT_QUEUE_DIR,
  isOpenWork,
  PRIORITY_RANK,
  SubmissionSchema,
  submissionFileName,
  type Submission,
  type SubmissionPriority,
  type SubmissionSource,
  type SubmissionStatus,
} from "./submission.js";

export function readQueue(dir: string = DEFAULT_QUEUE_DIR): {
  submissions: Submission[];
  unreadable: { file: string; reason: string }[];
} {
  const root = resolve(dir);
  const submissions: Submission[] = [];
  const unreadable: { file: string; reason: string }[] = [];
  if (!existsSync(root)) return { submissions, unreadable };

  for (const name of readdirSync(root).sort()) {
    if (!name.endsWith(".json")) continue;
    const file = join(root, name);
    try {
      submissions.push(SubmissionSchema.parse(JSON.parse(readFileSync(file, "utf8"))));
    } catch (error) {
      // Reported, never skipped silently: a malformed submission is work nobody is
      // seeing, which is the quiet failure this whole queue exists to prevent.
      unreadable.push({ file, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  submissions.sort(compareSubmissions);
  return { submissions, unreadable };
}

/**
 * Add or update one submission, preserving fields the queue owns rather than the caller.
 *
 * `status` belongs to the QUEUE's lifecycle — whoever is working the item — not to the
 * source that keeps re-filing it. A playtest loop re-triaging every wave must not reset
 * an item a dev agent already marked `in_progress`. `created_at` is likewise
 * first-filing, not latest-filing.
 *
 * A re-file that changes nothing is a NO-OP, down to the bytes on disk. These files are
 * tracked, and `loop.sh` runs `qa:triage` (which upserts every actionable ticket) inside
 * the dev cycle AFTER the cycle-start cleanliness check — so an unconditional
 * `updated_at` bump manufactured a tracked-file diff out of an unchanged corpus and left
 * every cycle with a dirty tree it never intended to produce. "Re-filing is safe and
 * expected" (docs/two_loop_workflow.md) has to mean byte-identical when nothing moved.
 */
export function upsertSubmission(
  submission: Submission,
  dir: string = DEFAULT_QUEUE_DIR,
): Submission {
  // The read path is strict, so the write path has to be too. Without this the queue
  // could persist a file it would never read back: `readQueue` parses with the same
  // schema, so an off-schema submission lands on disk, is reported `unreadable` on every
  // subsequent read, is invisible to `npm run work` and to the GitHub push loop, and —
  // because nothing downstream ever saw it — is re-minted identically by whatever wrote
  // it. A loud throw at the writer names the actual culprit; a quiet write blames the
  // reader for the rest of the file's life.
  const valid = SubmissionSchema.safeParse(submission);
  if (!valid.success) {
    throw new Error(
      `refusing to write submission ${submission.id}: ${valid.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const root = resolve(dir);
  mkdirSync(root, { recursive: true });

  const existing = readQueue(dir).submissions.find((s) => s.id === submission.id);
  let merged: Submission;
  if (existing) {
    const carried: Submission = {
      ...submission,
      status: existing.status === "stale" ? "open" : existing.status,
      // The claim is the queue's, exactly like `status`: a source re-filing an item it
      // knows nothing about must not evict the lane that is working it, and a re-file
      // that changes nothing must stay byte-identical even while the item is claimed.
      claimed_by: existing.claimed_by,
      claimed_at: existing.claimed_at,
      resolved_by: existing.resolved_by,
      created_at: existing.created_at,
      // Carried, not stamped, so the comparison below sees only real changes.
      updated_at: existing.updated_at,
    };
    if (canonicalize(carried) === canonicalize(existing)) return existing;
    merged = { ...carried, updated_at: new Date().toISOString() };
  } else {
    merged = submission;
  }

  // The filename encodes priority, so a re-file at a new priority must remove the old
  // file or the queue would hold the same id twice under two names.
  for (const name of readdirSync(root)) {
    if (name.endsWith(`-${submission.id}.json`) && name !== submissionFileName(merged)) {
      rmSync(join(root, name));
    }
  }
  writeFileAtomic(
    join(root, submissionFileName(merged)),
    `${JSON.stringify(merged, null, 2)}
`,
  );
  return merged;
}

/** Rewrite one submission in place, evicting any older file that carried its id. */
function rewriteSubmission(next: Submission, dir: string): Submission {
  const root = resolve(dir);
  for (const name of readdirSync(root)) {
    if (name.endsWith(`-${next.id}.json`) && name !== submissionFileName(next)) {
      rmSync(join(root, name));
    }
  }
  writeFileAtomic(
    join(root, submissionFileName(next)),
    `${JSON.stringify(next, null, 2)}
`,
  );
  return next;
}

/** Update just the lifecycle fields of one submission, by id. */
export function setSubmissionStatus(
  id: string,
  status: SubmissionStatus,
  dir: string = DEFAULT_QUEUE_DIR,
  options: { resolvedBy?: string } = {},
): Submission | null {
  const found = readQueue(dir).submissions.find((s) => s.id === id);
  if (!found) return null;
  const next: Submission = {
    ...found,
    status,
    ...(options.resolvedBy !== undefined ? { resolved_by: options.resolvedBy } : {}),
    updated_at: new Date().toISOString(),
  };
  return rewriteSubmission(next, dir);
}

/**
 * Retire work whose playtest identity was conclusively replaced during QA triage.
 * This is a lifecycle operation, not a re-file: retain authored content, ownership
 * history and tracker pointers. The successor references explain the machine decision.
 */
export const QA_SUPERSESSION_RESOLVER = "qa:triage:region-supersession";

export function supersedePlaytestSubmission(
  id: string,
  kind: Submission["kind"],
  successorTicketIds: readonly string[],
  dir: string = DEFAULT_QUEUE_DIR,
): Submission | null {
  const found = readQueue(dir).submissions.find((submission) => submission.id === id);
  if (!found || found.source !== "playtest" || found.kind !== kind) return null;
  if (!isOpenWork(found) || successorTicketIds.length === 0) return found;
  return rewriteSubmission(
    {
      ...found,
      status: "declined",
      resolved_by: QA_SUPERSESSION_RESOLVER,
      evidence: {
        ...found.evidence,
        refs: [
          ...new Set([
            ...found.evidence.refs,
            ...[...successorTicketIds].sort().map((ticketId) => `qa-ticket:${ticketId}`),
          ]),
        ],
      },
      updated_at: new Date().toISOString(),
    },
    dir,
  );
}

/** How long a work claim holds before another lane may take the item over. */
const DEFAULT_CLAIM_LEASE_HOURS = 24;

/**
 * Who is doing the claiming. `AI_LANE_ID` names one lane among several running the
 * same agent; `AI_AGENT` is the loop's vendor selection (see AGENTS.md); the machine
 * identity is the fallback so a bare human invocation still leaves a real name.
 */
export function resolveClaimIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.AI_LANE_ID?.trim() || env.AI_AGENT?.trim();
  return fromEnv || `${userInfo().username}@${hostname()}`;
}

/** Lease length in hours: env `AI_CLAIM_LEASE_HOURS`, else the default. */
export function claimLeaseHours(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.AI_CLAIM_LEASE_HOURS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLAIM_LEASE_HOURS;
}

type ClaimResult =
  | { ok: false; reason: "missing" }
  /** Someone else's claim is younger than the lease and `force` was not given. */
  | { ok: false; reason: "held"; holder: string; heldHours: number; leaseHours: number }
  | {
      ok: true;
      outcome: "claimed" | "refreshed" | "reclaimed" | "forced";
      submission: Submission;
      /** The lane displaced by a `reclaimed` or `forced` takeover; null otherwise. */
      previousHolder: string | null;
      heldHours: number | null;
    };

/**
 * Claim one submission for an identity, honouring the lease another lane may hold.
 *
 * The rules, in the order they resolve:
 *   - the same identity re-claiming REFRESHES its lease (a long task keeps its item);
 *   - a different identity's claim younger than the lease REFUSES unless forced,
 *     because two lanes building the same thing is the exact waste claims exist to stop;
 *   - a claim older than the lease is RECLAIMED — a crashed lane must not hold work
 *     hostage — and a claim with no timestamp at all (files from before claims
 *     existed) counts as expired for the same reason: it cannot prove freshness.
 */
export function claimSubmission(
  id: string,
  options: { identity?: string; leaseHours?: number; force?: boolean; now?: Date } = {},
  dir: string = DEFAULT_QUEUE_DIR,
): ClaimResult {
  const found = readQueue(dir).submissions.find((s) => s.id === id);
  if (!found) return { ok: false, reason: "missing" };
  const identity = options.identity ?? resolveClaimIdentity();
  const leaseHours = options.leaseHours ?? claimLeaseHours();
  const now = options.now ?? new Date();

  let outcome: "claimed" | "refreshed" | "reclaimed" | "forced" = "claimed";
  let previousHolder: string | null = null;
  let heldHours: number | null = null;
  if (found.status === "in_progress" && found.claimed_by && found.claimed_by !== identity) {
    heldHours = found.claimed_at
      ? (now.getTime() - Date.parse(found.claimed_at)) / 3_600_000
      : Number.POSITIVE_INFINITY;
    const fresh = heldHours < leaseHours;
    if (fresh && !options.force) {
      return { ok: false, reason: "held", holder: found.claimed_by, heldHours, leaseHours };
    }
    previousHolder = found.claimed_by;
    outcome = fresh ? "forced" : "reclaimed";
  } else if (found.claimed_by === identity) {
    outcome = "refreshed";
  }

  const next: Submission = {
    ...found,
    status: "in_progress",
    claimed_by: identity,
    claimed_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  return { ok: true, outcome, submission: rewriteSubmission(next, dir), previousHolder, heldHours };
}

type QueueSummary = {
  total: number;
  open: number;
  byPriority: Record<string, number>;
  bySource: Record<string, number>;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  next: Submission | null;
};

export function summarizeQueue(submissions: readonly Submission[]): QueueSummary {
  const bump = (t: Record<string, number>, k: string): void => {
    t[k] = (t[k] ?? 0) + 1;
  };
  const byPriority: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const s of submissions) {
    bump(byPriority, s.priority);
    bump(bySource, s.source);
    bump(byKind, s.kind);
    bump(byStatus, s.status);
  }
  const open = submissions.filter(isOpenWork);
  return {
    total: submissions.length,
    open: open.length,
    byPriority,
    bySource,
    byKind,
    byStatus,
    next: open[0] ?? null,
  };
}

/**
 * The single item the dev loop should pick up, honouring optional filters.
 *
 * `maxPriority` is a FLOOR on urgency expressed as a ceiling on the label: "P1" means
 * P0 and P1 are eligible and P2/P3 are not. It was declared in the signature but never
 * applied, so a caller asking for "nothing below P1" was handed the whole queue and had
 * no way to tell — the worst shape of no-op, because the answer looks plausible.
 */
export function nextWork(
  submissions: readonly Submission[],
  filters: { source?: SubmissionSource; maxPriority?: SubmissionPriority } = {},
): Submission | null {
  const eligible = submissions.filter((s) => {
    if (!isOpenWork(s)) return false;
    if (filters.source && s.source !== filters.source) return false;
    if (filters.maxPriority && PRIORITY_RANK[s.priority] > PRIORITY_RANK[filters.maxPriority]) {
      return false;
    }
    return true;
  });
  return eligible[0] ?? null;
}
