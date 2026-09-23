import { generateRpgPack } from "../gen/rpg_generator.js";
import type { ValidationReport } from "../validate/report.js";
import { validateRpg } from "../validate/rpg_validator.js";
import { completedCycleCount, totalCycleCount } from "./loop_state.js";
import { score, type ImprovementCandidate } from "./assessment_model.js";

/**
 * How many completed improvement cycles AI_LOOP_STATE.md records. Cycles are either
 * legacy "### Cycle result" entries or current "## AFK Cycle" scaffolds completed in
 * place; older token-heavy entries may be folded into the tiny historical_cycle_count
 * marker. This stays a PURE function of repo state while letting the live loop memory
 * remain small.
 */
export function generatedEvalSeedBase(loopStateText: string): number {
  return completedCycleCount(loopStateText);
}

/**
 * Disk wrapper: total completed cycles across the live log + the rotated archive
 * ({@link totalCycleCount}), so the generator seed window stays monotonic even after
 * AI_LOOP_STATE.md is trimmed by the rotation. {@link generatedEvalSeedBase} remains the
 * pure, single-file counter the unit tests pin.
 */
export function generatedEvalSeedBaseFromDisk(root: string): number {
  return totalCycleCount(root);
}

/**
 * How many fresh generated packs the assessor mints-and-checks each cycle. A small WINDOW
 * (not one pack) so a single cycle confronts several themes/structures; combined with the
 * advancing {@link generatedEvalSeedBase}, successive cycles sweep disjoint windows of the
 * seed space, exercising the verifier across an ever-widening, never-frozen slice.
 */
export const GEN_EVAL_CHECK_COUNT = 4;

/** One minted-and-validated generated pack: the deterministic seed and production report. */
export type GeneratedPackCheck = { seed: number; report: ValidationReport };

export function allGeneratedChecksClean(checks: GeneratedPackCheck[]): boolean {
  return checks.every((c) => c.report.findings.length === 0);
}

export function rpgGeneratorChecksForRoot(root: string): GeneratedPackCheck[] {
  const genBase = generatedEvalSeedBaseFromDisk(root) * GEN_EVAL_CHECK_COUNT;
  return Array.from({ length: GEN_EVAL_CHECK_COUNT }, (_, i) => {
    const seed = genBase + i;
    const pack = generateRpgPack(seed);
    return { seed, report: validateRpg(pack) };
  });
}

/**
 * The RPG generator mint-and-check verdict. Given this cycle's freshly minted-and-validated
 * generated RPG packs, return an improvement candidate IFF the production `validateRpg` did NOT
 * hold on one of them — i.e. a minted pack carries ANY finding (error OR warning), the same
 * zero-findings bar the curated RPG packs and the generator's own test (rpg_generator.test.ts)
 * clear, which INCLUDES the RPG-only COMBAT_UNWINNABLE / SCORE_UNREACHABLE /
 * SKILL_CHECK_IMPOSSIBLE checks. A clean sweep returns null (the verifier held on this cycle's
 * RPG moving target — the healthy state, so the lever does NOT mask the saturation floor).
 * When it fires it is a genuine, fixable problem — the RPG generator emitted an
 * unclean/unwinnable/score-unreachable shape, OR the fresh distribution surfaced a verifier gap
 * — scored high so the loop closes the divergence rather than re-polishing clean prose. Pure
 * (validated checks in, candidate out) so the negative path unit-tests against the REAL
 * validateRpg with no disk and no clock.
 */
export function generatorRpgDriftCandidate(
  checks: GeneratedPackCheck[],
): ImprovementCandidate | null {
  const bad = checks.filter((c) => c.report.findings.length > 0);
  if (bad.length === 0) return null;
  return {
    id: "generator-rpg-drift",
    category: "engine",
    target: "src/gen/rpg_generator.ts",
    title: `The RPG pack generator minted ${bad.length} pack(s) the verifier rejects — the evolving RPG eval distribution has drifted from the shipped bar`,
    rationale:
      "Evolving the RPG eval distribution only works if every minted pack clears the SAME zero-findings bar the curated RPG packs do — which for RPG includes COMBAT winnability and SCORE-economy soundness. A generated RPG pack the production validateRpg flags is a real defect: either the generator emits an unclean/unwinnable/score-unreachable shape, or the fresh distribution has surfaced a verifier gap. Fixing it keeps the RPG generator a trustworthy moving target instead of a source of false signal.",
    evidence: bad.map(
      (c) =>
        `seed ${c.seed}: ${c.report.findings.map((f) => `${f.severity}:${f.code}`).join(", ")}`,
    ),
    impact: 5,
    effort: "M",
    score: score(5, "M", "engine"),
  };
}
