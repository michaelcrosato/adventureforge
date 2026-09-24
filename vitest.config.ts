import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

const STANDARD_TESTS = "tests/**/*.test.ts";
const METAMORPHIC_OBSERVATION_PROOF = "tests/regression/rpg_metamorphic_observation_stream.test.ts";
const ENDING_RENDER_PROOF = "tests/regression/rpg_all_endings_reachable.test.ts";
const VARIANT_LIVENESS_PROOF = "tests/regression/rpg_variant_liveness.test.ts";
const EXHAUSTIVE_RPG_PROOFS = [
  "tests/regression/rpg_action_id_unique.test.ts",
  "tests/regression/rpg_score_economy_sound.test.ts",
  "tests/regression/rpg_metamorphic_relabel.test.ts",
  // The dynamic soft-lock census: every progress-reachable state of every shipped pack
  // must still reach an ending. Same whole-state-space BFS shape as the proofs above, and
  // at ~79s it was the single longest file in the standard project, so it sets the
  // active-development lane's wall clock by itself.
  "tests/regression/no_dead_pocket.test.ts",
];
const ALL_EXHAUSTIVE_RPG_PROOFS = [
  METAMORPHIC_OBSERVATION_PROOF,
  ENDING_RENDER_PROOF,
  VARIANT_LIVENESS_PROOF,
  ...EXHAUSTIVE_RPG_PROOFS,
];
// Deliberately 2 under CI, not 4. Raising it to 4 cut a shard from 1,562s to 959s (-38%)
// and turned two subprocess-spawning tests red on the same run — crawl_workers_determinism
// blew its 60s ceiling and rpg_validation_bar's `npm run validate` returned ETIMEDOUT with
// a null status. Both spawn child processes and are starved by the extra concurrency, which
// is the load artifact AGENTS.md's "budget the wall clock" note describes. The reachable
// win is real but belongs to a change that first gives those tests headroom; buying 10
// minutes with a flaky bar is a bad trade, and a flaky bar is the one thing that stops
// people running it.
const standardWorkerCap =
  process.env.CI === "true"
    ? Math.min(2, availableParallelism())
    : Math.min(8, availableParallelism());
const exhaustiveWorkerCap = Math.min(2, availableParallelism());
const commonProject = {
  environment: "node" as const,
  // Determinism: tests must not depend on wall-clock ordering or shared state.
  isolate: true,
  // The exhaustive ground-truth regression proofs BFS the full reachable state space of
  // the largest packs. Their state caps, rather than the clock, bound proof completeness;
  // this shared default retains fail-fast headroom for the rest of the suite.
  testTimeout: 60_000,
};

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text-summary", "json-summary", "html"],
      include: ["src/**/*.ts", "bin/**/*.ts", "scripts/**/*.ts", "agents/**/*.ts"],
      exclude: ["**/*.d.ts"],
    },
    projects: [
      {
        test: {
          ...commonProject,
          name: "standard",
          include: [STANDARD_TESTS],
          exclude: ALL_EXHAUSTIVE_RPG_PROOFS,
          maxWorkers: standardWorkerCap,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          ...commonProject,
          name: "exhaustive-rpg",
          include: EXHAUSTIVE_RPG_PROOFS,
          maxWorkers: exhaustiveWorkerCap,
          // Keep the exact proofs and caps, but do not launch all six memory-heavy BFS
          // files together. Under an eight-worker pool each became 44-70% slower and five
          // crossed their established fail-fast limits.
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          ...commonProject,
          name: "variant-liveness-proof",
          include: [VARIANT_LIVENESS_PROOF],
          maxWorkers: 1,
          // Wolf-Winter now consumes roughly 12 minutes of this proof's per-pack
          // timeout. Keep its exact 800k-state search and best/worst bracket, but do not
          // make it compete with another memory-heavy exhaustive proof.
          sequence: { groupOrder: 2 },
        },
      },
      {
        test: {
          ...commonProject,
          name: "ending-render-proof",
          include: [ENDING_RENDER_PROOF],
          maxWorkers: 1,
          // This unified proof consumes each terminal witness while traversing Wolf's full
          // graph. Its measured solo headroom is intentional; do not erase it with a peer.
          sequence: { groupOrder: 3 },
        },
      },
      {
        test: {
          ...commonProject,
          name: "metamorphic-observation",
          include: [METAMORPHIC_OBSERVATION_PROOF],
          maxWorkers: 1,
          // This proof renders and compares both a pack and its relabeled twin over the
          // full graph. Isolate it from the other exhaustive workers instead of weakening
          // its state cap or inflating its 25-minute per-test timeout.
          sequence: { groupOrder: 4 },
        },
      },
    ],
  },
});
