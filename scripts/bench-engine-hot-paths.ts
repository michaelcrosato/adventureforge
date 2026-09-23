/**
 * Engine hot-path benchmark — a dev tool, not part of any bar.
 *
 *   npx tsx scripts/bench-engine-hot-paths.ts            # the default table
 *   npx tsx scripts/bench-engine-hot-paths.ts --runs 9   # more timed runs per row
 *   npx tsx scripts/bench-engine-hot-paths.ts --only search,stateKey
 *   npx tsx scripts/bench-engine-hot-paths.ts --census   # one search per shipped pack
 *   npx tsx scripts/bench-engine-hot-paths.ts --census --wolf  # ...including wolf_winter
 *
 * Measures the paths the census proofs and the solver spend their time in, on real
 * states reached by stepping the shipped packs (no synthetic fixtures): canonicalize /
 * hashState, the solver's `stateKey`, `enumerateRpgActions`, `buildRpgObservation`, and
 * whole `exhaustiveEndingsMulti` searches under the best/worst roll regimes the
 * ending-reachability proof uses. Each row gets warm-up runs, then reports the median and
 * minimum of the timed runs.
 *
 * Every row also prints a checksum of what it computed (computed once, outside the timed
 * loop). A performance change here must leave every checksum byte-identical — that is
 * the "same output" half of the claim; the medians are the "faster" half. Compare two
 * runs of this script, before and after, on the same machine and an otherwise idle box.
 *
 * `--census` instead runs each shipped pack's search once and prints its state count,
 * reached endings and wall time: the quick check that a solver change did not move any
 * pack's reachable region. wolf_winter (~315k states) is opt-in with `--wolf`.
 */
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { RpgAction } from "../src/api/types.js";
import type { Rules } from "../src/core/engine.js";
import { canonicalize, hashState } from "../src/core/hash.js";
import type { Rng } from "../src/core/rng.js";
import type { GameState } from "../src/core/state.js";
import { buildRpgObservation } from "../src/rpg/observation.js";
import {
  buildRpgRules,
  enumerateRpgActions,
  indexRpgPack,
  initStateForRpgPack,
  type RpgIndex,
} from "../src/rpg/runner.js";
import { loadRpgSourceFile } from "../src/rpg/source.js";
import { exhaustiveEndingsMulti, stateKey } from "../src/solve/exhaustive_endings.js";

const PACK_DIR = "content/rpg/quests";
const MAX_STATES = 400_000;
/** Small quests timed as whole searches next to tide_mill. */
const SMALL_SEARCH_PACKS = ["gallowmere", "printers_night", "falconers_ransom"];
/** Packs whose reachable states feed the per-state rows. */
const SAMPLE_PACKS = ["tide_mill", "wolf_winter"];
/** wolf_winter's full graph is ~315k states; its sample comes from a capped prefix. */
const WOLF_SAMPLE_CAP = 40_000;
const SAMPLE_PER_PACK = 300;

type Args = {
  runs: number;
  warmups: number;
  only: Set<string> | null;
  census: boolean;
  wolf: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { runs: 7, warmups: 2, only: null, census: false, wolf: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runs") args.runs = Math.max(1, Number(argv[++i]));
    else if (a === "--warmups") args.warmups = Math.max(0, Number(argv[++i]));
    else if (a === "--only") args.only = new Set(String(argv[++i]).split(","));
    else if (a === "--census") args.census = true;
    else if (a === "--wolf") args.wolf = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

// The ending-reachability proof's two legal roll regimes (best and worst for the player),
// so a timed search costs exactly what the census proof's search costs.
function fixedSeqRng(fracs: readonly number[]): Rng {
  let i = 0;
  const next = (): number => {
    const f = fracs[Math.min(i, fracs.length - 1)] ?? 0;
    i += 1;
    return f;
  };
  return {
    next,
    int(min: number, max: number): number {
      const lo = Math.ceil(min);
      const hi = Math.floor(max);
      return lo + Math.floor(next() * (hi - lo + 1));
    },
  };
}
const bestRng = (): Rng => fixedSeqRng([0.999999, 0]);
const worstRng = (): Rng => fixedSeqRng([0, 0.999999]);

type Pack = { id: string; index: RpgIndex; rules: Rules<RpgAction>[]; start: GameState };

function loadPack(id: string): Pack {
  const loaded = loadRpgSourceFile(join(PACK_DIR, `${id}.yaml`));
  if (!loaded.ok) throw new Error(`${id}: pack failed to compile`);
  const index = indexRpgPack(loaded.compiled.pack);
  return {
    id,
    index,
    rules: [buildRpgRules(index, bestRng), buildRpgRules(index, worstRng)],
    start: initStateForRpgPack(index, 7),
  };
}

function search(pack: Pack, cap = MAX_STATES, onState?: (s: GameState) => void) {
  return exhaustiveEndingsMulti(pack.rules, pack.start, cap, onState);
}

/** Every `step`-th element, so a sample spans the whole BFS (early, mid and late game). */
function spread<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  const step = items.length / count;
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)]!);
}

function digest(parts: Iterable<string>): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p).update("\u0000");
  return h.digest("hex").slice(0, 12);
}

type Row = { name: string; detail: string; median: number; min: number; checksum: string };

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** `--only` matches a row's full name or its first word ("search" selects every search). */
function selected(args: Args, name: string): boolean {
  return args.only === null || args.only.has(name) || args.only.has(name.split(" ")[0]!);
}

let sink = 0; // keeps timed results observable so no work is optimized away

function bench(
  args: Args,
  name: string,
  detail: string,
  work: () => number,
  checksum: () => string,
  warmups = args.warmups,
): Row | null {
  if (!selected(args, name)) return null;
  for (let i = 0; i < warmups; i++) sink += work();
  const samples: number[] = [];
  for (let i = 0; i < args.runs; i++) {
    const t0 = performance.now();
    sink += work();
    samples.push(performance.now() - t0);
  }
  const row = {
    name,
    detail,
    median: median(samples),
    min: Math.min(...samples),
    checksum: checksum(),
  };
  process.stderr.write(`  ${name}: ${row.median.toFixed(1)} ms\n`);
  return row;
}

function printTable(rows: readonly Row[], args: Args): void {
  const header = ["row", "workload", "median ms", "min ms", "checksum"];
  const body = rows.map((r) => [
    r.name,
    r.detail,
    r.median.toFixed(1),
    r.min.toFixed(1),
    r.checksum,
  ]);
  const widths = header.map((h, c) => Math.max(h.length, ...body.map((b) => b[c]!.length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, c) => (c >= 2 && c <= 3 ? cell.padStart(widths[c]!) : cell.padEnd(widths[c]!)))
      .join("  ");
  console.log(`node ${process.version}, ${args.runs} timed runs after ${args.warmups} warm-ups`);
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const b of body) console.log(line(b));
}

function runCensus(args: Args): void {
  const ids = readdirSync(PACK_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.slice(0, -".yaml".length))
    .sort()
    .filter((id) => args.wolf || id !== "wolf_winter");
  console.log("pack                states  capped  endings  ms");
  for (const id of ids) {
    const pack = loadPack(id);
    const t0 = performance.now();
    const r = search(pack);
    const ms = performance.now() - t0;
    const endings = [...r.reached].sort().join(",");
    console.log(
      `${id.padEnd(18)}  ${String(r.states).padStart(6)}  ${String(r.cappedOut).padEnd(6)}  ${digest([endings])}  ${ms.toFixed(0)}`,
    );
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.census) return runCensus(args);

  const rows: Row[] = [];
  const packs = new Map<string, Pack>();
  // Per-state rows first and in their own scope, so the ~70k collected states are garbage
  // before the search rows run instead of taxing those searches' GC.
  if (PER_STATE_ROWS.some((name) => selected(args, name))) rows.push(...perStateRows(args, packs));
  rows.push(...searchRows(args, packs));
  printTable(rows, args);
  if (sink === -1) console.log(""); // unreachable; reads the sink
}

const PER_STATE_ROWS = [
  "canonicalize state",
  "hashState state",
  "canonicalize action",
  "stateKey",
  "enumerateRpgActions",
  "buildRpgObservation",
];

function perStateRows(args: Args, packs: Map<string, Pack>): Row[] {
  process.stderr.write("collecting reachable states...\n");
  for (const id of SAMPLE_PACKS) packs.set(id, loadPack(id));
  const sampled: { pack: Pack; states: GameState[] }[] = [];
  const allTideStates: GameState[] = [];
  for (const pack of packs.values()) {
    const collected: GameState[] = [];
    search(pack, pack.id === "wolf_winter" ? WOLF_SAMPLE_CAP : MAX_STATES, (s) =>
      collected.push(s),
    );
    if (pack.id === "tide_mill") allTideStates.push(...collected);
    sampled.push({ pack, states: spread(collected, SAMPLE_PER_PACK) });
  }
  const sampleStates = sampled.flatMap((s) => s.states);
  const sampleActions = sampled.flatMap(({ pack, states }) =>
    states.flatMap((s) => pack.rules[0]!.legalActions(s)),
  );
  const perState = `${sampleStates.length} states`;
  const rows: (Row | null)[] = [];

  const HASH_REPS = 10;
  rows.push(
    bench(
      args,
      "canonicalize state",
      `${perState} x${HASH_REPS}`,
      () => {
        let n = 0;
        for (let r = 0; r < HASH_REPS; r++)
          for (const s of sampleStates) n += canonicalize(s).length;
        return n;
      },
      () => digest(sampleStates.map((s) => canonicalize(s))),
    ),
    bench(
      args,
      "hashState state",
      `${perState} x${HASH_REPS}`,
      () => {
        let n = 0;
        for (let r = 0; r < HASH_REPS; r++) for (const s of sampleStates) n += hashState(s).length;
        return n;
      },
      () => digest(sampleStates.map((s) => hashState(s))),
    ),
    bench(
      args,
      "canonicalize action",
      `${sampleActions.length} legal actions x${HASH_REPS}`,
      () => {
        let n = 0;
        for (let r = 0; r < HASH_REPS; r++)
          for (const a of sampleActions) n += canonicalize(a).length;
        return n;
      },
      () => digest(sampleActions.map((a) => canonicalize(a))),
    ),
    bench(
      args,
      "stateKey",
      `${allTideStates.length} tide_mill states`,
      () => {
        let n = 0;
        for (const s of allTideStates) n += stateKey(s).length;
        return n;
      },
      () => digest(allTideStates.map((s) => stateKey(s))),
    ),
    bench(
      args,
      "enumerateRpgActions",
      perState,
      () => {
        let n = 0;
        for (const { pack, states } of sampled)
          for (const s of states) n += enumerateRpgActions(pack.index, s).length;
        return n;
      },
      () =>
        digest(
          sampled.flatMap(({ pack, states }) =>
            states.map((s) => JSON.stringify(enumerateRpgActions(pack.index, s))),
          ),
        ),
    ),
    bench(
      args,
      "buildRpgObservation",
      perState,
      () => {
        let n = 0;
        for (const { pack, states } of sampled)
          for (const s of states) n += buildRpgObservation(pack.index, s).available_actions.length;
        return n;
      },
      () =>
        digest(
          sampled.flatMap(({ pack, states }) =>
            states.map((s) => JSON.stringify(buildRpgObservation(pack.index, s))),
          ),
        ),
    ),
  );
  return rows.filter((r): r is Row => r !== null);
}

function searchRows(args: Args, packs: Map<string, Pack>): Row[] {
  const rows: (Row | null)[] = [];
  for (const id of ["tide_mill", ...SMALL_SEARCH_PACKS]) {
    if (!selected(args, `search ${id}`)) continue;
    const pack = packs.get(id) ?? loadPack(id);
    let last = search(pack, MAX_STATES);
    rows.push(
      bench(
        args,
        `search ${id}`,
        `${last.states} states`,
        () => {
          last = search(pack, MAX_STATES);
          return last.states;
        },
        () => digest([String(last.states), String(last.cappedOut), ...[...last.reached].sort()]),
        // The untimed sizing search above already warmed this path; one more is plenty
        // and keeps the ~20 s tide_mill row from dominating the script's wall clock.
        Math.min(args.warmups, 1),
      ),
    );
  }
  return rows.filter((r): r is Row => r !== null);
}

main();
