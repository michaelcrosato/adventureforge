/**
 * Overworld coverage — the denominators/orphans the overworld crawler (Task 8)
 * reports alongside its findings, plus the markdown renderer `run.ts`'s
 * summary uses for the "## Overworld coverage" section.
 */
import type { OverworldManifest } from "../world/overworld.js";
import type { CrawlRunSummary } from "./run.js";

export type OverworldCoverageSummary = {
  nodes: { visited: number; total: number; orphans: string[] };
  edges: { traveled: number; total: number; orphans: string[] };
  boards: { read: number; total: number };
  quests: { entered: string[]; total: number };
};

type OverworldCoverageInput = {
  world: OverworldManifest;
  visitedNodeIds: ReadonlySet<string>;
  traveledEdgeIds: ReadonlySet<string>;
  /** Distinct `(home,area)` quest-anchor keys whose board was successfully read. */
  boardsRead: ReadonlySet<string>;
  /** Distinct `(home,area)` quest-anchor keys across the whole quest registry. */
  boardsTotal: ReadonlySet<string>;
  questsEntered: readonly string[];
};

/** Build the coverage summary from raw crawl bookkeeping (sets, not counts) so
 *  the orphan lists (and their ordering) come out of one place. */
export function buildOverworldCoverageSummary(
  input: OverworldCoverageInput,
): OverworldCoverageSummary {
  const nodeOrphans = input.world.nodes
    .map((node) => node.id)
    .filter((id) => !input.visitedNodeIds.has(id))
    .sort();
  const edgeOrphans = input.world.edges
    .map((edge) => edge.id)
    .filter((id) => !input.traveledEdgeIds.has(id))
    .sort();

  return {
    nodes: {
      visited: input.visitedNodeIds.size,
      total: input.world.nodes.length,
      orphans: nodeOrphans,
    },
    edges: {
      traveled: input.traveledEdgeIds.size,
      total: input.world.edges.length,
      orphans: edgeOrphans,
    },
    boards: {
      read: input.boardsRead.size,
      total: input.boardsTotal.size,
    },
    quests: {
      entered: [...input.questsEntered].sort(),
      total: input.world.quests.length,
    },
  };
}

/** The overworld-coverage block of the crawl run's markdown summary — empty
 *  string when the run carried no overworld item (skipped/not run). */
export function renderCoverageMarkdown(summary: CrawlRunSummary): string {
  if (!summary.overworld) return "";
  const ow = summary.overworld;
  const lines: string[] = [];
  lines.push("## Overworld coverage", "");
  lines.push(`- nodes: ${ow.nodes.visited}/${ow.nodes.total}`);
  lines.push(`- edges: ${ow.edges.traveled}/${ow.edges.total}`);
  lines.push(`- boards: ${ow.boards.read}/${ow.boards.total}`);
  lines.push(`- quests entered: ${ow.quests.entered.length}/${ow.quests.total}`);
  lines.push("");
  return lines.join("\n");
}
