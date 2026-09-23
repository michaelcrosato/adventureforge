import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const EvidencePathSchema = z.string().min(1);

const StartingSliceForkSchema = z
  .object({
    id: z.string().regex(/^SS-F\d{2}-[a-z0-9-]+$/),
    title: z.string().min(1),
    phase: z.enum(["albany_opening", "albany_preparation", "wolf_winter", "albany_return"]),
    implementation_status: z.enum(["planned", "partial", "implemented"]),
    proof_status: z.enum(["unproven", "partial", "proven"]),
    counts_toward_contract: z.boolean(),
    visible_choice: z.string().min(1),
    immediate_state_delta: z.array(z.string().min(1)).min(1),
    delayed_consumers: z.array(z.string().min(1)).min(1),
    visible_feedback: z.array(z.string().min(1)).min(2),
    systems: z.array(z.string().min(1)).min(1),
    persistence_boundaries: z.array(z.string().min(1)),
    contract_tags: z
      .array(
        z.enum([
          "delayed",
          "cross_system",
          "cross_phase",
          "character_concept",
          "irreversible_tradeoff",
          "ally_agency",
          "build_profile",
          "pressure",
          "npc_memory",
          "resolution_strategy",
          "failure_forward",
        ]),
      )
      .min(1),
    baseline_evidence: z.array(EvidencePathSchema),
    counterfactual_test: z.string().regex(/^tests\/.+\.test\.ts$/),
  })
  .strict()
  .superRefine((fork, context) => {
    if (fork.counts_toward_contract && fork.implementation_status !== "implemented") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["implementation_status"],
        message: "A counted fork must be implemented.",
      });
    }
    if (fork.counts_toward_contract && fork.proof_status !== "proven") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proof_status"],
        message: "A counted fork must have proven counterfactual evidence.",
      });
    }
    if (fork.contract_tags.includes("cross_system") && fork.systems.length < 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["systems"],
        message: "A cross-system fork must name at least two systems.",
      });
    }
    if (fork.contract_tags.includes("cross_phase") && fork.persistence_boundaries.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["persistence_boundaries"],
        message: "A cross-phase fork must name a persistence boundary.",
      });
    }
  });

const StartingSliceCausalMatrixSchema = z
  .object({
    schema_version: z.literal(1),
    slice_id: z.literal("albany_winter_relief_v1"),
    status: z.enum(["active_unproven", "certified"]),
    updated_local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    contract: z
      .object({
        minimum_material_forks: z.number().int().min(12),
        minimum_delayed: z.number().int().min(8),
        minimum_cross_system: z.number().int().min(5),
        minimum_cross_phase: z.number().int().min(3),
        maximum_typical_first_goal_decisions: z.number().int().max(45),
        count_rule: z.string().min(1),
      })
      .strict(),
    phases: z
      .array(z.enum(["albany_opening", "albany_preparation", "wolf_winter", "albany_return"]))
      .length(4),
    forks: z.array(StartingSliceForkSchema).min(12),
  })
  .strict()
  .superRefine((matrix, context) => {
    const ids = new Set<string>();
    for (const [index, fork] of matrix.forks.entries()) {
      if (ids.has(fork.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["forks", index, "id"],
          message: `Duplicate fork id ${fork.id}.`,
        });
      }
      ids.add(fork.id);
    }

    if (matrix.status !== "certified") return;
    const counted = matrix.forks.filter((fork) => fork.counts_toward_contract);
    const countTag = (tag: (typeof counted)[number]["contract_tags"][number]) =>
      counted.filter((fork) => fork.contract_tags.includes(tag)).length;
    const checks = [
      [counted.length, matrix.contract.minimum_material_forks, "material forks"],
      [countTag("delayed"), matrix.contract.minimum_delayed, "delayed forks"],
      [countTag("cross_system"), matrix.contract.minimum_cross_system, "cross-system forks"],
      [countTag("cross_phase"), matrix.contract.minimum_cross_phase, "cross-phase forks"],
    ] as const;
    for (const [actual, minimum, label] of checks) {
      if (actual < minimum) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["status"],
          message: `Certification requires ${minimum} ${label}; found ${actual}.`,
        });
      }
    }
  });

type StartingSliceCausalMatrix = z.infer<typeof StartingSliceCausalMatrixSchema>;

export function parseStartingSliceCausalMatrix(input: unknown): StartingSliceCausalMatrix {
  return StartingSliceCausalMatrixSchema.parse(input);
}

export function loadStartingSliceCausalMatrix(root = process.cwd()): StartingSliceCausalMatrix {
  const path = resolve(root, "docs", "starting_slice_causal_matrix.json");
  return parseStartingSliceCausalMatrix(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function assertProvenStartingSliceProofsExist(
  matrix: StartingSliceCausalMatrix,
  root = process.cwd(),
): void {
  for (const fork of matrix.forks) {
    if (fork.proof_status !== "proven") continue;
    if (!existsSync(resolve(root, fork.counterfactual_test))) {
      throw new Error(
        `Proven starting-slice fork ${fork.id} is missing ${fork.counterfactual_test}.`,
      );
    }
  }
}
