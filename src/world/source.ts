import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SaveIntegrityError, type SaveSourceRef } from "../persist/save_load.js";
import type { Trace, TraceSourceRef } from "../trace/record.js";
import { generatedRpgSeedValidationMessage, isGeneratedRpgSeed } from "../gen/seed.js";
import {
  assertOverworldIntegrity,
  normalizeSourcePath,
  overworldQuestById,
  parseOverworldManifest,
  type OverworldManifest,
} from "./overworld.js";
import { assertOpeningPreparationCheckDisclosureSourceIntegrity } from "./opening_preparation_source_integrity.js";
import { registerDeepFrozenOverworldManifest } from "./session_indices.js";
import {
  compactSourceRefLegacyConsistency,
  compactSourceRefValidationError,
} from "./source_ref.js";

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
  sourceRefConflictsWithGeneratedRpgSeed: "Save source_ref conflicts with generatedRpgSeed.",
  sourceRefConflictsWithWorldQuestId: "Save source_ref conflicts with worldQuestId.",
} as const;

const TRACE_SOURCE_REF_CONSISTENCY_MESSAGES = {
  sourceConflict: "Trace source cannot carry both worldQuestId and generatedRpgSeed.",
  worldQuestMismatch: (sourceRefWorldQuestId: string, worldQuestId: string) =>
    `Trace source_ref world quest ${JSON.stringify(
      sourceRefWorldQuestId,
    )} does not match worldQuestId ${JSON.stringify(worldQuestId)}.`,
  generatedSeedMismatch: (sourceRefGeneratedSeed: number, generatedRpgSeed: number) =>
    `Trace source_ref generated seed ${JSON.stringify(
      sourceRefGeneratedSeed,
    )} does not match generatedRpgSeed ${JSON.stringify(generatedRpgSeed)}.`,
  sourceRefConflictsWithGeneratedRpgSeed: "Trace source_ref conflicts with generatedRpgSeed.",
  sourceRefConflictsWithWorldQuestId: "Trace source_ref conflicts with worldQuestId.",
} as const;

export type TraceSourceArgs = {
  world_quest_id?: string;
};

export type SaveSourceArgs = {
  world_quest_id?: string;
  generate_rpg_seed?: number;
};

export type GameSourceArgs = {
  generate_rpg_seed?: number;
};

export type SaveWorldSource = {
  worldQuestId?: unknown;
  generatedRpgSeed?: unknown;
  source_ref?: unknown;
};

export type WorldQuestGameSource = {
  kind: "worldQuest";
  worldQuestId: string;
  generateRpgSeed: null;
};

export type GameSource =
  | WorldQuestGameSource
  | {
      kind: "generated";
      worldQuestId: null;
      generateRpgSeed: number;
    };

export type GeneratedGameSource = Extract<GameSource, { kind: "generated" }>;
export type TraceGameSource = GameSource;
export type WorldQuestSourceArgs = {
  world_quest_id?: string;
};

const overworldManifestCache = new Map<string, OverworldManifest>();

/**
 * The world-integrity verdict cache (bug_0611).
 *
 * `assertOverworldIntegrity` is about 19 of the 20 seconds it takes to load the shipped
 * world, and it is a pure function of the manifest bytes and the engine source: the same
 * bytes under the same code always reach the same verdict. Every vitest file runs in its
 * own process, so without a cache the suite re-proved the identical world ~115 times per
 * run (a third of the fast lane's worker time), and every CLI, MCP server and crawler
 * start paid the same 20 seconds. A marker under `ai-runs/world-integrity/`, keyed on the
 * SHA-256 of the world bytes AND of every `.ts` file under `src/`, records a verdict a
 * later process may reuse.
 *
 * What keeps this honest: the marker names the exact bytes it vouches for (a changed
 * world or a changed engine is a miss, never a stale hit); `npm run validate` runs with
 * `refresh` so the bar always re-proves and rewrites it before the suite reads it; and a
 * build without `src/` beside this module (compiled output) gets no cache at all.
 * Forging a marker requires write access to `ai-runs/`, which already implies write
 * access to the world file itself.
 */
export type OverworldIntegrityCacheMode = "use" | "refresh" | "off";
export type OverworldIntegrityCacheKey = Readonly<{ world: string; code: string | null }>;
export const WORLD_INTEGRITY_CACHE_ENV = "ADVENTUREFORGE_WORLD_INTEGRITY_CACHE";
const WORLD_INTEGRITY_CACHE_DIR = ["ai-runs", "world-integrity"] as const;

let engineSourceDigestMemo: string | null | undefined;

/** SHA-256 over every `.ts` file under `src/` (relative path and bytes, in path order),
 *  or null when `src/` is not beside this module — a compiled build has no such tree
 *  and therefore no cache. Memoized: the engine does not change while a process runs. */
function engineSourceDigest(): string | null {
  if (engineSourceDigestMemo !== undefined) return engineSourceDigestMemo;
  const srcDir = fileURLToPath(new URL("../", import.meta.url));
  let files: string[];
  try {
    files = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts"))
      .map((name) => name.replaceAll("\\", "/"))
      .sort();
  } catch {
    files = [];
  }
  if (files.length === 0) {
    engineSourceDigestMemo = null;
    return null;
  }
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(srcDir, file)));
    hash.update("\0");
  }
  engineSourceDigestMemo = hash.digest("hex");
  return engineSourceDigestMemo;
}

export function overworldIntegrityCacheKey(worldText: string): OverworldIntegrityCacheKey {
  return {
    world: createHash("sha256").update(worldText).digest("hex"),
    code: engineSourceDigest(),
  };
}

/** Where the marker for this key lives under `root`, or null when no cache is possible. */
export function overworldIntegrityMarkerPath(
  root: string,
  key: OverworldIntegrityCacheKey,
): string | null {
  if (key.code === null) return null;
  return join(
    root,
    ...WORLD_INTEGRITY_CACHE_DIR,
    `${key.world.slice(0, 32)}-${key.code.slice(0, 32)}.json`,
  );
}

function integrityCacheMode(
  explicit: OverworldIntegrityCacheMode | undefined,
): OverworldIntegrityCacheMode {
  const requested = explicit ?? process.env[WORLD_INTEGRITY_CACHE_ENV] ?? "use";
  if (requested === "use" || requested === "refresh" || requested === "off") return requested;
  throw new Error(
    `${WORLD_INTEGRITY_CACHE_ENV} must be "use", "refresh" or "off"; got ${JSON.stringify(requested)}.`,
  );
}

/** True only when the marker parses and names exactly this key; a torn or foreign file is a miss. */
function integrityMarkerVouches(markerPath: string, key: OverworldIntegrityCacheKey): boolean {
  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return false;
  }
  if (stored === null || typeof stored !== "object") return false;
  const record = stored as Record<string, unknown>;
  return record.world_sha256 === key.world && record.code_sha256 === key.code;
}

function writeIntegrityMarker(markerPath: string, key: OverworldIntegrityCacheKey): void {
  const record = {
    world_sha256: key.world,
    code_sha256: key.code,
    validated_at: new Date().toISOString(),
    node: process.version,
  };
  const staging = `${markerPath}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(staging, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    renameSync(staging, markerPath);
  } catch {
    // The cache is an accelerator, never a gate: a marker that cannot be written costs
    // the next process one more proof and nothing else.
    try {
      rmSync(staging, { force: true });
    } catch {
      // Nothing left to clean up.
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function assertGenerateRpgSeed(seed: unknown, operation: string): asserts seed is number {
  if (!isGeneratedRpgSeed(seed)) {
    throw new Error(generatedRpgSeedValidationMessage(`${operation} generate_rpg_seed`, seed));
  }
}

function rejectRetiredWorldQuestSourceAliases(
  args: unknown,
  operation: string,
  accepted: string,
): void {
  const source = args as {
    pack_path?: unknown;
    quest_id?: unknown;
    quest_path?: unknown;
  };
  if (source.pack_path !== undefined) {
    throw new Error(`${operation} accepts ${accepted}, not pack_path.`);
  }
  if (source.quest_path !== undefined) {
    throw new Error(`${operation} accepts ${accepted}, not quest_path.`);
  }
  if (source.quest_id !== undefined) {
    throw new Error(`${operation} accepts ${accepted}, not quest_id.`);
  }
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function discoverShippedRpgSourcePaths(root: string): string[] {
  try {
    return readdirSync(join(root, "content", "rpg", "quests"))
      .filter((file) => file.endsWith(".yaml"))
      .map((file) => normalizeSourcePath(`content/rpg/quests/${file}`))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The single-world invariant: the New York overworld's quest registry and the shipped
 * RPG packs are the SAME set. Every overworld quest names a real pack, and every shipped
 * pack is bound to exactly one overworld quest — no orphan packs reachable only outside
 * the overworld, and no dangling quest sources. This replaced the retired Charter Marches
 * world-graph coverage check: the overworld is now the sole quest registry.
 */
export function assertOverworldQuestSourceCoverage(
  overworld: OverworldManifest,
  shippedSourcePaths: string[],
): void {
  const shipped = [...new Set(shippedSourcePaths.map(normalizeSourcePath))].sort();
  const questSources = overworld.quests.map((quest) => normalizeSourcePath(quest.source));

  const duplicates = duplicateValues(questSources);
  if (duplicates.length > 0) {
    throw new Error(
      `Overworld binds the same shipped RPG source more than once: ${duplicates.join(", ")}.`,
    );
  }

  const questSourceSet = new Set(questSources);
  const shippedSet = new Set(shipped);
  const extra = questSources.filter((path) => !shippedSet.has(path)).sort();
  const missing = shipped.filter((path) => !questSourceSet.has(path));

  if (extra.length > 0) {
    throw new Error(
      `Overworld references RPG source(s) not shipped in content/rpg/quests: ${extra.join(", ")}.`,
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `Shipped RPG source(s) not bound to any overworld quest: ${missing.join(", ")}.`,
    );
  }
}

export function loadOverworldManifest(
  root: string,
  options: { integrityCache?: OverworldIntegrityCacheMode } = {},
): OverworldManifest {
  const cached = overworldManifestCache.get(root);
  if (cached) return cached;

  const worldText = readFileSync(join(root, "content", "world", "new_york_overworld.json"), "utf8");
  const overworld = parseOverworldManifest(JSON.parse(worldText));
  const mode = integrityCacheMode(options.integrityCache);
  const key = mode === "off" ? null : overworldIntegrityCacheKey(worldText);
  const marker = key === null ? null : overworldIntegrityMarkerPath(root, key);
  const vouched =
    key !== null && marker !== null && mode === "use" && integrityMarkerVouches(marker, key);
  if (!vouched) {
    assertOverworldIntegrity(overworld);
    if (key !== null && marker !== null) writeIntegrityMarker(marker, key);
  }
  assertOverworldQuestSourceCoverage(overworld, discoverShippedRpgSourcePaths(root));
  assertOpeningPreparationCheckDisclosureSourceIntegrity(root, overworld);
  deepFreeze(overworld);
  registerDeepFrozenOverworldManifest(overworld);
  overworldManifestCache.set(root, overworld);
  return overworld;
}

export function resolveWorldQuestSourceId(args: WorldQuestSourceArgs, operation: string): string {
  rejectRetiredWorldQuestSourceAliases(args, operation, "world_quest_id");
  if (args.world_quest_id === undefined) {
    throw new Error(`${operation} requires world_quest_id.`);
  }
  return args.world_quest_id;
}

/** Resolve a shipped quest id to a playable game source via the overworld quest registry. */
function resolveWorldQuestGameSource(root: string, worldQuestId: string): WorldQuestGameSource {
  const overworld = loadOverworldManifest(root);
  const quest = overworldQuestById(overworld, worldQuestId);
  if (!quest) {
    throw new Error(`Unknown overworld quest "${worldQuestId}".`);
  }
  return {
    kind: "worldQuest",
    worldQuestId: quest.id,
    generateRpgSeed: null,
  };
}

function generatedGameSource(seed: number): GeneratedGameSource {
  return {
    kind: "generated",
    worldQuestId: null,
    generateRpgSeed: seed,
  };
}

function gameSourceIdentityForError(source: GameSource): string | number {
  return source.kind === "worldQuest" ? source.worldQuestId : source.generateRpgSeed;
}

export function resolveGameSource(
  _root: string,
  args: GameSourceArgs,
  operation: string,
): GeneratedGameSource {
  rejectRetiredWorldQuestSourceAliases(args, operation, "generate_rpg_seed");
  if ((args as { world_quest_id?: unknown }).world_quest_id !== undefined) {
    throw new Error(
      `${operation} starts generated RPG packs only; start a shipped quest from the overworld with start_overworld_session_quest.`,
    );
  }
  if (args.generate_rpg_seed === undefined) {
    throw new Error(`${operation} requires generate_rpg_seed.`);
  }
  assertGenerateRpgSeed(args.generate_rpg_seed, operation);
  return generatedGameSource(args.generate_rpg_seed);
}

export function traceGeneratedRpgSeed(trace: Trace, operation: string): number | undefined {
  return traceEmbeddedSource(trace, operation).generatedRpgSeed;
}

function traceEmbeddedSource(
  trace: Trace,
  operation: string,
): {
  worldQuestId?: string;
  generatedRpgSeed?: number;
} {
  const sourceRef = traceSourceRef(trace, operation);
  const raw = (trace as { worldQuestId?: unknown }).worldQuestId;
  let worldQuestId: string | undefined;
  if (raw !== undefined && typeof raw !== "string") {
    throw new SaveIntegrityError(
      `${operation} trace worldQuestId must be a string when present, got ${JSON.stringify(raw)}.`,
    );
  }
  if (typeof raw === "string") worldQuestId = raw;

  const rawGeneratedRpgSeed = (trace as { generatedRpgSeed?: unknown }).generatedRpgSeed;
  let generatedRpgSeed: number | undefined;
  if (rawGeneratedRpgSeed !== undefined && !isGeneratedRpgSeed(rawGeneratedRpgSeed)) {
    throw new SaveIntegrityError(
      generatedRpgSeedValidationMessage(`${operation} trace generatedRpgSeed`, rawGeneratedRpgSeed),
    );
  }
  if (typeof rawGeneratedRpgSeed === "number") generatedRpgSeed = rawGeneratedRpgSeed;

  const consistency = compactSourceRefLegacyConsistency(
    sourceRef,
    {
      ...(worldQuestId !== undefined ? { worldQuestId } : {}),
      ...(generatedRpgSeed !== undefined ? { generatedRpgSeed } : {}),
    },
    TRACE_SOURCE_REF_CONSISTENCY_MESSAGES,
  );
  if (!consistency.ok) throw new SaveIntegrityError(consistency.error);
  return consistency.metadata;
}

function traceSourceRef(trace: Trace, operation: string): TraceSourceRef {
  const sourceRef = (trace as { source_ref?: unknown }).source_ref;
  if (sourceRef === undefined) {
    throw new SaveIntegrityError(`${operation} trace source_ref is required.`);
  }
  const error = compactSourceRefValidationError(sourceRef, `${operation} trace source_ref`);
  if (error !== undefined) throw new SaveIntegrityError(error);
  return sourceRef as TraceSourceRef;
}

export function saveWorldQuestId(bundle: SaveWorldSource, operation: string): string | undefined {
  return saveEmbeddedSource(bundle, operation).worldQuestId;
}

export function saveGeneratedRpgSeed(
  bundle: SaveWorldSource,
  operation: string,
): number | undefined {
  return saveEmbeddedSource(bundle, operation).generatedRpgSeed;
}

function saveEmbeddedSource(
  bundle: SaveWorldSource,
  operation: string,
): {
  worldQuestId?: string;
  generatedRpgSeed?: number;
} {
  const sourceRef = saveSourceRef(bundle, operation);
  const rawWorldQuestId = bundle.worldQuestId;
  let worldQuestId: string | undefined;
  if (rawWorldQuestId !== undefined && typeof rawWorldQuestId !== "string") {
    throw new SaveIntegrityError(
      `${operation} save worldQuestId must be a string when present, got ${JSON.stringify(
        rawWorldQuestId,
      )}.`,
    );
  }
  if (typeof rawWorldQuestId === "string") worldQuestId = rawWorldQuestId;

  const rawGeneratedRpgSeed = bundle.generatedRpgSeed;
  let generatedRpgSeed: number | undefined;
  if (rawGeneratedRpgSeed !== undefined && !isGeneratedRpgSeed(rawGeneratedRpgSeed)) {
    throw new SaveIntegrityError(
      generatedRpgSeedValidationMessage(`${operation} save generatedRpgSeed`, rawGeneratedRpgSeed),
    );
  }
  if (typeof rawGeneratedRpgSeed === "number") generatedRpgSeed = rawGeneratedRpgSeed;

  const consistency = compactSourceRefLegacyConsistency(
    sourceRef,
    {
      ...(worldQuestId !== undefined ? { worldQuestId } : {}),
      ...(generatedRpgSeed !== undefined ? { generatedRpgSeed } : {}),
    },
    SAVE_SOURCE_REF_CONSISTENCY_MESSAGES,
  );
  if (!consistency.ok) throw new SaveIntegrityError(consistency.error);
  return consistency.metadata;
}

function saveSourceRef(bundle: SaveWorldSource, operation: string): SaveSourceRef {
  const sourceRef = bundle.source_ref;
  if (sourceRef === undefined) {
    throw new SaveIntegrityError(`${operation} save source_ref is required.`);
  }
  const error = compactSourceRefValidationError(sourceRef, `${operation} save source_ref`);
  if (error !== undefined) throw new SaveIntegrityError(error);
  return sourceRef as SaveSourceRef;
}

export function resolveSaveGameSource(
  root: string,
  args: SaveSourceArgs,
  bundle: SaveWorldSource,
  operation: string,
): GameSource {
  rejectRetiredWorldQuestSourceAliases(args, operation, "world_quest_id or generate_rpg_seed");
  const explicitCount = [
    args.world_quest_id !== undefined,
    args.generate_rpg_seed !== undefined,
  ].filter(Boolean).length;
  if (explicitCount > 1) {
    throw new Error(`${operation} accepts exactly one of world_quest_id or generate_rpg_seed.`);
  }
  if (args.generate_rpg_seed !== undefined) {
    assertGenerateRpgSeed(args.generate_rpg_seed, operation);
  }

  const embeddedSource = saveEmbeddedSource(bundle, operation);
  const embeddedWorldQuestId = embeddedSource.worldQuestId;
  const embeddedGeneratedRpgSeed = embeddedSource.generatedRpgSeed;

  let source: GameSource;
  if (args.generate_rpg_seed !== undefined) {
    source = generatedGameSource(args.generate_rpg_seed);
  } else if (args.world_quest_id !== undefined) {
    source = resolveWorldQuestGameSource(root, args.world_quest_id);
  } else if (embeddedGeneratedRpgSeed !== undefined) {
    source = generatedGameSource(embeddedGeneratedRpgSeed);
  } else if (embeddedWorldQuestId !== undefined) {
    source = resolveWorldQuestGameSource(root, embeddedWorldQuestId);
  } else {
    throw new Error(
      `${operation} requires world_quest_id, generate_rpg_seed, or a save with source_ref.`,
    );
  }

  if (
    embeddedWorldQuestId !== undefined &&
    (source.kind !== "worldQuest" || source.worldQuestId !== embeddedWorldQuestId)
  ) {
    throw new SaveIntegrityError(
      `Save source_ref world quest ${JSON.stringify(
        embeddedWorldQuestId,
      )} does not match requested source ${JSON.stringify(gameSourceIdentityForError(source))}.`,
    );
  }
  if (
    embeddedGeneratedRpgSeed !== undefined &&
    (source.kind !== "generated" || source.generateRpgSeed !== embeddedGeneratedRpgSeed)
  ) {
    throw new SaveIntegrityError(
      `Save source_ref generated seed ${JSON.stringify(
        embeddedGeneratedRpgSeed,
      )} does not match requested source ${JSON.stringify(gameSourceIdentityForError(source))}.`,
    );
  }
  return source;
}

export function resolveTraceGameSource(
  root: string,
  args: TraceSourceArgs,
  trace: Trace,
  operation: string,
): TraceGameSource {
  rejectRetiredWorldQuestSourceAliases(
    args,
    operation,
    "world_quest_id or embedded trace source_ref",
  );
  const embeddedSource = traceEmbeddedSource(trace, operation);
  const embeddedWorldQuestId = embeddedSource.worldQuestId;
  const embeddedGeneratedRpgSeed = embeddedSource.generatedRpgSeed;

  let source: TraceGameSource;
  if (args.world_quest_id !== undefined) {
    source = resolveWorldQuestGameSource(root, args.world_quest_id);
  } else if (embeddedGeneratedRpgSeed !== undefined) {
    source = generatedGameSource(embeddedGeneratedRpgSeed);
  } else if (embeddedWorldQuestId !== undefined) {
    source = resolveWorldQuestGameSource(root, embeddedWorldQuestId);
  } else {
    throw new Error(`${operation} requires world_quest_id or a trace with source_ref.`);
  }

  if (
    embeddedWorldQuestId !== undefined &&
    (source.kind !== "worldQuest" || source.worldQuestId !== embeddedWorldQuestId)
  ) {
    throw new SaveIntegrityError(
      `Trace source_ref world quest ${JSON.stringify(
        embeddedWorldQuestId,
      )} does not match requested source ${JSON.stringify(gameSourceIdentityForError(source))}.`,
    );
  }
  if (
    embeddedGeneratedRpgSeed !== undefined &&
    (source.kind !== "generated" || source.generateRpgSeed !== embeddedGeneratedRpgSeed)
  ) {
    throw new SaveIntegrityError(
      `Trace source_ref generated seed ${JSON.stringify(
        embeddedGeneratedRpgSeed,
      )} does not match requested source ${JSON.stringify(gameSourceIdentityForError(source))}.`,
    );
  }
  return source;
}
