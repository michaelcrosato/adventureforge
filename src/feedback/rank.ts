/**
 * Severity-weighted ranking and fix-layer suggestion — also NO LLM anywhere
 * in this path. Every score and every routing decision is a pure function of
 * an already-built `IssueCluster` (see cluster.ts).
 */
import type { FeedbackSource, FixLayer } from "./schema.js";
import type { PlaytestTier } from "../blind/providers.js";
import type { IssueCluster, IssueSeverity } from "./cluster.js";

/** S4 (blocking) outweighs S0 (cosmetic) sixteenfold — protocol polarity. */
export const SEVERITY_WEIGHT = { S0: 1, S1: 2, S2: 4, S3: 8, S4: 16 } as const;

/** Crawler+fleet agreement on the same cluster is the strongest signal. */
export const BOTH_SOURCES_BONUS = 2;

/**
 * Tier factors. These are the numbers that make a mass-parallel, mixed-vendor fleet
 * safe to rank, and each encodes a specific claim about what the evidence means.
 *
 * `REFERENCE_ONLY_FACTOR` is above 1 on purpose, and it is the whole reason the
 * reference cohort earns its cost. A defect only the expensive models notice arrives
 * with a tiny mention count — three runs against forty — so under plain
 * count×severity it sorts near the bottom, and the calibration instrument gets
 * outvoted by the very cohort it exists to check. Weighting it UP restores the
 * asymmetry the cohort was bought for.
 *
 * `VOLUME_SINGLE_FAMILY_FACTOR` is below 1 for the mirror-image reason. One cheap
 * model reporting "I got stuck" forty times is forty samples of one model's ceiling,
 * not forty players failing. Until a second lineage sees it, treat it as a capability
 * signal rather than a product defect — the discount is deliberately soft (it demotes,
 * never suppresses) because a real defect will pick up a second family quickly.
 */
const REFERENCE_CONFIRMED_FACTOR = 2;
const REFERENCE_ONLY_FACTOR = 1.5;
const VOLUME_SINGLE_FAMILY_FACTOR = 0.5;

/** Distinct lineages required before a volume-only cluster is taken at face value. */
const VOLUME_CONSENSUS_FAMILIES = 2;

function hasBothSources(sources: readonly FeedbackSource[]): boolean {
  return sources.includes("crawler") && sources.includes("fleet");
}

/**
 * Repetition within one lineage still counts — but sub-linearly.
 *
 * Straight mention-counting makes a cohort's SIZE the dominant term, so whoever ran
 * the most players decides the roadmap. A saturating curve keeps repetition
 * informative (8 mentions outrank 1) while preventing a 200-run Gemini cohort from
 * burying a 3-run finding that four vendors independently confirmed.
 */
function volumeWeight(mentions: number): number {
  return 1 + Math.log2(1 + Math.max(0, mentions));
}

/**
 * Read the provider dimensions tolerantly.
 *
 * `IssueCluster.families`/`tiers` are non-optional, so a cluster built by
 * `clusterIssues` always has them — this is not absorbing a historical artifact.
 * (`readLatestHotspots` returns compiled `Hotspot` records, and nothing in the repo
 * rebuilds an `IssueCluster` from a written file, so there is no re-rank path here to
 * be tolerant of.) What the `?? []` actually absorbs is a caller that hands in a
 * cluster-shaped object without these keys, which is how the rank tests build minimal
 * fixtures. Keeping it means such a shape ranks by the legacy formula instead of
 * throwing on a missing key.
 */
function clusterFamilies(c: IssueCluster): readonly string[] {
  return c.families ?? [];
}

function clusterTiers(c: IssueCluster): readonly PlaytestTier[] {
  return c.tiers ?? [];
}

function tierFactor(c: IssueCluster): number {
  const tiers = clusterTiers(c);
  const sawReference = tiers.includes("reference");
  const sawVolume = tiers.includes("volume");
  if (sawReference && sawVolume) return REFERENCE_CONFIRMED_FACTOR;
  if (sawReference) return REFERENCE_ONLY_FACTOR;
  if (sawVolume && clusterFamilies(c).length < VOLUME_CONSENSUS_FAMILIES) {
    return VOLUME_SINGLE_FAMILY_FACTOR;
  }
  return 1;
}

/**
 * Rank one cluster.
 *
 * Two regimes, and which one applies is a property of the EVIDENCE, not a setting:
 *
 *  - No provider metadata (crawler-only findings, and every report written before the
 *    multi-vendor playtest loop existed) → the original
 *    `count × severity × both-sources` rule, evaluated identically. Historical
 *    rankings and the accepted-manifest hashes that pin them stay exactly as they
 *    were, so this change cannot silently restate past compiles.
 *
 *  - Provider metadata present → distinct FAMILIES carry the count, repetition
 *    saturates, and the tier factor applies. Independence is what is being measured;
 *    volume is only evidence of itself.
 */
export function scoreCluster(c: IssueCluster): number {
  const sourceBonus = hasBothSources(c.sources) ? BOTH_SOURCES_BONUS : 1;
  const severity = SEVERITY_WEIGHT[c.maxSeverity];

  const families = clusterFamilies(c);
  if (families.length === 0 && clusterTiers(c).length === 0) {
    return c.issues.length * severity * sourceBonus;
  }

  const familyCount = Math.max(1, families.length);
  return familyCount * volumeWeight(c.issues.length) * severity * tierFactor(c) * sourceBonus;
}

/**
 * Crawler findings are compiled with a `"CODE: message"` text prefix (see
 * crawl finding -> IssueRecord conversion). Parse the leading all-caps code
 * token so crawler-origin clusters can route on the oracle that raised them
 * rather than on free text.
 */
function parseCrawlerCode(text: string): string | null {
  const match = /^([A-Z]+):/.exec(text);
  return match ? match[1]! : null;
}

const CRAWLER_CODE_LAYER: Readonly<Record<string, FixLayer>> = {
  CRASH: "engine_rule",
  INTEGRITY: "engine_rule",
  DESYNC: "engine_rule",
  PERSIST: "engine_rule",
  LEGALITY: "engine_rule",
  SOFTLOCK: "quest_structure",
  WORLD: "quest_structure",
  RENDER: "content",
};

/**
 * Fleet-origin keyword ladder over the cluster's (already-tokenized/stemmed)
 * `tokens`. First rung that hits wins. Keywords are given in the exact form
 * `tokenizeIssue` would stem real occurrences down to — e.g. "wording" is
 * listed here as "word" (tokenizeIssue stems the real surface word
 * "wording"/"worded"/"words" to "word" via its trailing-suffix stripper), so
 * a literal "wording" here would never match anything in practice.
 */
const FLEET_LADDER: ReadonlyArray<{ layer: FixLayer; keywords: readonly string[] }> = [
  { layer: "hint_text", keywords: ["stuck", "lost", "hint", "unclear", "confus"] },
  { layer: "quest_structure", keywords: ["softlock", "block", "cannot", "impossible"] },
  { layer: "content", keywords: ["typo", "word", "text", "prose", "repeat"] },
  { layer: "engine_rule", keywords: ["crash", "error", "reject"] },
];

function fleetFixLayer(tokens: readonly string[]): FixLayer {
  const tokenSet = new Set(tokens);
  for (const rung of FLEET_LADDER) {
    if (rung.keywords.some((keyword) => tokenSet.has(keyword))) return rung.layer;
  }
  return "content"; // default
}

/**
 * Picks the code from the HIGHEST-severity crawler-coded issue in the
 * cluster — never the first one encountered. A merged cluster can hold
 * issues of mixed crawler codes at different severities (e.g. a RENDER(S2)
 * and a CRASH(S4) issue merged at the same location); routing on whichever
 * code happened to sort first would silently downgrade a `severity_band:
 * "severe"` cluster to a cosmetic fix layer. Ties (same severity, distinct
 * codes) break deterministically on the code string itself so the result
 * never depends on input array order.
 */
function firstCrawlerCode(
  issues: ReadonlyArray<{ text: string; severity: IssueSeverity }>,
): string | null {
  let bestCode: string | null = null;
  let bestWeight = -1;
  for (const issue of issues) {
    const code = parseCrawlerCode(issue.text);
    if (code === null) continue;
    const weight = SEVERITY_WEIGHT[issue.severity];
    if (weight > bestWeight || (weight === bestWeight && bestCode !== null && code < bestCode)) {
      bestCode = code;
      bestWeight = weight;
    }
  }
  return bestCode;
}

/**
 * crawler-origin (cluster.sources includes "crawler"): parse the CODE prefix
 * off the highest-severity crawler-coded issue text and route through the
 * fixed code -> layer table. fleet-origin (or a crawler-origin cluster whose
 * issues carry no recognized code, e.g. a mixed crawler+fleet cluster where
 * the crawler code isn't in the table): fall back to the fleet keyword
 * ladder over the cluster's tokens.
 */
export function suggestFixLayer(c: IssueCluster): FixLayer {
  if (c.sources.includes("crawler")) {
    const code = firstCrawlerCode(c.issues);
    if (code !== null && code in CRAWLER_CODE_LAYER) {
      return CRAWLER_CODE_LAYER[code]!;
    }
  }
  return fleetFixLayer(c.tokens);
}

/**
 * Top hotspot recommendation. Picks the max-`scoreCluster` cluster out of
 * `ranked` (rather than blindly trusting `ranked[0]`, so this stays correct
 * even if a caller passes clusters out of score order) and cites the count,
 * max severity, and sources behind the pick. `hotspot_id` here is the
 * cluster's `key` — the compiler step that builds the final `Hotspot` list
 * (shortHash(key) per schema.ts) is responsible for mapping this back to the
 * matching Hotspot's real `id`.
 */
export function recommendNextFix(
  ranked: IssueCluster[],
): { hotspot_id: string; rationale: string } | null {
  if (ranked.length === 0) return null;

  let best = ranked[0]!;
  let bestScore = scoreCluster(best);
  for (const c of ranked.slice(1)) {
    const score = scoreCluster(c);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }

  const sourceLabel = hasBothSources(best.sources) ? "crawler+fleet" : best.sources.join("+");
  const count = best.issues.length;
  const rationale =
    `${count} issue mention${count === 1 ? "" : "s"}, max severity ${best.maxSeverity}, ` +
    `sources: ${sourceLabel} (score ${bestScore})`;
  return { hotspot_id: best.key, rationale };
}
