/**
 * Crawl run orchestration — turns CLI flags into a deterministic plan of
 * per-quest (and, from Task 8, overworld) crawl jobs, runs the plan either
 * single-process (`runPlanInProcess`) or fanned out across worker threads
 * (`runPlanWithWorkers`, Task 10 — see `mergeSummaries`), and writes the run's
 * artifacts (findings.jsonl, summary.json, summary.md).
 *
 * `parseCrawlArgs` and `buildPlan` are pure (no I/O beyond `listShippedQuestIds`'s
 * directory read, no wall clock) so they are unit-testable without running a
 * crawl; so are `mergeSummaries`, `sliceSeeds`, `buildWorkerPlans`, and
 * `finalizeFindings` (the shared dedupe/sort/count step `runPlanInProcess` and
 * `mergeSummaries` both route through — see its doc comment), the pure pieces
 * of the worker fan-out. `runPlanInProcess`, `runPlanWithWorkers`, and
 * `writeRunArtifacts` do the actual work and are exercised by the live
 * checkpoints instead (see bin/crawl.ts and the task brief).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { canonicalize } from "../core/hash.js";
import { maneuverActionId } from "../rpg/action_ids.js";
import { renderCoverageMarkdown, type OverworldCoverageSummary } from "./coverage.js";
import { CrawlFindingSchema, findingFingerprint, type CrawlFinding } from "./findings.js";
import { crawlOverworld } from "./overworld_crawler.js";
import { POLICY_NAMES, type PolicyName } from "./policies.js";
import { listShippedQuestIds, prepareShippedQuest, type PreparedQuest } from "./prepare.js";
import { crawlQuest } from "./quest_crawler.js";

/** `solveToEnding`'s state cap for the overworld crawler's quest round trips
 *  (Task 8) — distinct from `CrawlRunOptions.solverBudget`, which gates the
 *  quest crawler's own SOFTLOCK-solver oracle and defaults to 0 (off) for
 *  `--smoke`. A round trip always needs a real solver budget to find a
 *  playable ending, so this is a fixed constant rather than reusing that
 *  option. Tuned against `npm run crawl:smoke`'s wall-clock budget:
 *  tide_mill (6 endings, the largest shipped pack) needs ~60k states (~2s).
 *  If a future pack caps out here, smoke goes red with an honest "search
 *  capped" WORLD finding — raise this consciously rather than papering over.
 */
const OVERWORLD_QUEST_SOLVER_BUDGET = 60000;

export type CrawlPlanItem =
  | { kind: "quest"; questId: string; seeds: number[]; stepsPerSeed: number }
  | { kind: "overworld"; seed: number }; // overworld handled in Task 8

export type CrawlRunOptions = {
  root: string;
  policy: PolicyName;
  commit: string;
  quests: string[] | "all";
  overworld: boolean;
  seeds: number[];
  stepsPerSeed: number;
  secondsBudget?: number;
  solverBudget: number;
  persistEvery: number;
  outDir: string;
  workers: number;
  /** Test-only dependency-injection seam: overrides how `runPlanInProcess`
   *  turns a `questId` into a `PreparedQuest`, defaulting to
   *  `prepareShippedQuest`. Lets unit tests hand `runPlanInProcess` an
   *  in-memory, possibly-mutated pack (`preparePack`) under an arbitrary
   *  `questId`, without touching disk-backed shipped-quest content — see
   *  `tests/unit/crawl_run.test.ts`'s `describe("runPlanInProcess with
   *  injected quests …")`. IN-PROCESS ONLY: `runPlanWithWorkers` ships each
   *  worker its slice of `opts` through `worker_threads`' `workerData`, which
   *  is structured-cloned, and structured clone THROWS on a function rather
   *  than dropping it — so the seam is stripped on the way out by
   *  `workerCloneableOptions` (see its doc comment) and worker shards always
   *  fall back to the real `prepareShippedQuest` regardless of what the parent
   *  process's `opts.prepareQuest` was set to. Never set this from
   *  `bin/crawl.ts` or `parseCrawlArgs`; it exists purely for tests. */
  prepareQuest?: (root: string, questId: string) => PreparedQuest;
  /** Test-only dependency-injection seam: the clock `runPlanInProcess` reads
   *  for the soft `secondsBudget` cutoff, defaulting to `Date.now`. The two
   *  budget-truncation regressions used to race a real 50ms budget against how
   *  fast the first crawl happened to run — green on a loaded machine, red on
   *  an idle one — so they script this clock instead and the skip path is
   *  forced deterministically. IN-PROCESS ONLY, exactly like `prepareQuest`
   *  above: `workerCloneableOptions` strips it before `workerData`'s
   *  structured clone (which throws on functions), so worker shards always
   *  keep the real wall clock. Never set this from `bin/crawl.ts` or
   *  `parseCrawlArgs`; it exists purely for tests. */
  now?: () => number;
};

export type QuestCoverageSummary = {
  roomsVisited: number;
  roomsTotal: number;
  actionsTried: number;
  /** The actual distinct action ids behind `actionsTried` (Task 10). Unlike
   *  `roomsVisited`/`actionsTried` (counts derived from a Set at the point a
   *  single-process run finishes), this real id list is what makes
   *  `mergeSummaries` able to UNION a quest's action coverage exactly across
   *  worker shards — a plain count can only be summed (double-counting any
   *  action tried by more than one shard's seeds), but a set of ids can be
   *  unioned precisely, the same way `endingsReached` already is. */
  actionIdsTried: string[];
  actionsTotal: number;
  endingsReached: string[];
  endingsDeclared: string[];
  orphans: { rooms: string[]; endings: string[] };
};

export type CrawlRunSummary = {
  findings: CrawlFinding[];
  countsByCode: Record<string, number>;
  steps: number;
  wallMs: number;
  stepsPerSec: number;
  questCoverage: Record<string, QuestCoverageSummary>;
  overworld?: OverworldCoverageSummary; // Task 8
  /** Set true only when the soft `secondsBudget` cutoff caused one or more plan
   *  items to be skipped (checked between items, never mid-quest). */
  truncated?: boolean;
  /** Human-readable descriptions of any plan items that did not run because the
   *  seconds budget was exceeded. Always populated when non-empty — a skip is
   *  never silent. */
  skippedItems?: string[];
};

export class CrawlUsageError extends Error {}

/** Parsed CLI options, minus the fields the caller supplies at the call site
 *  (`root`/`commit` are resolved outside argument parsing; `outDir` is only
 *  present when `--out` was given explicitly — the wall-clock default lives in
 *  `defaultOutDir`, never inside this pure parser). */
type ParsedCrawlArgs = Omit<CrawlRunOptions, "root" | "commit" | "outDir"> & {
  outDir?: string;
};

function requireValue(flag: string, raw: string | undefined): string {
  if (raw === undefined) throw new CrawlUsageError(`${flag} requires a value`);
  return raw;
}

function parseNonNegativeInt(flag: string, raw: string | undefined): number {
  const value = requireValue(flag, raw);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new CrawlUsageError(`${flag} must be a non-negative integer, got "${value}"`);
  }
  return n;
}

function parseSeeds(flag: string, raw: string | undefined): number[] {
  const value = requireValue(flag, raw);
  const range = /^(-?\d+)\.\.(-?\d+)$/.exec(value);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (a > b) throw new CrawlUsageError(`${flag} range must be ascending, got "${value}"`);
    const seeds: number[] = [];
    for (let s = a; s <= b; s++) seeds.push(s);
    return seeds;
  }
  if (/^-?\d+$/.test(value)) return [Number(value)];
  throw new CrawlUsageError(`${flag} must be "A..B" or a single integer, got "${value}"`);
}

/**
 * Hand-rolled flag parser (no dependency), in the spirit of bin/replay.ts's
 * `arg()` helper. Pure and wall-clock-free: two calls with the same argv are
 * deep-equal (required by `--smoke`'s determinism contract).
 */
export function parseCrawlArgs(argv: string[]): ParsedCrawlArgs {
  const quests: string[] = [];
  let overworld = true;
  let overworldExplicit = false;
  let policy: PolicyName = "mixed";
  let stepsPerSeed = 400;
  let secondsBudget: number | undefined;
  let seeds = [1, 2, 3];
  let workers = 1;
  let solverBudget = 0;
  let persistEvery = 37;
  let outDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--quest":
        quests.push(requireValue("--quest", argv[++i]));
        break;
      case "--overworld":
        overworld = true;
        overworldExplicit = true;
        break;
      case "--no-overworld":
        overworld = false;
        overworldExplicit = true;
        break;
      case "--policy": {
        const v = requireValue("--policy", argv[++i]);
        if (!(POLICY_NAMES as readonly string[]).includes(v)) {
          throw new CrawlUsageError(
            `--policy must be one of ${POLICY_NAMES.join("|")}, got "${v}"`,
          );
        }
        policy = v as PolicyName;
        break;
      }
      case "--steps":
        stepsPerSeed = parseNonNegativeInt("--steps", argv[++i]);
        break;
      case "--seconds": {
        const n = parseNonNegativeInt("--seconds", argv[++i]);
        secondsBudget = n > 0 ? n : undefined;
        break;
      }
      case "--seeds":
        seeds = parseSeeds("--seeds", argv[++i]);
        break;
      case "--workers": {
        const n = parseNonNegativeInt("--workers", argv[++i]);
        if (n < 1) throw new CrawlUsageError("--workers must be >= 1");
        workers = n;
        break;
      }
      case "--solver-budget":
        solverBudget = parseNonNegativeInt("--solver-budget", argv[++i]);
        break;
      case "--out":
        outDir = requireValue("--out", argv[++i]);
        break;
      case "--smoke":
        policy = "mixed";
        seeds = [1, 2];
        stepsPerSeed = 250;
        solverBudget = 0;
        overworld = true;
        overworldExplicit = true;
        quests.length = 0;
        workers = 1;
        secondsBudget = undefined;
        break;
      case "--deep":
        seeds = parseSeeds("--deep", "1000..1063");
        stepsPerSeed = 2000;
        solverBudget = 20000;
        persistEvery = 37;
        workers = 8;
        secondsBudget = 900;
        break;
      default:
        throw new CrawlUsageError(`unknown flag: ${a}`);
    }
  }

  if (!overworldExplicit) overworld = quests.length === 0;

  return {
    quests: quests.length > 0 ? quests : "all",
    overworld,
    policy,
    stepsPerSeed,
    seeds,
    workers,
    solverBudget,
    persistEvery,
    ...(secondsBudget !== undefined ? { secondsBudget } : {}),
    ...(outDir !== undefined ? { outDir } : {}),
  };
}

/** Default `--out` directory: `ai-runs/crawl/<UTC yyyymmddThhmmssZ>`. Wall-clock
 *  is confined to this one naming helper (never called from the pure parser/plan
 *  builder above) — output naming/metadata only, never findings content. */
export function defaultOutDir(now: Date = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return join("ai-runs", "crawl", stamp);
}

/** Deterministic order: quests sorted by id, then the overworld item (if any). */
export function buildPlan(opts: CrawlRunOptions): CrawlPlanItem[] {
  const questIds = opts.quests === "all" ? listShippedQuestIds(opts.root) : [...opts.quests];
  const sorted = [...questIds].sort();
  const items: CrawlPlanItem[] = sorted.map((questId) => ({
    kind: "quest",
    questId,
    seeds: [...opts.seeds],
    stepsPerSeed: opts.stepsPerSeed,
  }));
  if (opts.overworld) {
    items.push({ kind: "overworld", seed: opts.seeds[0] ?? 1 });
  }
  return items;
}

function describePlanItem(item: CrawlPlanItem): string {
  return item.kind === "quest" ? `quest:${item.questId}` : `overworld:seed${item.seed}`;
}

/**
 * Static, declared-content totals for a prepared quest — the denominators for
 * `questCoverage`. Deliberately a content-surface count (declared rooms/exits/
 * objects/topics/enemies from the pack), not a state-space reachability
 * proof: the latter would need to explore every state combination a run's
 * seeds may never visit, which is out of scope here and would make `--smoke`
 * far too slow. `roomsTotal`/`endingsDeclared` are exact.
 *
 * `actionsTotal` is an UPPER BOUND on the distinct `RpgActionOption.id` values
 * `enumerateRpgActions` can ever emit for this pack — which is exactly what the
 * numerator (`actionIdsTried`, a set of those same ids) is drawn from, so the
 * printed `actions X/Y` ratio can never exceed 100%. It used to be described as
 * "coarse upper-bound-ish" and was in fact neither bound: it summed each room's
 * exits (but a MOVE's id is `go_<direction>`, NOT room-scoped, so every room's
 * `north` exit shares ONE id — a large overcount) while omitting whole families
 * the enumerator emits per object (`examine_`/`read_`/`open_`/`close_`/`drop_`/
 * `unlock_`), per npc (`examine_npc_`/`talk_`), per enemy maneuver, and the two
 * always-available globals (`look_around`/`inventory`) — a larger undercount.
 * Seven of the twelve shipped quests reported over 100% coverage in the
 * `--smoke` lane as a result, so nothing could ever gate or trend on the ratio.
 *
 * The families below mirror `enumerateRpgBaseActions` (src/rpg/legal_actions.ts)
 * plus the runner's combat additions, gated only on STRUCTURAL facts — the
 * conditions a pack's content can never satisfy in any state, never the
 * state-dependent ones (`present`, `isOpen`, inventory membership, dialogue
 * activity), which is what keeps this a bound rather than a census. Collecting
 * literal ids in a Set rather than adding counts is what collapses the shared
 * ones (`go_north` across rooms, an `ask_<topic>` reachable from two nodes)
 * exactly the way the numerator's own Set does.
 */
function computeQuestTotals(prepared: PreparedQuest): {
  roomsTotal: number;
  allRoomIds: string[];
  endingsDeclared: string[];
  actionsTotal: number;
} {
  const pack = prepared.index.pack;
  const allRoomIds = pack.rooms.map((r) => r.id).sort();
  const endingsDeclared = [...new Set(pack.endings.map((e) => e.id))].sort();

  const actionIds = new Set<string>();

  // MOVE — one id per DISTINCT compass direction anywhere in the pack.
  for (const room of pack.rooms) {
    for (const exit of room.exits) actionIds.add(`go_${exit.direction}`);
  }

  // Objects. `examine_` resolves for any present object, so it is unconditional;
  // the rest are gated on a structural fact that no state can supply:
  // READ needs `read_text` or a READ interaction (otherwise the resolver has
  // nothing to narrate and returns null in every state); TAKE needs `takeable`;
  // DROP needs a droppable, non-`held` object (an effect can `add_item` a
  // non-takeable object, so DROP is not conditioned on `takeable`); OPEN/CLOSE
  // need `openable` or an interaction with that verb; UNLOCK needs a `key_id`.
  let useInteractions = 0;
  for (const obj of pack.objects) {
    const verbs = new Set(obj.interactions.map((it) => it.verb));
    actionIds.add(`examine_${obj.id}`);
    if (obj.read_text !== undefined || verbs.has("READ")) actionIds.add(`read_${obj.id}`);
    if (obj.takeable) actionIds.add(`take_${obj.id}`);
    if (obj.held !== true && obj.droppable !== false) actionIds.add(`drop_${obj.id}`);
    if (obj.openable || verbs.has("OPEN")) actionIds.add(`open_${obj.id}`);
    if (obj.openable || verbs.has("CLOSE")) actionIds.add(`close_${obj.id}`);
    if (obj.key_id !== undefined) actionIds.add(`unlock_${obj.id}`);
    // USE ids are minted by `projectUseAction`'s authored-identity rules (legacy
    // `use_<item>_on_<target>` spellings, verb-named stages on an overloaded
    // target), which are not reconstructable from the pack alone. Counting one
    // per targeted USE interaction stays an upper bound: two interactions may
    // share an id, never the reverse.
    useInteractions += obj.interactions.filter(
      (it) => it.verb === "USE" && it.target !== undefined,
    ).length;
  }

  // NPCs: `talk_<npc>`, `ask_<topic>` (topic ids are pack-global, not npc- or
  // node-scoped, so the Set collapses a topic two nodes both offer), and
  // `examine_npc_<npc>` — which the enumerator disambiguates with a `__N`
  // suffix when an object already claimed that id (only possible when a pack
  // ships an object literally named `npc_<npcId>`), mirrored here so that
  // corner stays inside the bound.
  for (const npc of pack.npcs) {
    let examineId = `examine_npc_${npc.id}`;
    for (let n = 2; actionIds.has(examineId); n++) examineId = `examine_npc_${npc.id}__${n}`;
    actionIds.add(examineId);
    actionIds.add(`talk_${npc.id}`);
    for (const node of npc.dialogue.nodes) {
      for (const topic of node.topics) actionIds.add(`ask_${topic.id}`);
    }
  }

  // Enemies: the ordinary strike, plus one id per declared maneuver.
  for (const enemy of pack.enemies) {
    actionIds.add(`attack_${enemy.id}`);
    for (const maneuver of enemy.maneuvers ?? []) {
      actionIds.add(maneuverActionId(enemy.id, maneuver.id));
    }
  }

  // Always-available informational actions.
  actionIds.add("look_around");
  actionIds.add("inventory");

  return {
    roomsTotal: allRoomIds.length,
    allRoomIds,
    endingsDeclared,
    actionsTotal: actionIds.size + useInteractions,
  };
}

/** Fingerprint-based dedupe over already-built findings from possibly-different
 *  seeds/quests — NOT `FindingCollector.add` (that stamps its own base seed onto
 *  every finding, which would misattribute which seed a kept duplicate came
 *  from). Keeps the first occurrence in input order. */
function dedupeFindings(findings: readonly CrawlFinding[]): CrawlFinding[] {
  const seen = new Set<string>();
  const out: CrawlFinding[] = [];
  for (const f of findings) {
    const fp = findingFingerprint(f);
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push(f);
  }
  return out;
}

/**
 * Order-independent pre-sort used ONLY to decide which literal duplicate
 * survives a fingerprint collision — by `(fingerprint, canonical JSON)`
 * rather than by array/processing position. `dedupeFindings` keeps the FIRST
 * occurrence, so feeding it findings in this canonical order (instead of raw
 * concatenation/generation order) makes the surviving literal finding a pure
 * function of the findings' own content — never of how many workers a run
 * split its seeds across, or which shard/seed happened to run first (Task
 * 10's `mergeSummaries` order-independence requirement). `runPlanInProcess`
 * uses the same helper so a single-process run and any worker-split of the
 * same seeds keep the SAME literal survivor, not just the same fingerprint
 * SET, when two seeds happen to trip the identical bug.
 */
function canonicalFindingOrder(findings: readonly CrawlFinding[]): CrawlFinding[] {
  return [...findings].sort((a, b) => {
    const fa = findingFingerprint(a);
    const fb = findingFingerprint(b);
    if (fa !== fb) return fa < fb ? -1 : 1;
    const ca = canonicalize(a);
    const cb = canonicalize(b);
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });
}

function findingSortKey(f: CrawlFinding): string {
  const questId = f.location.questId ?? f.location.node ?? "";
  const step = String(f.step).padStart(12, "0");
  return `${questId}\x00${f.code}\x00${step}\x00${findingFingerprint(f)}`;
}

/** Deterministic order for artifacts/printing: `(questId, code, step, fingerprint)`. */
export function sortFindings(findings: readonly CrawlFinding[]): CrawlFinding[] {
  return [...findings].sort((a, b) => {
    const ka = findingSortKey(a);
    const kb = findingSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Shared finding finalization for BOTH `runPlanInProcess` (single-process) and
 * `mergeSummaries` (worker fan-out) — a Task 10 review fix. Before this, each
 * hand-rolled its own dedupe/count: `runPlanInProcess` deduped via
 * `canonicalFindingOrder` (fingerprint/code-first) and built `countsByCode`
 * from THAT order, while `mergeSummaries` additionally applied `sortFindings`
 * (questId-first) before counting. `findings.jsonl` was safe either way
 * (`writeRunArtifacts` always re-sorts before writing it), but `summary.json`
 * embeds the `findings` array and `countsByCode` object as-built — so their
 * JSON array/key order silently depended on `--workers`, even though the
 * VALUES were always worker-count-invariant. Routing both callers through one
 * function makes that impossible by construction: dedupe (tie-broken by
 * `canonicalFindingOrder` — content, never arrival order), sort into the
 * `sortFindings` artifact order, THEN derive `countsByCode` from that same
 * sorted array, in the one place both callers share.
 */
export function finalizeFindings(rawFindings: readonly CrawlFinding[]): {
  findings: CrawlFinding[];
  countsByCode: Record<string, number>;
} {
  const findings = sortFindings(dedupeFindings(canonicalFindingOrder(rawFindings)));
  const countsByCode: Record<string, number> = {};
  for (const f of findings) countsByCode[f.code] = (countsByCode[f.code] ?? 0) + 1;
  return { findings, countsByCode };
}

/**
 * Overworld crawl seam (Task 8) — runs the full deterministic overworld sweep
 * (edge sweep, boards/quest discovery, quest round trips, coverage) via
 * `crawlOverworld`. `questRoundTrips` is always on here: a real run (smoke,
 * deep, or a plain `--overworld` invocation) always wants the full proof, not
 * just the sweep — the cheaper `questRoundTrips:false` shape is for direct
 * `crawlOverworld` callers that only need the sweep.
 */
function runOverworldItem(
  item: Extract<CrawlPlanItem, { kind: "overworld" }>,
  opts: CrawlRunOptions,
): { findings: CrawlFinding[]; overworld: OverworldCoverageSummary } {
  const result = crawlOverworld({
    root: opts.root,
    seed: item.seed,
    commit: opts.commit,
    questRoundTrips: true,
    solverBudget: OVERWORLD_QUEST_SOLVER_BUDGET,
    maxLocalActionsPerTown: 40,
  });
  return { findings: result.findings, overworld: result.coverage };
}

/** Run a plan single-process (worker fan-out lands in Task 10). */
export function runPlanInProcess(items: CrawlPlanItem[], opts: CrawlRunOptions): CrawlRunSummary {
  const now = opts.now ?? Date.now;
  const wallStart = now();
  const deadline =
    opts.secondsBudget !== undefined && opts.secondsBudget > 0
      ? wallStart + opts.secondsBudget * 1000
      : null;

  const allFindings: CrawlFinding[] = [];
  const questCoverage: Record<string, QuestCoverageSummary> = {};
  let overworld: OverworldCoverageSummary | undefined;
  let totalSteps = 0;
  let truncated = false;
  const skippedItems: string[] = [];

  const prepareQuest = opts.prepareQuest ?? prepareShippedQuest;

  /**
   * A quest the seconds budget skipped must still get a row, or it vanishes from
   * the run's output entirely: `questCoverage` is keyed by the quests that
   * actually RAN, `mergeQuestCoverage` iterates only the keys present, and both
   * `bin/crawl.ts`'s console table and `summary.md`'s "## Quest coverage" list
   * iterate that same map — so a truncated run silently prints fewer quest rows
   * rather than showing the quest at zero. (`--deep` truncates the SAME tail in
   * every shard, since all eight walk one lexicographic plan order, so the
   * vanished rows are the same quests every night.) A zero row unions correctly
   * with any shard that did finish the quest: `orphans` merge by INTERSECTION,
   * and "every room orphaned" intersected with a real shard's orphans is that
   * shard's own set, so a placeholder never degrades a real result.
   *
   * Preparing the pack costs a read+compile the skip was meant to avoid, but it
   * is the only source of the static denominators and it is paid at most once
   * per skipped quest, after the budget is already spent — cheap next to
   * silently under-reporting the run. A prepare that throws (missing/invalid
   * content) leaves the quest absent exactly as before rather than turning a
   * truncated run into a crashed one.
   */
  const recordSkippedQuest = (item: Extract<CrawlPlanItem, { kind: "quest" }>): void => {
    if (questCoverage[item.questId] !== undefined) return;
    let totals: ReturnType<typeof computeQuestTotals>;
    try {
      totals = computeQuestTotals(prepareQuest(opts.root, item.questId));
    } catch {
      return;
    }
    questCoverage[item.questId] = {
      roomsVisited: 0,
      roomsTotal: totals.roomsTotal,
      actionsTried: 0,
      actionIdsTried: [],
      actionsTotal: totals.actionsTotal,
      endingsReached: [],
      endingsDeclared: totals.endingsDeclared,
      orphans: { rooms: totals.allRoomIds, endings: totals.endingsDeclared },
    };
  };

  for (const item of items) {
    // Soft wall-clock cutoff: checked BETWEEN plan items only, never mid-quest —
    // a (quest,seed) episode always finishes once started.
    if (deadline !== null && now() >= deadline) {
      truncated = true;
      skippedItems.push(describePlanItem(item));
      if (item.kind === "quest") recordSkippedQuest(item);
      continue;
    }

    if (item.kind === "quest") {
      const prepared = prepareQuest(opts.root, item.questId);
      const totals = computeQuestTotals(prepared);
      const roomsVisited = new Set<string>();
      const actionsTried = new Set<string>();
      const endingsReached = new Set<string>();

      for (const seed of item.seeds) {
        const result = crawlQuest(prepared, {
          seed,
          maxSteps: item.stepsPerSeed,
          policy: opts.policy,
          persistEvery: opts.persistEvery,
          solverBudget: opts.solverBudget,
          commit: opts.commit,
        });
        totalSteps += result.steps;
        allFindings.push(...result.findings);
        for (const r of result.coverage.roomsVisited) roomsVisited.add(r);
        for (const a of result.coverage.actionIdsTried) actionsTried.add(a);
        for (const e of result.endingsReached) endingsReached.add(e);
      }

      questCoverage[item.questId] = {
        roomsVisited: roomsVisited.size,
        roomsTotal: totals.roomsTotal,
        actionsTried: actionsTried.size,
        actionIdsTried: [...actionsTried].sort(),
        actionsTotal: totals.actionsTotal,
        endingsReached: [...endingsReached].sort(),
        endingsDeclared: totals.endingsDeclared,
        orphans: {
          rooms: totals.allRoomIds.filter((id) => !roomsVisited.has(id)),
          endings: totals.endingsDeclared.filter((id) => !endingsReached.has(id)),
        },
      };
    } else {
      const result = runOverworldItem(item, opts);
      allFindings.push(...result.findings);
      overworld = result.overworld;
    }
  }

  const { findings, countsByCode } = finalizeFindings(allFindings);

  const wallMs = now() - wallStart;
  const stepsPerSec = wallMs > 0 ? (totalSteps / wallMs) * 1000 : totalSteps;

  return {
    findings,
    countsByCode,
    steps: totalSteps,
    wallMs,
    stepsPerSec,
    questCoverage,
    ...(overworld !== undefined ? { overworld } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(skippedItems.length > 0 ? { skippedItems } : {}),
  };
}

/**
 * Split `seeds` into up to `workers` contiguous, non-overlapping, order-
 * preserving slices (`slices.flat()` reunites to `seeds`) — never more slices
 * than seeds (a slice is never empty; requesting more workers than seeds just
 * yields fewer, non-empty slices). Whole seeds only: a `(quest,seed)` episode
 * never splits across two slices. Pure, deterministic: same `(seeds,
 * workers)` in ⇒ same slices out.
 */
export function sliceSeeds(seeds: readonly number[], workers: number): number[][] {
  if (seeds.length === 0 || workers <= 0) return [];
  const n = Math.min(workers, seeds.length);
  const base = Math.floor(seeds.length / n);
  const extra = seeds.length % n;
  const slices: number[][] = [];
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const size = base + (i < extra ? 1 : 0);
    slices.push(seeds.slice(idx, idx + size));
    idx += size;
  }
  return slices;
}

/**
 * Splits a plan's QUEST items into up to `workers` per-worker sub-plans, by
 * slicing each item's own seed list via {@link sliceSeeds} (whole seeds per
 * worker — see its doc comment). The overworld item, if any, is deliberately
 * excluded here: Task 10 keeps it single-process, run directly by the parent
 * (see `runPlanWithWorkers`) — it's one deterministic sweep rather than a
 * per-seed loop, so fanning it out across workers would buy nothing. Only
 * non-empty worker plans are returned (never spawn a worker with nothing to
 * do). Pure: same `(items, workers)` in ⇒ same plans out, no I/O.
 */
function buildWorkerPlans(items: readonly CrawlPlanItem[], workers: number): CrawlPlanItem[][] {
  const questItems = items.filter(
    (i): i is Extract<CrawlPlanItem, { kind: "quest" }> => i.kind === "quest",
  );
  const plans: CrawlPlanItem[][] = Array.from({ length: Math.max(workers, 0) }, () => []);
  for (const item of questItems) {
    const slices = sliceSeeds(item.seeds, workers);
    slices.forEach((seeds, i) => {
      if (seeds.length > 0) plans[i]!.push({ ...item, seeds });
    });
  }
  return plans.filter((p) => p.length > 0);
}

/**
 * Merges per-quest coverage across shard summaries: rooms/endings are unioned
 * EXACTLY (their `orphans`/`endingsReached` fields already carry the real id
 * sets — see `QuestCoverageSummary`'s doc comments — so a room/ending is a
 * global orphan only when EVERY shard failed to cover it); actions are
 * unioned via `actionIdsTried` the same way. `roomsTotal`/`actionsTotal`/
 * `endingsDeclared` are static per-quest content facts (from the prepared
 * pack, not the seed), so they're invariant across shards — taken from
 * whichever shard is encountered first for that quest.
 */
function mergeQuestCoverage(
  summaries: readonly Partial<CrawlRunSummary>[],
): Record<string, QuestCoverageSummary> {
  const byQuest = new Map<string, QuestCoverageSummary[]>();
  for (const s of summaries) {
    for (const [questId, cov] of Object.entries(s.questCoverage ?? {})) {
      const list = byQuest.get(questId);
      if (list) list.push(cov);
      else byQuest.set(questId, [cov]);
    }
  }

  const merged: Record<string, QuestCoverageSummary> = {};
  for (const questId of [...byQuest.keys()].sort()) {
    const shards = byQuest.get(questId)!;
    const first = shards[0]!;

    const orphanRoomSets = shards.map((c) => new Set(c.orphans.rooms));
    const orphanRooms = [...orphanRoomSets[0]!]
      .filter((id) => orphanRoomSets.every((set) => set.has(id)))
      .sort();

    const endingsReached = [...new Set(shards.flatMap((c) => c.endingsReached))].sort();
    const endingsDeclared = first.endingsDeclared;
    const orphanEndings = endingsDeclared.filter((id) => !endingsReached.includes(id));

    const actionIdsTried = [...new Set(shards.flatMap((c) => c.actionIdsTried))].sort();

    merged[questId] = {
      roomsVisited: first.roomsTotal - orphanRooms.length,
      roomsTotal: first.roomsTotal,
      actionsTried: actionIdsTried.length,
      actionIdsTried,
      actionsTotal: first.actionsTotal,
      endingsReached,
      endingsDeclared,
      orphans: { rooms: orphanRooms, endings: orphanEndings },
    };
  }
  return merged;
}

/**
 * Merges shard `CrawlRunSummary`s (Task 10 worker fan-out): findings are
 * concatenated, then re-deduped by `findingFingerprint` — using
 * `canonicalFindingOrder` so which literal duplicate survives a collision
 * depends only on the findings' own content, never on shard/array order (the
 * hard invariant this function's test pins: `mergeSummaries([a,b])` equals
 * `mergeSummaries([b,a])`) — then sorted by `(questId, code, step,
 * fingerprint)`. `steps` is summed; per-quest coverage is unioned (see
 * `mergeQuestCoverage`); the overworld item (single-process, run once by the
 * parent) is carried through unchanged from whichever shard has it.
 *
 * Timing is NOT summed from the shards: `wallMs` reflects real parallel wall
 * time, not each shard's own (smaller) wall time, so the caller measures it
 * across the whole fan-out and passes it in; `stepsPerSec` is recomputed from
 * the MERGED step count against that. Omitting `wallMs` falls back to
 * summing shard wall times (only meaningful for tests/direct callers that
 * don't care about real throughput).
 *
 * Deliberately defensive about missing fields (`?.`/`??` throughout): the
 * merge test feeds it intentionally minimal/partial summaries.
 */
export function mergeSummaries(
  summaries: readonly CrawlRunSummary[],
  wallMs?: number,
): CrawlRunSummary {
  const allFindingsRaw: CrawlFinding[] = summaries.flatMap((s) => s?.findings ?? []);
  const { findings, countsByCode } = finalizeFindings(allFindingsRaw);

  const steps = summaries.reduce((sum, s) => sum + (s?.steps ?? 0), 0);
  const questCoverage = mergeQuestCoverage(summaries);
  const overworld = summaries.map((s) => s?.overworld).find((o) => o !== undefined);
  const truncated = summaries.some((s) => s?.truncated === true);
  const skippedItems = [...new Set(summaries.flatMap((s) => s?.skippedItems ?? []))].sort();

  const mergedWallMs = wallMs ?? summaries.reduce((sum, s) => sum + (s?.wallMs ?? 0), 0);
  const stepsPerSec = mergedWallMs > 0 ? (steps / mergedWallMs) * 1000 : steps;

  return {
    findings,
    countsByCode,
    steps,
    wallMs: mergedWallMs,
    stepsPerSec,
    questCoverage,
    ...(overworld !== undefined ? { overworld } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(skippedItems.length > 0 ? { skippedItems } : {}),
  };
}

/**
 * The slice of `CrawlRunOptions` a worker thread can actually be handed.
 *
 * `workerData` is structured-cloned, and structured clone does NOT silently drop
 * a function — it throws `DataCloneError: () => {} could not be cloned`. So
 * forwarding `opts` verbatim turned any caller that set the in-process-only
 * `prepareQuest` seam and asked for `--workers 2` into an opaque
 * worker-construction crash surfacing as a raw stack from `bin/crawl.ts`, even
 * though the seam's own doc comment promised worker shards would fall back to
 * the real `prepareShippedQuest`. Dropping the seam here is what makes that
 * documented contract true; every other option is plain data and clones fine.
 */
export function workerCloneableOptions(
  opts: CrawlRunOptions,
): Omit<CrawlRunOptions, "prepareQuest" | "now"> {
  const { prepareQuest: _inProcessOnly, now: _testClockOnly, ...cloneable } = opts;
  return cloneable;
}

/** Runs one worker thread on its slice of the plan, resolving with the
 *  shard's `CrawlRunSummary`. Uses `worker_threads` (not a `child_process`
 *  fallback): the worker loads `worker_bootstrap.mjs` — plain JS the thread
 *  can run natively — which registers tsx's ESM loader INSIDE the thread via
 *  `tsx/esm/api`'s `register()` and then imports the real `worker_entry.ts`.
 *  An earlier version spawned `worker_entry.ts` directly with
 *  `execArgv: ["--import", "tsx"]`; that worked on Node 24/Windows locally
 *  but failed on CI's ubuntu-latest + Node 22 with `ERR_MODULE_NOT_FOUND` for
 *  `./run.js` — `--import`'s effect on a worker thread's own module
 *  resolution is Node-version-dependent. Registering tsx via its API from
 *  code already running inside the thread (the bootstrap) is
 *  version-independent by construction, so no `execArgv` is needed at all.
 *
 *  `--seconds` deadline note: `opts` (including `secondsBudget`) is passed
 *  through unchanged to `worker_entry.ts`'s `runPlanInProcess(items, opts)`
 *  call, which computes ITS OWN `wallStart`/`deadline` from `Date.now()`
 *  inside the worker thread — there is no single global deadline shared
 *  across shards, and the parent never enforces one of its own either. This
 *  is deliberately per-worker, not global, and is acceptable because: (1) all
 *  workers are spawned back-to-back in one synchronous loop
 *  (`workerPlans.map(...)` in `runPlanWithWorkers`), so their wall clocks
 *  start within milliseconds of each other — not close enough to promise a
 *  shared deadline to the millisecond, but close enough that a worker
 *  drifting past `--seconds` by "however long its siblings took to spawn"
 *  (microseconds-to-low-milliseconds) is immaterial; (2) `secondsBudget` is
 *  already a SOFT cutoff even in the single-process path — checked only
 *  between plan items, never mid-quest — so a shard can already run over by
 *  up to one (quest,seed) episode's worth of time; and (3) any truncation is
 *  loud: a shard that hits its deadline sets `truncated`/`skippedItems`,
 *  which `mergeSummaries` ORs/unions across shards into the merged summary
 *  (see its doc comment), so a per-worker overrun is always visible in
 *  `summary.json`/`summary.md`, never silently swallowed. */
function runWorkerShard(items: CrawlPlanItem[], opts: CrawlRunOptions): Promise<CrawlRunSummary> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker_bootstrap.mjs", import.meta.url), {
      workerData: { items, opts: workerCloneableOptions(opts) },
    });
    let settled = false;
    worker.once("message", (summary: CrawlRunSummary) => {
      settled = true;
      resolve(summary);
      void worker.terminate();
    });
    worker.once("error", (err) => {
      if (!settled) reject(err);
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        reject(new Error(`worker exited with code ${code} before posting a summary`));
      }
    });
  });
}

/**
 * Fans a plan's quest items out across `opts.workers` worker threads (Task
 * 10) and merges their shard summaries back into one `CrawlRunSummary` via
 * `mergeSummaries`. The overworld item, if present, runs single-process in
 * THIS (parent) process — see `buildWorkerPlans`'s doc comment for why —
 * concurrently with the worker fan-out. `wallMs` is measured across the
 * WHOLE fan-out (workers + any parent-side overworld run), so
 * `stepsPerSec` reflects real achieved parallelism.
 *
 * `--seconds` (`opts.secondsBudget`) is NOT enforced as one global deadline
 * here — this function has no clock of its own for it. Each worker shard (via
 * `runWorkerShard`/`worker_entry.ts`) and the parent's own overworld run (via
 * `runPlanInProcess` above) independently compute their OWN wall-clock
 * deadline from their own `Date.now()` at the moment they start. See
 * `runWorkerShard`'s doc comment for why a per-worker deadline (rather than
 * one shared/global one) is an acceptable choice here.
 */
export async function runPlanWithWorkers(
  items: CrawlPlanItem[],
  opts: CrawlRunOptions,
): Promise<CrawlRunSummary> {
  const wallStart = Date.now();
  const workerPlans = buildWorkerPlans(items, opts.workers);
  const overworldItems = items.filter((i) => i.kind === "overworld");

  const [shardSummaries, overworldSummary] = await Promise.all([
    Promise.all(workerPlans.map((plan) => runWorkerShard(plan, opts))),
    overworldItems.length > 0 ? runPlanInProcess(overworldItems, opts) : null,
  ]);

  const all = overworldSummary ? [...shardSummaries, overworldSummary] : shardSummaries;
  const wallMs = Date.now() - wallStart;
  return mergeSummaries(all, wallMs);
}

function renderSummaryMarkdown(
  summary: CrawlRunSummary,
  meta: { argv: string[]; commit: string; startedAt: string },
): string {
  const lines: string[] = [];
  lines.push("# crawl run summary", "");
  lines.push(`commit: ${meta.commit}`);
  lines.push(`argv: ${meta.argv.join(" ")}`, "");

  const nonOrphan = summary.findings.filter((f) => f.code !== "ORPHAN");
  lines.push(`## Findings (${summary.findings.length} total, ${nonOrphan.length} non-ORPHAN)`, "");
  if (summary.findings.length === 0) {
    lines.push("No findings.", "");
  } else {
    for (const f of sortFindings(summary.findings)) {
      const loc = f.location.questId ?? f.location.node ?? "?";
      const scene = f.location.sceneId ?? "-";
      lines.push(`- ${f.code} ${f.severity} ${loc}/${scene} ${f.message}`);
    }
    lines.push("");
  }

  lines.push("## Quest coverage", "");
  for (const questId of Object.keys(summary.questCoverage).sort()) {
    const c = summary.questCoverage[questId]!;
    lines.push(
      `- ${questId}: rooms ${c.roomsVisited}/${c.roomsTotal}, actions ${c.actionsTried}/${c.actionsTotal}, ` +
        `endings ${c.endingsReached.length}/${c.endingsDeclared.length} reached=[${c.endingsReached.join(", ")}], ` +
        `orphan rooms=[${c.orphans.rooms.join(", ")}], orphan endings=[${c.orphans.endings.join(", ")}]`,
    );
  }
  lines.push("");

  const overworldMarkdown = renderCoverageMarkdown(summary);
  if (overworldMarkdown) lines.push(overworldMarkdown);

  if (summary.skippedItems && summary.skippedItems.length > 0) {
    lines.push("## Skipped", "");
    lines.push(`truncated: ${summary.truncated === true}`);
    for (const s of summary.skippedItems) lines.push(`- ${s}`);
    lines.push("");
  }

  // Timing lives in its OWN block, separate from the findings section above, so
  // two `--smoke` runs with identical findings/coverage are byte-identical up to
  // this point — everything wall-clock-derived (startedAt, wallMs, steps/sec) is
  // confined here.
  lines.push("## Timing", "");
  lines.push(`- started: ${meta.startedAt}`);
  lines.push(`- steps: ${summary.steps}`);
  lines.push(`- wallMs: ${summary.wallMs}`);
  lines.push(`- steps/sec: ${summary.stepsPerSec.toFixed(1)}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Write findings.jsonl (deduped, deterministic order), summary.json (plain
 * JSON — no zod — with wallMs/stepsPerSec moved under a `timing` key), and
 * summary.md (human-readable; findings section excludes wall-clock so
 * `--smoke` output is byte-comparable across runs).
 */
export function writeRunArtifacts(
  outDir: string,
  summary: CrawlRunSummary,
  meta: { argv: string[]; commit: string; startedAt: string },
): void {
  mkdirSync(outDir, { recursive: true });

  const sorted = sortFindings(summary.findings);
  for (const f of sorted) CrawlFindingSchema.parse(f);
  const jsonl = sorted.map((f) => canonicalize(f)).join("\n");
  writeFileSync(join(outDir, "findings.jsonl"), jsonl.length > 0 ? jsonl + "\n" : "", "utf8");

  const { wallMs, stepsPerSec, ...rest } = summary;
  const summaryJson = { ...rest, meta, timing: { wallMs, stepsPerSec } };
  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summaryJson, null, 2)}\n`, "utf8");

  writeFileSync(join(outDir, "summary.md"), renderSummaryMarkdown(summary, meta), "utf8");
}
