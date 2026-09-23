/**
 * Seeded action-selection policies for the crawl/quest runner.
 * Each policy picks an action from the legal set deterministically based on
 * an injected Rng. Policies must call rng a bounded, stable number of times
 * per pick to ensure determinism under replay.
 */

import type { Rng } from "../core/rng.js";
import type { RpgActionOption } from "../rpg/legal_actions.js";

export const POLICY_NAMES = ["random", "coverage", "mixed"] as const;
export type PolicyName = (typeof POLICY_NAMES)[number];

type PolicyContext = {
  visitedRooms: ReadonlySet<string>; // room ids seen this episode's quest so far
  triedActionIds: ReadonlySet<string>; // RpgActionOption.id values ever executed for this quest
};

type Policy = {
  readonly name: PolicyName;
  pick(options: RpgActionOption[], ctx: PolicyContext): RpgActionOption;
};

/**
 * Internal helper for coverage-based selection logic.
 * Makes exactly 1 rng.int call per invocation, ensuring deterministic pick counts.
 */
function pickCoverage(options: RpgActionOption[], ctx: PolicyContext, rng: Rng): RpgActionOption {
  // Prefer untried MOVE options
  const untriedMoves = options.filter(
    (opt) => opt.action.type === "MOVE" && !ctx.triedActionIds.has(opt.id),
  );
  if (untriedMoves.length > 0) {
    return untriedMoves[rng.int(0, untriedMoves.length - 1)]!;
  }

  // Then any untried option
  const untried = options.filter((opt) => !ctx.triedActionIds.has(opt.id));
  if (untried.length > 0) {
    return untried[rng.int(0, untried.length - 1)]!;
  }

  // Else uniform over all
  return options[rng.int(0, options.length - 1)]!;
}

export function makePolicy(name: PolicyName, rng: Rng): Policy {
  if (name === "random") {
    return {
      name: "random",
      // 1 rng.int call per pick
      pick(options: RpgActionOption[], _ctx: PolicyContext): RpgActionOption {
        const idx = rng.int(0, options.length - 1);
        return options[idx]!;
      },
    };
  }

  if (name === "coverage") {
    return {
      name: "coverage",
      // 1 rng.int call per pick
      pick(options: RpgActionOption[], ctx: PolicyContext): RpgActionOption {
        return pickCoverage(options, ctx, rng);
      },
    };
  }

  if (name === "mixed") {
    return {
      name: "mixed",
      // 2 rng calls per pick: 1 rng.next() for mode choice, 1 rng.int for selection
      pick(options: RpgActionOption[], ctx: PolicyContext): RpgActionOption {
        const rand = rng.next();
        if (rand < 0.2) {
          // 20% random behavior
          const idx = rng.int(0, options.length - 1);
          return options[idx]!;
        } else {
          // 80% coverage behavior
          return pickCoverage(options, ctx, rng);
        }
      },
    };
  }

  throw new Error(`Unknown policy: ${name}`);
}
