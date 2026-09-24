import { describe, expect, it } from "vitest";
import {
  parseCrawlArgs,
  buildPlan,
  finalizeFindings,
  mergeSummaries,
  runPlanInProcess,
  sliceSeeds,
  workerCloneableOptions,
  type CrawlPlanItem,
  type CrawlRunOptions,
} from "../../src/crawl/run.js";
import { listShippedQuestIds, preparePack, type PreparedQuest } from "../../src/crawl/prepare.js";
import { generateRpgPack } from "../../src/gen/rpg_generator.js";

function isQuestItem(p: CrawlPlanItem): p is Extract<CrawlPlanItem, { kind: "quest" }> {
  return p.kind === "quest";
}

describe("crawl CLI", () => {
  it("parses seed ranges and quest lists", () => {
    const o = parseCrawlArgs([
      "--quest",
      "sunken_barrow",
      "--seeds",
      "5..8",
      "--steps",
      "100",
      "--policy",
      "random",
    ]);
    expect(o.quests).toEqual(["sunken_barrow"]);
    expect(o.seeds).toEqual([5, 6, 7, 8]);
    expect(o.policy).toBe("random");
    expect(o.overworld).toBe(false);
  });

  it("smoke preset is fixed and deterministic", () => {
    const a = parseCrawlArgs(["--smoke"]);
    const b = parseCrawlArgs(["--smoke"]);
    expect(a).toEqual(b);
    expect(a.seeds.length).toBeGreaterThan(0);
    expect(a.secondsBudget).toBeUndefined();
    expect(a.overworld).toBe(true);
  });

  it("plan orders quests deterministically", () => {
    const o = parseCrawlArgs(["--smoke"]);
    const plan = buildPlan({ ...o, root: process.cwd(), commit: "x", outDir: "ignored" });
    const questIds = plan.filter(isQuestItem).map((p) => p.questId);
    expect(questIds).toEqual([...questIds].sort());
  });
});

describe("mergeSummaries", () => {
  it("merging shard summaries is order-independent and re-dedupes", () => {
    const f = (seed: number, msg: string) =>
      ({
        code: "RENDER",
        severity: "S2",
        seed,
        policy: "mixed",
        step: 1,
        location: { region: null, node: null, questId: "q", sceneId: "r" },
        action: null,
        message: msg,
        stateHash: null,
        commit: "x",
        repro: { kind: "none", trace: null, minimized: false },
      }) as const;
    const s1 = { findings: [f(1, "empty description 5")], steps: 10 /* …minimal summary… */ };
    const s2 = { findings: [f(2, "empty description 9")], steps: 20 };
    const ab = mergeSummaries([s1, s2] as never);
    const ba = mergeSummaries([s2, s1] as never);
    expect(ab.findings).toEqual(ba.findings);
    expect(ab.findings).toHaveLength(1); // same fingerprint (numbers normalized)
    expect(ab.steps).toBe(30);
  });

  it("unions per-quest coverage across shards (rooms/actions/endings)", () => {
    const s1 = {
      findings: [],
      steps: 5,
      questCoverage: {
        q1: {
          roomsVisited: 2,
          roomsTotal: 3,
          actionsTried: 2,
          actionIdsTried: ["MOVE:a", "MOVE:b"],
          actionsTotal: 5,
          endingsReached: ["good"],
          endingsDeclared: ["good", "bad"],
          orphans: { rooms: ["r3"], endings: ["bad"] },
        },
      },
    };
    const s2 = {
      findings: [],
      steps: 7,
      questCoverage: {
        q1: {
          roomsVisited: 2,
          roomsTotal: 3,
          actionsTried: 1,
          actionIdsTried: ["MOVE:c"],
          actionsTotal: 5,
          endingsReached: ["bad"],
          endingsDeclared: ["good", "bad"],
          orphans: { rooms: ["r1"], endings: ["good"] },
        },
      },
    };
    const merged = mergeSummaries([s1, s2] as never);
    const q1 = merged.questCoverage["q1"]!;
    expect(q1.roomsVisited).toBe(3); // r1 and r3 each covered by the OTHER shard
    expect(q1.orphans.rooms).toEqual([]);
    expect(q1.actionIdsTried).toEqual(["MOVE:a", "MOVE:b", "MOVE:c"]);
    expect(q1.actionsTried).toBe(3);
    expect(q1.endingsReached).toEqual(["bad", "good"]);
    expect(q1.orphans.endings).toEqual([]);
  });

  it("recomputes timing from an explicit wallMs rather than summing shard wallMs", () => {
    const s1 = { findings: [], steps: 100, wallMs: 999, stepsPerSec: 1 };
    const s2 = { findings: [], steps: 100, wallMs: 999, stepsPerSec: 1 };
    const merged = mergeSummaries([s1, s2] as never, 200);
    expect(merged.wallMs).toBe(200);
    expect(merged.stepsPerSec).toBeCloseTo((200 / 200) * 1000, 5);
  });
});

/**
 * Task 10 review fix: `summary.json` embeds `findings`/`countsByCode` as
 * built, not just as sets/values — so BOTH the single-process path
 * (`runPlanInProcess`, via `finalizeFindings`) and the worker-merge path
 * (`mergeSummaries`, via the SAME `finalizeFindings`) must produce identical
 * array/key ORDER for identical finding content, never an order that depends
 * on how many workers ran, or in what order shards happened to concatenate.
 * `quest_a`'s only code (WORLD) sorts alphabetically AFTER `quest_b`'s only
 * code (CRASH) — so a fingerprint/code-first order (the pre-fix bug: code
 * first, so CRASH before WORLD/LEGALITY) and a questId-first order (the
 * correct `sortFindings` artifact order: quest_a's codes before quest_b's)
 * disagree on which code appears first. That disagreement is exactly what
 * pins the regression.
 */
describe("finalizeFindings (shared by runPlanInProcess and mergeSummaries)", () => {
  const finding = (code: string, questId: string, seed: number, step: number, msg: string) =>
    ({
      code,
      severity: "S2",
      seed,
      policy: "mixed",
      step,
      location: { region: null, node: null, questId, sceneId: "r" },
      action: null,
      message: msg,
      stateHash: null,
      commit: "x",
      repro: { kind: "none", trace: null, minimized: false },
    }) as const;

  // Multi-code (CRASH, WORLD, LEGALITY, RENDER), multi-quest (quest_a/b/c) set,
  // fed in an arrival order that matches neither the fingerprint/code-first
  // order nor the correct questId-first order — so nothing "accidentally"
  // passes by matching input order.
  const raw = [
    finding("RENDER", "quest_c", 1, 1, "delta"),
    finding("CRASH", "quest_b", 1, 1, "alpha"),
    finding("WORLD", "quest_a", 2, 1, "beta"),
    finding("LEGALITY", "quest_a", 1, 2, "gamma"),
  ] as never as Parameters<typeof finalizeFindings>[0];

  it("orders findings/countsByCode by (questId, code) — NOT by fingerprint's code-first order", () => {
    const { findings, countsByCode } = finalizeFindings(raw);
    // questId-first: quest_a (LEGALITY before WORLD, alphabetically) then quest_b then quest_c.
    expect(findings.map((f) => `${f.location.questId}:${f.code}`)).toEqual([
      "quest_a:LEGALITY",
      "quest_a:WORLD",
      "quest_b:CRASH",
      "quest_c:RENDER",
    ]);
    expect(Object.keys(countsByCode)).toEqual(["LEGALITY", "WORLD", "CRASH", "RENDER"]);
    // The old bug's order (fingerprint/code-first, alphabetical by CODE alone)
    // would have put CRASH first — assert we do NOT match that shape.
    expect(Object.keys(countsByCode)).not.toEqual(["CRASH", "LEGALITY", "RENDER", "WORLD"]);
  });

  it("both paths agree: finalizeFindings(raw) directly vs. mergeSummaries splitting the SAME findings across shards in a different order", () => {
    const direct = finalizeFindings(raw);

    // Simulate a worker fan-out: the same findings, split into two shards in
    // an order that differs from `raw`'s own arrival order (as a real
    // multi-worker run's shard-completion order would).
    const shardA = { findings: [raw[2]!, raw[0]!], steps: 0 } as never;
    const shardB = { findings: [raw[3]!, raw[1]!], steps: 0 } as never;
    const merged = mergeSummaries([shardA, shardB]);

    expect(merged.findings).toEqual(direct.findings);
    expect(Object.keys(merged.countsByCode)).toEqual(Object.keys(direct.countsByCode));
    expect(merged.countsByCode).toEqual(direct.countsByCode);
  });
});

describe("sliceSeeds", () => {
  it("splits seeds into whole, contiguous, non-overlapping per-worker slices that reunite to the input", () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7];
    const slices = sliceSeeds(seeds, 3);
    expect(slices).toHaveLength(3);
    expect(slices.flat()).toEqual(seeds);
    // every seed appears in exactly one slice
    const seen = slices.flat();
    expect(new Set(seen).size).toBe(seeds.length);
  });

  it("never hands out more slices than seeds", () => {
    const slices = sliceSeeds([1, 2], 8);
    expect(slices.filter((s) => s.length > 0)).toHaveLength(2);
  });
});

/**
 * Review fix (Task 10 follow-up #2): the `finalizeFindings` tests above never
 * exercise `findings`/`countsByCode` with REAL findings produced by an actual
 * `runPlanInProcess` call — they hand-build `CrawlFinding` literals and call
 * `finalizeFindings`/`mergeSummaries` directly, so they cannot fail on the
 * historical defect (`runPlanInProcess`
 * and `mergeSummaries` disagreeing on array/key order) actually firing on a
 * live crawl.
 *
 * This suite uses the new `CrawlRunOptions.prepareQuest` DI seam to hand
 * `runPlanInProcess` two in-memory, mutated packs — a RENDER template-marker
 * mutation (`generateRpgPack(3)`) and a throwing-resolver CRASH wrapper
 * (`generateRpgPack(4)`), the recipes crawler_fault_injection.test.ts also plants
 * — under two different questIds
 * chosen so questId-alphabetical order and code-alphabetical order DISAGREE:
 * `quest_alpha_render` (RENDER) sorts before `quest_zulu_crash` (CRASH) by
 * questId, but "CRASH" sorts before "RENDER" alphabetically by code alone.
 * The plan items are also fed in the OPPOSITE order (CRASH item first) so
 * nothing "accidentally" passes by matching arrival order either.
 */
describe("runPlanInProcess with injected quests (real, non-empty findings)", () => {
  const RENDER_QUEST_ID = "quest_alpha_render";
  const CRASH_QUEST_ID = "quest_zulu_crash";

  function prepareRenderQuest(): PreparedQuest {
    const pack = generateRpgPack(3);
    // pack.rooms is an array (src/rpg/schema.ts RpgPackSchema); pick any non-start room.
    const room = pack.rooms.find((r) => r.id !== pack.meta.start_room)!;
    room.description = "You see {{treasure_name}} here.";
    return { ...preparePack(pack), questId: RENDER_QUEST_ID };
  }

  function prepareCrashQuest(): PreparedQuest {
    const pack = generateRpgPack(4);
    const prepared = preparePack(pack, {
      wrapRules: (rules) => ({
        ...rules,
        resolve: (state, action) => {
          if (action.type === "TAKE") throw new Error("planted resolver bomb");
          return rules.resolve(state, action);
        },
      }),
    });
    return { ...prepared, questId: CRASH_QUEST_ID };
  }

  function injectedPrepareQuest(_root: string, questId: string): PreparedQuest {
    if (questId === RENDER_QUEST_ID) return prepareRenderQuest();
    if (questId === CRASH_QUEST_ID) return prepareCrashQuest();
    throw new Error(`test seam: unexpected questId "${questId}"`);
  }

  const baseOpts: Omit<CrawlRunOptions, "prepareQuest"> = {
    root: process.cwd(),
    policy: "mixed",
    commit: "test",
    quests: "all",
    overworld: false,
    seeds: [11],
    stepsPerSeed: 400,
    solverBudget: 0,
    persistEvery: 37,
    outDir: "ignored",
    workers: 1,
  };
  const opts: CrawlRunOptions = { ...baseOpts, prepareQuest: injectedPrepareQuest };

  // Arrival order deliberately reversed from the eventual questId-sorted order.
  const crashItem: CrawlPlanItem = {
    kind: "quest",
    questId: CRASH_QUEST_ID,
    seeds: [11],
    stepsPerSeed: 400,
  };
  const renderItem: CrawlPlanItem = {
    kind: "quest",
    questId: RENDER_QUEST_ID,
    seeds: [11],
    stepsPerSeed: 600,
  };
  const items: CrawlPlanItem[] = [crashItem, renderItem];

  it("orders findings/countsByCode by (questId, code), not by arrival order or code alone", () => {
    const summary = runPlanInProcess(items, opts);
    const pairs = summary.findings.map((f) => `${f.location.questId}:${f.code}`);
    // The mutated room's template marker is rendered from two different call
    // sites (an observation description and a narration event), so the RENDER
    // quest legitimately produces two distinct (differently-worded, differently-
    // stepped) RENDER findings — both still sort before the CRASH quest's one
    // finding, since questId is the primary sort key.
    expect(pairs).toEqual([
      `${RENDER_QUEST_ID}:RENDER`,
      `${RENDER_QUEST_ID}:RENDER`,
      `${CRASH_QUEST_ID}:CRASH`,
    ]);
    expect(Object.keys(summary.countsByCode)).toEqual(["RENDER", "CRASH"]);
    expect(summary.countsByCode).toEqual({ RENDER: 2, CRASH: 1 });
  });

  it("mergeSummaries over per-quest shards matches runPlanInProcess's combined findings and key order", () => {
    const combined = runPlanInProcess(items, opts);

    // Simulate a worker-per-quest fan-out: each shard sees only its own item,
    // fed to mergeSummaries in the SAME (crash-then-render) arrival order.
    const crashShard = runPlanInProcess([crashItem], opts);
    const renderShard = runPlanInProcess([renderItem], opts);
    const merged = mergeSummaries([crashShard, renderShard]);

    expect(merged.findings).toEqual(combined.findings);
    expect(Object.keys(merged.countsByCode)).toEqual(Object.keys(combined.countsByCode));
    expect(merged.countsByCode).toEqual(combined.countsByCode);
  });
});

/**
 * `questCoverage.actionsTotal` is the denominator behind the `actions X/Y` line
 * `bin/crawl.ts` prints and `writeRunArtifacts` records in summary.{md,json}.
 * It used to be neither an upper nor a lower bound on the numerator: it summed
 * every room's exits (though a MOVE's id is `go_<direction>`, shared by every
 * room offering that direction) while omitting entire families the enumerator
 * emits — `examine_`/`read_`/`open_`/`close_`/`drop_`/`unlock_` per object,
 * `examine_npc_`/`talk_` per npc, one id per enemy maneuver, and the global
 * `look_around`/`inventory`. Five of the twelve shipped quests already exceed
 * 100% at the modest budget used here (advocates_case, cold_forge, factors_mark,
 * falconers_ransom, printers_night), so a ratio that can never reach a target is
 * useless as a gate or a trend line and hides a genuine drop in explored surface
 * inside denominator noise.
 *
 * Deliberately run against the REAL shipped packs rather than a fixture: the
 * defect was a mismatch between the declared-content estimate and what
 * `enumerateRpgActions` actually emits for shipped content shapes, which a
 * hand-built pack cannot witness. One seed and a short step budget keeps this
 * to about two seconds while still trying enough actions to cross the old bound.
 */
describe("quest coverage denominator", () => {
  it("actionsTotal upper-bounds actionsTried for every shipped quest", () => {
    const root = process.cwd();
    const questIds = listShippedQuestIds(root);
    expect(questIds.length).toBeGreaterThanOrEqual(11);

    const items: CrawlPlanItem[] = questIds.map((questId) => ({
      kind: "quest",
      questId,
      seeds: [1],
      stepsPerSeed: 150,
    }));
    const summary = runPlanInProcess(items, {
      root,
      policy: "mixed",
      commit: "test",
      quests: "all",
      overworld: false,
      seeds: [1],
      stepsPerSeed: 150,
      solverBudget: 0,
      persistEvery: 37,
      outDir: "ignored",
      workers: 1,
    });

    const over = Object.entries(summary.questCoverage)
      .filter(([, c]) => c.actionsTried > c.actionsTotal)
      .map(([questId, c]) => `${questId} ${c.actionsTried}/${c.actionsTotal}`);
    expect(over).toEqual([]);
    // Guard against a trivially-passing shape: a numerator stuck at zero, or a
    // non-finite denominator, would satisfy the bound while measuring nothing.
    for (const [questId, c] of Object.entries(summary.questCoverage)) {
      expect(c.actionsTried, questId).toBeGreaterThan(0);
      expect(Number.isFinite(c.actionsTotal), questId).toBe(true);
    }
  });
});

/**
 * A quest the `--seconds` budget skipped used to vanish from the run's output
 * entirely rather than reporting zero coverage: `questCoverage` was written only
 * after a quest actually ran, `mergeQuestCoverage` iterates only the keys
 * present, and both the console table and summary.md's "## Quest coverage" list
 * iterate that same map. Under `crawl:deep` every shard walks the identical
 * lexicographic plan order against the same soft cutoff, so the vanished rows
 * are the same tail quests every night — and the only signal was a stderr line
 * that does not affect the exit code.
 */
describe("runPlanInProcess seconds-budget truncation", () => {
  const QUEST_A = "quest_alpha_budget";
  const QUEST_B = "quest_zulu_budget";

  function injectedPrepareQuest(_root: string, questId: string): PreparedQuest {
    return { ...preparePack(generateRpgPack(3)), questId };
  }

  const budgetedOpts = (
    seeds: number[],
    secondsBudget?: number,
    now?: () => number,
  ): CrawlRunOptions => ({
    root: process.cwd(),
    policy: "mixed",
    commit: "test",
    quests: "all",
    overworld: false,
    seeds,
    stepsPerSeed: 150,
    solverBudget: 0,
    persistEvery: 37,
    outDir: "ignored",
    workers: 1,
    prepareQuest: injectedPrepareQuest,
    ...(secondsBudget !== undefined ? { secondsBudget } : {}),
    ...(now !== undefined ? { now } : {}),
  });

  /** A deterministic clock: one scripted reading per `now()` call, holding the
   *  last value forever. Kills the old race where a real 50ms budget bet that
   *  the first crawl was slower than 50ms — true on a loaded machine, false on
   *  an idle one. */
  const scriptedClock = (ticks: number[]): (() => number) => {
    let call = 0;
    return () => ticks[Math.min(call++, ticks.length - 1)]!;
  };

  it("still reports a zero-coverage row for a quest the budget skipped", () => {
    // The scripted clock reads 0 at wallStart, 10 at quest A's pre-check (under
    // the 50ms deadline, so A runs), and 60 at quest B's pre-check (over it, so
    // B is skipped) — the truncation path is forced, not raced.
    const items: CrawlPlanItem[] = [
      { kind: "quest", questId: QUEST_A, seeds: [11], stepsPerSeed: 150 },
      { kind: "quest", questId: QUEST_B, seeds: [11], stepsPerSeed: 150 },
    ];
    const summary = runPlanInProcess(items, budgetedOpts([11], 0.05, scriptedClock([0, 10, 60])));

    expect(summary.truncated).toBe(true);
    expect(summary.skippedItems).toEqual([`quest:${QUEST_B}`]);

    const skipped = summary.questCoverage[QUEST_B];
    expect(skipped).toBeDefined();
    expect(skipped!.roomsVisited).toBe(0);
    expect(skipped!.actionsTried).toBe(0);
    expect(skipped!.actionIdsTried).toEqual([]);
    expect(skipped!.endingsReached).toEqual([]);
    // The static denominators are real, so the row reads as honest zero coverage
    // rather than an empty placeholder, and every room/ending is an orphan.
    expect(skipped!.roomsTotal).toBeGreaterThan(0);
    expect(skipped!.actionsTotal).toBeGreaterThan(0);
    expect(skipped!.orphans.rooms).toHaveLength(skipped!.roomsTotal);
    expect(skipped!.orphans.endings).toEqual(skipped!.endingsDeclared);

    // The quest that DID run is unaffected.
    expect(summary.questCoverage[QUEST_A]!.roomsVisited).toBeGreaterThan(0);
  });

  it("a skipped row merges away against a shard that finished the same quest", () => {
    const truncatedShard = runPlanInProcess(
      [
        { kind: "quest", questId: QUEST_A, seeds: [11], stepsPerSeed: 150 },
        { kind: "quest", questId: QUEST_B, seeds: [11], stepsPerSeed: 150 },
      ],
      budgetedOpts([11], 0.05, scriptedClock([0, 10, 60])),
    );
    const fullShard = runPlanInProcess(
      [{ kind: "quest", questId: QUEST_B, seeds: [12], stepsPerSeed: 150 }],
      budgetedOpts([12]),
    );

    const real = fullShard.questCoverage[QUEST_B]!;
    // The placeholder must actually be present for this merge to mean anything —
    // without it the truncated shard contributes no row at all and the assertions
    // below would hold vacuously.
    const placeholder = truncatedShard.questCoverage[QUEST_B];
    expect(placeholder).toBeDefined();
    expect(placeholder!.orphans.rooms).toHaveLength(real.roomsTotal);

    const merged = mergeSummaries([truncatedShard, fullShard]);
    const q = merged.questCoverage[QUEST_B]!;
    // Orphans merge by INTERSECTION, so "every room orphaned" never drags a real
    // shard's coverage down.
    expect(q.orphans.rooms).toEqual(real.orphans.rooms);
    expect(q.roomsVisited).toBe(real.roomsVisited);
    expect(q.actionIdsTried).toEqual(real.actionIdsTried);
    expect(q.endingsReached).toEqual(real.endingsReached);
  });
});

/**
 * `CrawlRunOptions.prepareQuest`'s doc comment used to assert that worker shards
 * "always fall back to the real prepareShippedQuest" because `workerData` is
 * structured-cloned and "functions cannot cross that boundary". Structured clone
 * does not drop a function, it THROWS — so a caller that set the seam and asked
 * for `--workers 2` got an opaque DataCloneError at Worker construction instead
 * of the documented fallback. `workerCloneableOptions` is what makes the written
 * contract true.
 */
describe("workerCloneableOptions", () => {
  const opts: CrawlRunOptions = {
    root: process.cwd(),
    policy: "mixed",
    commit: "test",
    quests: "all",
    overworld: false,
    seeds: [11],
    stepsPerSeed: 10,
    solverBudget: 0,
    persistEvery: 37,
    outDir: "ignored",
    workers: 2,
    prepareQuest: (_root, questId) => ({ ...preparePack(generateRpgPack(3)), questId }),
  };

  it("strips the in-process-only seam so the options survive a structured clone", () => {
    // The hazard itself: cloning the raw options is exactly what `new Worker(...)` does.
    expect(() => structuredClone(opts)).toThrow();

    const cloneable = workerCloneableOptions(opts);
    expect("prepareQuest" in cloneable).toBe(false);
    expect(structuredClone(cloneable)).toEqual(cloneable);
    // Everything else is carried through untouched — a worker still honours the
    // same policy/seeds/budget the parent parsed.
    const { prepareQuest: _seam, ...rest } = opts;
    expect(cloneable).toEqual(rest);
  });
});
