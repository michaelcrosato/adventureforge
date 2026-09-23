import { readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { filterTestFilesByLane, LANE_NAMES, type LaneName } from "./test-lanes.js";

/**
 * File-level body-time samples from successful GitHub Actions run 30295854622
 * (2026-07-27). The raw Vitest shard split put most of these census proofs in
 * one job. Keep only the material outliers here; ordinary and future files use
 * the measured residual-file baseline below and are still discovered at run
 * time.
 *
 * A sample is only an outlier for as long as the file it names still does the work
 * that was measured. This table is a frozen one-shot snapshot with nothing that
 * re-measures it, so an entry can outlive its file: the two ending-render proofs sat
 * here at ~272s and ~271s each long after 303dc6b6 (2026-08-01) rewrote both into
 * 28-line fast companion guards that now run in 1.2s of test body time TOGETHER. That
 * was 543s of phantom cost in a 6,823s table — 8% — inflating the reported per-shard
 * estimate from roughly 63 to 67.9 minutes, and the two entries only kept the split
 * balanced because they happened to land one per shard. They are re-pinned below at
 * the residual-file baseline: with the expensive traversal gone they are ordinary
 * files, and that baseline is this table's own CI-measured price for an ordinary file.
 * When rewriting a listed file, re-measure or re-baseline its entry in the same change —
 * the dangerous direction is the reverse of this one, since a file that grows expensive
 * carries no entry at all and is packed as if trivial.
 *
 * `npm run test:durations` + `npm run test:census` re-measure every file so an entry here
 * can be refreshed from data rather than from memory. The 2026-09-03 census found both failure directions
 * live at once: `mcp_tools.test.ts` costs 56s alone against the 3s default for unlisted
 * files, and five of the six census proofs are 0.55-0.72x their frozen price here.
 */
export const MEASURED_TEST_COST_MS: Readonly<Record<string, number>> = {
  "tests/regression/rpg_metamorphic_observation_stream.test.ts": 1_592_521,
  "tests/regression/rpg_action_id_unique.test.ts": 794_613,
  "tests/regression/rpg_variant_liveness.test.ts": 704_596,
  "tests/regression/rpg_score_economy_sound.test.ts": 684_074,
  "tests/regression/rpg_metamorphic_relabel.test.ts": 643_454,
  "tests/regression/rpg_all_endings_reachable.test.ts": 315_297,
  "tests/regression/no_dead_pocket.test.ts": 303_808,
  "tests/regression/overworld_cli.test.ts": 285_798,
  "tests/regression/mcp_pure_play_mode.test.ts": 167_316,
  "tests/acceptance/fleet_mock_pipeline.test.ts": 100_156,
  "tests/unit/crawl_quest_crawler.test.ts": 88_648,
  "tests/starting_slice/campus_archive_query_counterfactual.test.ts": 86_923,
  "tests/regression/crawl_workers_determinism.test.ts": 84_749,
  "tests/unit/rpg_generator.test.ts": 77_171,
  "tests/unit/crawl_overworld.test.ts": 70_351,
  "tests/regression/trace_cli_integrity.test.ts": 66_290,
  "tests/regression/rpg_generator_guaranteed_gauntlet.test.ts": 50_338,
  "tests/starting_slice/ally_commitment_counterfactual.test.ts": 49_844,
  "tests/acceptance/crawler_fault_injection.test.ts": 41_269,
  "tests/regression/overworld_snapshot_integrity.test.ts": 37_362,
  "tests/starting_slice/cade_return_packet_counterfactual.test.ts": 35_416,
  // Re-measured 2026-08-28, and no longer outliers: these two sat at 272_925 and
  // 270_542 from the 2026-07-27 run until 303dc6b6 (2026-08-01) rewrote both into
  // 28-line fast companion guards for the unified ending proof. They now run in 1.2s
  // of body time TOGETHER. They stay listed at the residual-file baseline rather than
  // being dropped, so the table keeps the record that they WERE outliers and are not
  // any more; the scheduling result is identical either way.
  "tests/regression/nondeath_endings_render_cleanly.test.ts": 3_000,
  "tests/regression/death_endings_render_cleanly.test.ts": 3_000,
};

// The same run's unlisted files averaged about 3s of test body time. This is
// deliberately nonzero so newly added files participate in balancing instead
// of being appended to an arbitrary shard.
export const DEFAULT_TEST_COST_MS = 3_000;

export interface TestGroup {
  estimatedMs: number;
  files: string[];
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

export function discoverTestFiles(root = process.cwd()): string[] {
  const testsRoot = resolve(root, "tests");
  const files: string[] = [];

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        files.push(normalizePath(absolute.slice(resolve(root).length + 1)));
      }
    }
  };

  visit(testsRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

export function testCostMs(file: string): number {
  return MEASURED_TEST_COST_MS[file] ?? DEFAULT_TEST_COST_MS;
}

/**
 * Longest-processing-time scheduling: deterministic, low-overhead, and it
 * places every discovered file in exactly one group. File-name tie breaks make
 * both the estimate and the command line stable across CI runners.
 */
export function assignTestGroups(files: readonly string[], groupCount: number): TestGroup[] {
  if (!Number.isInteger(groupCount) || groupCount < 1) {
    throw new Error(`Group count must be a positive integer, received ${groupCount}.`);
  }
  if (new Set(files).size !== files.length) {
    throw new Error("Test discovery produced duplicate file paths.");
  }

  const groups = Array.from(
    { length: groupCount },
    (): TestGroup => ({
      estimatedMs: 0,
      files: [],
    }),
  );
  const firstGroup = groups[0];
  if (firstGroup === undefined) {
    throw new Error("Test group allocation requires at least one group.");
  }
  const ordered = [...files].sort((left, right) => {
    const costDifference = testCostMs(right) - testCostMs(left);
    return costDifference !== 0 ? costDifference : left.localeCompare(right);
  });

  for (const file of ordered) {
    let target = firstGroup;
    for (const candidate of groups.slice(1)) {
      if (
        candidate.estimatedMs < target.estimatedMs ||
        (candidate.estimatedMs === target.estimatedMs &&
          candidate.files.length < target.files.length)
      ) {
        target = candidate;
      }
    }
    target.files.push(file);
    target.estimatedMs += testCostMs(file);
  }

  for (const group of groups) {
    group.files.sort((left, right) => left.localeCompare(right));
  }
  return groups;
}

const USAGE =
  "Usage: tsx scripts/ci-test-groups.ts --count <n> --group <1..count> [--lane fast|exhaustive]";

export function parseGroupArguments(args: readonly string[]): {
  count: number;
  group: number;
  lane: LaneName;
} {
  let count: number | undefined;
  let group: number | undefined;
  // Sharding one lane at a time is what keeps the split balanced. Allocating over ALL
  // files and then letting vitest skip the other lane's would leave the census proofs'
  // measured weight — the large majority of this table — sitting in whichever shard drew
  // it, so one job would be handed almost no real work and the other nearly all of it.
  let lane: LaneName = "fast";
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--count" && flag !== "--group" && flag !== "--lane") || value === undefined) {
      throw new Error(USAGE);
    }
    if (flag === "--lane") {
      if (!(LANE_NAMES as string[]).includes(value)) {
        throw new Error(
          `Expected one of ${LANE_NAMES.join(", ")} after --lane, received ${value}.`,
        );
      }
      lane = value as LaneName;
      continue;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      throw new Error(`Expected an integer after ${flag}, received ${value}.`);
    }
    if (flag === "--count") count = parsed;
    if (flag === "--group") group = parsed;
  }
  if (count === undefined || group === undefined || count < 1 || group < 1 || group > count) {
    throw new Error(USAGE);
  }
  return { count, group, lane };
}

function main(): void {
  const { count, group, lane } = parseGroupArguments(process.argv.slice(2));
  const groups = assignTestGroups(filterTestFilesByLane(discoverTestFiles(), lane), count);
  const selected = groups[group - 1];
  if (selected === undefined || selected.files.length === 0) {
    throw new Error(`Test group ${group}/${count} of the ${lane} lane has no files.`);
  }
  console.error(
    `CI ${lane}-lane test group ${group}/${count}: ${selected.files.length} files, estimated ${selected.estimatedMs}ms.`,
  );
  process.stdout.write(`${selected.files.join("\n")}\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
