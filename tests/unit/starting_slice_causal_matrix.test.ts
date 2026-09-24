import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertProvenStartingSliceProofsExist,
  loadStartingSliceCausalMatrix,
  parseStartingSliceCausalMatrix,
} from "../regression/support/causal_matrix.js";
import { STARTING_SLICE_MAX_TYPICAL_FIRST_GOAL_DECISIONS } from "../../src/starting_slice/fleet_certifier.js";

describe("starting-slice causal matrix", () => {
  it("is machine-readable, uniquely keyed, and counts only proven opening forks", () => {
    const matrix = loadStartingSliceCausalMatrix();

    expect(matrix.status).toBe("active_unproven");
    expect(matrix.forks).toHaveLength(19);
    expect(new Set(matrix.forks.map((fork) => fork.id)).size).toBe(19);
    expect(matrix.forks.at(-1)).toMatchObject({
      id: "SS-F19-witnessed-wound-care",
      implementation_status: "implemented",
      proof_status: "proven",
      counts_toward_contract: false,
    });
    expect(
      matrix.forks.filter((fork) => fork.counts_toward_contract).map((fork) => fork.id),
    ).toEqual([
      "SS-F01-character-background",
      "SS-F02-relief-oath",
      "SS-F03-lead-source",
      "SS-F04-ally-commitment",
      "SS-F05-preparation-profile",
      "SS-F06-relief-allocation",
      "SS-F07-hill-route",
      "SS-F08-cade-trust",
      "SS-F09-wolf-strategy",
      "SS-F10-crisis-priority",
      "SS-F11-saved-wood",
      "SS-F12-albany-return",
    ]);
    const albanyReturn = matrix.forks.find((fork) => fork.id === "SS-F12-albany-return");
    expect(albanyReturn).toMatchObject({
      implementation_status: "implemented",
      proof_status: "proven",
      counts_toward_contract: true,
    });
    expect(albanyReturn?.delayed_consumers.join(" ")).toMatch(
      /wagon to Cade suppresses.*paling and evacuation-line.*wardens north preserves.*lower-pasture search.*either dawn dispatch/i,
    );
    expect(albanyReturn?.visible_feedback.join(" ")).toMatch(
      /full, compact, UI, MCP, and opportunity surfaces.*omit Cade's structural packet.*retain that work.*lower-pasture search/i,
    );
    expect(albanyReturn?.systems).toContain("jobs");
    expect(albanyReturn?.baseline_evidence).toContain(
      "tests/regression/wolf_winter_post_hunt_consequence.test.ts",
    );
    expect(() => assertProvenStartingSliceProofsExist(matrix)).not.toThrow();
    // Baseline evidence is a claim that a file exercises the fork, so a deleted test must
    // leave the matrix with it rather than linger as a citation nothing can open.
    const missingEvidence = matrix.forks.flatMap((fork) =>
      fork.baseline_evidence.filter((path) => !existsSync(path)).map((path) => `${fork.id}: ${path}`),
    );
    expect(missingEvidence).toEqual([]);
  });

  it("loads causal matrix from custom root directory and handles errors", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ss-causal-matrix-test-"));
    try {
      // Missing file
      expect(() => loadStartingSliceCausalMatrix(tempDir)).toThrow();

      // Custom valid matrix
      const matrix = loadStartingSliceCausalMatrix(process.cwd());
      const targetDir = join(tempDir, "docs");
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, "starting_slice_causal_matrix.json"), JSON.stringify(matrix));

      const loadedCustom = loadStartingSliceCausalMatrix(tempDir);
      expect(loadedCustom.slice_id).toBe("albany_winter_relief_v1");

      // Invalid JSON file
      writeFileSync(join(targetDir, "starting_slice_causal_matrix.json"), "invalid json");
      expect(() => loadStartingSliceCausalMatrix(tempDir)).toThrow(SyntaxError);

      // Schema mismatch JSON file
      writeFileSync(
        join(targetDir, "starting_slice_causal_matrix.json"),
        JSON.stringify({ schema_version: 999 }),
      );
      expect(() => loadStartingSliceCausalMatrix(tempDir)).toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("requires proof files for proven forks without imposing that requirement on partial proof", () => {
    const matrix = loadStartingSliceCausalMatrix();
    const missingPath = "tests/starting_slice/definitely_missing_ss_f19_counterfactual.test.ts";
    const hostile = structuredClone(matrix);
    const hostileFork = hostile.forks.find((fork) => fork.id === "SS-F19-witnessed-wound-care");
    if (!hostileFork) throw new Error("expected the uncounted proven SS-F19 fork");
    hostileFork.counterfactual_test = missingPath;

    expect(() => assertProvenStartingSliceProofsExist(hostile)).toThrowError(
      new Error(
        `Proven starting-slice fork SS-F19-witnessed-wound-care is missing ${missingPath}.`,
      ),
    );

    const partialControl = structuredClone(hostile);
    const partialFork = partialControl.forks.find(
      (fork) => fork.id === "SS-F19-witnessed-wound-care",
    );
    if (!partialFork) throw new Error("expected the uncounted SS-F19 control fork");
    partialFork.proof_status = "partial";
    expect(() => assertProvenStartingSliceProofsExist(partialControl)).not.toThrow();
  });

  it("rejects duplicate ids and forks counted without implementation and proof", () => {
    const matrix = loadStartingSliceCausalMatrix();
    const duplicate = structuredClone(matrix) as unknown as Record<string, unknown>;
    const duplicateForks = duplicate.forks as Record<string, unknown>[];
    duplicateForks[1]!.id = duplicateForks[0]!.id;
    expect(() => parseStartingSliceCausalMatrix(duplicate)).toThrow(/Duplicate fork id/);

    const falselyCounted = structuredClone(matrix) as unknown as Record<string, unknown>;
    const falselyCountedForks = falselyCounted.forks as Record<string, unknown>[];
    const plannedFork = falselyCountedForks.find((fork) => fork.counts_toward_contract === true);
    if (!plannedFork) throw new Error("expected a counted starting-slice fork");
    plannedFork.implementation_status = "planned";
    expect(() => parseStartingSliceCausalMatrix(falselyCounted)).toThrow(
      /counted fork must be implemented/i,
    );
  });

  it("refuses structural certification while any required fork remains uncounted", () => {
    const matrix = loadStartingSliceCausalMatrix();
    const premature = structuredClone(matrix);
    premature.status = "certified";
    premature.forks[1]!.counts_toward_contract = false;
    expect(() => parseStartingSliceCausalMatrix(premature)).toThrow(
      /Certification requires 12 material forks/,
    );
  });

  it("declares the same decision budget the fleet certifier gates on", () => {
    // The slice contract lives here; the gate that enforces it lives in
    // fleet_certifier.ts. They were two unlinked copies of one number — tightening the
    // matrix's budget would have left the certifier passing runs at the old, looser
    // bar with nothing to say so. Neither file is the source of truth for the other,
    // so this pin is what makes a change to either a deliberate change to both
    // (including the gate KEY, `completion_p50_at_most_45_decisions`, which spells the
    // number out in the published certification JSON).
    const matrix = loadStartingSliceCausalMatrix();
    expect(matrix.contract.maximum_typical_first_goal_decisions).toBe(
      STARTING_SLICE_MAX_TYPICAL_FIRST_GOAL_DECISIONS,
    );
  });
});
