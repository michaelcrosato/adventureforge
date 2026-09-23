/**
 * Deterministic issue clustering — the analytical core of the feedback
 * compiler. NO LLM anywhere in this path: every grouping decision is a pure
 * function of issue content (canonical location, severity, tokenized text),
 * never of input array order or any external judgment call.
 *
 * Pipeline (see `clusterIssues` below):
 *   1. Sort issues canonically (locationKey, severity, normalized text, ref)
 *      so nothing downstream ever depends on the order the caller happened
 *      to supply issues in.
 *   2. Pass 1 — exact fingerprint buckets on (locationKey, severityBand,
 *      first 6 tokens). Cheap and coarse: two issues land in the same bucket
 *      only when their tokenized fingerprints match exactly.
 *   3. Pass 2 — repeatedly merge any two buckets that share a locationKey and
 *      whose token sets are ALL pairwise >= JACCARD_MERGE_THRESHOLD similar,
 *      iterating to a fixpoint. Every pair, not just the two clusters' blended
 *      unions: comparing unions would make this single-link agglomeration, where
 *      two issues that share nothing land in one cluster because a third sits
 *      between them (see `everyMemberPairSimilar`). The merge direction
 *      (lexicographically-smaller key always folds into the larger) means the
 *      surviving key of any merged group is simply the max of that group's
 *      original bucket keys. Combined with step 1, the whole pipeline is a pure
 *      function of the *set* of input issues, never their order (see the "input
 *      order never changes the clustering" test).
 */
import type { PlaytestTier } from "../blind/providers.js";
import type { CanonicalLocation, FeedbackSource } from "./schema.js";

export type IssueSeverity = "S0" | "S1" | "S2" | "S3" | "S4";
export type SeverityBand = "minor" | "moderate" | "severe";

export type IssueRecord = {
  source: FeedbackSource;
  ref: string; // report filename / findings.jsonl row ref
  location: CanonicalLocation;
  severity: IssueSeverity;
  text: string;
  persona: string | null;
  target: string; // "overworld" | "quest:<id>"
  /**
   * Which model lineage reported this, and at which cost tier. Both are optional
   * because crawler findings have no model behind them at all, and because evidence
   * predating the multi-vendor playtest loop carries neither — a cluster with no
   * provider metadata is scored by the original count×severity rule (see
   * `scoreCluster`), so historical rankings are unchanged.
   *
   * When present they are what stops a mass-parallel fleet from fooling the ranking:
   * forty reports from one cheap model are one instrument sampled forty times, and
   * `familyOf` is how the ranking tells that apart from four vendors agreeing.
   */
  providerFamily?: string | null;
  tier?: PlaytestTier | null;
};

export type IssueCluster = {
  key: string;
  issues: IssueRecord[];
  tokens: string[];
  location: CanonicalLocation;
  maxSeverity: IssueSeverity;
  severityBand: SeverityBand;
  sources: FeedbackSource[];
  personas: string[];
  /** Distinct model lineages that reported this cluster, sorted. Empty when unknown. */
  families: string[];
  /** Distinct cost tiers that reported it, sorted. Empty when unknown. */
  tiers: PlaytestTier[];
};

/**
 * Jaccard similarity threshold for pass-2 cross-bucket merges.
 *
 * Calibrated against REAL reports rather than intuition, because the previous value of
 * 0.5 turned out to sit above the point where anything real ever merged. Four sessions
 * independently described one blocked-exit defect in their own words; their pairwise
 * similarity ran 0.219 to 0.429, so at 0.5 they produced four tickets at one report
 * each. Corroboration — the rung the whole two-loop split exists to reach — could
 * therefore never fire on genuinely independent prose, only on near-duplicate text.
 *
 * Measured both directions on that same real material:
 *
 *   same defect, four independent wordings   0.219 – 0.429   must merge
 *   different defects (incl. cross pairs)    0.000 – 0.043   must not merge
 *
 * A gap of 0.175 separates them, and 0.15 sits inside it — comfortably above the
 * highest false pair and below the lowest true one. It is a threshold on token bags,
 * so it will never be exact; what makes it safe is that pass 2 only ever compares
 * issues that ALREADY share a canonical location, so the question being asked is the
 * narrow "are these two reports about the same thing in the same place?"
 *
 * Verified end to end on both sides: four real wordings of one defect now form a single
 * ticket at report_count 4, while three genuinely different defects filed against one
 * story choice stay three tickets.
 */
export const JACCARD_MERGE_THRESHOLD = 0.15;

/**
 * Fixed ~40-word stopword list for `tokenizeIssue`. Deliberately separate
 * from normalize.ts's `RUNG3_STOPWORDS`: that list is a tiny 9-word set
 * tuned for conservative location-NAME matching (never strip enough to risk
 * a false collision between two different place names). This list serves the
 * opposite goal — collapsing near-duplicate free-text ISSUE reports together
 * — so it can afford to be broader: clustering only ever groups issues that
 * already share a canonical location (see `locationKey`), so a slightly
 * looser token match here can't glom together two genuinely different
 * places the way it could in normalize.ts.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "out",
  "over",
  "so",
  "than",
  "that",
  "the",
  "then",
  "there",
  "this",
  "to",
  "too",
  "under",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "with",
  "you",
  "your",
  "about",
]);

const SEVERITY_ORDER: readonly IssueSeverity[] = ["S0", "S1", "S2", "S3", "S4"];

function severityRank(severity: IssueSeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** S0-S1 minor, S2 moderate, S3-S4 severe. */
function severityBand(severity: IssueSeverity): SeverityBand {
  const rank = severityRank(severity);
  if (rank <= 1) return "minor";
  if (rank === 2) return "moderate";
  return "severe";
}

const MIN_STEM_LENGTH = 3;
/** Longest-first so "confusing" strips "ing" (not a shorter/wrong suffix). */
const STEM_SUFFIXES = ["ing", "ed", "es", "s"] as const;

/** Single-pass crude stemmer: strips at most one trailing suffix. */
function stem(token: string): string {
  for (const suffix of STEM_SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= MIN_STEM_LENGTH) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

/**
 * lowercase -> strip punctuation -> drop stopwords -> crude stem (trailing
 * "ing"/"ed"/"es"/"s", longest suffix first, min stem length 3) -> dedupe ->
 * sort. The sort+dedupe means two texts with the same *bag* of significant
 * words tokenize identically regardless of word order or repetition — the
 * property `clusterIssues` leans on for its fingerprint/Jaccard comparisons.
 */
export function tokenizeIssue(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const tokens = new Set<string>();
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    tokens.add(stem(word));
  }
  return [...tokens].sort();
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  return intersection / union.size;
}

/**
 * Stable string identity for a CanonicalLocation, used to decide which
 * issues are even ELIGIBLE to cluster together (pass 2 never merges across
 * locationKeys). Built from `kind|questId|node|sceneId`, with the region added
 * for overworld locations that resolve to a whole region rather than a node.
 * Region is redundant when a node is known, so those existing identities stay
 * independent of the region's display name.
 *
 * `unmapped` locations used to be the one exception: they key on
 * `kind|raw-joined`, on the reasoning that two DIFFERENT unmapped raw strings
 * must never be treated as the same place merely because neither resolved.
 *
 * That reasoning protects against a real failure, but it bought the protection
 * at a price nobody priced: pass 2 never merges across locationKeys, so making
 * the player's exact wording part of the key meant an unmapped finding could
 * only ever corroborate with a report phrased character-for-character the same
 * way. Two players describing one defect in their own words produced two
 * clusters of one, forever — so the findings least likely to name a resolvable
 * location became the findings least able to earn promotion, which is the
 * opposite of what evidence weight should do.
 *
 * They now share one bucket, and the merge is gated where the gate belongs: on
 * CONTENT. Pass 1 still demands the same severity band and the same first six
 * stemmed tokens; pass 2 still demands `everyMemberPairSimilar`. Neither test is
 * relaxed here — this only makes unmapped issues ELIGIBLE to be compared, where
 * before they were disqualified by their phrasing alone.
 *
 * The risk this accepts, stated plainly: two genuinely different unresolved
 * problems described in closely similar words can now land in one cluster, where
 * previously they could not. That is bounded by the similarity test, and it is
 * the same risk every mapped location already carries.
 */
function locationKey(location: CanonicalLocation): string {
  if (location.kind === "unmapped") {
    return UNMAPPED_LOCATION_KEY;
  }
  // Its OWN bucket, never merged with `unmapped`. The two mean opposite things — one text
  // named nothing recognisable, the other named several recognisable things — and pooling
  // them would let a report that pointed nowhere corroborate a report about the whole
  // game.
  if (location.kind === "global") {
    return GLOBAL_LOCATION_KEY;
  }
  const part = (value: string | null): string => value ?? "\x00";
  const key = `${location.kind}|${part(location.questId)}|${part(location.node)}|${part(location.sceneId)}`;
  return location.kind === "overworld" && location.node === null && location.region !== null
    ? `${key}|region:${location.region}`
    : key;
}

/**
 * The single key every unresolved free-text location shares. Exported because the
 * ticket layer labels these clusters with the same word, and two spellings of one
 * concept is how they drift apart.
 */
export const UNMAPPED_LOCATION_KEY = "unmapped";

/** The key every cross-cutting report shares. See `locationKey` for why it is separate. */
export const GLOBAL_LOCATION_KEY = "global";

function unionTokens(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

function fingerprint(locKey: string, band: SeverityBand, tokens: readonly string[]): string {
  return `${locKey}|${band}|${tokens.slice(0, 6).join(",")}`;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Canonical, content-only ordering — never touches input array position. */
function compareIssues(a: IssueRecord, b: IssueRecord): number {
  const sevDiff = severityRank(a.severity) - severityRank(b.severity);
  if (sevDiff !== 0) return sevDiff;
  const at = tokenizeIssue(a.text).join(" ");
  const bt = tokenizeIssue(b.text).join(" ");
  if (at !== bt) return compareStrings(at, bt);
  return compareStrings(a.ref, b.ref);
}

type WorkingCluster = {
  /** The fingerprint key of the bucket that "won" every merge it took part
   * in — always the lexicographically largest fingerprint key among the
   * original pass-1 buckets folded into this cluster. */
  key: string;
  locationKey: string;
  issues: IssueRecord[];
  tokens: string[];
  /**
   * The token set of each ORIGINAL pass-1 bucket folded into this cluster, kept
   * separately from the growing `tokens` union so pass 2 can ask its question of
   * every member rather than of the blend (see `everyMemberPairSimilar`).
   */
  members: string[][];
};

function finalizeCluster(cluster: WorkingCluster): IssueCluster {
  const sortedIssues = [...cluster.issues].sort(compareIssues);
  const first = sortedIssues[0]!;
  let maxSeverity = first.severity;
  for (const issue of sortedIssues) {
    if (severityRank(issue.severity) > severityRank(maxSeverity)) maxSeverity = issue.severity;
  }

  const sourceOrder: readonly FeedbackSource[] = ["crawler", "fleet"];
  const sourcesPresent = new Set(sortedIssues.map((issue) => issue.source));
  const sources = sourceOrder.filter((source) => sourcesPresent.has(source));

  const personas = [
    ...new Set(
      sortedIssues
        .map((issue) => issue.persona)
        .filter((persona): persona is string => persona !== null),
    ),
  ].sort();

  const families = [
    ...new Set(
      sortedIssues
        .map((issue) => issue.providerFamily)
        .filter((family): family is string => typeof family === "string" && family.length > 0),
    ),
  ].sort();

  const tierOrder: readonly PlaytestTier[] = ["reference", "volume"];
  const tiersPresent = new Set(
    sortedIssues
      .map((issue) => issue.tier)
      .filter((tier): tier is PlaytestTier => tier === "volume" || tier === "reference"),
  );
  const tiers = tierOrder.filter((tier) => tiersPresent.has(tier));

  const rawUnion = [...new Set(sortedIssues.flatMap((issue) => issue.location.raw))].sort();
  const location: CanonicalLocation = { ...first.location, raw: rawUnion };

  return {
    key: cluster.key,
    issues: sortedIssues,
    tokens: cluster.tokens,
    location,
    maxSeverity,
    severityBand: severityBand(maxSeverity),
    sources,
    personas,
    families,
    tiers,
  };
}

/**
 * Merge eligibility for pass 2: EVERY member of one cluster must clear the
 * threshold against every member of the other.
 *
 * The comparison used to be a single Jaccard between the two clusters' growing token
 * UNIONS, which made pass 2 single-link agglomeration: A merges with B, then B merges
 * with C, and A and C end up in one cluster having never been compared. At the old 0.5
 * threshold that rarely reached far; at 0.15 it chains routinely, and it chains across
 * severity bands because pass 2 gates on location alone. Verified against the real
 * code at one location: an S4 "Game crashed when I opened the door", an S1 "The door
 * description confused me about which way it opens", and an S0 "The description of the
 * music was confusing" collapsed into ONE cluster at count 3 and maxSeverity S4 —
 * although jaccard(crash, music) is 0.000 — and the union of their tokens then routed
 * the whole thing to `fix_layer: "hint_text"`. That is a blocking crash filed as prose
 * polish, on a count that includes issues the cluster's own defect never matched.
 *
 * Requiring every pair keeps the calibration the threshold was measured against intact
 * (the four real wordings of one blocked exit run 0.219-0.429 pairwise, so they still
 * form one ticket) while making "similar to something in this cluster" mean "similar
 * to everything in it". Members are the original pass-1 buckets, not individual
 * issues: a bucket's issues already matched on the strictly tighter (location, band,
 * first 6 tokens) fingerprint.
 */
function everyMemberPairSimilar(a: WorkingCluster, b: WorkingCluster): boolean {
  for (const left of a.members) {
    for (const right of b.members) {
      if (jaccard(left, right) < JACCARD_MERGE_THRESHOLD) return false;
    }
  }
  return true;
}

export function clusterIssues(issues: IssueRecord[]): IssueCluster[] {
  if (issues.length === 0) return [];

  const prepared = issues
    .map((issue) => {
      const tokens = tokenizeIssue(issue.text);
      return {
        issue,
        locKey: locationKey(issue.location),
        band: severityBand(issue.severity),
        tokens,
        normalizedText: tokens.join(" "),
      };
    })
    .sort((a, b) => {
      if (a.locKey !== b.locKey) return compareStrings(a.locKey, b.locKey);
      const sevDiff = severityRank(a.issue.severity) - severityRank(b.issue.severity);
      if (sevDiff !== 0) return sevDiff;
      if (a.normalizedText !== b.normalizedText)
        return compareStrings(a.normalizedText, b.normalizedText);
      return compareStrings(a.issue.ref, b.issue.ref);
    });

  // Pass 1: exact fingerprint buckets. Bucket membership order follows the
  // canonical sort above, so it never depends on the caller's input order.
  const buckets = new Map<string, WorkingCluster>();
  for (const p of prepared) {
    const fp = fingerprint(p.locKey, p.band, p.tokens);
    const existing = buckets.get(fp);
    if (existing) {
      existing.issues.push(p.issue);
      existing.tokens = unionTokens(existing.tokens, p.tokens);
      // One pass-1 bucket is one member: its issues already matched exactly on
      // (location, band, first 6 tokens), which is a tighter test than pass 2's.
      existing.members = [existing.tokens];
    } else {
      buckets.set(fp, {
        key: fp,
        locationKey: p.locKey,
        issues: [p.issue],
        tokens: p.tokens,
        members: [p.tokens],
      });
    }
  }

  let clusters = [...buckets.values()].sort((a, b) => compareStrings(a.key, b.key));

  // Pass 2: merge to fixpoint. On every pass, scan clusters in ascending-key
  // order and merge the first eligible pair found; the smaller key (earlier
  // in the scan) always folds into the larger one, so the surviving key of
  // any merged group is that group's max original key regardless of which
  // specific pair got merged first. Scan order is a function of the bucket
  // keys, which pass 1 derived from content alone, so the whole loop stays a
  // pure function of the SET of input issues.
  for (;;) {
    let mergedAny = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const smaller = clusters[i]!;
        const larger = clusters[j]!;
        if (smaller.locationKey !== larger.locationKey) continue;
        if (!everyMemberPairSimilar(smaller, larger)) continue;
        larger.issues = [...larger.issues, ...smaller.issues];
        larger.tokens = unionTokens(larger.tokens, smaller.tokens);
        larger.members = [...larger.members, ...smaller.members];
        clusters.splice(i, 1);
        mergedAny = true;
        break outer;
      }
    }
    if (!mergedAny) break;
    clusters = clusters.sort((a, b) => compareStrings(a.key, b.key));
  }

  return clusters.map(finalizeCluster);
}
