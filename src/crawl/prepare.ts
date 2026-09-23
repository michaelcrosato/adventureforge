/**
 * Prepared quests — turn a world-quest id or an in-memory `RpgPack` into the
 * indexed rules + content identity the quest crawler steps against.
 *
 * A shipped quest resolves through `RpgSourceRuntime` (the same source-resolution
 * machinery `bin/replay.ts` and the MCP server use), so a crawl sees byte-identical
 * content to real play. An in-memory pack (generated or test-mutated) skips source
 * resolution entirely and carries no `sourceRef` — there is no on-disk identity to
 * bind to.
 */
import type { RpgAction } from "../api/types.js";
import type { Rules } from "../core/engine.js";
import { hashState } from "../core/hash.js";
import { RpgSourceRuntime } from "../mcp/rpg_source_runtime.js";
import { buildRpgRules, indexRpgPack, type RpgIndex } from "../rpg/runner.js";
import type { RpgPack } from "../rpg/schema.js";

export type PreparedQuest = {
  /** world_quest_id for shipped quests, or pack.meta.id for in-memory packs. */
  questId: string;
  index: RpgIndex;
  rules: Rules<RpgAction>;
  contentHash: string;
  /** `["wq", questId]` for a shipped quest; `null` for an in-memory pack. */
  sourceRef: [string, string] | null;
};

type PrepareOptions = {
  /** Verification seam: wrap the compiled rules (e.g. to plant a resolver fault). */
  wrapRules?: (rules: Rules<RpgAction>) => Rules<RpgAction>;
};

function buildPrepared(
  questId: string,
  pack: RpgPack,
  contentHash: string,
  sourceRef: [string, string] | null,
  opts?: PrepareOptions,
): PreparedQuest {
  const index = indexRpgPack(pack);
  const baseRules = buildRpgRules(index);
  const rules = opts?.wrapRules ? opts.wrapRules(baseRules) : baseRules;
  return { questId, index, rules, contentHash, sourceRef };
}

/** Resolve + compile a shipped overworld quest by world_quest_id (mirrors bin/replay.ts). */
export function prepareShippedQuest(
  root: string,
  worldQuestId: string,
  opts?: PrepareOptions,
): PreparedQuest {
  const runtime = new RpgSourceRuntime(root);
  const { compiled } = runtime.requireWorldQuestPlayable(worldQuestId);
  return buildPrepared(
    worldQuestId,
    compiled.pack,
    compiled.contentHash,
    ["wq", worldQuestId],
    opts,
  );
}

/** Prepare an in-memory pack (generated or test-mutated) with no shipped source identity. */
export function preparePack(pack: RpgPack, opts?: PrepareOptions): PreparedQuest {
  return buildPrepared(pack.meta.id, pack, hashState(pack), null, opts);
}

/** Every shipped world-quest id, via the overworld quest registry (the single source of truth). */
export function listShippedQuestIds(root: string): string[] {
  return new RpgSourceRuntime(root).shippedWorldQuestIds();
}
