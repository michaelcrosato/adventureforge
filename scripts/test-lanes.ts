import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVitestSuiteProjects, type VitestSuiteProject } from "./verify-integrity.js";

/**
 * Two vitest lanes over ONE unchanged project set.
 *
 * `vitest.config.ts` still claims every discovered test file — `detectSuiteCoverage`
 * in the verifier proves that, and nothing here may weaken it. What splits is only
 * WHICH named projects a given npm script hands to vitest:
 *
 *   - FAST (`test:fast`) — every ordinary unit/property/regression/acceptance file.
 *     This is the active-development bucket and the pre-commit lane; `health:fast` is
 *     the bar built on it, and it must stay well under five minutes of wall clock.
 *   - EXHAUSTIVE (`test:exhaustive`) — the whole-state-space census proofs, the bucket
 *     to run while taking a break from coding. Each one BFSes the complete reachable
 *     region of every shipped pack, so they are minutes apiece and run one or two
 *     workers wide by design (see the per-project comments in vitest.config.ts). They
 *     run nightly in `deep-audit.yml`.
 *
 * The split is only defensible while it is EXHAUSTIVE, and the dangerous failure is
 * silent: add a sixth project to vitest.config.ts, forget to name it in either script,
 * and it runs in NO lane while both lanes still exit 0 — the same shape of silent skip
 * the suite-coverage guard exists to catch, one level up. `detectLanePartition` is that
 * guard for the lanes, and `tests/unit/test_lanes.test.ts` runs it against the real
 * package.json and vitest.config.ts on every suite run. It reads the ACTUAL script
 * bodies rather than a parallel list, so a lane list and the command that runs cannot
 * drift apart.
 */
export const LANE_SCRIPTS = {
  fast: "test:fast",
  exhaustive: "test:exhaustive",
} as const;

export type LaneName = keyof typeof LANE_SCRIPTS;

export const LANE_NAMES = Object.keys(LANE_SCRIPTS) as LaneName[];

/**
 * The exhaustive census proofs, as `tests/`-relative paths.
 *
 * This list is DUPLICATED from vitest.config.ts on purpose, and the duplication is
 * load-bearing rather than sloppy. The verifier's suite-coverage guard parses that
 * config as TEXT with a deliberately restricted parser that resolves only `const`
 * bindings declared IN THAT FILE; an identifier imported from here would resolve to
 * null, and the guard fails CLOSED on a config it cannot read. So the config must keep
 * its own literal arrays, and this copy earns its keep by being CHECKED against them:
 * `tests/unit/test_lanes.test.ts` asserts this list equals the union of the exhaustive
 * lane projects' include lists, so the two cannot drift.
 *
 * `scripts/ci-test-groups.ts` uses it to shard one lane at a time. That allocator stays
 * a plain readdir walk independent of the vitest config — that independence is what lets
 * the verifier treat it as a second opinion — so it needs this list, not the config.
 */
export const EXHAUSTIVE_PROOF_FILES: readonly string[] = [
  "tests/regression/no_dead_pocket.test.ts",
  "tests/regression/rpg_action_id_unique.test.ts",
  "tests/regression/rpg_all_endings_reachable.test.ts",
  "tests/regression/rpg_metamorphic_observation_stream.test.ts",
  "tests/regression/rpg_metamorphic_relabel.test.ts",
  "tests/regression/rpg_score_economy_sound.test.ts",
  "tests/regression/rpg_variant_liveness.test.ts",
];

/**
 * Every scope the census proofs can reach, TRANSITIVELY.
 *
 * This list is the whole basis for the fast lane being allowed to skip those proofs: a
 * change confined outside these scopes cannot move a census verdict. Turn it around and it
 * is the rule `ship` enforces — a change that DOES land in one has to run the full bar.
 *
 * It must be the transitive closure, not the proofs' direct imports. The first version of
 * this list was written from direct imports alone and missed four scopes reached one hop
 * further out: `tests/regression/support/exhaustive_endings.ts` is a one-line re-export of
 * `src/solve/exhaustive_endings.ts`, the solver every one of these proofs runs on, and
 * editing it would have chosen the fast lane — the lane that does not run them.
 * `tests/unit/ship.test.ts` now walks the real closure (89 files today) and fails on any
 * file it finds outside this list, so the list cannot fall behind the imports again.
 */
export const CENSUS_PROOF_SOURCE_SCOPES: readonly string[] = [
  "content/",
  "src/api/",
  "src/core/",
  "src/gen/",
  "src/persist/",
  "src/rpg/",
  "src/solve/",
  "src/trace/",
  "src/validate/",
  "src/world/",
  "tests/regression/support/",
  "vitest.config.ts",
];

/**
 * True when a changed path is something the census proofs read — including a proof file
 * itself. Editing a proof and then running only the lane that excludes it is the most
 * direct way to land an unexercised change, and the scope list alone does not catch it:
 * the proofs live in `tests/regression/`, not in `tests/regression/support/`.
 */
export function touchesCensusProofScope(file: string): boolean {
  const normalized = file.split("\\").join("/");
  if (EXHAUSTIVE_PROOF_FILES.includes(normalized)) return true;
  return CENSUS_PROOF_SOURCE_SCOPES.some((scope) =>
    scope.endsWith("/") ? normalized.startsWith(scope) : normalized === scope,
  );
}

/**
 * Which bar a changeset has to clear. `full` whenever ANY changed path is in census reach —
 * the safe direction, since being wrong the other way lands a regression on main that only
 * a nightly proof would catch.
 */
export function barForChangedFiles(files: readonly string[]): "fast" | "full" {
  return files.some((file) => touchesCensusProofScope(file)) ? "full" : "fast";
}

export function laneForTestFile(file: string): LaneName {
  return EXHAUSTIVE_PROOF_FILES.includes(file) ? "exhaustive" : "fast";
}

/** Every discovered file belongs to exactly one lane, so the two filters partition the
 *  suite: nothing is dropped by sharding a lane, and nothing is paid for twice. */
export function filterTestFilesByLane(files: readonly string[], lane: LaneName): string[] {
  return files.filter((file) => laneForTestFile(file) === lane);
}

/** Every `--project <name>` (and `--project=<name>`) a script body hands to vitest. */
export function parseLaneProjects(scriptBody: string): string[] {
  const projects: string[] = [];
  const tokens = scriptBody.split(/\s+/).filter((token) => token !== "");
  for (const [index, token] of tokens.entries()) {
    if (token.startsWith("--project=")) {
      projects.push(token.slice("--project=".length));
      continue;
    }
    if (token === "--project") {
      const value = tokens[index + 1];
      if (value !== undefined && !value.startsWith("-")) projects.push(value);
    }
  }
  return projects;
}

export function readPackageScripts(root = process.cwd()): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed))
    throw new Error("package.json has no scripts block.");
  const scripts = (parsed as { scripts: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null)
    throw new Error("package.json scripts block is not an object.");
  return scripts as Record<string, string>;
}

export function readLaneProjects(root = process.cwd()): Record<LaneName, string[]> {
  const scripts = readPackageScripts(root);
  const lanes = {} as Record<LaneName, string[]>;
  for (const lane of LANE_NAMES) {
    const body = scripts[LANE_SCRIPTS[lane]];
    if (body === undefined)
      throw new Error(`package.json is missing the ${LANE_SCRIPTS[lane]} script.`);
    lanes[lane] = parseLaneProjects(body);
  }
  return lanes;
}

export function readVitestProjects(root = process.cwd()): VitestSuiteProject[] {
  const projects = parseVitestSuiteProjects(
    readFileSync(resolve(root, "vitest.config.ts"), "utf8"),
  );
  if (projects === null) throw new Error("Could not read the vitest project list.");
  return projects;
}

export function readVitestProjectNames(root = process.cwd()): string[] {
  return readVitestProjects(root).map((project) => project.name);
}

/**
 * The lanes must PARTITION the config's projects: together they run every project, and
 * no project runs in both (which would pay for the same minutes twice). Returns one
 * human-readable problem per violation, empty when the partition holds.
 */
export function detectLanePartition(
  laneProjects: Readonly<Record<LaneName, string[]>>,
  configProjectNames: readonly string[],
): string[] {
  const problems: string[] = [];
  const seen = new Map<string, LaneName[]>();

  for (const lane of LANE_NAMES) {
    const projects = laneProjects[lane];
    if (projects.length === 0) problems.push(`lane ${lane} selects no vitest project at all`);
    for (const project of projects) {
      if (!configProjectNames.includes(project))
        problems.push(
          `lane ${lane} selects project "${project}", which vitest.config.ts does not define — vitest runs nothing for an unknown project name`,
        );
      seen.set(project, [...(seen.get(project) ?? []), lane]);
    }
  }

  for (const project of configProjectNames) {
    const lanes = seen.get(project) ?? [];
    if (lanes.length === 0)
      problems.push(
        `vitest project "${project}" runs in NO lane — it would never execute while both lanes still exit 0; add it to test:fast or test:exhaustive`,
      );
    if (lanes.length > 1)
      problems.push(`vitest project "${project}" runs in more than one lane (${lanes.join(", ")})`);
  }

  return problems;
}

function main(): void {
  const problems = detectLanePartition(readLaneProjects(), readVitestProjectNames());
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  [ERROR] ${problem}`);
    process.exit(1);
  }
  const lanes = readLaneProjects();
  for (const lane of LANE_NAMES) console.log(`${lane}: ${lanes[lane].join(", ")}`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
