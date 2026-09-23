import { generatedRpgSeedValidationMessage, isGeneratedRpgSeed } from "../gen/seed.js";

/** Compact canonical source identity shared by saves, traces, and source resolution. */
export type CompactSourceRef = ["wq", string] | ["gen", number];

type CompactSourceMetadata = {
  worldQuestId?: unknown;
  generatedRpgSeed?: unknown;
};

type CompactSourceMetadataLabels = {
  source: string;
  worldQuestId: string;
  generatedRpgSeed: string;
};

type CompactSourceRefResult =
  | { ok: true; sourceRef: CompactSourceRef }
  | { ok: false; error: string };

type CompactSourceLegacyMetadata = {
  worldQuestId?: string;
  generatedRpgSeed?: number;
};

type CompactSourceRefConsistencyMessages = {
  sourceConflict: string;
  worldQuestMismatch: (sourceRefWorldQuestId: string, worldQuestId: string) => string;
  generatedSeedMismatch: (sourceRefGeneratedSeed: number, generatedRpgSeed: number) => string;
  sourceRefConflictsWithGeneratedRpgSeed: string;
  sourceRefConflictsWithWorldQuestId: string;
};

type CompactSourceRefConsistencyResult =
  | { ok: true; metadata: CompactSourceLegacyMetadata }
  | { ok: false; error: string };

export function compactSourceRefFromMetadata(
  metadata: CompactSourceMetadata,
  labels: CompactSourceMetadataLabels,
): CompactSourceRefResult {
  const worldQuestId = metadata.worldQuestId ?? undefined;
  const generatedRpgSeed = metadata.generatedRpgSeed ?? undefined;
  const hasWorldQuest = worldQuestId !== undefined;
  const hasGeneratedSeed = generatedRpgSeed !== undefined;
  if (hasWorldQuest && hasGeneratedSeed) {
    return {
      ok: false,
      error: `${labels.source} cannot carry both worldQuestId and generatedRpgSeed.`,
    };
  }
  if (hasWorldQuest) {
    if (typeof worldQuestId !== "string") {
      return {
        ok: false,
        error: `${labels.worldQuestId} must be a string, got ${JSON.stringify(worldQuestId)}.`,
      };
    }
    return { ok: true, sourceRef: ["wq", worldQuestId] };
  }
  if (hasGeneratedSeed) {
    if (!isGeneratedRpgSeed(generatedRpgSeed)) {
      return {
        ok: false,
        error: generatedRpgSeedValidationMessage(labels.generatedRpgSeed, generatedRpgSeed),
      };
    }
    return { ok: true, sourceRef: ["gen", generatedRpgSeed] };
  }
  return {
    ok: false,
    error: `${labels.source} requires worldQuestId or generatedRpgSeed.`,
  };
}

export function compactSourceRefLabel(sourceRef: CompactSourceRef): string {
  if (sourceRef[0] === "wq") return `world_quest_id:${sourceRef[1]}`;
  return `generate_rpg_seed:${sourceRef[1]}`;
}

export function compactSourceRefLegacyConsistency(
  sourceRef: CompactSourceRef | undefined,
  metadata: CompactSourceLegacyMetadata,
  messages: CompactSourceRefConsistencyMessages,
): CompactSourceRefConsistencyResult {
  let { worldQuestId, generatedRpgSeed } = metadata;
  if (sourceRef?.[0] === "wq") {
    if (worldQuestId !== undefined && worldQuestId !== sourceRef[1]) {
      return { ok: false, error: messages.worldQuestMismatch(sourceRef[1], worldQuestId) };
    }
    if (generatedRpgSeed !== undefined) {
      return { ok: false, error: messages.sourceRefConflictsWithGeneratedRpgSeed };
    }
    worldQuestId = sourceRef[1];
  } else if (sourceRef?.[0] === "gen") {
    if (generatedRpgSeed !== undefined && generatedRpgSeed !== sourceRef[1]) {
      return { ok: false, error: messages.generatedSeedMismatch(sourceRef[1], generatedRpgSeed) };
    }
    if (worldQuestId !== undefined) {
      return { ok: false, error: messages.sourceRefConflictsWithWorldQuestId };
    }
    generatedRpgSeed = sourceRef[1];
  }

  if (worldQuestId !== undefined && generatedRpgSeed !== undefined) {
    return { ok: false, error: messages.sourceConflict };
  }
  return {
    ok: true,
    metadata: {
      ...(worldQuestId !== undefined ? { worldQuestId } : {}),
      ...(generatedRpgSeed !== undefined ? { generatedRpgSeed } : {}),
    },
  };
}

export function compactSourceRefValidationError(raw: unknown, label: string): string | undefined {
  if (!Array.isArray(raw) || raw.length !== 2) {
    return `${label} must be a compact tuple when present.`;
  }
  const [tag, value] = raw;
  if (tag === "wq") {
    return typeof value === "string" ? undefined : `${label} world quest id must be a string.`;
  }
  if (tag === "gen") {
    return isGeneratedRpgSeed(value)
      ? undefined
      : `${label} generated seed must be an integer within JavaScript's safe range.`;
  }
  return `${label} tag must be "wq" or "gen", got ${JSON.stringify(tag)}.`;
}
