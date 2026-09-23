/**
 * The AFK loop's brain — "what is the next best improvement?" (trust-but-verify).
 *
 * Each cycle the loop must decide where to spend its effort across FOUR categories:
 *   - content_new  : the world graph is thin (too few playable RPG quest nodes)
 *   - content_fix  : an existing quest has validator warnings, reachability gaps, or
 *                    blind-playtest findings
 *   - engine       : code-level debt (TODO/FIXME markers, pending mechanics)
 *   - repo         : project hygiene (missing tooling, docs, etc.)
 *
 * The assessor gathers evidence DETERMINISTICALLY through the same engine surfaces the
 * MCP server exposes (the overworld quest registry / validate) — no clock, no RNG, no
 * network — scores candidates, and recommends the single highest-value next action.
 * It is the deterministic *evaluator*; the actual quality judgement each cycle comes
 * from a mandatory LLM playtest (see docs/afk_loop.md). Pure enough to unit-test:
 * same repo ⇒ same ranking.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { isPureExitInterviewV2 } from "../blind/exit_interview.js";
import { parseBlindRunSidecar } from "../blind/run_evidence.js";
import { createToolApi } from "../mcp/tools.js";
import { RpgSourceRuntime } from "../mcp/rpg_source_runtime.js";
import { verifyBlindReportText } from "../blind/report_verifier.js";
import { readLatestHotspots } from "../feedback/compile.js";
import type { Hotspot, HotspotsFile } from "../feedback/schema.js";
import { auditStaleReactiveRoomItems } from "./stale_reactive_audit.js";
import { score, type Category, type ImprovementCandidate } from "./assessment_model.js";
import {
  allGeneratedChecksClean,
  generatorRpgDriftCandidate,
  rpgGeneratorChecksForRoot,
} from "./generated_eval.js";
import { loopStateEntriesOldestFirst } from "./loop_state.js";

export type { Category, ImprovementCandidate } from "./assessment_model.js";
export {
  allGeneratedChecksClean,
  generatedEvalSeedBase,
  generatorRpgDriftCandidate,
  GEN_EVAL_CHECK_COUNT,
} from "./generated_eval.js";
export type { GeneratedPackCheck } from "./generated_eval.js";

export type QuestHealth = {
  world_quest_id: string | null;
  playable: boolean;
  warnings: number;
};

type AssessedQuest = {
  target_ref: string;
  target_label: string;
  playable: boolean;
  world_quest_id: string | null;
};

export type Assessment = {
  rpgQuestCount: number;
  worldQuestCount: number;
  quests: QuestHealth[];
  /** True iff this cycle's fresh generated RPG window validated clean. */
  allGeneratorsClean: boolean;
  candidates: ImprovementCandidate[];
  top: ImprovementCandidate | null;
};

type AssessmentFormatOptions = {
  /** Print every quest/candidate with full rationale. Default output is compact for loop handoff. */
  full?: boolean;
  /** Maximum ranked candidates to show in compact mode before summarizing routine rows. */
  maxCandidates?: number;
};

// How many shipped quests in the New York overworld registry is "healthy" before
// net-new world expansion is deprioritized. Count world_quest_id entries, not raw
// YAML files, so this lever cannot reintroduce standalone package authoring. This
// is the actual shipped count (12 after the Tide-Mill benchmark slice landed, following
// the 5 overworld-orphaned quests), NOT an inflated target — per the DECISION_LOG
// anti-pattern ruling, breadth is never padded to force content_new.
const WORLD_QUEST_TARGET = 12;

// The blind-playtest target that means "the CORE GAME itself": the open-world
// overworld from a fresh start — what `npm run blind` plays by default and what
// every new player meets first. It shares the rotation's attendance namespace
// (report slugs and loop-state mentions both say "overworld").
export const OVERWORLD_PLAYTEST_TARGET = "overworld";

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.ts$/.test(e.name)) out.push(p);
    }
  };
  walk(join(root, "src"));
  return out;
}

// First-party code dirs we'd expect under a static-analysis/format gate. Pure
// data/build dirs (content/ YAML, traces/ snapshots, dist/, coverage/, node_modules/,
// saves/, ai-runs/) are intentionally NOT here — linting them is wrong, not missing.
const LINT_DIRS = ["src", "bin", "scripts", "agents", "tests", "ui"] as const;

/** Does `dir` (under root) hold any first-party, lintable .ts/.tsx (not .d.ts, not vendored)? */
function dirHasLintableTs(root: string, dir: string): boolean {
  let found = false;
  const walk = (d: string): void => {
    if (found || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (found) return;
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "dist" || e.name === "coverage") continue;
        walk(join(d, e.name));
      } else if (e.isFile() && /\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
        found = true;
      }
    }
  };
  walk(join(root, dir));
  return found;
}

/**
 * Is `dir` actually under the ESLint config's gate? — true iff some `files:` glob
 * names it AND no `ignores:` glob excludes it. Robust to glob shape (a bare
 * recursive glob, a typed-extension glob, brace forms): it keys off the dir prefix in the relevant
 * array bodies, so it disarms the moment a future cycle adds the dir to `files`
 * and drops it from `ignores`. Parses the flat-config text rather than executing
 * it — same lightweight, deterministic style as the TODO/marker scan below.
 */
export function eslintCovers(eslintText: string, dir: string): boolean {
  const bodies = (key: string): string =>
    [...eslintText.matchAll(new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`, "g"))]
      .map((m) => m[1])
      .join(",");
  const inFiles = new RegExp(`["'\`]${dir}/`).test(bodies("files"));
  const ignored = new RegExp(`["'\`]${dir}/\\*\\*`).test(bodies("ignores"));
  return inFiles && !ignored;
}

// ── Doc-staleness radar (bug_0045) ────────────────────────────────────────────
// The third cross-category repo lever, after eslint-coverage and the engine
// marker scan (both of which disarm once the code is tidy). It surfaces DOC
// rot: a canonical, maintained doc that points at a first-party file which no
// longer exists (a rename/delete the doc was never updated for) — exactly the
// "currently-invisible work" a radar should catch, and the standing next-best
// cross-category meta-improvement logged since bug_0032/0035.
//
// First-party path prefixes a doc reference can point at. Forward/ephemeral roots
// (node_modules/, dist/, coverage/, saves/, ai-runs/) are intentionally absent — a
// doc naming one of those is not a claim that a tracked file exists.
const DOC_REF_PREFIXES = [
  "src",
  "bin",
  "scripts",
  "agents",
  "tests",
  "traces",
  "docs",
  "content",
  "ui",
] as const;
const DOC_REF_RE = new RegExp(`(?:${DOC_REF_PREFIXES.join("|")})/[A-Za-z0-9_./-]+`, "g");
const DOC_REF_EXT = /\.(?:ts|tsx|js|mjs|cjs|json|yaml|yml|md|sh)$/;
// A path token is NOT a liveness claim when it is a glob/brace/placeholder pattern
// (content/rpg/quests/*.yaml, traces/bugs/bug_0001_*.yaml, ai-runs/<id>/playtest.md)…
const DOC_REF_PATTERN_CHARS = /[*{}?[\]<>]|\.\.\./;
// …or a command-line OUTPUT DESTINATION (`--record traces/run.json`, `--out …`,
// `-o file`, `> file`): the doc tells you to CREATE it, not that it already exists.
const DOC_REF_OUTPUT_FLAG = /(?:--record|--out|--output|-o|>)\s+$/;

/**
 * Extract the CONCRETE first-party file references a doc CLAIMS exist and return
 * those that DON'T resolve via `exists` — i.e. stale doc references to renamed or
 * deleted files. Pure (disk access injected) so it unit-tests without a fixture,
 * mirroring {@link eslintCovers}. Conservative by construction: it considers only
 * tokens under a known first-party dir that carry a concrete file extension, and
 * skips glob/placeholder patterns and command-line output destinations — the path
 * shapes a doc legitimately names WITHOUT asserting they already exist on disk. So
 * a hit is a real "doc points at a file that isn't there", not example/forward text.
 */
export function findStaleDocRefs(docText: string, exists: (relPath: string) => boolean): string[] {
  const stale: string[] = [];
  const seen = new Set<string>();
  for (const m of docText.matchAll(DOC_REF_RE)) {
    const at = m.index ?? 0;
    if (DOC_REF_OUTPUT_FLAG.test(docText.slice(Math.max(0, at - 14), at))) continue;
    const tok = m[0].replace(/[).,;:"'`]+$/, "");
    if (DOC_REF_PATTERN_CHARS.test(tok)) continue;
    if (!DOC_REF_EXT.test(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    if (!exists(tok)) stale.push(tok);
  }
  return stale;
}

/**
 * The canonical, CURRENT-system docs whose file references should all resolve.
 * Deliberately EXCLUDED (scanning them for liveness would be wrong, not missing —
 * the same discipline as LINT_DIRS omitting data/forward dirs): AI_LOOP_STATE.md (a
 * historical per-cycle log that records paths/hashes as they were, some since
 * moved), plus historical planning/gate logs that intentionally preserve retired
 * variant paths. Active current docs such as docs/ROADMAP.md and
 * ADVENTUREFORGE_BUILD_SPEC.md stay inside the scan.
 */
const DOC_STALENESS_EXCLUDED_DOCS = new Set(["DECISION_LOG.md"]);

export function docStalenessDocs(root: string): string[] {
  const out: string[] = [];
  for (const f of [
    "AGENTS.md",
    "README.md",
    "ADVENTUREFORGE_BUILD_SPEC.md",
    "blind-tester/README.md",
    "ui/README.md",
  ]) {
    if (existsSync(join(root, f))) out.push(f);
  }
  const docsDir = join(root, "docs");
  if (existsSync(docsDir)) {
    for (const e of readdirSync(docsDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (e.isFile() && e.name.endsWith(".md") && !DOC_STALENESS_EXCLUDED_DOCS.has(e.name))
        out.push(`docs/${e.name}`);
    }
  }
  return out;
}

/**
 * Normalize a quest reference — a full source path, a bare world quest id, OR a
 * pack id — to its stem, so an attendance line that names a quest any of those ways
 * maps to the same key.
 * E.g. "content/rpg/quests/cold_forge.yaml" -> "cold_forge", a bare
 * "sunken_barrow" is unchanged, and the pack ID "cold_forge_v1" also -> it.
 *
 * The trailing `_v\d+` strip matters for attendance keying (bug_0293): legacy log
 * lines named pack ids such as `Blind-playtest "cold_forge_v1"`, while current
 * candidates target world quest ids such as `cold_forge`. Without this strip
 * the id-form and world-id form key to different stems and the recency lookup misses,
 * re-freezing the rotation. No shipped source file name ends in `_v\d+`, so the strip
 * never collides two real sources.
 */
export function packStem(ref: string): string {
  const base = ref.split("/").pop() ?? ref;
  return base.replace(/\.ya?ml$/i, "").replace(/_v\d+$/i, "");
}

/**
 * Parse, from the AI_LOOP_STATE.md log, each quest's MOST RECENT blind-playtest
 * attendance — its character offset — keyed by {@link packStem}. A SMALLER offset
 * means more recently attended, because the log is written NEWEST-FIRST (every cycle
 * PREPENDS its entry at the top): a stem's FIRST match is its most recent attendance,
 * so we keep the first and ignore older repeats. Pure (text in, map out) so it
 * unit-tests without a fixture. Used to rotate the blind pass onto the
 * LEAST-recently-attended quest instead of re-nominating the alphabetically-first one.
 *
 * Recognizes BOTH the cycle-result phrasing the log actually uses today ("Mandated
 * blind pass ran on <quest>") AND the older structured-header marker ("Mandatory LLM
 * playtest target this cycle: <path>"); a token in either form may be a path or a
 * bare id. This is the bug_0128 fix: the attendance matcher previously matched ONLY the old
 * header — abandoned ~15 cycles ago for the prose format — so the recency signal had
 * frozen and the rotation silently fell back to alphabetical, re-nominating
 * cold_forge (the very lock-in the rotation was meant to cure). The caller
 * resolves only real quest stems, so incidental captures (e.g. "…ran on the assessor")
 * land under a stem no candidate queries and are harmless.
 *
 * bug_0235: the same blindness recurred via MARKDOWN WRAPPING. The log writes the quest
 * bold+backticked — `- **Mandated blind pass ran on \`bellfounders_alarm\`** …` — but the
 * capture class [A-Za-z0-9_./-] excluded the backtick, so the match failed at the opening
 * tick and EVERY recent entry was invisible: the just-played pack looked never-attended
 * (undefined offset) and the rotation re-nominated it FIRST (observed: bellfounders_alarm
 * ranked #1 the cycle after it was played). The optional `[\`*]*` wrapper below skips a
 * leading backtick/asterisk run; the capture still stops at the CLOSING tick (a backtick
 * is not in the class), so the bare stem is recovered. Unwrapped prose and path forms are
 * unaffected ([\`*]* matches zero).
 *
 * bug_0638: "the log is newest-first" stopped being true of the whole file at the
 * 2026-08-29 two-loop migration. The driver now APPENDS each cycle's "## AFK Cycle" entry
 * at the END, so the live ledger is legacy "### Cycle result" entries newest-first
 * followed by AFK entries OLDEST-first. Scanning raw file order gave the newest AFK entry
 * the LARGEST offset — the pack it just attended looked stale and could be re-nominated.
 * The scan therefore runs over {@link attendanceScanText}, the same entries laid out
 * truly newest-first, so the first-match-wins rule and every regex/capture below are
 * unchanged. Offsets are positions in that reordered text: still >= 0, still "smaller
 * offset = more recent", still comparable only with each other.
 */
export function parseAttendanceOffsets(loopStateText: string): Map<string, number> {
  const scanText = attendanceScanText(loopStateText);
  const map = new Map<string, number>();
  // bug_0293: ALSO match the model-INDEPENDENT code-written recommendation line
  // `Blind-playtest "<id>"` / `Blind-playtest quest "<id>"` (legacy), current
  // `Review quest "<id>"` titles, compact `Rec: playtest-<id>` loop-driver entries, and the looser
  // Sonnet-era agent phrasing "blind pass on `<quest>`". The wrapper class gains
  // `"` so the quoted id is skipped; `i` tolerates sentence-start caps; the `_v\d+`
  // on a captured pack id is normalized by packStem.
  const re =
    /(?:(?:Mandatory LLM playtest target this cycle:|Mandated blind pass ran on|blind pass on|Blind-playtest(?:\s+quest)?|Review\s+quest)\s+["`*]*|Rec:\s+playtest-)([A-Za-z0-9_./-]+)/gi;
  for (const m of scanText.matchAll(re)) {
    const captured = m[1];
    if (captured === undefined) continue;
    const stem = packStem(captured.replace(/[.,;]+$/, "")); // strip sentence-ending punctuation
    if (!stem) continue;
    if (!map.has(stem)) map.set(stem, m.index ?? 0); // newest-first ⇒ first match is most recent
  }
  return map;
}

/**
 * The ledger's cycle entries laid out NEWEST-FIRST (bug_0638): the entries from
 * loop_state.ts's single chronology ({@link loopStateEntriesOldestFirst}), reversed, then
 * the intro last. The intro is the ledger's standing contract and machine markers, not a
 * cycle, so nothing in it may outrank a real entry. Each piece ends in a newline so no
 * match can straddle a join. A text with no entry headings at all is returned unchanged,
 * so free-form text keeps its plain top-is-newest reading. Pure.
 */
export function attendanceScanText(loopStateText: string): string {
  const oldestFirst = loopStateEntriesOldestFirst(loopStateText);
  if (oldestFirst.length === 0) return loopStateText;
  const withNewline = (piece: string): string => (piece.endsWith("\n") ? piece : `${piece}\n`);
  const introEnd = Math.min(...oldestFirst.map((entry) => entry.start));
  const newestFirst = [...oldestFirst]
    .reverse()
    .map((entry) => withNewline(loopStateText.slice(entry.start, entry.end)));
  const intro = loopStateText.slice(0, introEnd);
  return newestFirst.join("") + (intro === "" ? "" : withNewline(intro));
}

const BLIND_REPORT_FILE_RE = /^(\d{8}T\d{6}Z)_(.+)_seed\d+\.md$/;

/**
 * Parse local blind-tester report filenames into attendance offsets. The report runner
 * writes accepted markdown reports as:
 *
 *   YYYYMMDDTHHMMSSZ_<pack-stem>_seed<N>.md
 *
 * Those files are gitignored scratch evidence, but they are authoritative for the
 * current worktree's AFK loop: if a blind pass just ran successfully, the assessor
 * must not immediately nominate the same pack again merely because AI_LOOP_STATE.md
 * has not been prepended yet. Filenames carry UTC timestamps, so ordering is stable
 * without consulting file mtimes. Returned offsets are NEGATIVE, making these local
 * reports newer than any tracked log offset (which is always >= 0) while preserving
 * the same "smaller offset = more recent" convention as {@link parseAttendanceOffsets}.
 */
export function parseBlindReportAttendanceOffsets(
  reportFileNames: Iterable<string>,
): Map<string, number> {
  const reports = [...reportFileNames]
    .map((name) => {
      const m = name.match(BLIND_REPORT_FILE_RE);
      if (!m) return null;
      return { stamp: m[1]!, stem: packStem(m[2]!), name };
    })
    .filter((r): r is { stamp: string; stem: string; name: string } => r !== null && !!r.stem)
    .sort((a, b) => b.stamp.localeCompare(a.stamp) || a.name.localeCompare(b.name));

  const map = new Map<string, number>();
  reports.forEach((report, i) => {
    if (!map.has(report.stem)) {
      map.set(report.stem, -(reports.length - i));
    }
  });
  return map;
}

export function blindReportAttendanceOffsets(root: string): Map<string, number> {
  const reportsDir = join(root, "blind-tester", "reports");
  if (!existsSync(reportsDir)) return new Map();
  const acceptedReports = readdirSync(reportsDir).filter((name) => {
    if (!BLIND_REPORT_FILE_RE.test(name)) return false;
    try {
      const reportPath = join(reportsDir, name);
      const reportText = readFileSync(reportPath, "utf8");
      const verification = verifyBlindReportText(reportText);
      if (!verification.ok) return false;

      // Unversioned historical reports remain useful attendance evidence. A
      // V2 pure report, however, is only authoritative when its adjacent
      // server-evidence sidecar is present, fresh, valid, and receipt-matched.
      if (!isPureExitInterviewV2(verification.interview)) return true;
      const sidecarPath = reportPath.replace(/\.md$/, ".run.json");
      if (!existsSync(sidecarPath)) return false;
      if (statSync(sidecarPath).mtimeMs < statSync(reportPath).mtimeMs) return false;
      const sidecar = parseBlindRunSidecar(readFileSync(sidecarPath, "utf8"));
      if (!sidecar.ok) return false;
      return verifyBlindReportText(reportText, {
        requiredPlayMode: "pure",
        runSidecar: sidecar.sidecar,
      }).ok;
    } catch {
      return false;
    }
  });
  return parseBlindReportAttendanceOffsets(acceptedReports);
}

export function mergeAttendanceOffsets(
  ...sources: ReadonlyArray<ReadonlyMap<string, number>>
): Map<string, number> {
  const map = new Map<string, number>();
  for (const source of sources) {
    for (const [stem, offset] of source) {
      const previous = map.get(stem);
      if (previous === undefined || offset < previous) map.set(stem, offset);
    }
  }
  return map;
}

// ── hotspot-driven candidates (Task 17): compiled feedback as a PRIMARY
// ranking input ──────────────────────────────────────────────────────────────
// This is the loop-closing wire: `readLatestHotspots` (src/feedback/compile.ts)
// reads only the unconsumed manifest/output digest named by committed loop
// state (null when absent, consumed, missing, or invalid), and its top hot
// spots become real candidates below. Merely newer ignored compiles cannot
// steer the loop. The candidates use the same category/impact/effort/score
// shape every other block produces, so feedback competes on ranking merit.

/** fix_layer values that name code/tooling work rather than quest content. */
const ENGINE_FIX_LAYERS: ReadonlySet<Hotspot["fix_layer"]> = new Set([
  "engine_rule",
  "validator",
  "test",
]);

function categoryForHotspot(h: Hotspot): Category {
  return ENGINE_FIX_LAYERS.has(h.fix_layer) ? "engine" : "content_fix";
}

/**
 * Effort floor for EVERY hotspot candidate is "M" — there is no "S" tier here,
 * unlike the repo-doc-staleness lever above. A prior version gave `content`/
 * `hint_text` fix_layers "S", which let a single hot spot outscore even an
 * unplayable-quest fix: `score(5, "S", "content_fix")` = 5.0 vs
 * `score(5, "M", "content_fix")` = 2.5 for `fix-unplayable-*`/`fix-unbound-*`
 * (see tests/unit/assessor_hotspots.test.ts and the real checkpoint capture in
 * .superpowers/sdd/task-17-report.md, where a `hint_text` hot spot legitimately
 * ranked #1 over everything). With the floor at "M", a hotspot candidate's
 * best-case score is exactly 2.5 — at most a TIE with, never a win over, an
 * unplayable/unbound-quest fix. CHOSEN TIE-BREAK MECHANISM: the final sort's
 * cross-class id-ascending tiebreak (below) already resolves that tie correctly
 * without any impact cap. Accepted-hotspot ordinals are compared only when BOTH
 * tied candidates are hot spots, so `fix-unplayable-*`/`fix-unbound-*`/`fix-<id>`
 * ids still sort before `hotspot-<id>` ids ('f' < 'h' lexicographically), and the
 * quest fix always wins an exact-score tie. (An impact-4 cap was considered and
 * rejected: it would needlessly discount hotspots that never actually collide
 * with a quest-health candidate, e.g. every `engine`-category hotspot, which
 * tops out at `score(5, "M", "engine")` = 2.0 regardless.)
 */
function effortForHotspot(_h: Hotspot): ImprovementCandidate["effort"] {
  return "M";
}

/**
 * Scales a hot spot's raw compiled score (unbounded — count × severity weight
 * × diversity; see feedback/rank.ts's `scoreCluster`) into the assessor's 1-5
 * impact range used everywhere else in this file, then applies a trend-aware
 * discount. Normalizes against the HIGHEST hot spot score in the WHOLE
 * compiled file (not just the top 3 considered below), so the file's single
 * worst issue always maps to impact 5 and lighter hot spots scale down
 * proportionally; clamped to [1, 5] to guard against ROUNDING at the extremes
 * — not because a hot spot's score can be non-positive: the schema guarantees
 * `score: z.number().positive()`, so whenever there is at least one hot spot
 * to normalize against, both `h.score` and `maxHotspotScore` are always > 0.
 *
 * Trend-aware deprioritization: a hot spot the compiler already marked
 * "improved" (its cluster's score fell since the previous compile — see
 * feedback/trends.ts) is an ALREADY-MOVING target; pinning the loop's top slot
 * to something already trending toward resolved is lower value than spending
 * that cycle on a target that isn't moving on its own. Knock its impact down
 * by 1 (floored at 1, never 0 — a hot spot still real enough to ship in the
 * top 3 never drops off the radar entirely) so it still competes but no
 * longer leads purely on a severity that's already easing. The accepted file
 * remains eligible until a cycle selects and seals its recommendation or a newer
 * accepted evidence cohort supersedes it. Unrelated cycles do not falsely mark it
 * consumed merely because the assessor offered it.
 */
function impactForHotspot(h: Hotspot, maxHotspotScore: number): number {
  const base =
    maxHotspotScore <= 0
      ? 1
      : Math.max(1, Math.min(5, Math.round((h.score / maxHotspotScore) * 5)));
  return h.trend === "improved" ? Math.max(1, base - 1) : base;
}

/**
 * The fixable target for a hot spot's location: its world quest id when the
 * compiler resolved one AND the location kind is actually `"quest"`, else the
 * shared overworld target when the location is an overworld surface. Pure
 * interview confusions do not have a separate location field, however, so the
 * compiler conservatively leaves prose such as "alarm thresholds took
 * attention" unmapped. When every actionable fleet report in the accepted
 * cohort has one unambiguous metric target, that authenticated cohort scope is
 * a safe fallback: `overworld` stays the shared target and `quest:<id>` is
 * admitted only for a currently shipped world quest. Zero, multiple, malformed,
 * crawler-only, or mixed-source targets remain unnominated rather than guessed.
 *
 * The explicit `kind === "quest"` gate (rather than a bare `questId`
 * truthiness check) matches the schema's intent precisely: `questId` is only
 * ever populated alongside `kind: "quest"` (see feedback/normalize.ts), but
 * the zod schema itself doesn't enforce that pairing, so checking `kind` first
 * documents and hardens the real invariant instead of relying on a field that
 * happens to be null everywhere else.
 */
function hotspotTarget(
  h: Hotspot,
  file: HotspotsFile,
  shippedWorldQuestIds: ReadonlySet<string>,
): string | null {
  if (h.location.kind === "quest" && h.location.questId) return h.location.questId;
  if (h.location.kind === "overworld") return OVERWORLD_PLAYTEST_TARGET;
  if (h.location.kind !== "unmapped" || h.sources.length !== 1 || h.sources[0] !== "fleet") {
    return null;
  }
  if (file.inputs.crawl_findings !== 0 || file.metrics.length !== 1) return null;
  const metric = file.metrics[0]!;
  if (metric.reports <= 0 || metric.reports !== file.inputs.actionable_reports) return null;
  const cohortTarget = metric.target;
  if (cohortTarget === OVERWORLD_PLAYTEST_TARGET) return OVERWORLD_PLAYTEST_TARGET;
  if (!cohortTarget.startsWith("quest:")) return null;
  const questId = cohortTarget.slice("quest:".length);
  return shippedWorldQuestIds.has(questId) ? questId : null;
}

/** Disk wrapper for attendance evidence; empty map when both evidence sources are absent. */
function lastAttendanceOffsets(root: string): Map<string, number> {
  const p = join(root, "AI_LOOP_STATE.md");
  const loopStateOffsets = existsSync(p)
    ? parseAttendanceOffsets(readFileSync(p, "utf8"))
    : new Map();
  return mergeAttendanceOffsets(loopStateOffsets, blindReportAttendanceOffsets(root));
}

/**
 * The score at/below which only ROUTINE work remains. The blind-playtest review
 * stubs (the rotation candidates raised for gated/puzzle packs) all land on this
 * 0.5 floor — `score(1, "M", "content_fix")`. So a top candidate at this
 * floor means every higher-value lever (real content gaps, net-new content, engine/repo, the
 * frontier benchmark lever) has disarmed.
 */
export const SATURATION_FLOOR = 0.5;

/**
 * Has the deterministic assessor run dry of STRATEGIC direction? True when this
 * cycle's fresh generator windows are clean AND the top candidate is at/below
 * {@link SATURATION_FLOOR} (only routine rotation work left) or there is no
 * candidate at all. This is the exact diminishing-returns signal — the state that
 * once pinned the loop to clockwork-polish — and the moment a multi-agent ultraplan
 * re-aim earns its cost (see docs/afk_loop.md, the saturation-triggered ultraplan
 * mode). If a generator window is unclean, the loop is not saturated: there is a
 * verifier/generator divergence to handle, even if a caller's candidate scoring has
 * collapsed to the floor.
 */
export function isSaturated(a: Assessment): boolean {
  return a.allGeneratorsClean && (a.top === null || a.top.score <= SATURATION_FLOOR);
}

/** Deterministically assess the repo and rank the next-best improvements. */
export function assess(root: string): Assessment {
  const api = createToolApi({ root });
  const quests: AssessedQuest[] = new RpgSourceRuntime(root)
    .discoverWorldQuestSources()
    .map((quest) => ({
      target_ref: quest.world_quest_id,
      target_label: quest.world_quest_id,
      playable: quest.playable,
      world_quest_id: quest.world_quest_id,
    }));

  const questHealth: QuestHealth[] = [];
  const candidates: ImprovementCandidate[] = [];
  const rpgQuestCount = quests.length;
  const worldQuestCount = quests.filter((s) => s.playable && s.world_quest_id !== null).length;

  // ── Per-quest health: validator findings (the deterministic dev-test signal) ───
  for (const s of quests) {
    if (!s.playable) {
      questHealth.push({
        world_quest_id: s.world_quest_id,
        playable: false,
        warnings: 0,
      });
      candidates.push({
        id: `fix-unplayable-${s.target_ref}`,
        category: "content_fix",
        target: s.target_ref,
        title: `Fix quest "${s.target_label}" — it does not validate (unplayable)`,
        rationale:
          "An unplayable world quest is the highest-impact thing to fix: nobody can experience it through the unified RPG runtime.",
        evidence: [`${s.target_ref} failed validation`],
        impact: 5,
        effort: "M",
        score: score(5, "M", "content_fix"),
      });
      continue;
    }
    if (s.world_quest_id === null) {
      questHealth.push({
        world_quest_id: null,
        playable: true,
        warnings: 0,
      });
      candidates.push({
        id: `fix-unbound-${s.target_ref}`,
        category: "content_fix",
        target: s.target_ref,
        title: `Fix quest "${s.target_label}" — it is not bound to the world graph`,
        rationale:
          "A playable quest without a world quest id cannot be reached through the single-world runtime.",
        evidence: [`${s.target_ref} has no world_quest_id`],
        impact: 5,
        effort: "M",
        score: score(5, "M", "content_fix"),
      });
      continue;
    }
    const report = api.validate_quest({ world_quest_id: s.world_quest_id });
    const warnings = report.report.findings.filter((f) => f.severity === "warning").length;
    questHealth.push({
      world_quest_id: s.world_quest_id,
      playable: true,
      warnings,
    });

    // content_fix is driven by VALIDATOR findings — the deterministic, code-checkable
    // signal (the "specific dev tests"). Player-facing QUALITY (signposting, clarity,
    // pacing) is judged only by the mandatory fresh-overworld blind LLM playtest each
    // cycle, so a structurally-clean quest carries a low-priority review rotation stub
    // rather than any heuristic-bot coverage score. The quest is the EDIT/REVIEW target,
    // never a direct live-playtest launch. (Two testing modes only: dev tests + blindtest.)
    if (warnings > 0) {
      const impact = Math.min(5, 1 + Math.ceil(warnings / 3));
      candidates.push({
        id: `fix-${s.world_quest_id}`,
        category: "content_fix",
        target: s.world_quest_id,
        title: `Fix quest "${s.world_quest_id}" — ${warnings} validator warning(s)`,
        rationale:
          "Validator warnings are concrete, code-checkable content defects; clearing them keeps the quest sound and raises player-facing quality.",
        evidence: [`${warnings} validator warning(s)`],
        impact,
        effort: "M",
        score: score(impact, "M", "content_fix"),
      });
    } else {
      // Structurally clean (the validator + exhaustive solver prove it winnable and
      // sound): keep it on the radar as a LOW-priority quest review, rotated by recency.
      // The fresh-overworld blind LLM playtest is the only live judge of its
      // signposting/clarity/pacing; the player is never dropped directly into this quest.
      candidates.push({
        id: `playtest-${s.world_quest_id}`,
        category: "content_fix",
        target: s.world_quest_id,
        title: `Maintenance rotation: review quest "${s.world_quest_id}" using fresh-overworld blind evidence — structurally clean`,
        rationale:
          "The validator and exhaustive solver prove this quest is winnable and sound; only a fresh-overworld blind LLM run reveals signposting/clarity/pacing issues a static check can't see. Keep the quest as the review target without dropping the player directly into it.",
        evidence: [
          "validator clean; due as the rotating quest review target after a fresh-overworld blind pass",
        ],
        impact: 1,
        effort: "M",
        score: score(1, "M", "content_fix"),
      });
    }
  }

  // The CORE GAME's opening experience is a first-class blind-playtest target: the
  // overworld fresh start is what every new player meets FIRST (and what the default
  // `npm run blind` plays), so it joins the same low-priority recency rotation as the
  // per-quest reviews instead of never being re-judged. Same floor score: the recency
  // tiebreak (below) decides when it is due, exactly like a structurally-clean quest.
  candidates.push({
    id: `playtest-${OVERWORLD_PLAYTEST_TARGET}`,
    category: "content_fix",
    target: OVERWORLD_PLAYTEST_TARGET,
    title:
      "Maintenance rotation: blind-playtest the CORE GAME opening — the overworld from a fresh start (the default blind run)",
    rationale:
      "The overworld opening is the first thing every new player experiences; only a fresh blind LLM playthrough of the core game can judge its orientation, signposting, discovery, and pacing.",
    evidence: [
      "the default blind run (npm run blind) plays exactly this surface; due on the same recency rotation as quest reviews",
    ],
    impact: 1,
    effort: "M",
    score: score(1, "M", "content_fix"),
  });

  // ── content_new: contiguous world graph breadth ───────────────────────────────
  if (worldQuestCount < WORLD_QUEST_TARGET) {
    const impact = Math.min(5, 2 + (WORLD_QUEST_TARGET - worldQuestCount));
    candidates.push({
      id: "new-world-quest",
      category: "content_new",
      target: "world",
      title: `Add a new world-graph RPG quest (${worldQuestCount}/${WORLD_QUEST_TARGET})`,
      rationale:
        "Breadth work must expand the single New York overworld, not create a detached source file. A registered overworld quest exercises the overworld handoff, RPG runtime, save metadata, and MCP quest-id path together.",
      evidence: [`${worldQuestCount} playable world quest node(s), target ${WORLD_QUEST_TARGET}`],
      impact,
      effort: "L",
      score: score(impact, "L", "content_new"),
    });
  }

  // ── engine: TODO/FIXME debt in src/ ───────────────────────────────────────────
  const markers: string[] = [];
  for (const f of listSourceFiles(root)) {
    const text = readFileSync(f, "utf8");
    text.split("\n").forEach((line, i) => {
      // Anchor to an actual comment marker so prose/regex mentions of the words
      // (like this assessor's own descriptions) aren't counted as debt.
      if (/(?:\/\/|\/\*)\s*(?:TODO|FIXME|HACK|XXX)\b/.test(line))
        markers.push(`${relative(root, f).replaceAll("\\", "/")}:${i + 1}`);
    });
  }
  if (markers.length > 0) {
    const impact = Math.min(5, 2 + Math.ceil(markers.length / 5));
    candidates.push({
      id: "engine-todos",
      category: "engine",
      target: "src/",
      title: `Address ${markers.length} engine TODO/FIXME marker(s)`,
      rationale:
        "Code-level debt the engine carries; clearing it keeps the deterministic core honest.",
      evidence: markers.slice(0, 8),
      impact,
      effort: "M",
      score: score(impact, "M", "engine"),
    });
  }

  // ── engine/content strategy: measure the stale reactive-description class ─────
  // The repeated bug_0282–0325 class is real, but a naive validator warning would be
  // noisy across the current corpus. Keep it as a deterministic audit signal first:
  // static room prose that names a takeable object in that room, with no room variant
  // reading that object's inventory state. The suppression rule is concrete enough to
  // tune before promoting any subset into validateRpg.
  const staleReactive = auditStaleReactiveRoomItems(root);
  if (staleReactive.sites.length > 0) {
    const examples = staleReactive.sites
      .slice(0, 6)
      .map(
        (site) =>
          `world_quest_id:${site.worldQuestId} room:${site.roomId} names object:${site.objectId} (` +
          `"${site.matchedTerm}") with no room variant reading item/take-effect state`,
      );
    candidates.push({
      id: "stale-reactive-room-item-audit",
      category: "engine",
      target: "src/validate/rpg_validator.ts",
      title: `Tune a class-level stale reactive-description check (${staleReactive.sites.length} room/item site(s) need triage)`,
      rationale:
        "Recent cycles repeatedly fixed stale prose one instance at a time. This audit measures the narrow structural slice most responsible for that class — room base text naming takeable objects after they may be removed — without turning the noisy first pass into shipped-pack warnings. The next move is to tune suppressions or promote the proven subset into validation.",
      evidence: examples,
      impact: 3,
      effort: "M",
      score: score(3, "M", "engine"),
    });
  }

  // ── repo: tooling/hygiene gaps (cheap, deterministic checks) ──────────────────
  const eslintConfig = [
    "eslint.config.js",
    "eslint.config.mjs",
    ".eslintrc",
    ".eslintrc.json",
    ".eslintrc.cjs",
  ]
    .map((f) => join(root, f))
    .find((p) => existsSync(p));
  if (!eslintConfig) {
    candidates.push({
      id: "repo-eslint",
      category: "repo",
      target: "tooling",
      title: "Add ESLint + Prettier (lint is currently just tsc)",
      rationale:
        "A linter/formatter catches a class of issues the typechecker misses and keeps autonomous edits consistent.",
      evidence: ["no eslint/prettier config found"],
      impact: 3,
      effort: "L",
      score: score(3, "L", "repo"),
    });
  } else {
    // ESLint IS wired (bug_0031) — the next repo lever is COVERAGE. bug_0031
    // deliberately scoped the gate to src/bin/scripts/agents and excluded tests/
    // and ui/ "to keep that cycle bounded", but those dirs hold real first-party TS
    // with no static-analysis or format gate — exactly the "currently-invisible
    // work" a cross-category radar should surface (bug_0032 deferred). This fires
    // while a first-party code dir exists, holds lintable TS, yet sits outside the
    // ESLint config's `files` globs; it disarms the moment a cycle brings the dir
    // under the gate. (The engine TODO/FIXME detector is the other non-content
    // lever; it's correctly inert while the codebase carries zero markers.)
    const eslintText = readFileSync(eslintConfig, "utf8");
    const uncovered = LINT_DIRS.filter(
      (d) => dirHasLintableTs(root, d) && !eslintCovers(eslintText, d),
    );
    if (uncovered.length > 0) {
      const impact = Math.min(5, 1 + uncovered.length);
      candidates.push({
        id: "repo-lint-coverage",
        category: "repo",
        target: "tooling",
        title: `Extend ESLint/Prettier coverage to ${uncovered.length} first-party code dir(s) outside the lint gate (${uncovered.join(", ")})`,
        rationale:
          "ESLint/Prettier is wired but scoped to src/bin/scripts/agents; first-party TS in these dirs has no static-analysis or format gate, so a class of issues there is invisible to the loop.",
        evidence: [
          `${uncovered.join(", ")} hold first-party .ts/.tsx but are absent from the ESLint config's files globs`,
          "excluded when ESLint was first added (bug_0031) to keep that cycle bounded; ui/ also needs its own React/TSX lint setup",
        ],
        impact,
        effort: "L",
        score: score(impact, "L", "repo"),
      });
    }
  }

  // ── repo: doc staleness — canonical docs referencing renamed/deleted files ────
  // The third cross-category repo lever (bug_0045). Both others disarm once the
  // code is tidy (repo-eslint since the config ships; lint-coverage since bug_0038
  // gated the last dir; the engine TODO/marker scan at zero markers), leaving the
  // loop with no high-impact non-content lever — yet a canonical doc can still rot
  // when a file it names is renamed/deleted. This fires when such a reference no
  // longer resolves and disarms when every one does. It scans only CURRENT-system
  // docs (see docStalenessDocs): historical archives/logs stay out of scope, while
  // active root, build-spec, blind-tester, UI, and docs/ guidance stays inside it.
  const staleDocRefs: string[] = [];
  for (const docPath of docStalenessDocs(root)) {
    const text = readFileSync(join(root, docPath), "utf8");
    // Most active docs use repo-root paths. A nested guide may also name a path
    // relative to itself (for example ui/README.md → scripts/inline-dist.mjs), so
    // resolve both honest conventions before calling a reference stale.
    const docDir = dirname(docPath);
    for (const ref of findStaleDocRefs(
      text,
      (rel) => existsSync(join(root, rel)) || existsSync(join(root, docDir, rel)),
    )) {
      staleDocRefs.push(`${docPath} → ${ref}`);
    }
  }
  if (staleDocRefs.length > 0) {
    const impact = Math.min(5, 1 + Math.ceil(staleDocRefs.length / 3));
    candidates.push({
      id: "repo-doc-staleness",
      category: "repo",
      target: "docs",
      title: `Fix ${staleDocRefs.length} stale doc reference(s) to renamed/deleted files`,
      rationale:
        "A canonical doc that points at a file which no longer exists misleads the next reader — a human or a fresh AFK agent navigating by it; updating the reference keeps the docs a trustworthy map of the repo.",
      evidence: staleDocRefs.slice(0, 8),
      impact,
      effort: "S",
      score: score(impact, "S", "repo"),
    });
  }

  // ── eval-distribution: mint-and-check a fresh RPG generator window ────────────
  // The public runtime is now RPG-only. Each assessor cycle still confronts the RPG
  // verifier with a fresh, deterministic seed window, but retired legacy windows
  // no longer consume loop time or reintroduce legacy work.
  const rpgGenChecks = rpgGeneratorChecksForRoot(root);
  const rpgGenDrift = generatorRpgDriftCandidate(rpgGenChecks);
  if (rpgGenDrift) candidates.push(rpgGenDrift);
  const allGeneratorsClean = allGeneratedChecksClean(rpgGenChecks);

  // ── hotspot-driven candidates: accepted, unconsumed feedback (see helper
  // functions above) ────────────────────────────────────────────────────────
  const acceptedHotspotOrdinalByCandidateId = new Map<string, number>();
  const hotspotsFile = readLatestHotspots(root);
  if (hotspotsFile) {
    const shippedWorldQuestIds = new Set(
      quests
        .map(({ world_quest_id }) => world_quest_id)
        .filter((questId): questId is string => questId !== null),
    );
    const maxHotspotScore = hotspotsFile.hotspots.reduce((max, h) => Math.max(max, h.score), 0);
    hotspotsFile.hotspots.slice(0, 3).forEach((h, index) => {
      const target = hotspotTarget(h, hotspotsFile, shippedWorldQuestIds);
      if (!target) return;
      const usedCohortFallback = h.location.kind === "unmapped";
      const category = categoryForHotspot(h);
      const effort = effortForHotspot(h);
      const impact = impactForHotspot(h, maxHotspotScore);
      const candidateId = `hotspot-${h.id}`;
      acceptedHotspotOrdinalByCandidateId.set(candidateId, index);
      candidates.push({
        id: candidateId,
        category,
        target,
        title: `Fix compiled feedback hot spot: ${h.title}`,
        rationale:
          `hot spot #${index + 1}: ${h.title} (count ${h.count}, ${h.max_severity}, ` +
          `sources ${h.sources.join("+")})`,
        evidence: [
          `compiled hot spot score ${h.score}, fix_layer ${h.fix_layer}, ` +
            `${h.evidence.length} evidence excerpt(s)`,
          ...(usedCohortFallback
            ? ["unmapped hot spot; target inferred from the sole accepted cohort metric"]
            : []),
        ],
        impact,
        effort,
        score: score(impact, effort, category),
      });
    });
  }

  // Deterministic ordering: score desc, then — among equal scores — rotate the
  // blind-playtest pass onto the LEAST-recently-attended pack (never-attended first,
  // then the oldest most-recent attendance first). When BOTH tied candidates are
  // accepted hot spots, retain their compiler ordinal (raw score desc, then compiler
  // key tie-break); every other tie falls through to id asc. The recency term only
  // separates equal-scored `playtest-*` stubs (all at 0.5); every other candidate gets
  // a sentinel (MAX_SAFE_INTEGER), so accepted-hotspot ordinals can decide their own
  // equal-score ties. Attendance offsets come from the NEWEST-FIRST log, so a SMALLER
  // offset is MORE recent — we negate it so a less-recent (larger-offset) pack sorts
  // EARLIER, and a never-attended pack (MIN_SAFE_INTEGER) sorts earliest of all.
  // c.target is a world quest id for shipped content; legacy/path fallbacks still
  // normalize through packStem so old loop-state attendance remains usable.
  // Reading the tracked AI_LOOP_STATE.md keeps this a pure function of repo state
  // (same repo ⇒ same ranking), curing the cold_forge lock-in (bug_0128).
  // The hot-spot ordinal applies only hot-spot-to-hot-spot. Cross-class ties still use
  // id asc, which guarantees a hot spot never OUTRANKS an unplayable/unbound-quest fix:
  // `fix-unplayable-*`/`fix-unbound-*`/`fix-<id>` all sort before `hotspot-<id>`
  // ('f' < 'h'), so the quest fix wins any exact-score tie.
  const attendance = lastAttendanceOffsets(root);
  const recencyOf = (c: ImprovementCandidate): number => {
    if (!c.id.startsWith("playtest-")) return Number.MAX_SAFE_INTEGER;
    const off = attendance.get(packStem(c.target));
    return off === undefined ? Number.MIN_SAFE_INTEGER : -off;
  };
  const acceptedHotspotOrdinalTie = (a: ImprovementCandidate, b: ImprovementCandidate): number => {
    const aOrdinal = acceptedHotspotOrdinalByCandidateId.get(a.id);
    const bOrdinal = acceptedHotspotOrdinalByCandidateId.get(b.id);
    return aOrdinal !== undefined && bOrdinal !== undefined ? aOrdinal - bOrdinal : 0;
  };
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      recencyOf(a) - recencyOf(b) ||
      acceptedHotspotOrdinalTie(a, b) ||
      a.id.localeCompare(b.id),
  );
  return {
    rpgQuestCount,
    worldQuestCount,
    quests: questHealth,
    allGeneratorsClean,
    candidates,
    top: candidates[0] ?? null,
  };
}

function isRoutinePlaytestCandidate(c: ImprovementCandidate): boolean {
  return (
    c.category === "content_fix" && c.id.startsWith("playtest-") && c.score <= SATURATION_FLOOR
  );
}

function isRoutineQuestReviewCandidate(c: ImprovementCandidate): boolean {
  return isRoutinePlaytestCandidate(c) && c.target !== OVERWORLD_PLAYTEST_TARGET;
}

/**
 * Distinguish evidence-backed strategic direction from the low-value review
 * rotation that remains after every strategic lever has disarmed. Keeping the
 * floor candidates in `candidates` preserves deterministic attendance rotation,
 * but calling one the "next best improvement" at saturation overstates what the
 * assessor knows. Generator drift remains strategic even if a malformed caller
 * supplies a floor-scored top candidate, matching {@link isSaturated}.
 */
export function assessmentRecommendationKind(a: Assessment): "strategic" | "maintenance" | "none" {
  if (a.top === null) return "none";
  return isSaturated(a) ? "maintenance" : "strategic";
}

export function formatAssessment(a: Assessment, opts: AssessmentFormatOptions = {}): string {
  const full = opts.full === true;
  const maxCandidates = opts.maxCandidates ?? 8;
  const recommendationKind = assessmentRecommendationKind(a);
  const playable = a.quests.filter((p) => p.playable).length;
  const warningCount = a.quests.reduce((sum, p) => sum + p.warnings, 0);
  const unhealthy = a.quests.filter((p) => !p.playable || p.warnings > 0);
  const lines: string[] = [];
  lines.push(
    recommendationKind === "strategic"
      ? "# AFK assessment — next best improvement"
      : recommendationKind === "maintenance"
        ? "# AFK assessment — maintenance rotation only"
        : "# AFK assessment — no strategic recommendation",
  );
  lines.push("");
  lines.push(`RPG catalog: ${a.rpgQuestCount} quest(s), ${a.worldQuestCount} world quest node(s)`);
  lines.push(
    `RPG generator mint-and-check: ${a.allGeneratorsClean ? "clean" : "findings present"}`,
  );
  lines.push("");
  lines.push("## Quest health");
  lines.push(
    `- ${playable}/${a.quests.length} playable; ${warningCount} validator warning(s); ${unhealthy.length} quest(s) need deterministic attention.`,
  );
  if (full || unhealthy.length > 0) {
    const listedQuests = full ? a.quests : unhealthy.slice(0, 8);
    for (const p of listedQuests) {
      const label = p.world_quest_id ?? "unbound quest";
      lines.push(`- ${label} ${p.playable ? `${p.warnings} warning(s)` : "UNPLAYABLE"}`);
    }
    if (!full && unhealthy.length > listedQuests.length) {
      lines.push(
        `- ... ${unhealthy.length - listedQuests.length} more unhealthy quest(s) in JSON.`,
      );
    }
  }
  lines.push("");
  lines.push("## Ranked candidates");
  let shown = 0;
  let shownQuestReview = false;
  let omittedRoutine = 0;
  let omittedOther = 0;
  a.candidates.forEach((c, i) => {
    if (!full && shown >= maxCandidates) {
      if (isRoutinePlaytestCandidate(c)) omittedRoutine++;
      else omittedOther++;
      return;
    }
    if (!full && isRoutinePlaytestCandidate(c) && shown >= 3) {
      omittedRoutine++;
      return;
    }
    lines.push(`${i + 1}. [${c.score}] (${c.category}/${c.effort}) ${c.title}`);
    if (isRoutineQuestReviewCandidate(c)) shownQuestReview = true;
    if (full || !isRoutinePlaytestCandidate(c)) {
      lines.push(`     why: ${c.rationale}`);
      for (const e of c.evidence) lines.push(`     · ${e}`);
    }
    shown++;
  });
  if (!full && omittedRoutine > 0) {
    lines.push(
      `... ${omittedRoutine} routine fresh-world review candidate(s) omitted; full list is in assessment.json.`,
    );
    // A hotspot-heavy backlog can occupy every detailed compact row. Keep the
    // rotating quest REVIEW target visible even then. Its live evidence still comes
    // only from the separate required fresh-overworld pass.
    if (!shownQuestReview) {
      const nextQuestRotation = a.candidates.find(isRoutineQuestReviewCandidate);
      if (nextQuestRotation) lines.push(`- Next quest review: ${nextQuestRotation.title}`);
    }
  }
  if (!full && omittedOther > 0) {
    lines.push(
      `... ${omittedOther} additional candidate(s) omitted; full list is in assessment.json.`,
    );
  }
  lines.push("");
  lines.push(
    recommendationKind === "strategic"
      ? `## ▶ Recommended next: ${a.top!.title}`
      : recommendationKind === "maintenance"
        ? `## Maintenance rotation only — no strategic recommendation: ${a.top!.title}`
        : "## No improvement candidates — the game is healthy.",
  );
  return lines.join("\n");
}

/** Convenience used by tests/CLI; the CLI lives in bin/assess.ts. */
