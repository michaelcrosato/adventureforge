/** Stable public action id for one authored enemy maneuver. */
export function maneuverActionId(enemyId: string, maneuverId: string): string {
  // Keep the established public spelling for compatibility. The RPG validator
  // rejects the rare ambiguous enemy/maneuver id pair instead of changing ids
  // already consumed by MCP, UI, traces, and scripted play.
  return `maneuver_${enemyId}_${maneuverId}`;
}

type UseActionIdentity = {
  id: string;
  /** Accepted only as an input compatibility spelling; never a listed menu id. */
  inputAliases?: readonly string[];
};

/**
 * Stable public identity for authored USE actions.
 *
 * Most USE identities remain the long-established verb-agnostic target shape. When
 * every authored target-only interaction on an overloaded target has its own natural
 * verb, that verb is a structurally stable stage identity. Deriving the id preserves
 * identifier-relabeling invariance without changing source content hashes, saves, or
 * structured traces.
 */
export function authoredUseActionIdentity(args: {
  item?: string;
  target: string;
  commandVerb?: string;
  legacyId: string;
  verbIdentifiedTarget: boolean;
}): UseActionIdentity {
  if (args.item !== undefined || args.commandVerb === undefined || !args.verbIdentifiedTarget) {
    return { id: args.legacyId };
  }
  return {
    id: `${args.commandVerb}_${args.target}`,
    inputAliases: [args.legacyId],
  };
}
