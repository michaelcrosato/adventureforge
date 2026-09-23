import { readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { hashState } from "../core/hash.js";
import type { RpgAction } from "../api/types.js";
import { compileRpgSource, type CompiledRpgSource } from "../rpg/source.js";
import { indexRpgPack, initStateForRpgPack } from "../rpg/runner.js";
import type { RpgPack } from "../rpg/schema.js";
import {
  CampaignCharacterImportsSchema,
  campaignCharacterImportPlayerStateContract,
  campaignCharacterImportTargetIssues,
  type CampaignCharacterImports,
} from "../rpg/campaign_character_import.js";
import { generateRpgPack } from "../gen/rpg_generator.js";
import { assertGeneratedRpgSeed } from "../gen/seed.js";
import { validateRpg } from "../validate/rpg_validator.js";
import {
  formatReport,
  makeReport,
  type Finding,
  type ValidationReport,
} from "../validate/report.js";
import type { Trace } from "../trace/record.js";
import type { WorldBinding } from "../world/schema.js";
import {
  normalizeSourcePath,
  overworldQuestById,
  type OverworldQuestCampaignExport,
} from "../world/overworld.js";
import { loadOverworldManifest, resolveTraceGameSource, type GameSource } from "../world/source.js";
import { safeResolve } from "./paths.js";
import { isRpgPackShape } from "./types.js";

export type RpgLoadResult =
  | { ok: true; compiled: CompiledRpgSource; report: ValidationReport }
  | { ok: false; report: ValidationReport };

type RpgSourceLoadCacheEntry = {
  ctimeMs: number;
  mtimeMs: number;
  size: number;
  result: RpgLoadResult;
};

type GeneratedRpgCacheEntry = {
  compiled: CompiledRpgSource;
  report: ValidationReport;
};

type WorldQuestSourceEntry = {
  title: string;
  playable: boolean;
  world: WorldBinding | null;
  world_quest_id: string;
};

type RpgTraceSource =
  | {
      kind: "worldQuest";
      worldQuestId: string;
      generateRpgSeed: null;
      compiled: CompiledRpgSource;
      campaignImports?: CampaignCharacterImports;
      campaignImportsHash?: string;
    }
  | {
      kind: "generated";
      worldQuestId: null;
      generateRpgSeed: number;
      compiled: CompiledRpgSource;
    };

type RpgWorldQuestPlayableSource = {
  questId: string;
  title: string;
  compiled: CompiledRpgSource;
  campaignImports?: CampaignCharacterImports;
  campaignImportsHash?: string;
};

export type RpgWorldQuestReportSource = {
  questId: string;
  title: string;
  result: RpgLoadResult;
};

type RpgWorldQuestSource = {
  questId: string;
  title: string;
  sourcePath: string;
  campaignImports?: CampaignCharacterImports;
  campaignImportsHash?: string;
  campaignExports: readonly OverworldQuestCampaignExport[] | undefined;
};

export const RPG_SOURCE_RUNTIME_CACHE_LIMIT = 8;

function refreshSourceCacheEntry<Key, Entry>(cache: Map<Key, Entry>, key: Key): Entry | undefined {
  const cached = cache.get(key);
  if (cached === undefined) return undefined;
  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

function rememberSourceCacheEntry<Key, Entry>(
  cache: Map<Key, Entry>,
  key: Key,
  entry: Entry,
  maxEntries = RPG_SOURCE_RUNTIME_CACHE_LIMIT,
): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function schemaFindings(error: {
  issues: { message: string; path: (string | number)[] }[];
}): Finding[] {
  return error.issues.map((i) => ({
    severity: "error" as const,
    code: "SCHEMA",
    message: `${i.message} (${i.path.join(".") || "<root>"})`,
    where: [i.path.join(".") || "<root>"],
  }));
}

function deepFreezeSourceResult<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeSourceResult(child);
  }
  return Object.freeze(value);
}

function freezeLoadResult(result: RpgLoadResult): RpgLoadResult {
  return deepFreezeSourceResult(result);
}

function freezeGeneratedEntry(entry: GeneratedRpgCacheEntry): GeneratedRpgCacheEntry {
  return deepFreezeSourceResult(entry);
}

function campaignExportParityFindings(
  source: RpgWorldQuestSource,
  compiled: CompiledRpgSource,
): Finding[] {
  if (source.campaignExports === undefined) return [];
  const endingsById = new Map(compiled.pack.endings.map((ending) => [ending.id, ending]));
  const exportedEndingIds = new Set(
    source.campaignExports.map((campaignExport) => campaignExport.ending_id),
  );
  const findings: Finding[] = [];

  source.campaignExports.forEach((campaignExport, index) => {
    const where = [source.questId, `campaign_exports.${index}`];
    const ending = endingsById.get(campaignExport.ending_id);
    if (!ending) {
      findings.push({
        severity: "error",
        code: "CAMPAIGN_EXPORT_ENDING_MISSING",
        message: `Campaign export ending "${campaignExport.ending_id}" does not exist in the compiled RPG.`,
        where,
      });
      return;
    }
    if (ending.title !== campaignExport.ending_title) {
      findings.push({
        severity: "error",
        code: "CAMPAIGN_EXPORT_TITLE_MISMATCH",
        message: `Campaign export title ${JSON.stringify(campaignExport.ending_title)} does not exactly match compiled ending title ${JSON.stringify(ending.title)}.`,
        where,
      });
    }
    if (ending.death) {
      findings.push({
        severity: "error",
        code: "CAMPAIGN_EXPORT_DEATH_ENDING",
        message: `Campaign export ending "${campaignExport.ending_id}" is a death ending and cannot grant persistent consequences.`,
        where,
      });
    }
  });

  for (const ending of compiled.pack.endings) {
    if (!ending.death && !exportedEndingIds.has(ending.id)) {
      findings.push({
        severity: "error",
        code: "CAMPAIGN_EXPORT_ENDING_UNDECLARED",
        message: `Compiled non-death ending "${ending.id}" has no campaign export.`,
        where: [source.questId, "campaign_exports"],
      });
    }
  }

  return findings;
}

function campaignImportTargetFindings(
  source: RpgWorldQuestSource,
  compiled: CompiledRpgSource,
): Finding[] {
  if (source.campaignImports === undefined) return [];
  return campaignCharacterImportTargetIssues(compiled.pack, source.campaignImports).map(
    (issue) => ({
      severity: "error" as const,
      code: `CAMPAIGN_IMPORT_${issue.code}`,
      message: issue.message,
      where: [source.questId, `campaign_imports.${issue.path.join(".")}`],
    }),
  );
}

function sameFinding(left: Finding, right: Finding): boolean {
  return (
    left.severity === right.severity &&
    left.code === right.code &&
    left.message === right.message &&
    left.where.length === right.where.length &&
    left.where.every((value, index) => value === right.where[index])
  );
}

function campaignImportDirectStartFindings(
  source: RpgWorldQuestSource,
  compiled: CompiledRpgSource,
): Finding[] {
  if (source.campaignImports === undefined) return [];
  const importContract = campaignCharacterImportPlayerStateContract(source.campaignImports);
  const importedFlags = new Set(importContract.settableFlagIds);
  const importedItems = new Set(importContract.obtainableObjectIds);
  const importedVars = new Set(importContract.initialVarRanges.keys());
  const defaultStartState = initStateForRpgPack(indexRpgPack(compiled.pack), 1);
  const conditionImportRefs = (condition: unknown): Set<string> => {
    const refs = new Set<string>();
    if (condition === null || typeof condition !== "object") return refs;
    const record = condition as Record<string, unknown>;
    if (typeof record.has_flag === "string" && importedFlags.has(record.has_flag)) {
      refs.add(`flag:${record.has_flag}`);
      return refs;
    }
    if (typeof record.has_item === "string" && importedItems.has(record.has_item)) {
      refs.add(`item:${record.has_item}`);
      return refs;
    }
    for (const operator of ["var_gte", "var_lte", "var_eq"] as const) {
      const comparison = record[operator];
      if (
        comparison === null ||
        typeof comparison !== "object" ||
        typeof (comparison as { name?: unknown }).name !== "string" ||
        !importedVars.has((comparison as { name: string }).name)
      ) {
        continue;
      }
      const { name, value } = comparison as { name: string; value: number };
      const initial = defaultStartState.vars[name];
      const holdsByDefault =
        initial !== undefined &&
        (operator === "var_gte"
          ? initial >= value
          : operator === "var_lte"
            ? initial <= value
            : initial === value);
      if (!holdsByDefault) refs.add(`var:${name}`);
      return refs;
    }
    if (Array.isArray(record.all_of)) {
      for (const child of record.all_of) {
        for (const ref of conditionImportRefs(child)) refs.add(ref);
      }
      return refs;
    }
    if (Array.isArray(record.any_of)) {
      const branches = record.any_of.map(conditionImportRefs);
      // A disjunction depends on imports only when every alternative does. A
      // mixed import/base any_of preserves a direct/default route.
      if (branches.length > 0 && branches.every((branch) => branch.size > 0)) {
        for (const branch of branches) for (const ref of branch) refs.add(ref);
      }
      return refs;
    }
    // none_of/negative predicates do not positively require an imported fact.
    return refs;
  };
  const requiredImportRefs = (conditions: readonly unknown[]): Set<string> => {
    const refs = new Set<string>();
    for (const condition of conditions) {
      for (const ref of conditionImportRefs(condition)) refs.add(ref);
    }
    return refs;
  };
  const wins = compiled.pack.win_conditions.map((win) => {
    return { id: win.id, refs: requiredImportRefs(win.conditions) };
  });
  if (wins.length === 0 || wins.some((win) => win.refs.size === 0)) return [];
  return [
    {
      severity: "error",
      code: "CAMPAIGN_IMPORT_DIRECT_START_UNWINNABLE",
      message: `Every win condition directly requires a campaign import target, but public/direct starts use pack defaults. Keep at least one structurally import-independent victory; blocked wins: ${wins.map((win) => `${win.id} (${[...win.refs].sort().join(", ")})`).join("; ")}.`,
      where: [source.questId, "campaign_imports", ...wins.map((win) => `win:${win.id}`)],
    },
  ];
}

function campaignImportCombatGuaranteeFindings(
  source: RpgWorldQuestSource,
  compiled: CompiledRpgSource,
): Finding[] {
  if (
    compiled.pack.meta.combat_guaranteed !== true ||
    !source.campaignImports?.rules.some((rule) => rule.type === "health_current_to_var")
  ) {
    return [];
  }
  return [
    {
      severity: "error",
      code: "CAMPAIGN_IMPORT_COMBAT_GUARANTEE_CONFLICT",
      message:
        "health_current_to_var cannot target a combat_guaranteed quest: active campaign health may be as low as 1, outside the pack-default worst-case proof. Author a validated wounded-character recovery/minimum contract before enabling this combination.",
      where: [source.questId, "meta:combat_guaranteed", "campaign_imports"],
    },
  ];
}

function withCampaignCatalogParity(
  source: RpgWorldQuestSource,
  result: RpgLoadResult,
): RpgLoadResult {
  if (!result.ok) return result;
  const importContract = campaignCharacterImportPlayerStateContract(source.campaignImports);
  const importFlags = importContract.settableFlagIds;
  const importItems = importContract.obtainableObjectIds;
  const importVarRanges = importContract.initialVarRanges;
  const importAwareReport =
    importFlags.length === 0 && importItems.length === 0 && importVarRanges.size === 0
      ? result.report
      : validateRpg(result.compiled.pack, {
          extraSettableFlags: importFlags,
          extraObtainable: importItems,
          extraInitialVarRanges: importVarRanges,
        });
  const findings = [...importAwareReport.findings];
  // An embedded import may make an additional route possible, but public/direct
  // starts still use pack defaults. Retain any global base-state reachability
  // failure; the catalog parity check below separately rejects the common case
  // where every declared win is directly gated on imported state.
  for (const finding of result.report.findings.filter(
    (candidate) => candidate.code === "WIN_UNREACHABLE",
  )) {
    if (!findings.some((candidate) => sameFinding(candidate, finding))) findings.push(finding);
  }
  const parityFindings = [
    ...campaignExportParityFindings(source, result.compiled),
    ...campaignImportTargetFindings(source, result.compiled),
    ...campaignImportDirectStartFindings(source, result.compiled),
    ...campaignImportCombatGuaranteeFindings(source, result.compiled),
  ];
  if (
    parityFindings.length === 0 &&
    importFlags.length === 0 &&
    importItems.length === 0 &&
    importVarRanges.size === 0
  ) {
    return result;
  }
  return freezeLoadResult({
    ok: true,
    compiled: result.compiled,
    report: makeReport(source.sourcePath, [...findings, ...parityFindings]),
  });
}

export class RpgSourceRuntime {
  private readonly sourceLoadCache = new Map<string, RpgSourceLoadCacheEntry>();
  private readonly generatedRpgCache = new Map<number, GeneratedRpgCacheEntry>();

  constructor(private readonly root: string) {}

  /** Read an RPG source, compile, and validate it with the single runtime loader. */
  private loadSourceBackedReport(sourcePath: string): RpgLoadResult {
    const abs = safeResolve(this.root, sourcePath);
    // A manifest may name a source file that is missing or unreadable on disk.
    // Surface that as a normal not-ok load report instead of letting the raw fs
    // error escape: Node's message embeds the resolved ABSOLUTE path, which no
    // MCP client may see (bug_0492's class), and a throw here would also let one
    // broken quest row break the whole overworld quest catalog. Echo only the
    // manifest-relative source path the reports already use. Not cached: there
    // is no stat identity to key on, and the error path is cold.
    const unreadable = (): RpgLoadResult =>
      freezeLoadResult({
        ok: false,
        report: makeReport(sourcePath, [
          {
            severity: "error",
            code: "SOURCE_UNREADABLE",
            message: `RPG source "${sourcePath}" is missing or unreadable.`,
            where: [sourcePath],
          },
        ]),
      });
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(abs);
    } catch {
      return unreadable();
    }
    const cached = refreshSourceCacheEntry(this.sourceLoadCache, abs);
    if (
      cached &&
      cached.ctimeMs === stat.ctimeMs &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.result;
    }

    let source: string;
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      return unreadable();
    }
    let result: RpgLoadResult;
    if (!isRpgPackShape(parseYaml(source) as unknown)) {
      result = freezeLoadResult({
        ok: false,
        report: makeReport(sourcePath, [
          {
            severity: "error",
            code: "UNSUPPORTED_LEGACY_PACK",
            message: "MCP source loading is RPG-only; legacy shapes are migration data.",
            where: [sourcePath],
          },
        ]),
      });
      rememberSourceCacheEntry(this.sourceLoadCache, abs, {
        ctimeMs: stat.ctimeMs,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        result,
      });
      return result;
    }
    const compileRes = compileRpgSource(source);
    if (!compileRes.ok) {
      result = freezeLoadResult({
        ok: false,
        report: makeReport(sourcePath, schemaFindings(compileRes.error)),
      });
      rememberSourceCacheEntry(this.sourceLoadCache, abs, {
        ctimeMs: stat.ctimeMs,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        result,
      });
      return result;
    }
    const pack = compileRes.compiled.pack;
    const report = validateRpg(pack);
    result = freezeLoadResult({ ok: true, compiled: compileRes.compiled, report });
    rememberSourceCacheEntry(this.sourceLoadCache, abs, {
      ctimeMs: stat.ctimeMs,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      result,
    });
    return result;
  }

  private loadWorldQuestSourceReport(source: RpgWorldQuestSource): RpgLoadResult {
    return withCampaignCatalogParity(source, this.loadSourceBackedReport(source.sourcePath));
  }

  /** Compile + validate the RPG and its trusted campaign import/export catalogs before play. */
  private requireWorldQuestSourcePlayable(source: RpgWorldQuestSource): CompiledRpgSource {
    const lr = this.loadWorldQuestSourceReport(source);
    if (!lr.ok || !lr.report.ok) {
      throw new Error(`RPG source is not playable:\n${formatReport(lr.report)}`);
    }
    return lr.compiled;
  }

  requireGameSourcePlayable(source: GameSource): CompiledRpgSource {
    return source.kind === "generated"
      ? this.requireGeneratedRpgPlayable(source.generateRpgSeed)
      : this.requireWorldQuestPlayable(source.worldQuestId).compiled;
  }

  generatedRpg(seed: number): GeneratedRpgCacheEntry {
    assertGeneratedRpgSeed(seed, "Generated RPG seed");
    const cached = refreshSourceCacheEntry(this.generatedRpgCache, seed);
    if (cached) return cached;
    const pack = generateRpgPack(seed);
    const report = validateRpg(pack);
    const entry = freezeGeneratedEntry({
      compiled: { pack, contentHash: hashState(pack) },
      report,
    });
    rememberSourceCacheEntry(this.generatedRpgCache, seed, entry);
    return entry;
  }

  /**
   * Mint a fresh RPG pack from a seed and refuse to play it unless it clears the
   * same validator gate the curated RPG packs clear.
   */
  requireGeneratedRpgPlayable(seed: number): CompiledRpgSource {
    const { compiled, report } = this.generatedRpg(seed);
    if (!report.ok) {
      throw new Error(
        `Generated RPG pack (seed ${seed}) is not playable:\n${formatReport(report)}`,
      );
    }
    return compiled;
  }

  /** Shipped quest ids, from the overworld quest registry (the single source of truth). */
  shippedWorldQuestIds(): string[] {
    return loadOverworldManifest(this.root)
      .quests.map((quest) => quest.id)
      .sort();
  }

  discoverWorldQuestSources(): WorldQuestSourceEntry[] {
    return this.shippedWorldQuestIds().map((worldQuestId) => {
      const source = this.loadWorldQuestReport(worldQuestId);
      const lr = source.result;
      return {
        title: lr.ok ? lr.compiled.pack.meta.title : source.title,
        playable: lr.ok && lr.report.ok,
        world: lr.ok ? (lr.compiled.pack.meta.world ?? null) : null,
        world_quest_id: source.questId,
      };
    });
  }

  private resolveWorldQuestRpgSource(worldQuestId: string): RpgWorldQuestSource {
    const overworld = loadOverworldManifest(this.root);
    const quest = overworldQuestById(overworld, worldQuestId);
    if (!quest) {
      throw new Error(`Unknown overworld quest "${worldQuestId}".`);
    }
    const campaignImports =
      quest.campaign_imports === undefined
        ? undefined
        : deepFreezeSourceResult(CampaignCharacterImportsSchema.parse(quest.campaign_imports));
    return {
      questId: quest.id,
      title: quest.title,
      sourcePath: normalizeSourcePath(quest.source),
      ...(campaignImports === undefined
        ? {}
        : { campaignImports, campaignImportsHash: hashState(campaignImports) }),
      campaignExports: quest.campaign_exports,
    };
  }

  requireWorldQuestPlayable(worldQuestId: string): RpgWorldQuestPlayableSource {
    const source = this.resolveWorldQuestRpgSource(worldQuestId);
    const campaignCatalog =
      source.campaignImports === undefined
        ? {}
        : {
            campaignImports: source.campaignImports,
            campaignImportsHash: source.campaignImportsHash ?? hashState(source.campaignImports),
          };
    return {
      questId: source.questId,
      title: source.title,
      compiled: this.requireWorldQuestSourcePlayable(source),
      ...campaignCatalog,
    };
  }

  loadWorldQuestReport(worldQuestId: string): RpgWorldQuestReportSource {
    const source = this.resolveWorldQuestRpgSource(worldQuestId);
    return {
      questId: source.questId,
      title: source.title,
      result: this.loadWorldQuestSourceReport(source),
    };
  }

  /**
   * Validate a CANDIDATE pack for a shipped world quest exactly as the load path validates
   * that quest's source: plain `validateRpg`, then `withCampaignCatalogParity`, which
   * re-validates with the flags, items and var ranges the quest's campaign imports supply
   * and adds the export/import catalog parity findings.
   *
   * `apply_content_patch` validated a patched pack with plain `validateRpg` alone, which
   * does not know that Wolf-Winter's approach and oath flags arrive through campaign
   * imports — so even a zero-op patch on the shipped quest came back `ok:false` with 74
   * IMPOSSIBLE_GATE errors (bug_0653). A patch's proof has to be the same bar the quest
   * is played against, or it proves nothing about whether the patched quest would load.
   *
   * The report is labelled with the pack's own id rather than the manifest source path
   * the load path uses once parity rewrites it, so every report `apply_content_patch`
   * returns — its own PATCH_* refusals included — names the pack the same way.
   */
  validateWorldQuestPack(worldQuestId: string, pack: RpgPack): ValidationReport {
    const source = this.resolveWorldQuestRpgSource(worldQuestId);
    const plain = validateRpg(pack);
    const result = withCampaignCatalogParity(source, {
      ok: true,
      compiled: { pack, contentHash: hashState(pack) },
      report: plain,
    });
    return makeReport(plain.source_id, [...result.report.findings]);
  }

  resolveTraceSource(
    args: { world_quest_id?: string },
    trace: Trace<RpgAction>,
    operation: string,
  ): RpgTraceSource {
    const source = resolveTraceGameSource(this.root, args, trace, operation);
    if (source.kind === "generated") {
      return {
        kind: "generated",
        worldQuestId: null,
        generateRpgSeed: source.generateRpgSeed,
        compiled: this.requireGeneratedRpgPlayable(source.generateRpgSeed),
      };
    }

    const playable = this.requireWorldQuestPlayable(source.worldQuestId);
    const campaignCatalog =
      playable.campaignImports === undefined
        ? {}
        : {
            campaignImports: playable.campaignImports,
            campaignImportsHash:
              playable.campaignImportsHash ?? hashState(playable.campaignImports),
          };
    return {
      kind: "worldQuest",
      worldQuestId: source.worldQuestId,
      generateRpgSeed: null,
      compiled: playable.compiled,
      ...campaignCatalog,
    };
  }
}
