/**
 * Shared dialogue session helpers.
 *
 * Parser and RPG dialogue both store the active node as a 1-based ordinal in
 * GameState.vars. Keeping that state convention here prevents each runtime from
 * re-owning the same hidden loop bookkeeping.
 */
type DialogueNodeLike = { id: string };

type DialogueNpcLike = {
  id: string;
  dialogue: {
    nodes: readonly DialogueNodeLike[];
  };
};

export const DIALOGUE_VAR_PREFIX = "__dlg_";

export function dlgVar(npcId: string): string {
  return `${DIALOGUE_VAR_PREFIX}${npcId}`;
}

export function nodeOrdinal<Npc extends DialogueNpcLike>(npc: Npc, nodeId: string): number {
  const index = npc.dialogue.nodes.findIndex((node) => node.id === nodeId);
  return index < 0 ? 0 : index + 1;
}

export function nodeByOrdinal<Npc extends DialogueNpcLike>(
  npc: Npc,
  ordinal: number,
): Npc["dialogue"]["nodes"][number] | undefined {
  return npc.dialogue.nodes[ordinal - 1];
}
