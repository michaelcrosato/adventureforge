/**
 * A submission — one piece of work somebody wants done, whoever "somebody" is.
 *
 * This is the repository's single intake format, and its whole reason for existing is
 * that PLAYTEST FEEDBACK IS NOT THE ONLY WAY THE GAME CHANGES. An independent audit
 * agent finds a structural problem. A research agent proposes a mechanic. A human types
 * a feature request from their phone. The deterministic crawler files a softlock. None
 * of those are playtest reports, and a dev loop that could only consume playtest
 * findings would be blind to all of them.
 *
 * So the queue is deliberately source-agnostic. `src/qa/ticket.ts` stays the RICH,
 * playtest-specific evidence model — corroboration across model lineages, cost tiers,
 * session trails — because that reasoning is real and domain-specific. What lands in
 * the queue is the flattened result: a submission with a priority, a body, and a pointer
 * back to whatever evidence produced it. Other sources produce submissions directly,
 * with far simpler evidence, and compete on the same ranking.
 *
 * Identity is content-addressed on the STABLE part only — source, kind and an identity
 * key — never on the body, which gets edited, or the evidence, which accumulates. A
 * submission therefore keeps its id from first filing through to done, which is what
 * makes "have we already got this one?" answerable without fuzzy matching, and what
 * makes syncing to an external tracker idempotent instead of duplicate-generating.
 */
import { z } from "zod";
import { hashState } from "../core/hash.js";

export const SUBMISSION_SCHEMA_VERSION = 1 as const;

/** Where the queue lives. Tracked in git: it is the dev loop's inbox. */
export const DEFAULT_QUEUE_DIR = "intake/queue";

/**
 * Who filed it.
 *
 * Deliberately open-ended in spirit but closed in code: a new kind of agent gets an
 * entry here so the ranking can reason about it, rather than inventing a source string
 * at the call site that nothing downstream understands.
 */
export const SubmissionSourceSchema = z.enum([
  /** Promoted by playtest triage after corroboration or reproduction. */
  "playtest",
  /** An agent auditing the repo or the game independently of any playthrough. */
  "audit",
  /** A design or research proposal — a change nobody has complained about yet. */
  "research",
  /** A person. The one source that needs no evidence and outranks nothing by default. */
  "human",
  /** The deterministic crawler's invariant oracles. */
  "crawler",
]);
export type SubmissionSource = z.infer<typeof SubmissionSourceSchema>;

export const SubmissionKindSchema = z.enum([
  "bug",
  "experience",
  "feature",
  "refactor",
  "docs",
  "research",
]);
type SubmissionKind = z.infer<typeof SubmissionKindSchema>;

/**
 * Priority, kept separate from severity on purpose.
 *
 * Severity says how bad the thing is; priority says when we do it. A cosmetic defect on
 * the opening screen can outrank a severe one in content nobody reaches. Every real
 * tracker separates these and every homegrown one eventually regrets not doing so.
 */
export const SubmissionPrioritySchema = z.enum(["P0", "P1", "P2", "P3"]);
export type SubmissionPriority = z.infer<typeof SubmissionPrioritySchema>;

export const PRIORITY_RANK: Readonly<Record<SubmissionPriority, number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

export const SubmissionStatusSchema = z.enum([
  "open",
  "in_progress",
  "done",
  "declined",
  /** Aged out — see the playtest staleness rule. Revivable by a fresh report. */
  "stale",
]);
export type SubmissionStatus = z.infer<typeof SubmissionStatusSchema>;

/**
 * Why this is worth doing, in whatever terms the source can offer.
 *
 * Deliberately loose: an audit cites files, a playtest cites sessions and lineages, a
 * human cites nothing at all. Forcing every source into the playtest evidence shape
 * would either block the other sources or reduce playtest evidence to the weakest
 * common denominator. `refs` is where the trail back to the real artifact lives.
 */
export const SubmissionEvidenceSchema = z
  .object({
    /** One line a human can read without opening anything. */
    summary: z.string().min(1),
    /** Session ids, file paths, finding codes, URLs — whatever the source can point at. */
    refs: z.array(z.string().min(1)).default([]),
    /** Distinct model lineages behind it, when the source has that notion. */
    lineages: z.array(z.string().min(1)).default([]),
    /** How many independent observations. 1 for a human request; N for a corroborated cluster. */
    observations: z.number().int().positive().default(1),
  })
  .strict();

/** Where this lives in an external tracker, once synced. */
const GitHubExternalSchema = z
  .object({
    provider: z.literal("github"),
    number: z.number().int().positive(),
    url: z.string().min(1),
    /** Last state we pushed, so a no-op sync is detectable without a round trip. */
    synced_status: SubmissionStatusSchema,
  })
  .strict();
const LinearMirrorSchema = z
  .object({
    provider: z.literal("linear"),
    /** Linear's UUID, used for updates after the first marker lookup. */
    id: z.string().min(1),
    /** Human-facing identifier such as MIC-28. */
    identifier: z.string().min(1),
    url: z.string().min(1),
    /** Last state we pushed, so a no-op sync is detectable without a round trip. */
    synced_status: SubmissionStatusSchema,
  })
  .strict();

/** The legacy `external` field remains the GitHub pointer for compatibility. */
const SubmissionExternalSchema = GitHubExternalSchema;

/** References used by either the legacy primary pointer or additional mirrors. */
const SubmissionMirrorSchema = z.discriminatedUnion("provider", [
  GitHubExternalSchema,
  LinearMirrorSchema,
]);
type SubmissionMirror = z.infer<typeof SubmissionMirrorSchema>;

export const SubmissionSchema = z
  .object({
    schema_version: z.literal(SUBMISSION_SCHEMA_VERSION),
    id: z.string().regex(/^[0-9a-f]{16}$/),
    title: z.string().min(1),
    /** Markdown. What a dev agent reads to know what to build. */
    body: z.string().min(1),
    source: SubmissionSourceSchema,
    kind: SubmissionKindSchema,
    priority: SubmissionPrioritySchema,
    status: SubmissionStatusSchema,
    /**
     * The work claim: which lane holds this item and since when. OPTIONAL on purpose —
     * every queue file written before claims existed must keep parsing — and owned by
     * the queue's lifecycle like `status`, never by the source re-filing the item.
     * None of these participate in the content-addressed id (`submissionId` hashes
     * source/kind/key only).
     */
    claimed_by: z.string().min(1).optional(),
    claimed_at: z.string().datetime().optional(),
    /** Who marked it done or declined. The claim fields stay behind as history. */
    resolved_by: z.string().min(1).optional(),
    /** Free-form tags, mirrored to the tracker's labels. */
    labels: z.array(z.string().min(1)).default([]),
    /** Where in the game or repo, when the source knows. */
    area: z.string().min(1).nullable(),
    evidence: SubmissionEvidenceSchema,
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    external: SubmissionExternalSchema.nullable(),
    /** Additional tracker references when GitHub and Linear are mirrored together. */
    mirrors: z.array(SubmissionMirrorSchema).optional(),
  })
  .strict();
export type Submission = z.infer<typeof SubmissionSchema>;

/** Return all known tracker references, de-duplicated by provider. */
export function externalMirrors(
  submission: Pick<Submission, "external" | "mirrors">,
): SubmissionMirror[] {
  const refs = [
    ...(submission.external ? [submission.external] : []),
    ...(submission.mirrors ?? []),
  ];
  const seen = new Set<SubmissionMirror["provider"]>();
  return refs.filter((ref): ref is SubmissionMirror => {
    if (seen.has(ref.provider)) return false;
    seen.add(ref.provider);
    return true;
  });
}

/** Find a provider-specific reference without making callers know the storage layout. */
export function externalMirrorFor(
  submission: Pick<Submission, "external" | "mirrors">,
  provider: SubmissionMirror["provider"],
): SubmissionMirror | null {
  return externalMirrors(submission).find((ref) => ref.provider === provider) ?? null;
}

/** Add or replace one provider reference while retaining the other tracker mirror. */
export function withExternalMirror(submission: Submission, mirror: SubmissionMirror): Submission {
  const primaryProvider = submission.external?.provider;
  const retained = externalMirrors(submission).filter(
    (ref) => ref.provider !== mirror.provider && ref.provider !== primaryProvider,
  );
  if (mirror.provider === "github") {
    const mirrors = retained.filter((ref) => ref.provider !== "github");
    return { ...submission, external: mirror, mirrors };
  }
  return {
    ...submission,
    mirrors: [...retained.filter((ref) => ref.provider !== "linear"), mirror],
  };
}

/**
 * Stable identity. `key` is whatever the source uses to mean "the same problem" — a
 * playtest cluster fingerprint, an audit finding code plus path, a human's slugged
 * title.
 */
export function submissionId(identity: {
  source: SubmissionSource;
  kind: SubmissionKind;
  key: string;
}): string {
  return hashState(identity).slice(0, 16);
}

/** Slug a free-text title into a stable identity key, for sources with nothing better. */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Work the dev loop may pick up right now. */
export function isOpenWork(submission: Submission): boolean {
  return submission.status === "open" || submission.status === "in_progress";
}

/**
 * Queue order: priority first, then weight of evidence, then age.
 *
 * Evidence breaks ties rather than driving the order, because priority is a DECISION and
 * observation count is only an input to it. Letting raw counts sort the queue would put
 * a loud cheap cohort permanently ahead of a considered human request — which is exactly
 * the failure the ranking layer already corrects for upstream.
 */
export function compareSubmissions(a: Submission, b: Submission): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (byPriority !== 0) return byPriority;
  const byLineages = b.evidence.lineages.length - a.evidence.lineages.length;
  if (byLineages !== 0) return byLineages;
  const byObservations = b.evidence.observations - a.evidence.observations;
  if (byObservations !== 0) return byObservations;
  const byAge = a.created_at.localeCompare(b.created_at);
  return byAge !== 0 ? byAge : a.id.localeCompare(b.id);
}

/** Filename. Priority-prefixed so a plain directory listing is already the queue order. */
export function submissionFileName(submission: Submission): string {
  return `${submission.priority}-${submission.source}-${submission.id}.json`;
}

/**
 * Default priority for a source that has not decided one.
 *
 * A human request defaults higher than an unprompted agent proposal — not because
 * people are always right, but because a person filing a request has already spent
 * judgement that an agent's speculative proposal has not.
 */
export function defaultPriority(
  source: SubmissionSource,
  kind: SubmissionKind,
): SubmissionPriority {
  if (kind === "bug") return source === "crawler" ? "P0" : "P1";
  if (source === "human") return "P1";
  if (source === "research") return "P3";
  return "P2";
}
