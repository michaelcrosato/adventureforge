/**
 * Save / load (spec §8.7).
 *
 * A save = the full GameState + its deterministic state hash + compact RPG
 * source identity + content hash.
 * Loading MUST verify the content hash against the content it will be played on;
 * a mismatch is a hard error, never a silent re-interpretation (§8.8, §16
 * "integrity at load"). This prevents replaying a save against edited content
 * and corrupting it.
 */
import { z } from "zod";
import { CampaignImportReceiptSchema } from "../core/campaign_import_receipt.js";
import {
  EmbeddedLaunchOverlayReceiptSchema,
  assertEmbeddedLaunchOverlayWorldQuest,
} from "../core/embedded_launch_overlay_receipt.js";
import { MAX_ENGINE_STEP, cloneGameState, isRuntimeSeed, type GameState } from "../core/state.js";
import { canonicalize, hashState } from "../core/hash.js";
import { isGeneratedRpgSeed } from "../gen/seed.js";
import {
  EMBEDDED_QUEST_CONTINUITY_EXPLANATION,
  EmbeddedQuestCharacterContinuitySchema,
  cloneEmbeddedQuestCharacterContinuity,
  type EmbeddedQuestCharacterContinuity,
} from "../rpg/embedded_quest_character_continuity.js";
import {
  compactSourceRefFromMetadata,
  compactSourceRefLegacyConsistency,
  compactSourceRefValidationError,
  type CompactSourceRef,
} from "../world/source_ref.js";

export const LEGACY_SAVE_VERSION = 1 as const;
export const PREVIOUS_SAVE_VERSION = 2 as const;
export const SAVE_VERSION = 3 as const;
export const SAVE_MODE = "rpg" as const;
const EMBEDDED_QUEST_CONTINUITY_SAVE_VERSION = 1 as const;
export type SaveMode = typeof SAVE_MODE;

const UINT32_SEED_RANGE = 0x100000000;

/**
 * Structural + finiteness validator for a loaded GameState (§16 "integrity at
 * load"). This mirrors `GameState` (src/core/state.ts) field-for-field, and is
 * the load-side complement to the effects-layer `guardFinite` (effects.ts) —
 * which only ever runs on EFFECT APPLICATION during play and so never sees a
 * value injected by a forged save. The contentHash check below guards WHICH
 * source a save was made against; this guards WHETHER the state is well-formed.
 *
 * The load-bearing gate is `vars: z.record(z.number().finite())`:
 * `JSON.parse('{"...":1e999}')` yields `Infinity`, which — left unguarded —
 * flows into `conditions.ts:75` `var_gte` and makes EVERY `var_gte` gate
 * always-true (NaN makes every `var_*` always-false). The gate REJECTS such a
 * save (throws `SaveIntegrityError`); it never coerces/clamps.
 *
 * `seed`/`step` are gated to the safe INTEGER domain. `rngForStep` preserves the
 * historical unsigned-32-bit stream and uses exact BigInt state for signed/wide
 * seeds, so a non-integer is not a valid deterministic identity. `step` is also
 * bounded to the engine's safe increment domain; an unsafe integer can make
 * `step + 1` stop advancing precisely. `seed` stays signed and may exceed 32
 * bits — both are legitimate and both reach the stream — but unsafe integers
 * are rejected before persistence can commit an imprecise identity.
 *
 * `objectState` mirrors `ObjectRuntime` (src/core/state.ts) with `.strict()` so an
 * unknown or wrong-typed key is rejected, not silently carried into the engine.
 */
const ObjectRuntimeSchema = z
  .object({
    open: z.boolean().optional(),
    locked: z.boolean().optional(),
    takenBy: z.enum(["player", "world"]).optional(),
    room: z.string().optional(),
  })
  .strict();

function isOwnEntryRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const OwnEntryRecordInputSchema = z.custom<Record<string, unknown>>(isOwnEntryRecord, {
  message: "Expected an object record.",
});

/**
 * z.record may skip or drop reserved own keys such as `__proto__` during parse.
 * Validate Object.entries explicitly and rebuild through Object.fromEntries so
 * every schema-valid key survives and reserved-name values receive the same
 * strict checks as ordinary keys.
 */
function ownEntryRecordSchema<Value>(valueSchema: z.ZodType<Value>) {
  return OwnEntryRecordInputSchema.transform((record, ctx): Record<string, Value> => {
    const entries: [string, Value][] = [];
    for (const [key, value] of Object.entries(record)) {
      const parsed = valueSchema.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: [key, ...issue.path] });
        }
        continue;
      }
      entries.push([key, parsed.data]);
    }
    return Object.fromEntries(entries) as Record<string, Value>;
  });
}

const GameStateSchema = z
  .object({
    // identity / determinism — INTEGER domain only (the values rngForStep
    // consumes); rejects non-integers AND Infinity/-Infinity/NaN. Matches the
    // MCP entry gates (the `.int().safe()` seed schemas in src/mcp/server.ts):
    // negative and above-32-bit seeds are legitimate; step is a bounded
    // monotonic counter.
    seed: z.number().int().refine(isRuntimeSeed, {
      message: "GameState seed must be within JavaScript's safe integer range.",
    }),
    step: z.number().int().nonnegative().max(MAX_ENGINE_STEP),
    // location
    current: z.string(),
    visited: ownEntryRecordSchema(z.boolean()),
    // world state
    flags: ownEntryRecordSchema(z.boolean()),
    // THE load-bearing finiteness gate (the Infinity/NaN -> conditions.ts:75 hole):
    vars: ownEntryRecordSchema(z.number().finite()),
    inventory: z.array(z.string()),
    objectState: ownEntryRecordSchema(ObjectRuntimeSchema),
    // narrative
    journal: z.array(z.string()),
    questStage: ownEntryRecordSchema(z.string()),
    // termination
    ended: z.boolean(),
    endingId: z.string().nullable(),
    campaignImportReceipt: CampaignImportReceiptSchema.optional(),
    embeddedLaunchOverlayReceipt: EmbeddedLaunchOverlayReceiptSchema.optional(),
  })
  .strict();

// ObjectRuntime.contents existed in save version 1. Keep the current v3
// runtime/write schema strict, but recognize exactly that historical field
// while loading v1 bytes and erase it before the state reaches the engine.
// The old field was semantically dead; accepting any shape broader than its
// original string-array contract would turn compatibility into coercion.
const Version1ObjectRuntimeSchema = ObjectRuntimeSchema.extend({
  contents: z.array(z.string()).optional(),
}).strict();

const Version1GameStateSchema = GameStateSchema.extend({
  objectState: ownEntryRecordSchema(Version1ObjectRuntimeSchema),
}).strict();

function assertVersion1SeedCompatibility(seed: number): void {
  if (seed >= 0 && seed < UINT32_SEED_RANGE) return;
  throw new SaveIntegrityError(
    `Save version ${String(LEGACY_SAVE_VERSION)} seed ${String(seed)} cannot be resumed because ` +
      `signed/wide RNG streams changed in save version ${String(PREVIOUS_SAVE_VERSION)}. ` +
      "Only version-1 seeds from 0 through 4294967295 are continuation-compatible.",
  );
}

function migrateVersion1State(state: unknown): GameState {
  const parsed = Version1GameStateSchema.safeParse(state);
  if (!parsed.success) {
    throw new SaveIntegrityError(`Save state is malformed or non-finite: ${parsed.error.message}`);
  }
  assertVersion1SeedCompatibility(parsed.data.seed);

  const objectState = Object.fromEntries(
    Object.entries(parsed.data.objectState).map(([id, runtime]) => [
      id,
      {
        ...(runtime.open !== undefined ? { open: runtime.open } : {}),
        ...(runtime.locked !== undefined ? { locked: runtime.locked } : {}),
        ...(runtime.takenBy !== undefined ? { takenBy: runtime.takenBy } : {}),
        ...(runtime.room !== undefined ? { room: runtime.room } : {}),
      },
    ]),
  ) as GameState["objectState"];

  const migrated = { ...parsed.data, objectState };
  const current = GameStateSchema.safeParse(migrated);
  if (!current.success) {
    throw new SaveIntegrityError(
      `Save state is malformed or non-finite after v1 migration: ${current.error.message}`,
    );
  }
  return current.data as GameState;
}

function assertTerminalStateCoherence(state: Pick<GameState, "ended" | "endingId">): void {
  if (state.ended === (state.endingId !== null)) return;
  throw new SaveIntegrityError(
    `GameState terminal state is incoherent: ended=${String(state.ended)} and ` +
      `endingId=${JSON.stringify(state.endingId)}; ended must be true exactly when endingId is non-null.`,
  );
}

/**
 * Assert a (possibly untrusted) GameState is well-formed + FINITE per §16
 * "integrity at load". REUSED at every untrusted-state-from-disk boundary: the
 * save load() guard below and the trace/CLI load gates. Same
 * safeParse path as load(), returning parsed.data so future schema transforms or
 * defaults cannot be bypassed accidentally. Current validation never coerces, so a
 * valid state's canonical bytes/hash remain identical. Throws on invalid input.
 */
export function assertWellFormedState(state: unknown): GameState {
  const parsed = GameStateSchema.safeParse(state);
  if (!parsed.success) {
    throw new SaveIntegrityError(`State is malformed or non-finite: ${parsed.error.message}`);
  }
  const wellFormedState = parsed.data as GameState;
  assertTerminalStateCoherence(wellFormedState);
  return wellFormedState;
}

type SaveBundle = {
  version: typeof SAVE_VERSION;
  contentHash: string;
  /** Canonical SHA-256 of `state`; a deterministic consistency check, not authentication. */
  stateHash: string;
  /** Pack mode. Required so persisted state is bound to the unified RPG engine. */
  mode: SaveMode;
  /** Compact canonical source identity for world quests or generated RPG runs. */
  source_ref: SaveSourceRef;
  state: GameState;
  /** Optional campaign-parent sidecar; absent on standalone/direct quest saves. */
  embedded_character_continuity?: EmbeddedQuestCharacterContinuitySave;
};

type EmbeddedQuestCharacterContinuitySave = {
  version: typeof EMBEDDED_QUEST_CONTINUITY_SAVE_VERSION;
  character_continuity: EmbeddedQuestCharacterContinuity;
};

export type SaveSourceRef = CompactSourceRef;

const LEGACY_EMBEDDED_QUEST_CONTINUITY_EXPLANATIONS = new Set([
  "Scenario-local numbers and issued kit govern this quest. Your persistent record remains intact; only authored campaign import and export effects cross the quest boundary.",
  "Campaign supplies, fatigue, and character record persist. Quest HP, stats, and issued inventory are local; only authored campaign imports and exports cross the boundary.",
]);

// The explanation is player-facing copy, but version-1 sidecars persisted it as
// a literal. Accept the two shipped legacy literals at the load boundary and
// normalize them before the strict current runtime schema sees the value.
const PersistedEmbeddedQuestCharacterContinuitySchema = z.preprocess((value) => {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    LEGACY_EMBEDDED_QUEST_CONTINUITY_EXPLANATIONS.has(
      (value as Record<string, unknown>)["explanation"] as string,
    )
  ) {
    return {
      ...(value as Record<string, unknown>),
      explanation: EMBEDDED_QUEST_CONTINUITY_EXPLANATION,
    };
  }
  return value;
}, EmbeddedQuestCharacterContinuitySchema);

const EmbeddedQuestCharacterContinuitySaveSchema = z
  .object({
    version: z.literal(EMBEDDED_QUEST_CONTINUITY_SAVE_VERSION),
    character_continuity: PersistedEmbeddedQuestCharacterContinuitySchema,
  })
  .strict();

const StateHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Save stateHash must be a lowercase 64-character SHA-256 digest.");

const SaveSourceRefSchema = z.custom<SaveSourceRef>(
  (raw) => compactSourceRefValidationError(raw, "Save source_ref") === undefined,
  {
    message:
      'Save source_ref must be ["wq", string] or ["gen", integer within JavaScript\'s safe range].',
  },
);

const GeneratedSaveSeedSchema = z.number().refine(isGeneratedRpgSeed, {
  message: "Save generatedRpgSeed must be an integer within JavaScript's safe range.",
});

// Historical save writers briefly mirrored source_ref into one of these fields.
// They remain explicit, typed compatibility fields in every strict envelope schema;
// normalization checks their consistency and omits them from the returned v3 bundle.
const PersistedSaveIdentityShape = {
  contentHash: z.string().min(1),
  mode: z.literal(SAVE_MODE),
  source_ref: SaveSourceRefSchema,
  worldQuestId: z.string().optional(),
  generatedRpgSeed: GeneratedSaveSeedSchema.optional(),
  embedded_character_continuity: EmbeddedQuestCharacterContinuitySaveSchema.optional(),
} as const;

/** Exact historical envelopes. Neither v1 nor v2 claimed to carry a state digest. */
const Version1SaveBundleSchema = z
  .object({
    version: z.literal(LEGACY_SAVE_VERSION),
    ...PersistedSaveIdentityShape,
    state: Version1GameStateSchema,
  })
  .strict();

const Version2SaveBundleSchema = z
  .object({
    version: z.literal(PREVIOUS_SAVE_VERSION),
    ...PersistedSaveIdentityShape,
    state: GameStateSchema,
  })
  .strict();

/** Current saves bind the strict parsed state to its canonical deterministic hash. */
const CurrentSaveBundleSchema = z
  .object({
    version: z.literal(SAVE_VERSION),
    ...PersistedSaveIdentityShape,
    stateHash: StateHashSchema,
    state: GameStateSchema,
  })
  .strict();

type PersistedSaveBundle =
  | z.infer<typeof Version1SaveBundleSchema>
  | z.infer<typeof Version2SaveBundleSchema>
  | z.infer<typeof CurrentSaveBundleSchema>;

export type SaveMetadata = {
  worldQuestId?: string | null;
  generatedRpgSeed?: number | null;
  embeddedCharacterContinuity?: EmbeddedQuestCharacterContinuity | null;
};

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SaveIntegrityError(
      `${label} must be a non-empty string, got ${JSON.stringify(value)}.`,
    );
  }
}

function deepFreezeSaveBundle<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  const object = value as object;
  if (seen.has(object) || Object.isFrozen(object)) return value;
  seen.add(object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeSaveBundle(child, seen);
  }
  return Object.freeze(value);
}

function cloneSaveSourceRef(sourceRef: SaveSourceRef): SaveSourceRef {
  return [sourceRef[0], sourceRef[1]] as SaveSourceRef;
}

function immutableLoadedSaveBundle(bundle: SaveBundle): SaveBundle {
  const sourceRef = cloneSaveSourceRef(bundle.source_ref);
  const {
    worldQuestId: _legacyWorldQuestId,
    generatedRpgSeed: _legacyGeneratedRpgSeed,
    ...canonicalBundle
  } = bundle as SaveBundle & {
    worldQuestId?: unknown;
    generatedRpgSeed?: unknown;
  };
  return deepFreezeSaveBundle({
    ...canonicalBundle,
    state: cloneGameState(bundle.state),
    source_ref: sourceRef,
    ...(bundle.embedded_character_continuity
      ? {
          embedded_character_continuity: {
            version: bundle.embedded_character_continuity.version,
            character_continuity: cloneEmbeddedQuestCharacterContinuity(
              bundle.embedded_character_continuity.character_continuity,
            ),
          },
        }
      : {}),
  });
}

const SAVE_SOURCE_LABELS = {
  source: "Save source",
  worldQuestId: "Save worldQuestId",
  generatedRpgSeed: "Save generatedRpgSeed",
} as const;
const SAVE_SOURCE_REF_CONSISTENCY_MESSAGES = {
  sourceConflict: "Save source cannot carry both worldQuestId and generatedRpgSeed.",
  worldQuestMismatch: (sourceRefWorldQuestId: string, worldQuestId: string) =>
    `Save source_ref world quest ${JSON.stringify(
      sourceRefWorldQuestId,
    )} does not match worldQuestId ${JSON.stringify(worldQuestId)}.`,
  generatedSeedMismatch: (sourceRefGeneratedSeed: number, generatedRpgSeed: number) =>
    `Save source_ref generated seed ${JSON.stringify(
      sourceRefGeneratedSeed,
    )} does not match generatedRpgSeed ${JSON.stringify(generatedRpgSeed)}.`,
  sourceRefConflictsWithGeneratedRpgSeed:
    "Save source_ref world quest conflicts with generatedRpgSeed.",
  sourceRefConflictsWithWorldQuestId: "Save source_ref generated seed conflicts with worldQuestId.",
} as const;

/** Serialize a save to canonical bytes (stable across machines/runs). */
export function save(
  state: GameState,
  contentHash: string,
  mode: SaveMode = SAVE_MODE,
  metadata: SaveMetadata = {},
): string {
  assertRpgMode(mode, "Save mode");
  assertNonEmptyString(contentHash, "Save contentHash");
  const parsedState = assertWellFormedState(state);
  const sourceRef = saveSourceRef(metadata);
  assertSaveLaunchOverlaySource(parsedState, sourceRef);
  const continuity = metadata.embeddedCharacterContinuity ?? undefined;
  if (continuity !== undefined) {
    if (sourceRef[0] !== "wq") {
      throw new SaveIntegrityError(
        "Embedded quest character continuity requires a world-quest save source.",
      );
    }
    const parsed = EmbeddedQuestCharacterContinuitySchema.safeParse(continuity);
    if (!parsed.success) {
      throw new SaveIntegrityError(
        `Embedded quest character continuity is malformed: ${parsed.error.message}`,
      );
    }
    assertEmbeddedContinuityMatchesState(parsed.data, parsedState);
  }
  const bundle: SaveBundle = {
    version: SAVE_VERSION,
    contentHash,
    stateHash: hashState(parsedState),
    state: parsedState,
    mode,
    source_ref: sourceRef,
    ...(continuity
      ? {
          embedded_character_continuity: {
            version: EMBEDDED_QUEST_CONTINUITY_SAVE_VERSION,
            character_continuity: cloneEmbeddedQuestCharacterContinuity(continuity),
          },
        }
      : {}),
  };
  return canonicalize(bundle);
}

function assertEmbeddedContinuityMatchesState(
  continuity: EmbeddedQuestCharacterContinuity,
  state: GameState,
): void {
  const stateEffects = state.campaignImportReceipt?.effects ?? [];
  if (canonicalize(continuity.applied_campaign_import_effects) !== canonicalize(stateEffects)) {
    throw new SaveIntegrityError(
      "Embedded quest character continuity import effects do not match the saved GameState receipt.",
    );
  }
}

export class SaveIntegrityError extends Error {}

export function assertSaveContentHash(
  bundle: Pick<SaveBundle, "contentHash">,
  expectedContentHash: string,
): void {
  if (bundle.contentHash !== expectedContentHash) {
    throw new SaveIntegrityError(
      `Content hash mismatch: save was made against ${bundle.contentHash}, ` +
        `but the loaded source is ${expectedContentHash}.`,
    );
  }
}

function assertRpgMode(mode: unknown, label: string): asserts mode is SaveMode {
  if (mode !== SAVE_MODE) {
    throw new SaveIntegrityError(`${label} must be "${SAVE_MODE}", got ${JSON.stringify(mode)}.`);
  }
}

function assertOptionalRpgMode(mode: unknown, label: string): asserts mode is SaveMode | undefined {
  if (mode !== undefined) assertRpgMode(mode, label);
}

function saveSourceRef(metadata: SaveMetadata): SaveSourceRef {
  const sourceRef = compactSourceRefFromMetadata(metadata, SAVE_SOURCE_LABELS);
  if (!sourceRef.ok) throw new SaveIntegrityError(sourceRef.error);
  return sourceRef.sourceRef;
}

function assertSaveLaunchOverlaySource(state: GameState, sourceRef: SaveSourceRef): void {
  try {
    assertEmbeddedLaunchOverlayWorldQuest(state, sourceRef[0] === "wq" ? sourceRef[1] : null);
  } catch (error) {
    throw new SaveIntegrityError((error as Error).message);
  }
}

function assertSaveSourceRefConsistency(bundle: PersistedSaveBundle): void {
  const legacyMirror = bundle as PersistedSaveBundle & {
    worldQuestId?: string;
    generatedRpgSeed?: number;
  };
  const consistency = compactSourceRefLegacyConsistency(
    bundle.source_ref,
    {
      ...(legacyMirror.worldQuestId !== undefined
        ? { worldQuestId: legacyMirror.worldQuestId }
        : {}),
      ...(legacyMirror.generatedRpgSeed !== undefined
        ? { generatedRpgSeed: legacyMirror.generatedRpgSeed }
        : {}),
    },
    SAVE_SOURCE_REF_CONSISTENCY_MESSAGES,
  );
  if (!consistency.ok) throw new SaveIntegrityError(consistency.error);
}

function saveBundleParseError(error: z.ZodError): SaveIntegrityError {
  const field = error.issues[0]?.path[0];
  const detail = error.message;
  if (field === "state") {
    return new SaveIntegrityError(`Save state is malformed or non-finite: ${detail}`);
  }
  if (field === "embedded_character_continuity") {
    return new SaveIntegrityError(
      `Embedded quest character continuity save metadata is malformed: ${detail}`,
    );
  }
  const label = typeof field === "string" && field.length > 0 ? `Save ${field}` : "Save bundle";
  return new SaveIntegrityError(`${label} is malformed: ${detail}`);
}

function parsePersistedSaveBundle(raw: unknown): PersistedSaveBundle {
  if (isOwnEntryRecord(raw) && Object.hasOwn(raw, "packId")) {
    throw new SaveIntegrityError("Save packId is retired; use source_ref plus contentHash.");
  }
  const persistedVersion = isOwnEntryRecord(raw) ? raw["version"] : undefined;
  const schema =
    persistedVersion === LEGACY_SAVE_VERSION
      ? Version1SaveBundleSchema
      : persistedVersion === PREVIOUS_SAVE_VERSION
        ? Version2SaveBundleSchema
        : persistedVersion === SAVE_VERSION
          ? CurrentSaveBundleSchema
          : undefined;
  if (schema === undefined) {
    throw new SaveIntegrityError(
      `Unsupported save version: ${String(persistedVersion)}; expected ${String(
        LEGACY_SAVE_VERSION,
      )}, ${String(PREVIOUS_SAVE_VERSION)}, or ${String(SAVE_VERSION)}.`,
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw saveBundleParseError(parsed.error);
  return parsed.data as PersistedSaveBundle;
}

/**
 * Deserialize a save. If `expectedContentHash` is given, the save's contentHash
 * must match it exactly (§8.7). Saves must carry the RPG mode; missing or
 * legacy modes are integrity failures, not migration inputs. Legacy
 * worldQuestId/generatedRpgSeed mirror fields are accepted only to check old
 * artifacts against source_ref, and are dropped from the returned bundle.
 * Version 1 is migrated only when its seed remains on the byte-identical legacy
 * RNG path. Honest v1/v2 envelopes did not carry stateHash; loading computes one
 * after strict parsing/migration. Current v3 saves must carry a matching digest.
 * Every returned bundle uses the current version and exact current field set.
 */
export function load(
  bytes: string,
  expectedContentHash?: string,
  expectedMode?: SaveMode,
): SaveBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (e) {
    throw new SaveIntegrityError(`Save is not valid JSON: ${(e as Error).message}`);
  }
  const bundle = parsePersistedSaveBundle(parsed);
  const persistedVersion = bundle.version;
  assertOptionalRpgMode(expectedMode, "Expected mode");
  if (bundle.worldQuestId !== undefined && bundle.generatedRpgSeed !== undefined) {
    throw new SaveIntegrityError(
      "Save source cannot carry both worldQuestId and generatedRpgSeed.",
    );
  }
  assertSaveSourceRefConsistency(bundle);
  if (expectedContentHash !== undefined) assertSaveContentHash(bundle, expectedContentHash);
  // §16 integrity at load: v1 recognizes and removes only its deprecated
  // ObjectRuntime.contents field. v2/v3 use the current strict shape. Every
  // envelope and nested state came from schema parsed.data, never the raw object.
  const normalizedState = assertWellFormedState(
    persistedVersion === LEGACY_SAVE_VERSION ? migrateVersion1State(bundle.state) : bundle.state,
  );
  const normalizedStateHash = hashState(normalizedState);
  if (persistedVersion === SAVE_VERSION && bundle.stateHash !== normalizedStateHash) {
    throw new SaveIntegrityError(
      `Save stateHash mismatch: save declares ${bundle.stateHash}, but its parsed state hashes to ${normalizedStateHash}. ` +
        "Local saves are editable, but stateHash must be recomputed after a state edit.",
    );
  }
  const normalizedBundle: SaveBundle = {
    version: SAVE_VERSION,
    contentHash: bundle.contentHash,
    stateHash: normalizedStateHash,
    mode: bundle.mode,
    source_ref: bundle.source_ref,
    state: normalizedState,
  };
  assertSaveLaunchOverlaySource(normalizedBundle.state, normalizedBundle.source_ref);
  const normalizedContinuity = bundle.embedded_character_continuity;
  if (normalizedContinuity !== undefined) {
    if (bundle.source_ref[0] !== "wq") {
      throw new SaveIntegrityError(
        "Embedded quest character continuity requires a world-quest save source.",
      );
    }
    assertEmbeddedContinuityMatchesState(
      normalizedContinuity.character_continuity,
      normalizedBundle.state,
    );
  }
  return immutableLoadedSaveBundle(
    normalizedContinuity === undefined
      ? normalizedBundle
      : { ...normalizedBundle, embedded_character_continuity: normalizedContinuity },
  );
}
